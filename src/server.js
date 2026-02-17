// src/server.js
import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import mongoSanitize from "express-mongo-sanitize";
import xss from "xss-clean";
import hpp from "hpp";
import path from "path";
import { fileURLToPath } from "url";
import { createServer } from "http";
import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import WebSocket from "ws";
import winston from "winston";
import cookieParser from "cookie-parser";
import fs from "fs";

// Import routes
import authRoutes from "./routes/auth.routes.js";
import userRoutes from "./routes/user.routes.js";
import sessionRoutes from "./routes/session.routes.js";
import aiRoutes from "./routes/ai.routes.js";
import paymentRoutes from "./routes/payment.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import { setIO } from "./socket.js";
import Session from "./models/Session.model.js";
import scrapeRoutes from "./routes/scrape.routes.js";
import dashboardRoutes from "./routes/dashboard.routes.js";
import sttRoutes from "./routes/stt.routes.js";

// Import middleware
import errorHandler from "./middleware/errorHandler.js";
import requestLogger from "./middleware/requestLogger.js";
import { connectRedis, redisClient } from "./config/redis.js";
import { attachWsSttGateway } from "./wsSttGateway.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Express
const app = express();
const httpServer = createServer(app);

// Render (and most cloud hosts) run Node behind a reverse proxy that sets
// `X-Forwarded-For`. express-rate-limit validates this and will throw if
// `trust proxy` is not enabled.
// Use TRUST_PROXY=1 (default in production) to trust the first proxy hop.
try {
  const isProduction = process.env.NODE_ENV === "production";
  const trustProxy = String(
    process.env.TRUST_PROXY || (isProduction ? "1" : "0")
  )
    .trim()
    .toLowerCase();

  if (["1", "true", "yes", "on"].includes(trustProxy)) {
    app.set("trust proxy", 1);
  } else if (trustProxy && trustProxy !== "0" && trustProxy !== "false") {
    // Allow advanced express formats like "loopback" or a subnet.
    app.set("trust proxy", trustProxy);
  }
} catch {
  // ignore
}

const buildCorsOriginChecker = () => {
  const isProduction = process.env.NODE_ENV === "production";

  const normalizeConfiguredOrigin = (value) => {
    const raw = String(value || "").trim();
    if (!raw || raw === "*") return "";

    // Allow pattern-style entries like "*.vercel.app" or "https://*.vercel.app".
    // For non-URL inputs, assume https for public domains and http for localhost.
    if (!raw.includes("://")) {
      const hostish = raw.replace(/^\.+/, "");
      const isLocal =
        hostish.startsWith("localhost") ||
        hostish.startsWith("127.0.0.1") ||
        hostish.startsWith("::1");
      const scheme = isLocal ? "http://" : "https://";
      return `${scheme}${raw}`;
    }

    try {
      // If a full URL is provided, normalize to the origin (strip path/query).
      const u = new URL(raw);
      return u.origin;
    } catch {
      return raw;
    }
  };

  const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const wildcardToRegExp = (pattern) => {
    const normalized = normalizeConfiguredOrigin(pattern);
    if (!normalized) return null;

    // Only support http(s) origin patterns.
    const lower = normalized.toLowerCase();
    if (!(lower.startsWith("http://") || lower.startsWith("https://")))
      return null;

    // Convert '*' wildcards to a safe regex that matches within an origin string.
    const parts = String(normalized).split("*").map(escapeRegExp);
    const rx = `^${parts.join(".*")}$`;
    try {
      return new RegExp(rx, "i");
    } catch {
      return null;
    }
  };

  const isAllowedDevOrigin = (origin) => {
    try {
      const url = new URL(origin);
      const hostname = url.hostname;

      const isLocalhost =
        hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        hostname === "::1";

      if (
        (url.protocol === "http:" || url.protocol === "https:") &&
        isLocalhost
      ) {
        return true;
      }

      // Allow common ngrok hostnames in dev so mobile testing works without
      // updating env vars on every new tunnel.
      const ngrokSuffixes = [
        ".ngrok-free.app",
        ".ngrok-free.dev",
        ".ngrok.app",
        ".ngrok.dev",
        ".ngrok.io",
      ];

      const isNgrokHost = ngrokSuffixes.some((suffix) =>
        hostname.toLowerCase().endsWith(suffix)
      );

      if (
        (url.protocol === "http:" || url.protocol === "https:") &&
        isNgrokHost
      ) {
        return true;
      }
    } catch {
      // ignore parse errors
    }
    return false;
  };

  const configuredOrigins = [
    process.env.FRONTEND_URL,
    process.env.CORS_ORIGINS,
    "http://localhost:5173",
    "http://localhost:5174",
  ]
    .filter(Boolean)
    .flatMap((value) => String(value).split(","))
    .map((value) => value.trim())
    .filter((value) => value && value !== "*");

  const exactOrigins = new Set();
  const wildcardOrigins = [];

  for (const raw of configuredOrigins) {
    const normalized = normalizeConfiguredOrigin(raw);
    if (!normalized) continue;

    if (String(normalized).includes("*")) {
      const rx = wildcardToRegExp(normalized);
      if (rx) wildcardOrigins.push(rx);
      continue;
    }

    exactOrigins.add(normalized);
  }

  return (origin, callback) => {
    if (!origin) return callback(null, true);

    let normalizedOrigin = origin;
    try {
      const u = new URL(origin);
      if (!(u.protocol === "http:" || u.protocol === "https:")) {
        return callback(new Error(`CORS blocked for origin: ${origin}`));
      }
      normalizedOrigin = u.origin;
    } catch {
      // If origin isn't a valid URL, block it.
      return callback(new Error(`CORS blocked for origin: ${origin}`));
    }

    if (exactOrigins.has(normalizedOrigin)) return callback(null, true);

    for (const rx of wildcardOrigins) {
      if (rx.test(normalizedOrigin)) return callback(null, true);
    }

    if (!isProduction && isAllowedDevOrigin(origin)) {
      return callback(null, true);
    }

    return callback(new Error(`CORS blocked for origin: ${origin}`));
  };
};

const corsOrigin = buildCorsOriginChecker();

const io = new Server(httpServer, {
  cors: {
    origin: corsOrigin,
    credentials: true,
  },
});

setIO(io);

io.use((socket, next) => {
  try {
    const token = socket.handshake?.auth?.token;
    if (!token) return next();
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    socket.data.userId = decoded?.id;
    return next();
  } catch {
    // Allow connection but treat as unauthenticated for privileged events.
    return next();
  }
});

// Redis client
await connectRedis();

await fs.promises.mkdir("logs", { recursive: true });

// Winston logger
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: "logs/error.log", level: "error" }),
    new winston.transports.File({ filename: "logs/combined.log" }),
    new winston.transports.Console({
      format: winston.format.simple(),
    }),
  ],
});

// Security middleware
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
      },
    },
  })
);

// CORS (must run early so preflights + errors include CORS headers)
const corsOptions = {
  origin: corsOrigin,
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// Rate limiting
const rateLimitDisabled =
  process.env.NODE_ENV !== "production" ||
  ["1", "true", "yes", "on"].includes(
    String(process.env.DISABLE_RATE_LIMIT || "").toLowerCase()
  );

if (!rateLimitDisabled) {
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    message: "Too many requests from this IP, please try again later.",
  });
  app.use("/api", limiter);
}

// Body parser
app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: true, limit: "10kb" }));
app.use(cookieParser());

// Data sanitization
app.use(mongoSanitize());
app.use(xss());
app.use(hpp());

// Compression
app.use(compression());

// Request logging
app.use(requestLogger(logger));

// Static files
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Routes
app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/users", userRoutes);
app.use("/api/v1/dashboard", dashboardRoutes);
app.use("/api/v1/sessions", sessionRoutes);
app.use("/api/v1/ai", aiRoutes);
app.use("/api/v1/scrape", scrapeRoutes);
app.use("/api/v1/payments", paymentRoutes);
app.use("/api/v1/admin", adminRoutes);
app.use("/api/v1/stt", sttRoutes);

// Health check
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "success",
    message: "Parakeet AI API is running",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Health check (API namespace) - useful when frontend uses /api/v1 via proxy/ngrok.
app.get("/api/v1/health", (req, res) => {
  res.status(200).json({
    status: "success",
    message: "Parakeet AI API is running",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// 404 handler
app.all("*", (req, res) => {
  res.status(404).json({
    status: "error",
    message: `Can't find ${req.originalUrl} on this server!`,
  });
});

// Error handler
app.use(errorHandler);

// Socket.io
io.on("connection", (socket) => {
  console.log("New client connected:", socket.id);

  // Backend realtime STT is opt-in to avoid accidental cost.
  const ENABLE_ASSEMBLYAI_REALTIME = ["1", "true", "yes", "on"].includes(
    String(process.env.ENABLE_ASSEMBLYAI_REALTIME || "").toLowerCase()
  );
  const STT_DISABLED = !ENABLE_ASSEMBLYAI_REALTIME;

  const sttState = {
    provider: null,
    sessionId: null,
    ws: null,
    opened: false,
  };

  const cleanupStt = () => {
    try {
      if (sttState.ws) {
        sttState.ws.close();
      }
    } catch {
      // ignore
    }
    sttState.provider = null;
    sttState.sessionId = null;
    sttState.ws = null;
    sttState.opened = false;
  };

  socket.on("stt_start", async (payload, cb) => {
    try {
      if (STT_DISABLED) {
        cb?.({
          ok: false,
          status: 503,
          message:
            "Realtime STT is disabled on the server. Set ENABLE_ASSEMBLYAI_REALTIME=1 to enable.",
        });
        cleanupStt();
        return;
      }

      const provider = String(payload?.provider || "")
        .trim()
        .toLowerCase();
      const sessionId = String(payload?.sessionId || "").trim();
      const sampleRate = Number(payload?.sampleRate || 16000);
      const wordBoostRaw = payload?.wordBoost;
      const boostParamRaw = payload?.boostParam;
      const modelIdRaw = payload?.modelId || payload?.model;
      const audioFormatRaw = payload?.audioFormat;
      const commitStrategyRaw = payload?.commitStrategy;

      const wordBoost = Array.isArray(wordBoostRaw)
        ? wordBoostRaw
            .map((w) => String(w || "").trim())
            .filter(Boolean)
            .slice(0, 60)
        : [];
      const boostParam = String(boostParamRaw || "")
        .trim()
        .toLowerCase();

      const modelId = String(modelIdRaw || "")
        .trim()
        .toLowerCase();
      const audioFormat = String(audioFormatRaw || "")
        .trim()
        .toLowerCase();
      const commitStrategy = String(commitStrategyRaw || "")
        .trim()
        .toLowerCase();

      if (!socket.data?.userId) {
        cb?.({ ok: false, status: 401, message: "Not authenticated" });
        return;
      }

      if (!provider || provider !== "assemblyai") {
        cb?.({ ok: false, status: 400, message: "Unsupported STT provider" });
        return;
      }

      if (!sessionId) {
        cb?.({ ok: false, status: 400, message: "Missing sessionId" });
        return;
      }

      if (provider === "assemblyai" && !ENABLE_ASSEMBLYAI_REALTIME) {
        cb?.({
          ok: false,
          status: 503,
          message:
            "AssemblyAI realtime is disabled on the server. Set ENABLE_ASSEMBLYAI_REALTIME=1 to enable.",
        });
        return;
      }

      // Only allow one active realtime session per socket.
      cleanupStt();

      if (provider === "assemblyai") {
        const apiKey = process.env.ASSEMBLYAI_API_KEY;
        if (!apiKey) {
          cb?.({
            ok: false,
            status: 501,
            message: "Missing ASSEMBLYAI_API_KEY",
          });
          cleanupStt();
          return;
        }

        sttState.provider = provider;
        sttState.sessionId = sessionId;

        const assemblyHost = String(
          process.env.ASSEMBLYAI_REALTIME_HOST || "api.assemblyai.com"
        )
          .trim()
          .replace(/^wss?:\/\//i, "")
          .replace(/\/$/, "");

        const url = `wss://${assemblyHost}/v2/realtime/ws?sample_rate=${encodeURIComponent(
          String(Number.isFinite(sampleRate) ? sampleRate : 16000)
        )}`;

        const ws = new WebSocket(url, {
          headers: {
            Authorization: apiKey,
          },
        });
        sttState.ws = ws;

        ws.on("open", () => {
          // Optional config message. Keep it lightweight for latency.
          try {
            const cfg = {
              // Accuracy helpers
              word_boost: wordBoost.length ? wordBoost : undefined,
              boost_param:
                boostParam === "high" ||
                boostParam === "medium" ||
                boostParam === "low"
                  ? boostParam
                  : "high",

              // Latency killers (keep off)
              speaker_labels: false,
              disfluencies: false,
              profanity_filter: false,
              redact_pii: false,
            };

            // Remove undefined keys to avoid confusing upstream.
            Object.keys(cfg).forEach(
              (k) => cfg[k] === undefined && delete cfg[k]
            );
            ws.send(JSON.stringify(cfg));
          } catch {
            // ignore
          }
          sttState.opened = true;
          cb?.({ ok: true });
        });

        ws.on("message", (data) => {
          try {
            const msg = JSON.parse(data.toString("utf8"));
            const type = String(msg?.message_type || msg?.type || "")
              .trim()
              .toLowerCase();

            const text = String(msg?.text || msg?.transcript || "").trim();
            if (!text) return;

            const isFinal =
              type.includes("final") ||
              type === "finaltranscript" ||
              type === "final_transcript" ||
              msg?.is_final === true;

            socket.emit("stt_transcript", {
              provider: "assemblyai",
              sessionId: sttState.sessionId,
              text,
              isFinal,
            });

            // Cross-device sync: mirror transcripts to other devices in the same session.
            try {
              if (sttState.sessionId) {
                socket
                  .to(`session_${sttState.sessionId}`)
                  .emit("transcript_append", {
                    sessionId: sttState.sessionId,
                    text,
                    source: "mic",
                    isFinal,
                    ts: Date.now(),
                  });
              }
            } catch {
              // ignore
            }
          } catch {
            // ignore parse errors
          }
        });

        ws.on("close", () => {
          cleanupStt();
        });

        ws.on("error", (err) => {
          socket.emit("stt_error", {
            provider: "assemblyai",
            sessionId: sttState.sessionId,
            message: String(err?.message || "AssemblyAI realtime error"),
          });
          cleanupStt();
        });

        return;
      }
    } catch (e) {
      cb?.({
        ok: false,
        status: 500,
        message: String(e?.message || "STT start failed"),
      });
      cleanupStt();
    }
  });

  socket.on("stt_audio", (payload, maybeAudio) => {
    if (STT_DISABLED) return;
    try {
      if (!sttState.ws || !sttState.opened) return;
      const sessionId =
        typeof payload === "string" || typeof payload === "number"
          ? String(payload).trim()
          : String(payload?.sessionId || "").trim();
      if (!sessionId || sessionId !== sttState.sessionId) return;

      const audio =
        typeof payload === "string" || typeof payload === "number"
          ? maybeAudio
          : payload?.audio;
      if (!audio) return;

      // socket.io sends binary as Buffer in Node.
      const buf = Buffer.isBuffer(audio)
        ? audio
        : audio instanceof ArrayBuffer
          ? Buffer.from(audio)
          : ArrayBuffer.isView(audio)
            ? Buffer.from(audio.buffer)
            : null;
      if (!buf || !buf.length) return;

      // AssemblyAI realtime expects raw 16-bit PCM (little endian).
      sttState.ws.send(buf);
    } catch {
      // ignore
    }
  });

  socket.on("stt_stop", (payload, cb) => {
    try {
      if (STT_DISABLED) {
        cleanupStt();
        cb?.({ ok: true });
        return;
      }

      const sessionId = String(payload?.sessionId || "").trim();
      if (sessionId && sttState.sessionId && sessionId !== sttState.sessionId) {
        cb?.({ ok: true });
        return;
      }
      cleanupStt();
      cb?.({ ok: true });
    } catch {
      cleanupStt();
      cb?.({ ok: true });
    }
  });

  socket.on("join_session", (sessionId) => {
    (async () => {
      try {
        if (!socket.data?.userId) return;
        const id = String(sessionId || "").trim();
        if (!id) return;
        const session = await Session.findOne({
          _id: id,
          user: socket.data.userId,
        })
          .select("_id")
          .lean();
        if (!session) return;
        socket.join(`session_${id}`);
      } catch {
        // ignore
      }
    })();
  });

  socket.on("send_message", async (data) => {
    const { sessionId, message } = data;
    try {
      if (!socket.data?.userId) return;
      const id = String(sessionId || "").trim();
      if (!id) return;
      const session = await Session.findOne({
        _id: id,
        user: socket.data.userId,
      })
        .select("_id")
        .lean();
      if (!session) return;
      io.to(`session_${id}`).emit("new_message", message);
    } catch {
      // ignore
    }
  });

  // Lightweight cross-device transcript streaming (not persisted).
  socket.on("transcript_append", async (payload) => {
    try {
      if (!socket.data?.userId) return;
      const sessionId = String(payload?.sessionId || "").trim();
      if (!sessionId) return;
      const text = String(payload?.text || "").trim();
      if (!text) return;
      const source = String(payload?.source || "mic");
      const isFinal = Boolean(payload?.isFinal);
      const ts = Number.isFinite(Number(payload?.ts))
        ? Number(payload.ts)
        : Date.now();

      const session = await Session.findOne({
        _id: sessionId,
        user: socket.data.userId,
      })
        .select("_id")
        .lean();
      if (!session) return;

      socket.to(`session_${sessionId}`).emit("transcript_append", {
        sessionId,
        text,
        source,
        isFinal,
        ts,
      });
    } catch {
      // ignore
    }
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
    cleanupStt();
  });
});

// Raw WebSocket endpoint for low-latency PCM streaming (AudioWorklet client)
// Path: /api/v1/stt/stream?token=JWT
attachWsSttGateway({ httpServer });

// Connect to MongoDB
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    logger.info("MongoDB connected successfully");

    // If an older deployment created a TTL index on `expiresAt`, Mongo will
    // auto-delete session documents (and transcripts) once expired.
    // Users expect sessions to remain until they explicitly delete them.
    try {
      const indexes = await Session.collection.indexes();
      const ttlIndexes = (indexes || []).filter(
        (idx) =>
          idx?.key &&
          idx.key.expiresAt === 1 &&
          Object.prototype.hasOwnProperty.call(idx, "expireAfterSeconds")
      );

      for (const idx of ttlIndexes) {
        const name = String(idx?.name || "").trim();
        if (!name) continue;
        await Session.collection.dropIndex(name);
        logger.info(`Dropped TTL index on sessions.expiresAt: ${name}`);
      }
    } catch {
      // ignore (insufficient privileges / not found / etc.)
    }
  } catch (error) {
    logger.error("MongoDB connection failed:", error);
    process.exit(1);
  }
};

// Start server
const startServer = async () => {
  await connectDB();

  const PORT = process.env.PORT || 5000;
  httpServer.listen(PORT, () => {
    logger.info(
      `Server running in ${process.env.NODE_ENV} mode on port ${PORT}`
    );
  });
};

// Handle unhandled rejections
process.on("unhandledRejection", (err) => {
  logger.error("UNHANDLED REJECTION! 💥 Shutting down...", err);
  process.exit(1);
});

// Handle uncaught exceptions
process.on("uncaughtException", (err) => {
  logger.error("UNCAUGHT EXCEPTION! 💥 Shutting down...", err);
  process.exit(1);
});

startServer();
