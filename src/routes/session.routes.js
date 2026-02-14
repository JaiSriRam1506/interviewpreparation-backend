import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import {
  createSession,
  listSessions,
  getSession,
  startSession,
  updateSession,
  updateSessionSettings,
  deleteSession,
  endSession,
  getMessages,
  addMessage,
  aiResponse,
  transcribeAudio,
  aiAnswer,
  aiAnswerParakeet,
  aiAnswerStream,
  analyzeScreen,
  downloadTranscript,
} from "../controllers/session.controller.js";
import { protect } from "../middleware/auth.js";

const router = express.Router();

const uploadDir = path.join(process.cwd(), "src", "uploads");
await fs.promises.mkdir(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${Date.now()}_${safe}`);
  },
});

const allowedExt = new Set([".pdf", ".txt", ".doc", ".docx"]);

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname || "").toLowerCase();
  if (!allowedExt.has(ext)) {
    return cb(new Error("Unsupported file type. Use PDF, DOC, DOCX, or TXT."));
  }
  cb(null, true);
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 },
});

const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok =
      typeof file.mimetype === "string" &&
      (file.mimetype.startsWith("audio/") ||
        file.mimetype === "application/octet-stream");
    if (!ok) return cb(new Error("Unsupported audio type"));
    cb(null, true);
  },
});

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok =
      typeof file.mimetype === "string" && file.mimetype.startsWith("image/");
    if (!ok) return cb(new Error("Unsupported image type"));
    cb(null, true);
  },
});

router.use(protect);

router.get("/", listSessions);
router.post("/", upload.single("resume"), createSession);

router.get("/:id", getSession);
router.patch("/:id", updateSession);
router.delete("/:id", deleteSession);
router.put("/:id", updateSession);
router.post("/:id/start", startSession);
router.patch("/:id/settings", updateSessionSettings);
router.post("/:id/end", endSession);

router.get("/:id/messages", getMessages);
router.post("/:id/messages", addMessage);
router.post("/:id/ai-response", aiResponse);

router.post("/:id/ai-answer/stream", aiAnswerStream);
router.post("/:id/ai-answer", aiAnswer);
router.post("/:id/ai-answer/parakeet", aiAnswerParakeet);
router.post("/:id/analyze-screen", imageUpload.single("image"), analyzeScreen);

router.post("/:id/transcribe", audioUpload.single("audio"), transcribeAudio);

router.get("/:id/transcript", downloadTranscript);

export default router;
