import express from "express";
import { protect } from "../middleware/auth.js";
import { getElevenLabsSingleUseScribeToken } from "../controllers/stt.controller.js";

const router = express.Router();

// Client-side ElevenLabs realtime requires a short-lived single-use token.
router.get("/elevenlabs/token", protect, getElevenLabsSingleUseScribeToken);

export default router;
