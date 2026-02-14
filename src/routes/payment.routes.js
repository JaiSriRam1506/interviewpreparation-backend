import express from "express";
import { protect } from "../middleware/auth.js";
import { paymentLimiter } from "../middleware/rateLimiter.js";
import { createCheckoutSession } from "../controllers/payment.controller.js";

const router = express.Router();

router.post("/checkout", protect, paymentLimiter, createCheckoutSession);

export default router;
