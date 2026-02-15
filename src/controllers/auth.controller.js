// src/controllers/auth.controller.js
import crypto from "crypto";
import jwt from "jsonwebtoken";
import User from "../models/User.model.js";
import { sendEmail } from "../services/email.service.js";
import { redisClient } from "../config/redis.js";
import { parseExpiryToSeconds } from "../utils/time.js";
import { isRedisReady } from "../config/redis.js";

const signToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_ACCESS_EXPIRY,
  });
};

const hashToken = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");

const newTokenId = () => {
  try {
    return crypto.randomUUID();
  } catch {
    return crypto.randomBytes(16).toString("hex");
  }
};

const cookieOptionsForRequest = (req, refreshTtlSeconds) => {
  const expires = new Date(Date.now() + refreshTtlSeconds * 1000);

  const origin = req?.headers?.origin;
  if (!origin) {
    return {
      expires,
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
    };
  }

  try {
    // Compare "site" (scheme + hostname) instead of full origin (ports differ in dev).
    const originUrl = new URL(origin);
    const originSite = `${originUrl.protocol}//${originUrl.hostname}`;
    const backendSite = `${req.protocol}://${req.hostname}`;
    const isCrossSite = originSite !== backendSite;

    // Cross-site cookies only work over HTTPS and must be SameSite=None; Secure.
    const isHttpsOrigin = originUrl.protocol === "https:";
    const sameSite = isCrossSite && isHttpsOrigin ? "none" : "lax";
    const secure =
      sameSite === "none" ? true : process.env.NODE_ENV === "production";

    return { expires, httpOnly: true, secure, sameSite };
  } catch {
    return {
      expires,
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
    };
  }
};

const createSendToken = async (user, statusCode, req, res) => {
  const accessToken = signToken(user._id);

  const refreshTtlSeconds = parseExpiryToSeconds(
    process.env.JWT_REFRESH_EXPIRY,
    7 * 24 * 60 * 60
  );

  const tokenId = newTokenId();
  const refreshToken = jwt.sign(
    { id: user._id, jti: tokenId },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRY }
  );

  // Persist refresh token: Redis (if available) + Mongo fallback (hashed)
  if (isRedisReady()) {
    await redisClient.setEx(
      `refresh_token:${user._id}:${tokenId}`,
      refreshTtlSeconds,
      refreshToken
    );
  }

  const expiresAt = new Date(Date.now() + refreshTtlSeconds * 1000);
  const hashed = hashToken(refreshToken);

  // Legacy single-token fields (backward compatible)
  user.refreshTokenHash = hashed;
  user.refreshTokenExpires = expiresAt;

  // Multi-device fallback
  if (!Array.isArray(user.refreshTokens)) user.refreshTokens = [];
  const now = Date.now();
  user.refreshTokens = user.refreshTokens
    .filter((t) => t && t.expires && new Date(t.expires).getTime() > now)
    .slice(-9);
  user.refreshTokens.push({ hash: hashed, expires: expiresAt });

  await user.save({ validateBeforeSave: false });

  // Remove password from output
  user.password = undefined;

  const cookieOptions = cookieOptionsForRequest(req, refreshTtlSeconds);
  res.cookie("refreshToken", refreshToken, cookieOptions);

  res.status(statusCode).json({
    status: "success",
    accessToken,
    refreshToken,
    data: {
      user,
    },
  });
};

export const signup = async (req, res, next) => {
  try {
    const { email, password, name } = req.body;

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({
        status: "error",
        message: "User already exists with this email",
      });
    }

    const newUser = await User.create({
      email,
      password,
      name,
      role: "user",
      subscription: {
        plan: "free",
        status: "active",
      },
    });

    // Generate email verification token
    const verificationToken = newUser.createEmailVerificationToken();
    await newUser.save({ validateBeforeSave: false });

    const verificationUrl = `${process.env.FRONTEND_URL}/verify-email/${verificationToken}`;

    await sendEmail({
      email: newUser.email,
      subject: "Verify your email - Parakeet AI",
      template: "email-verification",
      data: {
        name: newUser.name,
        verificationUrl,
      },
    });

    await createSendToken(newUser, 201, req, res);
  } catch (error) {
    next(error);
  }
};

export const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        status: "error",
        message: "Please provide email and password",
      });
    }

    const user = await User.findOne({ email }).select("+password");

    if (!user || !(await user.correctPassword(password, user.password))) {
      return res.status(401).json({
        status: "error",
        message: "Incorrect email or password",
      });
    }

    if (!user.isActive) {
      return res.status(401).json({
        status: "error",
        message: "Your account has been deactivated",
      });
    }

    user.lastLogin = new Date();
    await user.save({ validateBeforeSave: false });

    await createSendToken(user, 200, req, res);
  } catch (error) {
    next(error);
  }
};

export const logout = async (req, res) => {
  try {
    const cookieToken = req.cookies?.refreshToken;
    const bodyToken = req.body?.refreshToken;
    const headerToken =
      req.headers["x-refresh-token"] || req.headers["x-refreshtoken"];
    const refreshToken =
      cookieToken ||
      (typeof bodyToken === "string" ? bodyToken : null) ||
      (typeof headerToken === "string" ? headerToken : null);
    let decoded;
    if (refreshToken) {
      try {
        decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
      } catch {
        decoded = null;
      }
    }

    // Revoke only the current device's refresh token when possible.
    if (isRedisReady() && decoded?.id) {
      if (decoded?.jti) {
        await redisClient.del(`refresh_token:${decoded.id}:${decoded.jti}`);
      } else {
        // Legacy key
        await redisClient.del(`refresh_token:${decoded.id}`);
      }
    }

    if (decoded?.id) {
      const user = await User.findById(decoded.id);
      if (user) {
        const hashed = refreshToken ? hashToken(refreshToken) : null;

        if (hashed && Array.isArray(user.refreshTokens)) {
          user.refreshTokens = user.refreshTokens.filter(
            (t) => t?.hash !== hashed
          );
        }

        // If the legacy fields match this token, clear them.
        if (hashed && user.refreshTokenHash === hashed) {
          user.refreshTokenHash = undefined;
          user.refreshTokenExpires = undefined;
        }

        await user.save({ validateBeforeSave: false });
      }
    }

    // Clear cookie (use same attributes so browser removes it reliably)
    const logoutCookieOptions = cookieOptionsForRequest(req, 1);
    res.cookie("refreshToken", "loggedout", logoutCookieOptions);

    res.status(200).json({
      status: "success",
      message: "Logged out successfully",
    });
  } catch {
    res.status(500).json({
      status: "error",
      message: "Error logging out",
    });
  }
};

export const refreshToken = async (req, res, next) => {
  try {
    const cookieToken = req.cookies?.refreshToken;
    const bodyToken = req.body?.refreshToken;
    const headerToken =
      req.headers["x-refresh-token"] || req.headers["x-refreshtoken"];
    const refreshToken =
      cookieToken ||
      (typeof bodyToken === "string" ? bodyToken : null) ||
      (typeof headerToken === "string" ? headerToken : null);

    if (!refreshToken) {
      return res.status(401).json({
        status: "error",
        message: "No refresh token provided",
      });
    }

    let decoded;
    try {
      decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    } catch {
      return res.status(401).json({
        status: "error",
        message: "Invalid refresh token",
      });
    }

    const currentUser = await User.findById(decoded.id);
    if (!currentUser) {
      return res.status(401).json({
        status: "error",
        message: "User no longer exists",
      });
    }

    if (currentUser.changedPasswordAfter(decoded.iat)) {
      return res.status(401).json({
        status: "error",
        message: "User recently changed password. Please login again.",
      });
    }

    if (isRedisReady()) {
      if (decoded?.jti) {
        const storedToken = await redisClient.get(
          `refresh_token:${decoded.id}:${decoded.jti}`
        );
        if (!storedToken || storedToken !== refreshToken) {
          return res.status(401).json({
            status: "error",
            message: "Refresh token has been revoked",
          });
        }
      } else {
        // Legacy single-token storage
        const storedToken = await redisClient.get(
          `refresh_token:${decoded.id}`
        );
        if (!storedToken || storedToken !== refreshToken) {
          return res.status(401).json({
            status: "error",
            message: "Refresh token has been revoked",
          });
        }
      }
    } else {
      const hashed = hashToken(refreshToken);

      // Prefer multi-token list if available
      const list = Array.isArray(currentUser.refreshTokens)
        ? currentUser.refreshTokens
        : [];
      const now = Date.now();

      const hasValidListToken = list.some(
        (t) =>
          t &&
          t.hash === hashed &&
          t.expires &&
          new Date(t.expires).getTime() > now
      );

      if (!hasValidListToken) {
        // Legacy fallback
        const storedHash = currentUser.refreshTokenHash;
        const exp = currentUser.refreshTokenExpires;
        if (!storedHash || !exp || exp.getTime() < now) {
          return res.status(401).json({
            status: "error",
            message: "Refresh token expired. Please login again.",
          });
        }
        if (hashed !== storedHash) {
          return res.status(401).json({
            status: "error",
            message: "Refresh token has been revoked",
          });
        }
      }
    }

    const accessToken = signToken(currentUser._id);

    res.status(200).json({
      status: "success",
      accessToken,
      data: {
        user: currentUser,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({
        status: "error",
        message: "No user found with that email address",
      });
    }

    const resetToken = user.createPasswordResetToken();
    await user.save({ validateBeforeSave: false });

    const resetURL = `${process.env.FRONTEND_URL}/reset-password/${resetToken}`;

    await sendEmail({
      email: user.email,
      subject: "Reset your password (valid for 10 minutes)",
      template: "password-reset",
      data: {
        name: user.name,
        resetURL,
      },
    });

    res.status(200).json({
      status: "success",
      message: "Password reset token sent to email",
    });
  } catch (error) {
    next(error);
  }
};

export const resetPassword = async (req, res, next) => {
  try {
    const { token } = req.params;
    const { password } = req.body;

    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

    const user = await User.findOne({
      passwordResetToken: hashedToken,
      passwordResetExpires: { $gt: Date.now() },
    });

    if (!user) {
      return res.status(400).json({
        status: "error",
        message: "Token is invalid or has expired",
      });
    }

    user.password = password;
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save();

    await createSendToken(user, 200, req, res);
  } catch (error) {
    next(error);
  }
};

export const verifyEmail = async (req, res, next) => {
  try {
    const { token } = req.params;

    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

    const user = await User.findOne({
      emailVerificationToken: hashedToken,
      emailVerificationExpires: { $gt: Date.now() },
    });

    if (!user) {
      return res.status(400).json({
        status: "error",
        message: "Verification token is invalid or has expired",
      });
    }

    user.isEmailVerified = true;
    user.emailVerificationToken = undefined;
    user.emailVerificationExpires = undefined;
    await user.save();

    res.status(200).json({
      status: "success",
      message: "Email verified successfully",
    });
  } catch (error) {
    next(error);
  }
};

export const changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = await User.findById(req.user.id).select("+password");

    if (!(await user.correctPassword(currentPassword, user.password))) {
      return res.status(401).json({
        status: "error",
        message: "Your current password is wrong",
      });
    }

    user.password = newPassword;
    await user.save();

    await createSendToken(user, 200, req, res);
  } catch (error) {
    next(error);
  }
};

export const getMe = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);

    res.status(200).json({
      status: "success",
      data: {
        user,
      },
    });
  } catch (error) {
    next(error);
  }
};
