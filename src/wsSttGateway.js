import { WebSocketServer } from "ws";
import jwt from "jsonwebtoken";
import Session from "./models/Session.model.js";
import { transcribeAudioBuffer } from "./services/stt.service.js";

const WS_PATH = "/api/v1/stt/stream";

const defaultSttModelForProvider = (provider) => {
  const p = String(provider || "")
    .trim()
    .toLowerCase();
  if (p === "openai") return "whisper-1";
  if (p === "elevenlabs") return "scribe_v2";
  return "whisper-large-v3-turbo";
};

const sanitizeSttModelForProvider = (provider, model) => {
  const p = String(provider || "")
    .trim()
    .toLowerCase();
  const m = String(model || "").trim();
  if (!m) return "";
  if (p === "webspeech") return "";
  if (/^scribe_v\d+_realtime$/i.test(m)) return "";

  if (p === "openai") {
    return m === "whisper-1" ? m : "";
  }

  if (p === "elevenlabs") {
    const allowed = new Set(["scribe_v2", "scribe_v2_1", "scribe"]);
    return allowed.has(m) ? m : "";
  }

  if (p === "groq") {
    const allowed = new Set([
      "whisper-large-v3-turbo",
      "whisper-large-v3",
      "distil-whisper-large-v3-en",
    ]);
    return allowed.has(m) ? m : "";
  }

  return m;
};

const pcm16ToWav = ({ pcmBuffer, sampleRate = 16000, channels = 1 }) => {
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcmBuffer.length;
  const headerSize = 44;

  const header = Buffer.alloc(headerSize);
  header.write("RIFF", 0);
  header.writeUInt32LE(headerSize - 8 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuffer]);
};

const safeSend = (ws, obj) => {
  try {
    if (!ws || ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(obj));
  } catch {
    // ignore
  }
};

const parseFrame = (buf) => {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 8) return null;

  const headerLen = buf.readUInt32LE(0);
  if (!Number.isFinite(headerLen) || headerLen <= 0) return null;
  if (buf.length < 4 + headerLen) return null;

  const headerRaw = buf.slice(4, 4 + headerLen).toString("utf8");
  let header;
  try {
    header = JSON.parse(headerRaw);
  } catch {
    return null;
  }

  const audio = buf.slice(4 + headerLen);
  return { header, audio };
};

const pickProviderForSession = ({ session }) => {
  const providerFromSessionRaw = String(session?.settings?.sttProvider || "")
    .trim()
    .toLowerCase();
  const providerFromSession =
    providerFromSessionRaw === "webspeech" ? "" : providerFromSessionRaw;

  const providerEnv = String(process.env.STT_PROVIDER || "")
    .trim()
    .toLowerCase();

  const provider =
    providerFromSession ||
    providerEnv ||
    (process.env.GROQ_API_KEY
      ? "groq"
      : process.env.OPENAI_API_KEY
        ? "openai"
        : process.env.ELEVENLABS_API_KEY
          ? "elevenlabs"
          : "");

  return provider;
};

const pickLanguageForSession = ({ session }) => {
  const forcedLanguageRaw = String(process.env.STT_FORCE_LANGUAGE || "").trim();
  const forcedLanguage = forcedLanguageRaw ? forcedLanguageRaw : "";
  return forcedLanguage || session?.settings?.language || "";
};

const pickModelForSession = ({ provider, session }) => {
  const sessionModelRaw = String(session?.settings?.sttModel || "").trim();
  const envModelRaw = String(process.env.STT_MODEL || "").trim();
  const candidate = sessionModelRaw || envModelRaw;
  const sanitized = sanitizeSttModelForProvider(provider, candidate);

  const sttLanguage = pickLanguageForSession({ session });
  const forceEnglish =
    String(sttLanguage || "")
      .trim()
      .toLowerCase() === "english" ||
    String(sttLanguage || "")
      .trim()
      .toLowerCase() === "en" ||
    String(sttLanguage || "")
      .trim()
      .toLowerCase()
      .startsWith("en-");

  return (
    sanitized ||
    (provider === "groq" && forceEnglish
      ? "distil-whisper-large-v3-en"
      : defaultSttModelForProvider(provider))
  );
};

export const attachWsSttGateway = ({ httpServer }) => {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    try {
      const url = new URL(req.url || "", "http://localhost");
      if (url.pathname !== WS_PATH) return; // let socket.io/others handle

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } catch {
      // If we can't parse URL, let other upgrade handlers attempt.
      return;
    }
  });

  wss.on("connection", (ws, req) => {
    const url = new URL(req?.url || "", "http://localhost");
    const token = String(url.searchParams.get("token") || "").trim();

    let userId = "";
    try {
      if (!token) throw new Error("Missing token");
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      userId = String(decoded?.id || "").trim();
      if (!userId) throw new Error("Invalid token");
    } catch {
      safeSend(ws, { type: "error", status: 401, message: "Unauthorized" });
      try {
        ws.close(1008, "Unauthorized");
      } catch {
        // ignore
      }
      return;
    }

    const state = {
      userId,
      sessionId: "",
      sampleRate: 16000,
      buffers: [],
      bytes: 0,
      maxBytes: (() => {
        const n = Number(process.env.STT_WS_MAX_BYTES || 15 * 1024 * 1024);
        if (!Number.isFinite(n) || n <= 0) return 15 * 1024 * 1024;
        return Math.max(1024 * 1024, Math.min(50 * 1024 * 1024, Math.floor(n)));
      })(),
      inFlight: false,
    };

    const resetBuffer = () => {
      state.buffers = [];
      state.bytes = 0;
    };

    const finalize = async ({ reason } = {}) => {
      if (state.inFlight) return;
      if (!state.sessionId) {
        safeSend(ws, {
          type: "error",
          status: 400,
          message: "Missing sessionId (send hello first)",
        });
        resetBuffer();
        return;
      }

      if (!state.buffers.length || state.bytes < 320 * 2) {
        resetBuffer();
        return;
      }

      state.inFlight = true;
      try {
        const session = await Session.findOne({
          _id: state.sessionId,
          user: state.userId,
        })
          .select("_id settings job")
          .lean();

        if (!session) {
          safeSend(ws, {
            type: "error",
            status: 404,
            message: "Session not found",
          });
          resetBuffer();
          return;
        }

        const provider = pickProviderForSession({ session });
        if (!provider) {
          safeSend(ws, {
            type: "error",
            status: 501,
            message:
              "Speech transcription not configured. Set STT_PROVIDER and credentials.",
          });
          resetBuffer();
          return;
        }

        const model = pickModelForSession({ provider, session });
        const language = pickLanguageForSession({ session });

        const pcm = Buffer.concat(state.buffers, state.bytes);
        resetBuffer();

        const wav = pcm16ToWav({
          pcmBuffer: pcm,
          sampleRate: state.sampleRate || 16000,
          channels: 1,
        });

        const controller = new AbortController();
        const timeoutMs = 25000;
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
          const result = await transcribeAudioBuffer({
            provider,
            model,
            buffer: wav,
            mimetype: "audio/wav",
            filename: `audio-${Date.now()}.wav`,
            prompt: "",
            language,
            signal: controller.signal,
          });

          const text = String(result?.text || "").trim();
          if (text) {
            safeSend(ws, {
              type: "final",
              text,
              provider: String(result?.provider || provider),
              model: String(result?.model || model),
              reason: String(reason || ""),
            });
          }
        } finally {
          clearTimeout(timer);
        }
      } catch (e) {
        const status = Number(e?.statusCode) || 502;
        safeSend(ws, {
          type: "error",
          status,
          message: String(e?.message || "Transcription failed"),
          details: e?.details || undefined,
        });
      } finally {
        state.inFlight = false;
      }
    };

    ws.on("message", (data, isBinary) => {
      try {
        if (!isBinary) {
          const raw = data?.toString?.("utf8") || "";
          const msg = JSON.parse(raw);
          const type = String(msg?.type || "")
            .trim()
            .toLowerCase();

          if (type === "hello") {
            state.sessionId = String(msg?.sessionId || "").trim();
            const sr = Number(msg?.sampleRate || 16000);
            state.sampleRate = Number.isFinite(sr) ? sr : 16000;
            resetBuffer();
            safeSend(ws, { type: "hello_ack", ok: true });
            return;
          }

          if (type === "utterance_end") {
            void finalize({ reason: "utterance_end" });
            return;
          }

          if (type === "finalize") {
            void finalize({ reason: "finalize" });
            return;
          }

          return;
        }

        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const parsed = parseFrame(buf);
        if (!parsed) return;

        const { header, audio } = parsed;
        if (header?.sessionId) {
          state.sessionId = String(header.sessionId || "").trim();
        }
        const sr = Number(header?.sampleRate || 16000);
        if (Number.isFinite(sr)) state.sampleRate = sr;

        if (audio && audio.length) {
          state.buffers.push(audio);
          state.bytes += audio.length;
        }

        if (state.bytes > state.maxBytes) {
          // Prevent unbounded memory growth; force a flush.
          void finalize({ reason: "max_bytes" });
          return;
        }

        if (header?.isFinal) {
          void finalize({ reason: "frame_final" });
        }
      } catch {
        // ignore bad frames
      }
    });

    ws.on("close", () => {
      resetBuffer();
    });

    safeSend(ws, { type: "ready", path: WS_PATH });
  });

  return { path: WS_PATH };
};
