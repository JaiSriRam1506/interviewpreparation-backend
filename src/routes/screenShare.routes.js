import express from "express";
import Joi from "joi";
import { protect } from "../middleware/auth.js";
import { validate } from "../middleware/validation.js";
import {
  createSession,
  joinSession,
  getSession,
  endSession,
  listMyActiveSessions,
} from "../controllers/screenShare.controller.js";

const router = express.Router();

router.use(protect);

const joinSchema = Joi.object({
  sessionId: Joi.string().alphanum().min(6).max(32).required(),
});

router.get("/my-sessions", listMyActiveSessions);

router.post("/create-session", createSession);
router.post("/join-session", validate(joinSchema), joinSession);

router.get("/session/:sessionId", getSession);
router.delete("/session/:sessionId", endSession);

export default router;
