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
  30, // 30 requests per window for auth (login/signup)
  "Too many login attempts, please try again later."
);

// Refresh-token can be called on page load and on 401 recovery.
// Keep it rate-limited, but not so strict that normal usage locks users out.
export const refreshTokenLimiter = createRateLimiter(
  15 * 60 * 1000, // 15 minutes
  120, // 120 refresh attempts per window
  "Too many refresh attempts, please try again later."
);

export const paymentLimiter = createRateLimiter(
  60 * 60 * 1000, // 1 hour
  10, // 10 payment attempts per hour
  "Too many payment attempts, please try again later."
);
