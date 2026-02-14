// src/middleware/rateLimiter.js
import rateLimit from "express-rate-limit";

const isRateLimitDisabled = () =>
  process.env.NODE_ENV !== "production" ||
  ["1", "true", "yes", "on"].includes(
    String(process.env.DISABLE_RATE_LIMIT || "").toLowerCase()
  );

const createRateLimiter = (windowMs, max, message) => {
  if (isRateLimitDisabled()) {
    return (req, res, next) => next();
  }

  return rateLimit({
    windowMs,
    max,
    message: {
      status: "error",
      message,
    },
    standardHeaders: true,
    legacyHeaders: false,
  });
};

export const apiLimiter = createRateLimiter(
  15 * 60 * 1000, // 15 minutes
  100, // 100 requests per window
  "Too many requests from this IP, please try again later."
);

export const authLimiter = createRateLimiter(
  15 * 60 * 1000, // 15 minutes
  5, // 5 requests per window for auth
  "Too many login attempts, please try again later."
);

export const paymentLimiter = createRateLimiter(
  60 * 60 * 1000, // 1 hour
  10, // 10 payment attempts per hour
  "Too many payment attempts, please try again later."
);
