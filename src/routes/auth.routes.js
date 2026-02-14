import express from "express";
import {
  signup,
  login,
  logout,
  refreshToken,
  forgotPassword,
  resetPassword,
  verifyEmail,
  changePassword,
  getMe,
} from "../controllers/auth.controller.js";
import { validate, authSchemas } from "../middleware/validation.js";
import { authLimiter } from "../middleware/rateLimiter.js";
import { protect } from "../middleware/auth.js";

const router = express.Router();

router.post("/signup", authLimiter, validate(authSchemas.register), signup);
router.post("/login", authLimiter, validate(authSchemas.login), login);
router.post("/refresh-token", refreshToken);

router.post("/forgot-password", forgotPassword);
router.patch(
  "/reset-password/:token",
  validate(authSchemas.resetPassword),
  resetPassword
);
router.get("/verify-email/:token", verifyEmail);

router.post("/logout", protect, logout);
router.get("/me", protect, getMe);
router.patch("/change-password", protect, changePassword);

export default router;
