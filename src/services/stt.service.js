import os from "os";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const parseRetryAfterSeconds = ({ response, message }) => {
  const retryAfterHeader = response?.headers?.get?.("retry-after");
  if (retryAfterHeader != null) {
    const n = Number(retryAfterHeader);
    if (Number.isFinite(n) && n >= 0) return n;
  }

  const m = String(message || "").match(/try again in\s*(\d+)s/i);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 0) return n;
  }

  return undefined;
};

const normalizeLanguage = (language) => {
  const lang = String(language || "")
    .trim()
    .toLowerCase();
  if (!lang) return undefined;

  // If already an ISO code, keep it.
  const isoDirect = new Set(["en", "hi", "es", "fr", "de"]);
  if (isoDirect.has(lang)) return lang;

  // Common locale formats.
  const locale = lang.replace("_", "-");
  if (locale.startsWith("en-")) return "en";
  if (locale.startsWith("hi-")) return "hi";
  if (locale.startsWith("es-")) return "es";
  if (locale.startsWith("fr-")) return "fr";
  if (locale.startsWith("de-")) return "de";

  const langMap = {
    english: "en",
    hindi: "hi",
    spanish: "es",
    french: "fr",
    german: "de",
  };
  return langMap[lang];
};

const getElevenLabsModelId = ({ model } = {}) => {
  const raw =
    String(model || "").trim() ||
    String(process.env.ELEVENLABS_STT_MODEL_ID || "").trim() ||
    String(process.env.ELEVENLABS_MODEL_ID || "").trim() ||
    "scribe_v2";

  const v = raw.toLowerCase();
  const allowed = new Set(["scribe_v1", "scribe_v2"]);
  return allowed.has(v) ? v : "scribe_v2";
};

const getElevenLabsEnableLogging = () => {
  const raw = String(process.env.ELEVENLABS_STT_ENABLE_LOGGING || "1")
    .trim()
    .toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "no" || raw === "off");
};

export const transcribeWithElevenLabsScribe = async ({
  apiKey,
  model,
  buffer,
  mimetype,
  filename,
  language,
  signal,
}) => {
  if (!apiKey) {
    const err = new Error(
      "Speech transcription not configured. Missing ELEVENLABS_API_KEY."
    );
    err.statusCode = 501;
    throw err;
  }

  const modelId = getElevenLabsModelId({ model });
  const enableLogging = getElevenLabsEnableLogging();
  const url = `https://api.elevenlabs.io/v1/speech-to-text?enable_logging=${
    enableLogging ? "true" : "false"
  }`;

  const form = new FormData();
  form.append("model_id", modelId);

  const langIso = normalizeLanguage(language);
  if (langIso) form.append("language_code", langIso);

  const blob = new Blob([buffer], { type: mimetype || "audio/webm" });
  form.append("file", blob, filename || `audio-${Date.now()}.webm`);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
    },
    body: form,
    signal,
  });

  const rawText = await response.text().catch(() => "");
  const data = tryParseJson(rawText) || {};

  if (!response.ok) {
    const msg =
      data?.detail?.message ||
      data?.message ||
      (rawText && rawText.length < 800
        ? rawText
        : "Speech transcription failed");
    const retryAfterSeconds = parseRetryAfterSeconds({
      response,
      message: msg,
    });

    const err = new Error(msg);
    err.statusCode = response.status === 429 ? 429 : 502;
    err.details = { provider: "elevenlabs", model: modelId, retryAfterSeconds };
    throw err;
  }

  const text = String(data?.text || "").trim();
  return { text, provider: "elevenlabs", model: modelId };
};

const getPromptMaxChars = () => {
  const n = Number(process.env.STT_PROMPT_MAX_CHARS || 500);
  if (!Number.isFinite(n) || n <= 0) return 500;
  return Math.max(40, Math.min(1000, Math.floor(n)));
};

const getSttResponseFormat = ({ provider } = {}) => {
  const p = String(provider || "").toLowerCase();
  const raw =
    (p === "groq"
      ? process.env.GROQ_STT_RESPONSE_FORMAT
      : p === "openai"
        ? process.env.OPENAI_STT_RESPONSE_FORMAT
        : process.env.STT_RESPONSE_FORMAT) || "json";
  const v = String(raw || "json")
    .trim()
    .toLowerCase();
  // OpenAI-compatible transcription response_format: json|text|srt|vtt|verbose_json
  const allowed = new Set(["json", "text", "srt", "vtt", "verbose_json"]);
  return allowed.has(v) ? v : "json";
};

const tryParseJson = (text) => {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

export const transcribeWithGroqOpenAICompat = async ({
  provider,
  apiKey,
  baseURL,
  model,
  buffer,
  mimetype,
  filename,
  prompt,
  language,
  signal,
}) => {
  if (!apiKey) {
    const err = new Error(
      `Speech transcription not configured. Missing API key for provider: ${provider}`
    );
    err.statusCode = 501;
    throw err;
  }

  const url = `${baseURL}/audio/transcriptions`;

  const responseFormat = getSttResponseFormat({ provider });
  const promptMaxChars = getPromptMaxChars();

  const form = new FormData();
  form.append("model", model);
  form.append("temperature", "0");

  if (responseFormat && responseFormat !== "json") {
    form.append("response_format", responseFormat);
  }

  const p = String(prompt || "").trim();
  if (p) form.append("prompt", p.slice(0, promptMaxChars));

  const langIso = normalizeLanguage(language);
  if (langIso) form.append("language", langIso);

  const blob = new Blob([buffer], { type: mimetype || "audio/webm" });
  form.append("file", blob, filename || `audio-${Date.now()}.webm`);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
    signal,
  });

  const rawText = await response.text().catch(() => "");
  const data = tryParseJson(rawText) || {};

  if (!response.ok) {
    const msg =
      data?.error?.message ||
      data?.message ||
      (rawText && rawText.length < 800
        ? rawText
        : "Speech transcription failed");
    const retryAfterSeconds = parseRetryAfterSeconds({
      response,
      message: msg,
    });

    const err = new Error(msg);
    err.statusCode = response.status === 429 ? 429 : 502;
    err.details = { provider, model, retryAfterSeconds };
    throw err;
  }

  // Successful response: if response_format isn't JSON, providers may return plain text.
  const text =
    responseFormat && responseFormat !== "json"
      ? String(rawText || "")
      : String(data?.text || rawText || "");

  return { text: text, provider, model };
};

export const transcribeWithAssemblyAI = async ({
  apiKey,
  buffer,
  mimetype,
  prompt,
  language,
  timeoutMs = 30000,
}) => {
  if (!apiKey) {
    const err = new Error(
      "Speech transcription not configured. Missing ASSEMBLYAI_API_KEY."
    );
    err.statusCode = 501;
    throw err;
  }

  // AssemblyAI: upload -> request transcript -> poll.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const uploadRes = await fetch("https://api.assemblyai.com/v2/upload", {
      method: "POST",
      headers: {
        authorization: apiKey,
        "content-type": mimetype || "application/octet-stream",
      },
      body: buffer,
      signal: controller.signal,
    });

    const uploadData = await uploadRes.json().catch(() => ({}));
    if (!uploadRes.ok || !uploadData?.upload_url) {
      const msg =
        uploadData?.error || uploadData?.message || "AssemblyAI upload failed";
      const err = new Error(msg);
      err.statusCode = 502;
      err.details = { provider: "assemblyai" };
      throw err;
    }

    const langIso = normalizeLanguage(language);
    const speechModelsRaw = String(
      process.env.ASSEMBLYAI_SPEECH_MODELS ||
        process.env.ASSEMBLYAI_SPEECH_MODEL ||
        ""
    ).trim();
    const speechModels = speechModelsRaw
      ? speechModelsRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : ["universal-2"];

    const body = {
      audio_url: uploadData.upload_url,
      punctuate: true,
      format_text: true,
      // Required by newer AssemblyAI STT APIs
      speech_models: speechModels,
    };

    // Optional hints
    if (langIso) body.language_code = langIso;
    const p = String(prompt || "").trim();
    // AssemblyAI only supports `prompt` with universal-3-pro (universal-2 rejects it).
    const supportsPrompt = speechModels.some(
      (m) => String(m).toLowerCase() === "universal-3-pro"
    );
    if (p && supportsPrompt) body.prompt = p.slice(0, 500);

    const createRes = await fetch("https://api.assemblyai.com/v2/transcript", {
      method: "POST",
      headers: {
        authorization: apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const createData = await createRes.json().catch(() => ({}));
    if (!createRes.ok || !createData?.id) {
      const msg =
        createData?.error ||
        createData?.message ||
        "AssemblyAI transcription request failed";
      const err = new Error(msg);
      err.statusCode = 502;
      err.details = { provider: "assemblyai" };
      throw err;
    }

    const id = createData.id;
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      await sleep(800);
      const pollRes = await fetch(
        `https://api.assemblyai.com/v2/transcript/${id}`,
        {
          method: "GET",
          headers: {
            authorization: apiKey,
          },
          signal: controller.signal,
        }
      );

      const pollData = await pollRes.json().catch(() => ({}));
      if (!pollRes.ok) {
        const msg =
          pollData?.error || pollData?.message || "AssemblyAI polling failed";
        const err = new Error(msg);
        err.statusCode = 502;
        err.details = { provider: "assemblyai" };
        throw err;
      }

      const status = String(pollData?.status || "").toLowerCase();
      if (status === "completed") {
        return {
          text: String(pollData?.text || ""),
          provider: "assemblyai",
          model: "default",
        };
      }

      if (status === "error") {
        const msg = pollData?.error || "AssemblyAI transcription failed";
        const err = new Error(msg);
        err.statusCode = 502;
        err.details = { provider: "assemblyai" };
        throw err;
      }
    }

    const err = new Error("AssemblyAI transcription timed out");
    err.statusCode = 502;
    err.details = { provider: "assemblyai" };
    throw err;
  } catch (e) {
    const isAbort = String(e?.name || "") === "AbortError";
    if (isAbort) {
      const err = new Error("Speech transcription timed out");
      err.statusCode = 502;
      err.details = { provider: "assemblyai" };
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
};

export const transcribeWithDeepSpeech = async ({
  buffer,
  pythonExe,
  scriptPath,
  modelPath,
  scorerPath,
  timeoutMs = 20000,
}) => {
  if (!modelPath) {
    const err = new Error(
      "DeepSpeech is not configured. Set DEEPSPEECH_MODEL_PATH (and optionally DEEPSPEECH_SCORER_PATH)."
    );
    err.statusCode = 501;
    err.details = { provider: "deepspeech" };
    throw err;
  }

  const exe = pythonExe || process.env.DEEPSPEECH_PYTHON || "python";
  const pyScript =
    scriptPath ||
    path.join(process.cwd(), "src", "services", "deepspeech_transcribe.py");

  const tmpDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "parakeet-stt-")
  );
  const audioPath = path.join(tmpDir, `audio-${Date.now()}.wav`);

  try {
    await fs.promises.writeFile(audioPath, buffer);

    const args = [pyScript, "--model", modelPath, "--audio", audioPath];
    if (scorerPath) {
      args.push("--scorer", scorerPath);
    }

    const out = await new Promise((resolve, reject) => {
      const child = spawn(exe, args, { windowsHide: true });
      const stdout = [];
      const stderr = [];

      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
        reject(new Error("DeepSpeech transcription timed out"));
      }, timeoutMs);

      child.stdout.on("data", (d) => stdout.push(d));
      child.stderr.on("data", (d) => stderr.push(d));
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) return resolve(Buffer.concat(stdout).toString("utf8"));
        reject(
          new Error(
            Buffer.concat(stderr).toString("utf8").trim() ||
              `DeepSpeech exited ${code}`
          )
        );
      });
    });

    return {
      text: String(out || "").trim(),
      provider: "deepspeech",
      model: "deepspeech",
    };
  } catch (e) {
    const err = new Error(e?.message || "DeepSpeech transcription failed");
    err.statusCode = 502;
    err.details = { provider: "deepspeech" };
    throw err;
  } finally {
    try {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
};

let fasterWhisperWorker = null;

const startFasterWhisperWorker = () => {
  const exe = process.env.FASTER_WHISPER_PYTHON || "python";
  const script = path.join(
    process.cwd(),
    "src",
    "services",
    "faster_whisper_worker.py"
  );

  const child = spawn(exe, [script], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      PYTHONUNBUFFERED: "1",
    },
  });

  let stdoutBuf = "";
  const pending = new Map();

  const failAll = (err) => {
    for (const { reject } of pending.values()) {
      try {
        reject(err);
      } catch {
        // ignore
      }
    }
    pending.clear();
  };

  child.on("error", (err) => {
    failAll(err);
  });

  child.on("close", (code) => {
    const err = new Error(
      `faster-whisper worker exited (${code}). Ensure Python is available and run: pip install faster-whisper`
    );
    failAll(err);
  });

  child.stderr.on("data", (d) => {
    const s = String(d || "");
    if (s.trim()) console.warn("[faster-whisper]", s.trim());
  });

  child.stdout.on("data", (d) => {
    stdoutBuf += String(d || "");
    while (true) {
      const idx = stdoutBuf.indexOf("\n");
      if (idx === -1) break;
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;

      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }

      const id = String(msg?.id || "");
      if (!id) continue;

      const p = pending.get(id);
      if (!p) continue;
      pending.delete(id);

      if (msg?.ok) p.resolve(msg);
      else p.reject(new Error(String(msg?.error || "Transcription failed")));
    }
  });

  const request = ({ audioPath, language }) =>
    new Promise((resolve, reject) => {
      const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      pending.set(id, { resolve, reject });

      const payload = {
        id,
        audioPath,
        language,
        beamSize: Number(process.env.FASTER_WHISPER_BEAM_SIZE || 1),
        vadFilter: !["0", "false", "no", "off"].includes(
          String(process.env.FASTER_WHISPER_VAD_FILTER || "1").toLowerCase()
        ),
        // Latency-friendly defaults
        conditionOnPreviousText: !["0", "false", "no", "off"].includes(
          String(
            process.env.FASTER_WHISPER_CONDITION_ON_PREV || "0"
          ).toLowerCase()
        ),
        initialPrompt:
          String(process.env.FASTER_WHISPER_INITIAL_PROMPT || "").trim() ||
          null,
      };

      try {
        child.stdin.write(`${JSON.stringify(payload)}\n`);
      } catch (e) {
        pending.delete(id);
        reject(e);
      }
    });

  return {
    child,
    request,
  };
};

const getFasterWhisperWorker = () => {
  if (fasterWhisperWorker?.child && !fasterWhisperWorker.child.killed) {
    return fasterWhisperWorker;
  }
  fasterWhisperWorker = startFasterWhisperWorker();
  return fasterWhisperWorker;
};

export const transcribeWithFasterWhisper = async ({
  buffer,
  language,
  mimetype,
  filename,
  timeoutMs = 25000,
}) => {
  const tmpDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "parakeet-fasterwhisper-")
  );

  const ext = (() => {
    const name = String(filename || "").toLowerCase();
    if (name.endsWith(".wav")) return ".wav";
    if (name.endsWith(".webm")) return ".webm";
    if (name.endsWith(".ogg")) return ".ogg";
    if (name.endsWith(".mp3")) return ".mp3";
    if (String(mimetype || "").includes("wav")) return ".wav";
    if (String(mimetype || "").includes("webm")) return ".webm";
    if (String(mimetype || "").includes("ogg")) return ".ogg";
    if (String(mimetype || "").includes("mpeg")) return ".mp3";
    return ".wav";
  })();

  const audioPath = path.join(tmpDir, `audio-${Date.now()}${ext}`);

  try {
    await fs.promises.writeFile(audioPath, buffer);

    const worker = getFasterWhisperWorker();

    const out = await Promise.race([
      worker.request({ audioPath, language: normalizeLanguage(language) }),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("faster-whisper timed out")),
          timeoutMs
        )
      ),
    ]);

    return {
      text: String(out?.text || "").trim(),
      provider: "fasterwhisper",
      model: String(process.env.FASTER_WHISPER_MODEL || "small"),
    };
  } catch (e) {
    const err = new Error(e?.message || "faster-whisper transcription failed");
    err.statusCode = 502;
    err.details = { provider: "fasterwhisper" };
    throw err;
  } finally {
    try {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
};

export const transcribeAudioBuffer = async ({
  provider,
  model,
  buffer,
  mimetype,
  filename,
  prompt,
  language,
  signal,
}) => {
  const p = String(provider || "").toLowerCase();

  if (p === "webspeech") {
    const err = new Error(
      "Web Speech API is a browser STT mode; do not call server /transcribe."
    );
    err.statusCode = 400;
    err.details = { provider: "webspeech" };
    throw err;
  }

  if (p === "assemblyai") {
    return await transcribeWithAssemblyAI({
      apiKey: process.env.ASSEMBLYAI_API_KEY,
      buffer,
      mimetype,
      prompt,
      language,
    });
  }

  if (p === "deepspeech") {
    return await transcribeWithDeepSpeech({
      buffer,
      modelPath: process.env.DEEPSPEECH_MODEL_PATH,
      scorerPath: process.env.DEEPSPEECH_SCORER_PATH,
    });
  }

  if (p === "fasterwhisper") {
    return await transcribeWithFasterWhisper({
      buffer,
      language,
      mimetype,
      filename,
    });
  }

  if (p === "elevenlabs") {
    return await transcribeWithElevenLabsScribe({
      apiKey: process.env.ELEVENLABS_API_KEY,
      model,
      buffer,
      mimetype,
      filename,
      language,
      signal,
    });
  }

  // Default: OpenAI-compatible providers (groq/openai)
  if (p === "openai") {
    return await transcribeWithGroqOpenAICompat({
      provider: "openai",
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: "https://api.openai.com/v1",
      model: model || process.env.STT_MODEL || "whisper-1",
      buffer,
      mimetype,
      filename,
      prompt,
      language,
      signal,
    });
  }

  // groq (default)
  return await transcribeWithGroqOpenAICompat({
    provider: "groq",
    apiKey: process.env.GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1",
    model: model || process.env.STT_MODEL || "whisper-large-v3-turbo",
    buffer,
    mimetype,
    filename,
    prompt,
    language,
    signal,
  });
};
