import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import pdf from "pdf-parse";
import mammoth from "mammoth";
import mongoose from "mongoose";
import Session from "../models/Session.model.js";
import AppError from "../utils/AppError.js";
import aiService from "../services/ai.service.js";
import { transcribeAudioBuffer } from "../services/stt.service.js";
import { getIO } from "../socket.js";
import { getDefaultSttDomainVocabString } from "../utils/sttDomainVocab.js";

let ffmpegPath = null;
try {
  const mod = await import("ffmpeg-static");
  ffmpegPath = mod?.default || mod;
} catch {
  ffmpegPath = null;
}

const MIN_SESSION_DURATION_MINUTES = 15;
const MAX_SESSION_DURATION_MINUTES = 12 * 60;

const clampSessionDurationMinutes = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 60;
  const rounded = Math.floor(n);
  return Math.max(
    MIN_SESSION_DURATION_MINUTES,
    Math.min(MAX_SESSION_DURATION_MINUTES, rounded)
  );
};

const ensureSessionActive = async (session) => {
  if (!session) throw new AppError("Session not found", 404);

  if (session.status === "active") return session;

  if (session.status === "created" || session.status === "paused") {
    if (!session.settings) session.settings = {};

    session.settings.duration = clampSessionDurationMinutes(
      session?.settings?.duration
    );

    session.startSession();
    await session.save();
    return session;
  }

  throw new AppError("Session not active", 409);
};

const getSessionForUser = async ({ sessionId, userId }) => {
  const id = String(sessionId || "").trim();
  const uid = String(userId || "").trim();
  if (!id) throw new AppError("Session not found", 404);
  if (!uid) throw new AppError("Unauthorized", 401);

  const session = await Session.findOne({ _id: id, user: uid });
  if (!session) throw new AppError("Session not found", 404);
  return session;
};

const persistQaPair = async ({
  session,
  question,
  answer,
  sttProvider,
  sttModel,
  llmModel,
  provider,
}) => {
  if (!session) return;
  const q = String(question || "").trim();
  const a = String(answer || "").trim();
  if (!q || !a) return;

  const sttP = String(
    sttProvider || session?.settings?.sttProvider || ""
  ).trim();
  const sttM = String(sttModel || session?.settings?.sttModel || "").trim();
  const llmM = String(llmModel || session?.settings?.aiModel || "").trim();
  const prov = String(provider || "").trim();

  const msgs = session.messages || [];
  const last = msgs[msgs.length - 1];
  const prev = msgs[msgs.length - 2];

  // Avoid accidental duplicates when clients retry.
  const alreadySaved =
    prev?.role === "user" &&
    last?.role === "assistant" &&
    String(prev?.kind || "") === "qa" &&
    String(last?.kind || "") === "qa" &&
    String(prev?.content || "").trim() === q &&
    String(last?.content || "").trim() === a;

  if (alreadySaved) return;

  session.addMessage({
    role: "user",
    kind: "qa",
    content: q,
    tokens: 0,
    meta: {
      ...(sttP ? { sttProvider: sttP } : {}),
      ...(sttM ? { sttModel: sttM } : {}),
      ...(llmM ? { llmModel: llmM } : {}),
      ...(prov ? { provider: prov } : {}),
    },
  });
  session.addMessage({
    role: "assistant",
    kind: "qa",
    content: a,
    tokens: 0,
    meta: {
      ...(llmM ? { llmModel: llmM } : {}),
      ...(prov ? { provider: prov } : {}),
    },
  });

  await session.save();

  try {
    const io = getIO();
    io?.to(`session_${session._id}`).emit("new_message", { ok: true });
  } catch {
    // ignore
  }
};

const tryConvertToWav16kMono = async ({ buffer }) => {
  if (!buffer || !Buffer.isBuffer(buffer)) return null;
  if (!ffmpegPath || typeof ffmpegPath !== "string") return null;

  // Keep conversions bounded; our uploads are already limited, but be defensive.
  const maxInputBytes = 10 * 1024 * 1024;
  if (buffer.length > maxInputBytes) return null;

  return await new Promise((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-f",
      "wav",
      "pipe:1",
    ];

    const child = spawn(ffmpegPath, args, { windowsHide: true });

    const stdout = [];
    const stderr = [];

    child.stdout.on("data", (d) => stdout.push(d));
    child.stderr.on("data", (d) => stderr.push(d));
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) return resolve(Buffer.concat(stdout));
      const errText = Buffer.concat(stderr).toString("utf8").trim();
      reject(new Error(errText || `ffmpeg failed (exit ${code})`));
    });

    try {
      child.stdin.end(buffer);
    } catch (e) {
      reject(e);
    }
  });
};

const safeUnlink = async (filePath) => {
  try {
    await fs.promises.unlink(filePath);
  } catch {
    // ignore
  }
};

export const listSessions = async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 20), 100);
  const sort = req.query.sort || "-createdAt";

  const sessions = await Session.find({ user: req.user._id })
    .sort(sort)
    .limit(limit);

  res.status(200).json({
    status: "success",
    data: sessions,
    sessions,
  });
};

export const getSession = async (req, res, next) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return next(new AppError("Invalid session id", 400));
  }

  const session = await Session.findOne({
    _id: req.params.id,
    user: req.user._id,
  });
  if (!session) {
    const existing = await Session.findById(req.params.id).select("_id user");
    if (existing) {
      return next(
        new AppError(
          "You do not have access to this session (it may belong to a different login).",
          403
        )
      );
    }
    return next(new AppError("Session not found", 404));
  }

  res.status(200).json({
    status: "success",
    ...session.toObject(),
  });
};

export const createSession = async (req, res, next) => {
  try {
    const {
      company,
      jobTitle,
      jobDescription,
      jobUrl,
      language,
      aiModel,
      extraContext,
      instructions,
      difficulty,
      duration,
      useProfileResume,
    } = req.body;

    if (!company || !jobTitle || !jobDescription) {
      return next(new AppError("Missing required job fields", 400));
    }

    const profileAi = req.user?.profileDefaults?.aiAnswer || {};
    const detailLevel = ["short", "medium", "deep"].includes(
      String(profileAi?.detailLevel || "").toLowerCase()
    )
      ? String(profileAi.detailLevel).toLowerCase()
      : "medium";

    const session = await Session.create({
      user: req.user._id,
      job: {
        company,
        title: jobTitle,
        description: jobDescription,
        url: jobUrl,
      },
      settings: {
        language: language || "english",
        aiModel: aiModel || "llama-3.1-8b",
        extraContext: extraContext || "",
        instructions: instructions || "",
        difficulty: difficulty || "intermediate",
        duration: clampSessionDurationMinutes(duration),
        aiAnswerDetailLevel: detailLevel,
        aiAnswerIncludeCode:
          typeof profileAi?.includeCode === "boolean"
            ? profileAi.includeCode
            : true,
        aiAnswerIncludeExtras:
          typeof profileAi?.includeExtras === "boolean"
            ? profileAi.includeExtras
            : true,
        aiAnswerMaxTokens:
          Number.isFinite(Number(profileAi?.maxTokens)) &&
          Number(profileAi.maxTokens) > 0
            ? Math.min(4000, Math.floor(Number(profileAi.maxTokens)))
            : 0,
        aiAnswerTemperature:
          Number.isFinite(Number(profileAi?.temperature)) &&
          Number(profileAi.temperature) >= 0
            ? Math.min(2, Math.max(0, Number(profileAi.temperature)))
            : 0,
      },
      status: "created",
    });

    const wantsProfileResume = ["1", "true", "yes", "on"].includes(
      String(useProfileResume || "").toLowerCase()
    );

    // Parse resume if provided (or use the saved profile resume when requested)
    if (req.file || wantsProfileResume) {
      if (req.file) {
        const resumePath = req.file.path;
        try {
          const buffer = await fs.promises.readFile(resumePath);
          const ext = path.extname(req.file.originalname || "").toLowerCase();
          const url = `/uploads/${path.basename(resumePath)}`;

          let extractedText = "";
          let parsedOk = false;

          if (ext === ".pdf") {
            const parsed = await pdf(buffer);
            extractedText = parsed.text || "";
            parsedOk = true;
          } else if (ext === ".txt") {
            extractedText = buffer.toString("utf8");
            parsedOk = true;
          } else if (ext === ".docx") {
            const result = await mammoth.extractRawText({ buffer });
            extractedText = result?.value || "";
            parsedOk = true;
          } else {
            // .doc is allowed for upload, but extraction isn't supported without extra native tooling
            extractedText = "";
            parsedOk = false;
          }

          session.resume = {
            filename: req.file.originalname,
            url,
            text: extractedText.slice(0, 20000),
            parsed: parsedOk,
          };
        } finally {
          // Keep file on disk for downloads; do not unlink here
        }
        await session.save();
      } else {
        const saved = req.user?.profileDefaults?.resume;
        if (saved?.url) {
          session.resume = {
            filename: saved.filename || "resume",
            url: saved.url,
            text: String(saved.text || "").slice(0, 20000),
            parsed: !!saved.parsed,
          };
          await session.save();
        }
      }
    }

    // Update usage counters
    req.user.usage.sessions.total += 1;
    req.user.usage.sessions.thisMonth += 1;
    await req.user.save({ validateBeforeSave: false });

    res.status(201).json({
      status: "success",
      session,
    });
  } catch (err) {
    next(err);
  }
};

const defaultSttModelForProvider = (provider) => {
  const p = String(provider || "")
    .trim()
    .toLowerCase();
  if (p === "openai") return "whisper-1";
  if (p === "elevenlabs_client") return "scribe_v2_realtime";
  if (p === "elevenlabs") return "scribe_v2";
  // Groq and most others (including faster-whisper) default to Whisper Large v3 Turbo.
  return "whisper-large-v3-turbo";
};

const sanitizeSttModelForProvider = (provider, model) => {
  const p = String(provider || "")
    .trim()
    .toLowerCase();
  const m = String(model || "").trim();
  if (!m) return "";

  // Browser-only; keep any model field empty.
  if (p === "webspeech") return "";

  // ElevenLabs client-side realtime: allow realtime model ids.
  if (p === "elevenlabs_client") {
    return /^scribe_v\d+_realtime$/i.test(m) ? m : "";
  }

  // Prevent mixing ElevenLabs realtime client model ids into server STT providers.
  // (This is the source of: Groq + scribe_v2_realtime)
  if (/^scribe_v\d+_realtime$/i.test(m)) return "";

  if (p === "openai") {
    return m === "whisper-1" ? m : "";
  }

  if (p === "elevenlabs") {
    // ElevenLabs server-side STT models.
    const allowed = new Set(["scribe_v2", "scribe_v2_1", "scribe"]);
    return allowed.has(m) ? m : "";
  }

  if (p === "groq") {
    // Common Groq STT model ids.
    const allowed = new Set([
      "whisper-large-v3-turbo",
      "whisper-large-v3",
      "distil-whisper-large-v3-en",
    ]);
    return allowed.has(m) ? m : "";
  }

  // Unknown/custom provider: keep as-is.
  return m;
};

export const startSession = async (req, res, next) => {
  try {
    const session = await Session.findOne({
      _id: req.params.id,
      user: req.user._id,
    });
    if (!session) return next(new AppError("Session not found", 404));

    // Allow restarting completed/expired sessions (common when users reopen an old session).
    // Still block cancelled sessions.
    if (session.status === "cancelled") {
      return next(new AppError("Session cannot be started", 409));
    }

    const canStartOrRestart = [
      "created",
      "paused",
      "active",
      "completed",
      "expired",
    ].includes(session.status);
    if (!canStartOrRestart) {
      return next(new AppError("Session cannot be started", 409));
    }

    const { language, aiModel, simpleLanguage, sttProvider, sttModel } =
      req.body || {};

    if (!session.settings) session.settings = {};

    if (typeof language === "string" && language.trim()) {
      session.settings.language = language.trim();
    }
    if (typeof aiModel === "string" && aiModel.trim()) {
      session.settings.aiModel = aiModel.trim();
    }
    if (typeof simpleLanguage === "boolean") {
      session.settings.simpleLanguage = simpleLanguage;
    }
    if (typeof sttProvider === "string" && sttProvider.trim()) {
      session.settings.sttProvider = sttProvider.trim().toLowerCase();
    }
    if (typeof sttModel === "string" && sttModel.trim()) {
      session.settings.sttModel = sttModel.trim();
    }

    // Ensure model matches provider (avoid persisting invalid combos).
    const p = String(session.settings.sttProvider || "")
      .trim()
      .toLowerCase();
    const sanitized = sanitizeSttModelForProvider(p, session.settings.sttModel);
    if (String(session.settings.sttModel || "").trim() !== sanitized) {
      session.settings.sttModel = sanitized;
    }

    session.settings.duration = clampSessionDurationMinutes(
      session?.settings?.duration
    );

    if (session.status === "completed" || session.status === "expired") {
      // Restart: reset timing fields; keep messages/settings.
      session.status = "active";
      session.startedAt = new Date();
      session.pausedAt = undefined;
      session.endedAt = undefined;
      session.expiresAt = new Date(
        Date.now() + session.settings.duration * 60 * 1000
      );
    } else if (session.status === "created" || session.status === "paused") {
      session.startSession();
    }
    await session.save();

    try {
      const io = getIO();
      io?.to(`session_${session._id}`).emit("session_updated", {
        sessionId: String(session._id),
      });
    } catch {
      // ignore
    }

    res.status(200).json({ status: "success", session });
  } catch (err) {
    next(err);
  }
};

export const updateSessionSettings = async (req, res, next) => {
  try {
    const session = await Session.findOne({
      _id: req.params.id,
      user: req.user._id,
    });
    if (!session) return next(new AppError("Session not found", 404));

    // Allow updating settings even for ended sessions so users can fix metadata.
    // Starting/resuming is still blocked elsewhere for ended sessions.

    const { language, aiModel, simpleLanguage, sttProvider, sttModel } =
      req.body || {};
    if (!session.settings) session.settings = {};

    if (typeof language === "string" && language.trim()) {
      session.settings.language = language.trim();
    }
    if (typeof aiModel === "string" && aiModel.trim()) {
      session.settings.aiModel = aiModel.trim();
    }
    if (typeof simpleLanguage === "boolean") {
      session.settings.simpleLanguage = simpleLanguage;
    }
    if (typeof sttProvider === "string" && sttProvider.trim()) {
      session.settings.sttProvider = sttProvider.trim().toLowerCase();
    }
    if (typeof sttModel === "string" && sttModel.trim()) {
      session.settings.sttModel = sttModel.trim();
    }

    // Ensure model matches provider (avoid persisting invalid combos).
    const p = String(session.settings.sttProvider || "")
      .trim()
      .toLowerCase();
    const sanitized = sanitizeSttModelForProvider(p, session.settings.sttModel);
    if (String(session.settings.sttModel || "").trim() !== sanitized) {
      session.settings.sttModel = sanitized;
    }

    await session.save();

    try {
      const io = getIO();
      io?.to(`session_${session._id}`).emit("session_updated", {
        sessionId: String(session._id),
      });
    } catch {
      // ignore
    }

    res.status(200).json({ status: "success", session });
  } catch (err) {
    next(err);
  }
};

export const updateSession = async (req, res, next) => {
  try {
    const session = await Session.findOne({
      _id: req.params.id,
      user: req.user._id,
    });
    if (!session) return next(new AppError("Session not found", 404));

    const isLocked = ["completed", "expired", "cancelled"].includes(
      session.status
    );

    const {
      company,
      jobTitle,
      jobDescription,
      jobUrl,
      extraContext,
      instructions,
      difficulty,
      duration,
    } = req.body || {};

    if (!session.job) session.job = {};
    if (!session.settings) session.settings = {};

    if (typeof company === "string") session.job.company = company;
    if (typeof jobTitle === "string") session.job.title = jobTitle;
    if (typeof jobDescription === "string")
      session.job.description = jobDescription;
    if (typeof jobUrl === "string") session.job.url = jobUrl;

    if (typeof extraContext === "string")
      session.settings.extraContext = extraContext;
    if (typeof instructions === "string")
      session.settings.instructions = instructions;
    if (typeof difficulty === "string" && difficulty.trim()) {
      session.settings.difficulty = difficulty.trim();
    }

    if (duration !== undefined) {
      session.settings.duration = clampSessionDurationMinutes(duration);

      // Avoid extending/altering expiry for already-ended sessions.
      if (!isLocked) {
        const base = session.startedAt
          ? new Date(session.startedAt).getTime()
          : Date.now();
        session.expiresAt = new Date(
          base + session.settings.duration * 60 * 1000
        );
      }
    }

    await session.save();

    try {
      const io = getIO();
      io?.to(`session_${session._id}`).emit("session_updated", {
        sessionId: String(session._id),
      });
    } catch {
      // ignore
    }

    res.status(200).json({ status: "success", session });
  } catch (err) {
    next(err);
  }
};

export const deleteSession = async (req, res, next) => {
  try {
    const session = await Session.findOneAndDelete({
      _id: req.params.id,
      user: req.user._id,
    }).select("_id");
    if (!session) return next(new AppError("Session not found", 404));

    res.status(200).json({ status: "success" });
  } catch (err) {
    next(err);
  }
};

export const endSession = async (req, res, next) => {
  const session = await Session.findOne({
    _id: req.params.id,
    user: req.user._id,
  });
  if (!session) return next(new AppError("Session not found", 404));

  if (session.status !== "active" && session.status !== "paused") {
    return next(new AppError("Session cannot be ended", 409));
  }

  session.endSession();
  await session.save();

  try {
    const io = getIO();
    io?.to(`session_${session._id}`).emit("session_updated", {
      sessionId: String(session._id),
    });
  } catch {
    // ignore
  }

  res.status(200).json({ status: "success", session });
};

export const getMessages = async (req, res, next) => {
  const session = await Session.findOne({
    _id: req.params.id,
    user: req.user._id,
  }).select("messages status");
  if (!session) return next(new AppError("Session not found", 404));

  res.status(200).json({ status: "success", messages: session.messages });
};

export const addMessage = async (req, res, next) => {
  const { content } = req.body;
  if (!content || !String(content).trim()) {
    return next(new AppError("Message content required", 400));
  }

  const session = await Session.findOne({
    _id: req.params.id,
    user: req.user._id,
  });
  if (!session) return next(new AppError("Session not found", 404));
  try {
    await ensureSessionActive(session);
  } catch (e) {
    return next(e);
  }

  session.addMessage({ role: "user", content: String(content), tokens: 0 });
  await session.save();

  try {
    const io = getIO();
    io?.to(`session_${session._id}`).emit("new_message", { ok: true });
  } catch {
    // ignore
  }

  res.status(201).json({ status: "success" });
};

export const aiResponse = async (req, res, next) => {
  const session = await Session.findOne({
    _id: req.params.id,
    user: req.user._id,
  });
  if (!session) return next(new AppError("Session not found", 404));
  try {
    await ensureSessionActive(session);
  } catch (e) {
    return next(e);
  }

  const lastMessage = String(req.body?.lastMessage || "").trim();

  // If no AI keys configured, fall back to deterministic placeholder
  const hasAnyProviderKey =
    Boolean(process.env.GROQ_API_KEY) ||
    Boolean(process.env.OPENAI_API_KEY) ||
    Boolean(process.env.ANTHROPIC_API_KEY) ||
    Boolean(process.env.CEREBRAS_API_KEY);

  try {
    let assistantText;
    let usage;
    let model;
    let cost;

    if (hasAnyProviderKey) {
      const response = await aiService.generateInterviewQuestion(
        session,
        lastMessage
      );
      assistantText = response?.content;
      usage = response?.usage;
      model = response?.model;
      cost = response?.cost;
    } else {
      assistantText =
        `Great. Let’s dive deeper. ` +
        `Based on your last answer: "${lastMessage.slice(0, 300)}"\n\n` +
        `Question: Can you explain your approach and trade-offs?`;
    }

    const tokens =
      Number(usage?.total_tokens) ||
      Number(usage?.output_tokens) + Number(usage?.input_tokens) ||
      0;

    session.addMessage({
      role: "assistant",
      content: String(assistantText || ""),
      tokens,
    });
    if (typeof cost === "number") {
      session.analytics.totalCost = (session.analytics.totalCost || 0) + cost;
    }
    await session.save();

    try {
      const io = getIO();
      io?.to(`session_${session._id}`).emit("new_message", { ok: true });
    } catch {
      // ignore
    }

    res.status(201).json({ status: "success", model, tokens, cost });
  } catch (err) {
    next(new AppError(err?.message || "Failed to get AI response", 502));
  }
};

export const aiAnswer = async (req, res, next) => {
  const session = await Session.findOne({
    _id: req.params.id,
    user: req.user._id,
  });
  if (!session) return next(new AppError("Session not found", 404));
  try {
    await ensureSessionActive(session);
  } catch (e) {
    return next(e);
  }

  const draft = String(req.body?.draft || "").trim();
  const lastAssistant = [...(session.messages || [])]
    .reverse()
    .find((m) => m.role === "assistant");
  const question = String(
    req.body?.question || lastAssistant?.content || ""
  ).trim();

  const hasAnyProviderKey =
    Boolean(process.env.GROQ_API_KEY) ||
    Boolean(process.env.OPENAI_API_KEY) ||
    Boolean(process.env.ANTHROPIC_API_KEY) ||
    Boolean(process.env.CEREBRAS_API_KEY);

  if (!hasAnyProviderKey) {
    return next(
      new AppError(
        "AI Answer not configured. Set a provider API key (e.g., GROQ_API_KEY or OPENAI_API_KEY).",
        501
      )
    );
  }

  try {
    const response = await aiService.generateAnswer(
      session.toObject(),
      question,
      draft
    );
    const text = String(response?.content || "").trim();

    const persist =
      req.body?.persist === true ||
      String(req.body?.persist || "").toLowerCase() === "true";

    if (persist) {
      try {
        await persistQaPair({
          session,
          question,
          answer: normalizeAiAnswerTranscript(text),
          sttProvider: req.body?.sttProvider,
          sttModel: req.body?.sttModel,
          llmModel: response?.model || session?.settings?.aiModel,
        });
      } catch {
        // Don't fail the request if persistence fails.
      }
    }

    res.status(200).json({
      status: "success",
      text,
      model: response?.model,
      usage: response?.usage,
    });
  } catch (err) {
    next(new AppError(err?.message || "Failed to generate AI answer", 502));
  }
};

const normalizeAiAnswerTranscript = (input) => {
  let text = String(input || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";

  const rules = [
    [/\bnode\s*js\b/gi, "Node.js"],
    [/\bnext\s*js\b/gi, "Next.js"],
    [/\breact\s*js\b/gi, "React"],
    [/\bjavascript\b/gi, "JavaScript"],
    [/\btypescript\b/gi, "TypeScript"],
    [/\bmongo\s*db\b/gi, "MongoDB"],
    [/\bpostgre\s*s\b/gi, "Postgres"],
    [/\bci\s*cd\b/gi, "CI/CD"],
    [/\brest\s*api\b/gi, "REST API"],
    [/\bsocket\s*io\b/gi, "Socket.IO"],
    [/\baws\b/gi, "AWS"],
    [/\bk\s*8\s*s\b/gi, "Kubernetes"],
  ];

  for (const [re, replacement] of rules) {
    text = text.replace(re, replacement);
  }

  return text;
};

const truncateForPrompt = (value, maxChars) => {
  const text = String(value || "").trim();
  if (!text) return "";
  const n = Number(maxChars);
  if (!Number.isFinite(n) || n <= 0) return "";
  return text.length > n ? text.slice(0, n) + "…" : text;
};

const buildParakeetJsonPrompt = ({ cleanedText, rawASR, session }) => {
  const settings = session?.settings || {};
  const job = session?.job || {};
  const resume = session?.resume || {};

  const preferredLanguage = String(settings.language || "english").trim();
  const simpleLanguage = settings.simpleLanguage === true;
  const difficulty = String(settings.difficulty || "intermediate").trim();

  const jdText = truncateForPrompt(job.description, 8000);
  const resumeText = truncateForPrompt(resume.text, 8000);
  const extraContext = truncateForPrompt(settings.extraContext, 6000);
  const instructions = truncateForPrompt(settings.instructions, 4000);

  // Always use user/session settings for detail/code/extras; no fallback/derived logic.
  const detailLevel = String(settings.aiAnswerDetailLevel || "medium")
    .trim()
    .toLowerCase();
  // Backward-compatible defaults: older sessions may not have these booleans set.
  const includeCode =
    typeof settings.aiAnswerIncludeCode === "boolean"
      ? settings.aiAnswerIncludeCode
      : true;
  const includeExtras =
    typeof settings.aiAnswerIncludeExtras === "boolean"
      ? settings.aiAnswerIncludeExtras
      : true;

  const bulletsRule =
    detailLevel === "short"
      ? "- 'bullets' must be 4-5 bullets, each 8-16 words, include technical keywords wrapped in backticks.\n"
      : detailLevel === "deep"
        ? "- 'bullets' must be 6-8 bullets, each 8-20 words, include technical keywords wrapped in backticks.\n"
        : "- 'bullets' must be 4-6 bullets, each 8-18 words, include technical keywords wrapped in backticks.\n";

  const explanationRule =
    detailLevel === "short"
      ? "- 'explanation' must be 1 short paragraph (max ~450 chars), practical + tailored.\n"
      : detailLevel === "deep"
        ? "- 'explanation' must be 2-4 short paragraphs, practical + tailored to JD/resume.\n"
        : "- 'explanation' must be 1-3 short paragraphs, practical + tailored to JD/resume.\n";

  const system =
    "You are an expert technical interview coach. " +
    "Use the provided job description, resume, extra context, and instructions to tailor the answer for the candidate and role. " +
    "Return a structured JSON response only (no surrounding commentary). " +
    "Do not include any extra keys beyond those requested.";

  const user =
    "Context (tailor to this; do not invent details):\n" +
    `- Preferred language: ${preferredLanguage}\n` +
    `- Difficulty: ${difficulty}\n` +
    `- Simple language: ${simpleLanguage ? "true" : "false"}\n` +
    `- Job title: ${truncateForPrompt(job.title, 180)}\n` +
    `- Company: ${truncateForPrompt(job.company, 180)}\n\n` +
    (jdText ? `Job description (excerpt):\n"""${jdText}"""\n\n` : "") +
    (resumeText ? `Candidate resume (excerpt):\n"""${resumeText}"""\n\n` : "") +
    (extraContext ? `Extra context:\n"""${extraContext}"""\n\n` : "") +
    (instructions ? `Instructions:\n"""${instructions}"""\n\n` : "") +
    `User transcript (cleaned): """${String(cleanedText || "").trim()}"""\n` +
    `User raw ASR (verbatim): """${String(rawASR || "").trim()}"""\n\n` +
    "Produce a JSON object with these exact keys:\n\n" +
    "{\n" +
    '  "short_definition": "one line simple English definition",\n' +
    '  "tl_dr": "one sentence TL;DR",\n' +
    '  "bullets": ["bullet 1", "bullet 2", "..."],\n' +
    '  "explanation": "1-3 short paragraphs, practical + tailored to JD/resume",\n' +
    (includeCode
      ? '  "code_example": { "language": "javascript", "code": "// 6-12 lines short runnable code (NO code fences)" },\n'
      : '  "code_example": null,\n') +
    (includeExtras
      ? '  "interview_talking_points": ["point 1","point 2","point 3"],\n'
      : '  "interview_talking_points": [],\n') +
    (includeExtras
      ? '  "common_pitfalls": ["pitfall 1", "pitfall 2"],\n'
      : '  "common_pitfalls": [],\n') +
    (includeExtras
      ? '  "follow_up_questions": ["fup 1", "fup 2"],\n'
      : '  "follow_up_questions": [],\n') +
    (includeExtras
      ? '  "estimated_time_to_answer": "e.g., 45 seconds",\n'
      : '  "estimated_time_to_answer": "",\n') +
    '  "verbatim_asr": "the original raw ASR transcript (exact string passed in rawASR field)"\n' +
    "}\n\n" +
    "Requirements:\n" +
    "- Output must be valid JSON only (no markdown or extra text).\n" +
    "- IMPORTANT: JSON strings must not contain literal newlines. Use \\n escapes inside strings instead.\n" +
    "- Keep it interview-ready: concise, keyword-rich, and confident.\n" +
    "- 'short_definition' must be 1 line, very simple English.\n" +
    bulletsRule +
    explanationRule +
    (includeExtras
      ? "- 'interview_talking_points' must be exactly 3 short lines the candidate can say aloud.\n"
      : "- 'interview_talking_points' must be an empty array.\n") +
    (includeExtras
      ? "- 'common_pitfalls' must be exactly 2 one-sentence pitfalls.\n"
      : "- 'common_pitfalls' must be an empty array.\n") +
    (includeExtras
      ? "- 'follow_up_questions' must be exactly 2 likely follow-up questions.\n"
      : "- 'follow_up_questions' must be an empty array.\n") +
    (includeCode
      ? "- Because includeCode=true, 'code_example' MUST be an object (not null).\n" +
        "- 'code_example.code' must be 6-12 lines of plain runnable code WITHOUT code fences.\n"
      : "- 'code_example' must be null.\n") +
    "- Tailor content using JD/resume/extra context/instructions. If something is missing, keep it generic (do not hallucinate).\n" +
    "- 'verbatim_asr' must be EXACTLY the rawASR string provided above.\n\n" +
    "Return the JSON object only.";

  return { system, user };
};

const parseJsonFromModel = (content) => {
  let raw = String(content || "").trim();
  if (!raw) throw new Error("LLM returned empty response");

  // Strip common markdown code fences.
  raw = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const escapeNewlinesInJsonStrings = (s) => {
    const input = String(s || "");
    let out = "";
    let inString = false;
    let escaped = false;

    for (let i = 0; i < input.length; i++) {
      const ch = input[i];

      if (inString) {
        if (escaped) {
          out += ch;
          escaped = false;
          continue;
        }

        if (ch === "\\") {
          out += ch;
          escaped = true;
          continue;
        }

        if (ch === '"') {
          out += ch;
          inString = false;
          continue;
        }

        if (ch === "\n") {
          out += "\\n";
          continue;
        }

        if (ch === "\r") {
          // drop CR (CRLF will become just \n)
          continue;
        }

        out += ch;
        continue;
      }

      if (ch === '"') {
        out += ch;
        inString = true;
        continue;
      }

      out += ch;
    }

    return out;
  };

  const tryParse = (s) => {
    const cleaned = String(s || "")
      .trim()
      // Remove trailing commas before } or ] which commonly break JSON
      .replace(/,\s*([}\]])/g, "$1")
      // Replace smart quotes that sometimes appear
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2018\u2019]/g, "'");

    // Repair common invalid JSON produced by LLMs: literal newlines inside quoted strings.
    const repaired = escapeNewlinesInJsonStrings(cleaned);
    return JSON.parse(repaired);
  };

  try {
    return tryParse(raw);
  } catch {
    // Prefer slicing from first { to last } to avoid greedy regex pitfalls.
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    const candidate =
      start >= 0 && end > start ? raw.slice(start, end + 1) : "";

    if (!candidate) throw new Error("LLM returned non-JSON content");
    try {
      return tryParse(candidate);
    } catch {
      throw new Error("LLM returned invalid JSON");
    }
  }
};

const coerceParakeetShape = ({ parsed, rawASR }) => {
  const obj = parsed && typeof parsed === "object" ? parsed : {};
  const safeArray = (v) =>
    Array.isArray(v) ? v.filter(Boolean).map(String) : [];
  const safeStr = (v) =>
    typeof v === "string" ? v : v == null ? "" : String(v);

  const stripCodeFences = (code) => {
    let raw = String(code || "").trim();
    if (!raw) return "";
    raw = raw.replace(/^```[a-z0-9_-]*\s*/i, "").replace(/\s*```$/i, "");
    return raw.trim();
  };

  // Backward-compatible coercion:
  // - prefer new schema keys (short_definition/bullets/explanation/...) when present
  // - fallback to old schema keys (tl_dr/star_answer/key_steps/detailed_explanation/...) if needed
  const shortDefinition = safeStr(obj.short_definition).trim();
  const tlDr = safeStr(obj.tl_dr).trim();
  const bullets = safeArray(obj.bullets).slice(0, 10);
  const explanation = safeStr(obj.explanation).trim();
  const interviewTalkingPoints = safeArray(obj.interview_talking_points).slice(
    0,
    10
  );

  const out = {
    short_definition: shortDefinition,
    tl_dr: tlDr,
    bullets,
    explanation,
    code_example:
      obj.code_example && typeof obj.code_example === "object"
        ? {
            language:
              safeStr(obj.code_example.language || "").trim() || "javascript",
            code: stripCodeFences(safeStr(obj.code_example.code || "").trim()),
          }
        : null,
    interview_talking_points: interviewTalkingPoints,
    common_pitfalls: safeArray(obj.common_pitfalls).slice(0, 20),
    follow_up_questions: safeArray(obj.follow_up_questions).slice(0, 20),
    estimated_time_to_answer: safeStr(obj.estimated_time_to_answer).trim(),
    verbatim_asr: String(rawASR || ""),

    // Legacy keys kept for older UI code paths (and for debugging/compat):
    star_answer: safeStr(obj.star_answer).trim(),
    key_steps: safeArray(obj.key_steps).slice(0, 10),
    detailed_explanation: safeStr(obj.detailed_explanation).trim(),
    technical_terms: Array.isArray(obj.technical_terms)
      ? obj.technical_terms
          .filter((t) => t && typeof t === "object")
          .slice(0, 30)
          .map((t) => ({
            term: safeStr(t.term).trim(),
            definition: safeStr(t.definition).trim(),
          }))
          .filter((t) => t.term && t.definition)
      : [],
    interview_tips: safeArray(obj.interview_tips).slice(0, 20),
    notes_for_candidate: safeStr(obj.notes_for_candidate).trim(),
  };

  // If model returned a non-null code example without a real block, drop it.
  if (out.code_example && !out.code_example.code) out.code_example = null;

  // If new schema fields are empty, derive something sensible from legacy fields.
  if (!out.short_definition) out.short_definition = out.tl_dr || "";
  if (!out.tl_dr) out.tl_dr = out.short_definition || "";
  if (
    !out.bullets.length &&
    Array.isArray(out.key_steps) &&
    out.key_steps.length
  ) {
    out.bullets = out.key_steps.slice(0, 10);
  }
  if (!out.explanation) out.explanation = out.detailed_explanation || "";
  // Legacy UI sometimes reads detailed_explanation even though we now prefer explanation.
  if (!out.detailed_explanation)
    out.detailed_explanation = out.explanation || "";

  // If the model returns only code (or explanation is empty), force a minimal spoken explanation.
  if (!out.explanation && out.code_example && out.code_example.code) {
    out.explanation =
      "I’ll start with the approach in plain English, then show a short code sketch.";
  }
  if (!out.detailed_explanation)
    out.detailed_explanation = out.explanation || out.detailed_explanation || "";

  if (!out.bullets.length) {
    out.bullets = [
      "Clarify inputs/outputs and constraints up front.",
      "Pick the simplest correct approach, then optimize if needed.",
      "Call out edge cases and time/space complexity briefly.",
      "Walk through one example to validate correctness.",
    ];
  }

  return out;
};

const buildFallbackParakeetFromText = ({ text, rawASR }) => {
  const t = String(text || "").trim();
  const lines = t.split(/\r?\n/).map((l) => l.trim());
  const firstNonEmpty = lines.find((l) => l) || "";
  const firstSentence =
    (t.match(/^[\s\S]{1,240}?[.!?](\s|$)/)?.[0] || "").trim() || firstNonEmpty;

  const extractFirstFencedCode = (value) => {
    const src = String(value || "");
    const re = /```\s*([a-z0-9_-]+)?\s*\n([\s\S]*?)\n```/i;
    const m = src.match(re);
    if (!m) return null;
    return {
      language: String(m[1] || "").trim() || "javascript",
      code: String(m[2] || "").trim(),
      stripped: src.replace(re, "").trim(),
    };
  };

  const looksLikeCodeOnly = (value) => {
    const src = String(value || "").trim();
    if (!src) return false;
    const ls = src.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (ls.length < 3) return false;
    const codey = ls.filter((l) => /[{}();]|=>|\b(const|let|var|function|class|return)\b/.test(l));
    // Heuristic: if a large fraction of non-empty lines look like code, treat it as code-only.
    return codey.length / ls.length >= 0.6;
  };

  let explanationText = t;
  let codeExample = null;

  const fenced = extractFirstFencedCode(t);
  if (fenced && fenced.code) {
    codeExample = { language: fenced.language, code: fenced.code };
    explanationText = String(fenced.stripped || "").trim();
  } else if (looksLikeCodeOnly(t)) {
    codeExample = { language: "javascript", code: t };
    explanationText = "";
  }

  const bullets = lines
    .map((l) => l.replace(/^[-*•]+\s*/, "").trim())
    .filter((l) => l && l.length <= 180);

  const safeExplanation = explanationText
    ? explanationText
    : "I’ll explain the approach first, then show a short code sketch.";

  const safeBullets = bullets.length
    ? bullets.slice(0, 6)
    : [
        "Clarify inputs/outputs and constraints.",
        "State the core idea and why it works.",
        "Mention complexity and edge cases.",
        "Then show a short, readable code sketch.",
      ];

  return {
    short_definition: firstSentence || firstNonEmpty || "",
    tl_dr: firstSentence || firstNonEmpty || "",
    bullets: safeBullets,
    explanation: safeExplanation,
    code_example: codeExample,
    common_pitfalls: [],
    interview_talking_points: [],
    follow_up_questions: [],
    estimated_time_to_answer: "",
    verbatim_asr: String(rawASR || ""),

    // Legacy keys
    star_answer: firstNonEmpty || t,
    key_steps: bullets.slice(0, 6),
    detailed_explanation: t,
    technical_terms: [],
    interview_tips: [],
    notes_for_candidate: "",
  };
};

const formatParakeetForTranscript = ({ question, parakeet }) => {
  const q = String(question || "").trim();
  const p = parakeet && typeof parakeet === "object" ? parakeet : null;
  if (!p) return "";

  const shortDefinition = String(p.short_definition || "").trim();
  const tlDr = String(p.tl_dr || "").trim();
  const answer = String(
    shortDefinition && tlDr && shortDefinition !== tlDr
      ? `${shortDefinition} ${tlDr}`
      : shortDefinition || tlDr || p.star_answer || ""
  ).trim();

  const explanation = String(
    p.explanation || p.detailed_explanation || ""
  ).trim();

  const keyPoints = Array.isArray(p.bullets)
    ? p.bullets
        .filter(Boolean)
        .map((v) => String(v).trim())
        .filter(Boolean)
    : Array.isArray(p.key_steps)
      ? p.key_steps
          .filter(Boolean)
          .map((v) => String(v).trim())
          .filter(Boolean)
      : [];

  const lines = [];
  if (q) {
    lines.push(`💬 **Question**: ${q}`);
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  if (answer) {
    lines.push(`⭐️ **Answer**: ${answer}`);
    lines.push("");
  }

  if (keyPoints.length) {
    lines.push("**Key Points**:");
    lines.push("");
    for (const point of keyPoints.slice(0, 12)) {
      lines.push(`* ${point}`);
    }
    lines.push("");
  }

  const code = String(p?.code_example?.code || "").trim();
  const lang = String(p?.code_example?.language || "").trim() || "javascript";
  if (code) {
    lines.push("**💻 Code**:");
    lines.push("```" + lang);
    lines.push(code);
    lines.push("```");
    lines.push("");
  }

  if (explanation) {
    lines.push(`**💡 Explanation**: ${explanation}`);
  }

  return lines.join("\n").trim();
};

export const aiAnswerParakeet = async (req, res, next) => {
  const session = await Session.findOne({
    _id: req.params.id,
    user: req.user._id,
  });
  if (!session) return next(new AppError("Session not found", 404));
  try {
    await ensureSessionActive(session);
  } catch (e) {
    return next(e);
  }

  const parseHttpStatusFromMessage = (message) => {
    const m = String(message || "").match(/\(HTTP\s+(\d{3})\)/i);
    if (!m) return null;
    const code = Number(m[1]);
    return Number.isFinite(code) ? code : null;
  };

  const isJsonModeValidationError = (err) => {
    const msg = String(
      err?.response?.data?.error?.message ||
        err?.response?.data?.message ||
        err?.message ||
        ""
    )
      .toLowerCase()
      .trim();
    return (
      msg.includes("failed to validate json") ||
      msg.includes("failed_generation") ||
      msg.includes("response_format")
    );
  };

  const lastAssistant = [...(session.messages || [])]
    .reverse()
    .find((m) => m.role === "assistant");

  const question = String(
    req.body?.question || req.body?.text || lastAssistant?.content || ""
  ).trim();
  const rawASR = String(req.body?.rawASR || "");
  const cleanedOverride = String(req.body?.cleaned || "").trim();
  // Default to persisting Q/A so transcripts are reliably stored.
  // Clients can disable by sending persist=false explicitly.
  const persist =
    req.body?.persist === false ||
    String(req.body?.persist || "").toLowerCase() === "false"
      ? false
      : true;

  const hasAnyProviderKey =
    Boolean(process.env.GROQ_API_KEY) ||
    Boolean(process.env.OPENAI_API_KEY) ||
    Boolean(process.env.ANTHROPIC_API_KEY) ||
    Boolean(process.env.CEREBRAS_API_KEY);

  if (!hasAnyProviderKey) {
    return next(
      new AppError(
        "AI Answer not configured. Set a provider API key (e.g., GROQ_API_KEY or OPENAI_API_KEY).",
        501
      )
    );
  }

  if (!question && !rawASR && !cleanedOverride) {
    return next(new AppError("Question text is required", 400));
  }

  try {
    const sessionObj = session.toObject();

    // Always use user/session settings for LLM params; no fallback/derived logic.
    const maxTokens =
      Number.isFinite(Number(sessionObj?.settings?.aiAnswerMaxTokens)) &&
      Number(sessionObj.settings.aiAnswerMaxTokens) > 0
        ? Math.min(
            4000,
            Math.floor(Number(sessionObj.settings.aiAnswerMaxTokens))
          )
        : undefined;
    const temperature =
      Number.isFinite(Number(sessionObj?.settings?.aiAnswerTemperature)) &&
      Number(sessionObj.settings.aiAnswerTemperature) >= 0
        ? Math.min(
            2,
            Math.max(0, Number(sessionObj.settings.aiAnswerTemperature))
          )
        : undefined;

    const cleaned = cleanedOverride
      ? cleanedOverride
      : normalizeAiAnswerTranscript(question || rawASR);

    const rawForReturn = rawASR || question || "";
    const { system, user } = buildParakeetJsonPrompt({
      cleanedText: cleaned,
      rawASR: rawForReturn,
      session: sessionObj,
    });

    const modelOverride = String(
      process.env.AI_ANSWER_PARAKEET_MODEL_OVERRIDE || ""
    ).trim();
    const model = modelOverride || aiService.getAnswerModel(sessionObj);
    const provider = aiService.getProviderByModel(model);

    const jsonObjectMode = { type: "json_object" };

    let response;
    switch (provider) {
      case "openai":
        try {
          response = await aiService.callOpenAI(model, user, {
            systemPrompt: system,
            temperature,
            top_p: 1,
            max_tokens: maxTokens,
            response_format: jsonObjectMode,
          });
        } catch (e) {
          // Some providers reject/strictly validate JSON mode and will 400
          // even when we can safely parse/repair JSON ourselves.
          if (isJsonModeValidationError(e)) {
            response = await aiService.callOpenAI(model, user, {
              systemPrompt: system,
              temperature,
              top_p: 1,
              max_tokens: maxTokens,
            });
          } else {
            throw e;
          }
        }
        break;
      case "groq":
        // Groq/OpenAI-compatible JSON mode can hard-fail with HTTP 400 if the
        // model emits any invalid JSON (e.g., literal newlines in strings).
        // We intentionally avoid response_format here and repair JSON locally.
        response = await aiService.callGroq(model, user, {
          systemPrompt: system,
          temperature,
          top_p: 1,
          max_tokens: maxTokens,
          retries: 1,
        });
        break;
      case "anthropic":
        response = await aiService.callAnthropic(model, user, {
          systemPrompt: system,
          temperature,
          max_tokens: maxTokens,
        });
        break;
      case "cerebras":
        response = await aiService.callCerebras(model, user, {
          systemPrompt: system,
          temperature,
          max_tokens: maxTokens,
        });
        break;
      default:
        throw new Error(`Unsupported provider for model: ${model}`);
    }

    let parakeet;
    try {
      const parsed = parseJsonFromModel(response?.content);
      parakeet = coerceParakeetShape({ parsed, rawASR: rawForReturn });
    } catch (e) {
      // Do not fail the whole request if the model output is not valid JSON.
      // Return a safe fallback so the UI still gets an answer.
      try {
        const rawText = String(response?.content || "").trim();
        parakeet = buildFallbackParakeetFromText({
          text: rawText,
          rawASR: rawForReturn,
        });
      } catch {
        // If even fallback fails, rethrow original.
        throw e;
      }
    }

    if (persist) {
      try {
        const questionToSave = String(cleaned || question || rawForReturn)
          .trim()
          .slice(0, 5000);
        const answerToSave = String(
          formatParakeetForTranscript({ question: questionToSave, parakeet })
        )
          .trim()
          .slice(0, 20000);

        const sttProvider = String(session?.settings?.sttProvider || "").trim();
        const sttModel = String(session?.settings?.sttModel || "").trim();
        const llmModel = String(response?.model || model || "").trim();

        const lastMsg = Array.isArray(session.messages)
          ? session.messages[session.messages.length - 1]
          : null;
        const lastTwo = Array.isArray(session.messages)
          ? session.messages.slice(-2)
          : [];

        const alreadyHasUser = lastTwo.some(
          (m) =>
            String(m?.role || "") === "user" &&
            String(m?.content || "").trim() === questionToSave
        );
        const alreadyHasAssistant = lastTwo.some(
          (m) =>
            String(m?.role || "") === "assistant" &&
            String(m?.content || "").trim() === answerToSave
        );

        if (questionToSave && !alreadyHasUser) {
          session.addMessage({
            role: "user",
            kind: "qa",
            content: questionToSave,
            tokens: 0,
            meta: {
              ...(sttProvider ? { sttProvider } : {}),
              ...(sttModel ? { sttModel } : {}),
              ...(llmModel ? { llmModel } : {}),
            },
          });
        }

        if (answerToSave && !alreadyHasAssistant) {
          session.addMessage({
            role: "assistant",
            kind: "qa",
            content: answerToSave,
            tokens: 0,
            meta: {
              ...(llmModel ? { llmModel } : {}),
              ...(provider ? { provider } : {}),
            },
          });
        }

        if (
          (questionToSave && !alreadyHasUser) ||
          (answerToSave && !alreadyHasAssistant) ||
          (lastMsg && String(lastMsg?.role || "") === "system")
        ) {
          await session.save();
          try {
            const io = getIO();
            io?.to(`session_${session._id}`).emit("new_message", { ok: true });
          } catch {
            // ignore
          }
        }
      } catch {
        // Don't fail the request if persistence fails.
      }
    }

    // Final compatibility safeguard for older clients/debuggers.
    if (parakeet && typeof parakeet === "object") {
      const explanation = String(parakeet.explanation || "").trim();
      const detailed = String(parakeet.detailed_explanation || "").trim();
      if (!detailed && explanation) parakeet.detailed_explanation = explanation;
    }

    res.set("x-parakeet-build", "session-parakeet-2026-02-14");
    res.status(200).json({
      status: "success",
      cleaned,
      parakeet,
      model: response?.model || model,
      usage: response?.usage,
    });
  } catch (err) {
    const status =
      err?.statusCode ||
      err?.response?.status ||
      parseHttpStatusFromMessage(err?.message) ||
      502;

    const safeStatus =
      Number.isFinite(Number(status)) &&
      Number(status) >= 400 &&
      Number(status) <= 599
        ? Number(status)
        : 502;

    next(
      new AppError(err?.message || "Failed to generate AI answer", safeStatus)
    );
  }
};

const writeSseEvent = (res, { event, data }) => {
  if (event) res.write(`event: ${event}\n`);
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  const lines = String(payload).split(/\r?\n/);
  for (const line of lines) {
    res.write(`data: ${line}\n`);
  }
  res.write("\n");
};

export const aiAnswerStream = async (req, res, next) => {
  const session = await Session.findOne({
    _id: req.params.id,
    user: req.user._id,
  });
  if (!session) return next(new AppError("Session not found", 404));
  try {
    await ensureSessionActive(session);
  } catch (e) {
    return next(e);
  }

  const draft = String(req.body?.draft || "").trim();
  const lastAssistant = [...(session.messages || [])]
    .reverse()
    .find((m) => m.role === "assistant");
  const question = String(
    req.body?.question || lastAssistant?.content || ""
  ).trim();

  const hasAnyProviderKey =
    Boolean(process.env.GROQ_API_KEY) ||
    Boolean(process.env.OPENAI_API_KEY) ||
    Boolean(process.env.ANTHROPIC_API_KEY) ||
    Boolean(process.env.CEREBRAS_API_KEY);

  if (!hasAnyProviderKey) {
    return next(
      new AppError(
        "AI Answer not configured. Set a provider API key (e.g., GROQ_API_KEY or OPENAI_API_KEY).",
        501
      )
    );
  }

  if (!question) {
    return next(new AppError("Question is required", 400));
  }

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const abortController = new AbortController();
  req.on("close", () => {
    abortController.abort();
  });

  try {
    writeSseEvent(res, {
      event: "meta",
      data: { ok: true },
    });

    const startedAt = Date.now();
    let firstTokenAt = null;
    const upstream = {
      provider: null,
      model: null,
      region: null,
      cfRay: null,
      requestId: null,
    };

    const onResponse = ({ provider, model, response }) => {
      upstream.provider = provider || upstream.provider;
      upstream.model = model || upstream.model;

      try {
        upstream.region =
          response?.headers?.get?.("x-groq-region") || upstream.region;
      } catch {
        // ignore
      }

      try {
        upstream.cfRay = response?.headers?.get?.("cf-ray") || upstream.cfRay;
      } catch {
        // ignore
      }

      try {
        upstream.requestId =
          response?.headers?.get?.("x-request-id") || upstream.requestId;
      } catch {
        // ignore
      }

      try {
        // Optional debug info; frontend ignores unknown events.
        writeSseEvent(res, {
          event: "meta",
          data: {
            ok: true,
            upstream: {
              provider: upstream.provider,
              model: upstream.model,
              region: upstream.region,
            },
          },
        });
      } catch {
        // ignore
      }
    };

    let fullText = "";
    for await (const token of aiService.streamAnswer(
      session.toObject(),
      question,
      draft,
      { signal: abortController.signal, onResponse }
    )) {
      if (abortController.signal.aborted) break;
      const value = String(token || "");
      if (!value) continue;

      if (!firstTokenAt) {
        firstTokenAt = Date.now();
        const ttftMs = firstTokenAt - startedAt;
        try {
          writeSseEvent(res, {
            event: "meta",
            data: {
              ok: true,
              timing: { ttftMs },
              upstream: {
                provider: upstream.provider,
                model: upstream.model,
                region: upstream.region,
              },
            },
          });
        } catch {
          // ignore
        }
      }

      fullText += value;
      writeSseEvent(res, {
        event: "token",
        data: { token: value },
      });
    }

    const persist =
      req.body?.persist === true ||
      String(req.body?.persist || "").toLowerCase() === "true";
    if (persist) {
      try {
        await persistQaPair({
          session,
          question,
          answer: normalizeAiAnswerTranscript(fullText),
          sttProvider: req.body?.sttProvider,
          sttModel: req.body?.sttModel,
          llmModel: upstream.model || session?.settings?.aiModel,
          provider: upstream.provider,
        });
      } catch {
        // Don't fail the stream if persistence fails.
      }
    }

    const totalMs = Date.now() - startedAt;

    writeSseEvent(res, {
      event: "done",
      data: {
        ok: true,
        text: fullText,
        timing: {
          ttftMs: firstTokenAt ? firstTokenAt - startedAt : null,
          totalMs,
        },
        upstream: {
          provider: upstream.provider,
          model: upstream.model,
          region: upstream.region,
          cfRay: upstream.cfRay,
          requestId: upstream.requestId,
        },
      },
    });
    res.end();
  } catch (err) {
    try {
      writeSseEvent(res, {
        event: "error",
        data: { ok: false, message: err?.message || "Stream failed" },
      });
    } catch {
      // ignore
    }
    res.end();
  }
};

export const persistTranscriptQa = async (req, res, next) => {
  try {
    const session = await getSessionForUser({
      sessionId: req.params.id,
      userId: req.user?._id,
    });

    const question = String(req.body?.question || "").trim();
    const answer = String(req.body?.answer || "").trim();
    const sttProvider = String(req.body?.sttProvider || "").trim();
    const sttModel = String(req.body?.sttModel || "").trim();
    const llmModel = String(req.body?.llmModel || "").trim();
    const provider = String(req.body?.provider || "").trim();

    if (!question || !answer) {
      return next(new AppError("question and answer are required", 400));
    }

    await persistQaPair({
      session,
      question,
      answer,
      sttProvider,
      sttModel,
      llmModel,
      provider,
    });

    res.status(201).json({ status: "success" });
  } catch (err) {
    next(err);
  }
};

export const analyzeScreen = async (req, res, next) => {
  const session = await Session.findOne({
    _id: req.params.id,
    user: req.user._id,
  });
  if (!session) return next(new AppError("Session not found", 404));
  try {
    await ensureSessionActive(session);
  } catch (e) {
    return next(e);
  }
  if (!req.file || !req.file.buffer) {
    return next(new AppError("Image file is required", 400));
  }

  // For now we only support OpenAI vision-style models if OPENAI_API_KEY is set.
  if (!process.env.OPENAI_API_KEY) {
    return next(
      new AppError(
        "Screen analysis not configured. Set OPENAI_API_KEY to enable vision analysis.",
        501
      )
    );
  }

  try {
    const base64 = req.file.buffer.toString("base64");
    const mimeType = req.file.mimetype || "image/png";
    const dataUrl = `data:${mimeType};base64,${base64}`;

    const prompt =
      `You are analyzing the candidate's shared screen during an interview. ` +
      `Extract any visible question, code, errors, or key UI context. ` +
      `Return a short, actionable summary and, if relevant, a suggested next step.`;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: session.settings?.aiModel?.startsWith("gpt-")
          ? session.settings.aiModel
          : "gpt-4.1-mini",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
        temperature: 0.2,
        max_tokens: 500,
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg =
        data?.error?.message || data?.message || "Screen analysis failed";
      return next(new AppError(msg, 502));
    }

    const analysis = String(data?.choices?.[0]?.message?.content || "").trim();
    if (analysis) {
      session.addMessage({
        role: "assistant",
        content: `Screen Analysis:\n${analysis}`,
        tokens: Number(data?.usage?.total_tokens || 0),
      });
      await session.save();

      try {
        const io = getIO();
        io?.to(`session_${session._id}`).emit("new_message", { ok: true });
      } catch {
        // ignore
      }
    }

    res.status(200).json({ status: "success", analysis });
  } catch (err) {
    next(new AppError(err?.message || "Screen analysis failed", 502));
  }
};

export const transcribeAudio = async (req, res, next) => {
  // Backend STT can be disabled via env to avoid accidental cost.
  // Default: enabled.
  const STT_DISABLED = ["1", "true", "yes", "on"].includes(
    String(process.env.STT_DISABLED || "").toLowerCase()
  );
  if (STT_DISABLED) {
    return next(
      new AppError(
        "Speech-to-text is temporarily disabled on the server (frontend-only mode).",
        503
      )
    );
  }

  const session = await Session.findOne({
    _id: req.params.id,
    user: req.user._id,
  }).select("_id settings job");
  if (!session) return next(new AppError("Session not found", 404));

  if (!req.file || !req.file.buffer) {
    return next(new AppError("Audio file is required", 400));
  }

  try {
    const prompt = String(req.body?.prompt || "").trim();

    const forcedLanguageRaw = String(
      process.env.STT_FORCE_LANGUAGE || ""
    ).trim();
    const forcedLanguage = forcedLanguageRaw ? forcedLanguageRaw : "";
    const sttLanguage = forcedLanguage || session?.settings?.language;

    const providerFromSessionRaw = String(session?.settings?.sttProvider || "")
      .trim()
      .toLowerCase();
    // If session is set to browser-only STT, still allow server transcription
    // (needed for mobile fallback). We treat these as "no provider" so the
    // server can pick from env / configured credentials.
    const providerFromSession =
      providerFromSessionRaw === "webspeech" ||
      providerFromSessionRaw === "elevenlabs_client"
        ? ""
        : providerFromSessionRaw;
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

    if (!provider) {
      return next(
        new AppError(
          "Speech transcription not configured. Choose an STT provider in session settings or set STT_PROVIDER plus credentials.",
          501
        )
      );
    }

    const sessionModelRaw = String(session?.settings?.sttModel || "").trim();
    const envModelRaw = String(process.env.STT_MODEL || "").trim();
    const candidate = sessionModelRaw || envModelRaw;
    const sanitized = sanitizeSttModelForProvider(provider, candidate);

    // If user wants English-only, prefer an English-only Whisper variant on Groq.
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

    const model =
      sanitized ||
      (provider === "groq" && forceEnglish
        ? "distil-whisper-large-v3-en"
        : defaultSttModelForProvider(provider));

    // Provider-specific audio normalization: keep opt-in, but enable for providers
    // that strongly benefit from or require 16kHz mono WAV.
    const normalizeEnv = String(process.env.STT_NORMALIZE_AUDIO || "").trim();
    const shouldNormalize =
      normalizeEnv === "1" ||
      provider === "deepspeech" ||
      provider === "fasterwhisper";

    let uploadBuffer = req.file.buffer;
    let uploadMime = req.file.mimetype || "audio/webm";
    let uploadName = req.file.originalname || `audio-${Date.now()}.webm`;

    if (shouldNormalize) {
      try {
        const wav = await tryConvertToWav16kMono({ buffer: req.file.buffer });
        if (wav && wav.length) {
          uploadBuffer = wav;
          uploadMime = "audio/wav";
          uploadName = `audio-${Date.now()}.wav`;
        }
      } catch (e) {
        if (provider === "deepspeech") {
          return next(
            new AppError(
              "DeepSpeech requires 16kHz mono WAV input. Enable ffmpeg-static or upload WAV.",
              400
            )
          );
        }
        console.warn(
          "STT audio normalization failed; using original:",
          e?.message
        );
      }
    }

    if (provider === "deepspeech" && uploadMime !== "audio/wav") {
      return next(
        new AppError(
          "DeepSpeech requires 16kHz mono WAV input. Enable STT_NORMALIZE_AUDIO=1 (ffmpeg-static) or upload WAV.",
          400
        )
      );
    }

    const controller = new AbortController();
    const timeoutMs = 25000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const call = async ({ buf, mime, name }) =>
      await transcribeAudioBuffer({
        provider,
        model,
        buffer: buf,
        mimetype: mime,
        filename: name,
        prompt,
        language: sttLanguage,
        signal: controller.signal,
      });

    let result;
    try {
      result = await call({
        buf: uploadBuffer,
        mime: uploadMime,
        name: uploadName,
      });
    } catch (e) {
      const msg = String(e?.message || "");
      const looksLikeInvalidMedia =
        /valid media file|could not process file|invalid media/i.test(msg);
      const canRetryWithWav =
        looksLikeInvalidMedia &&
        (provider === "groq" || provider === "openai") &&
        uploadMime !== "audio/wav";

      if (!canRetryWithWav) throw e;

      try {
        const wav = await tryConvertToWav16kMono({ buffer: uploadBuffer });
        if (wav && wav.length) {
          result = await call({
            buf: wav,
            mime: "audio/wav",
            name: `audio-${Date.now()}.wav`,
          });
        } else {
          throw e;
        }
      } catch {
        throw e;
      }
    } finally {
      clearTimeout(timer);
    }

    res.status(200).json({
      status: "success",
      text: await (async () => {
        const raw = String(result?.text || "").trim();
        if (!raw) return "";

        const wantCorrect = ["1", "true", "yes", "on"].includes(
          String(req.body?.correctWithAi || "").toLowerCase()
        );
        const enabled = ["1", "true", "yes", "on"].includes(
          String(process.env.STT_AI_CORRECT_ENABLED || "").toLowerCase()
        );
        if (!wantCorrect || !enabled) return raw;

        try {
          const model =
            String(process.env.STT_AI_CORRECT_MODEL || "").trim() ||
            "llama-3.1-8b";

          // Keep the correction cheap and deterministic.
          const systemPrompt =
            "You correct speech-to-text transcripts for a technical interview. " +
            "Fix misheard technical terms and casing (e.g., Node.js, React, MongoDB, GraphQL, CI/CD, NPM). " +
            "Prefer spellings from the provided vocabulary lists. " +
            "If ambiguous, prefer common software-engineering terms. " +
            "Return ONLY the corrected transcript text. No quotes, no extra lines.";

          const jobTitle = String(session?.job?.title || "").trim();
          const extraVocabRaw = String(
            process.env.STT_AI_CORRECT_VOCAB ||
              process.env.STT_DOMAIN_VOCAB ||
              ""
          ).trim();
          const builtInVocab = getDefaultSttDomainVocabString();
          const vocabMaxChars = (() => {
            const n = Number(
              process.env.STT_AI_CORRECT_VOCAB_MAX_CHARS || 3500
            );
            if (!Number.isFinite(n) || n <= 0) return 3500;
            return Math.max(200, Math.min(15000, Math.floor(n)));
          })();

          const extraVocab = extraVocabRaw
            ? extraVocabRaw.replace(/\s+/g, " ").slice(0, vocabMaxChars)
            : "";
          const builtInTrimmed = builtInVocab
            ? builtInVocab.slice(
                0,
                Math.max(0, vocabMaxChars - extraVocab.length)
              )
            : "";

          const prompt =
            (jobTitle ? `Role: ${jobTitle}\n` : "") +
            "Important vocabulary: JavaScript, TypeScript, HTML, CSS, React, Node.js, Express, MongoDB, REST, GraphQL, AWS, CI/CD, NPM, Git, MERN, full stack, backend, frontend, closure.\n\n" +
            (extraVocab ? `Extra vocabulary: ${extraVocab}\n\n` : "") +
            (builtInTrimmed
              ? `Default vocabulary: ${builtInTrimmed}\n\n`
              : "") +
            `Raw transcript:\n${raw}`;

          const fixed = await aiService.callGroq(model, prompt, {
            systemPrompt,
            temperature: 0,
            max_tokens: 220,
            timeout: 12000,
            retries: 1,
          });

          const out = String(fixed?.content || "").trim();
          return out || raw;
        } catch {
          return raw;
        }
      })(),
      provider: String(result?.provider || provider),
      model: String(result?.model || model),
    });
  } catch (err) {
    const isAbort = String(err?.name || "") === "AbortError";
    const status = Number(err?.statusCode) || (isAbort ? 502 : 502);
    const details = err?.details;
    next(
      new AppError(
        isAbort
          ? "Speech transcription timed out"
          : err?.message || "Speech transcription failed",
        status,
        details
      )
    );
  }
};

export const downloadTranscript = async (req, res, next) => {
  const session = await Session.findOne({
    _id: req.params.id,
    user: req.user._id,
  }).select("messages job createdAt settings");
  if (!session) return next(new AppError("Session not found", 404));

  const lines = [];
  lines.push(
    `Interview: ${session.job?.title || ""} at ${session.job?.company || ""}`
  );
  lines.push(`Created: ${new Date(session.createdAt).toISOString()}`);
  lines.push("---");

  const all = session.messages || [];
  const qa = all.filter((m) => String(m?.kind || "") === "qa");
  const msgsToWrite = qa.length > 0 ? qa : all;

  if (qa.length > 0) {
    for (const msg of msgsToWrite) {
      const ts = msg?.timestamp ? new Date(msg.timestamp).toISOString() : "";
      if (msg.role === "user") {
        lines.push(`[${ts}] QUESTION:`);
        const sttP = String(msg?.meta?.sttProvider || "").trim();
        const sttM = String(msg?.meta?.sttModel || "").trim();
        const llmM = String(msg?.meta?.llmModel || "").trim();
        const parts = [];
        if (sttP || sttM)
          parts.push(`STT: ${[sttP, sttM].filter(Boolean).join("/")}`);
        if (llmM) parts.push(`LLM: ${llmM}`);
        if (parts.length) lines.push(parts.join(" | "));
        lines.push(String(msg.content || ""));
        lines.push("");
        continue;
      }

      if (msg.role === "assistant") {
        lines.push(`[${ts}] ANSWER:`);
        lines.push(String(msg.content || ""));
        lines.push("");
        continue;
      }
    }
  } else {
    // Back-compat: old sessions stored mixed message types.
    for (const msg of msgsToWrite) {
      lines.push(
        `[${new Date(msg.timestamp).toISOString()}] ${msg.role.toUpperCase()}:`
      );
      lines.push(String(msg.content || ""));
      lines.push("");
    }
  }

  const body = lines.join("\n");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="interview-transcript-${session._id}.txt"`
  );
  res.status(200).send(body);
};
