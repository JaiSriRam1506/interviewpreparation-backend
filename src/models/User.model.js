// src/models/User.model.js
import mongoose from "mongoose";
import validator from "validator";
import bcrypt from "bcryptjs";
import crypto from "crypto";

const userSchema = new mongoose.Schema(
  {
    // Basic Info
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      lowercase: true,
      validate: [validator.isEmail, "Please provide a valid email"],
    },
    password: {
      type: String,
      required: [true, "Password is required"],
      minlength: 8,
      select: false,
    },
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
    },
    avatar: {
      type: String,
      default: "default-avatar.png",
    },

    // Role & Permissions
    role: {
      type: String,
      enum: ["user", "premium", "admin"],
      default: "user",
    },
    isEmailVerified: {
      type: Boolean,
      default: false,
    },
    isActive: {
      type: Boolean,
      default: true,
    },

    // Subscription Info
    subscription: {
      plan: {
        type: String,
        enum: ["free", "basic", "premium", "enterprise"],
        default: "free",
      },
      status: {
        type: String,
        enum: ["active", "canceled", "expired"],
        default: "active",
      },
      startDate: Date,
      endDate: Date,
      stripeCustomerId: String,
      stripeSubscriptionId: String,
    },

    // Usage Limits
    usage: {
      sessions: {
        total: { type: Number, default: 0 },
        thisMonth: { type: Number, default: 0 },
        limit: { type: Number, default: 3 },
      },
      tokens: {
        used: { type: Number, default: 0 },
        limit: { type: Number, default: 10000 },
      },
      lastReset: Date,
    },

    // Preferences
    preferences: {
      language: { type: String, default: "english" },
      defaultModel: { type: String, default: "llama-3.1-8b" },
      theme: { type: String, default: "light" },
      notifications: {
        email: { type: Boolean, default: true },
        push: { type: Boolean, default: true },
      },
    },

    // Profile defaults (used to prefill session creation)
    profileDefaults: {
      jobTitle: { type: String, default: "" },
      jobDescription: { type: String, default: "" },
      extraContext: { type: String, default: "" },
      instructions: { type: String, default: "" },
      aiAnswer: {
        detailLevel: {
          type: String,
          enum: ["short", "medium", "deep"],
          default: "medium",
        },
        includeCode: { type: Boolean, default: true },
        includeExtras: { type: Boolean, default: true },
        maxTokens: { type: Number, default: 0 },
        temperature: { type: Number, default: 0 },
      },
      resume: {
        filename: String,
        url: String,
        text: String,
        parsed: Boolean,
        mimetype: String,
        size: Number,
        uploadedAt: Date,
      },
    },

    // Security
    passwordChangedAt: Date,
    passwordResetToken: String,
    passwordResetExpires: Date,
    emailVerificationToken: String,
    emailVerificationExpires: Date,

    // Refresh token fallback (Mongo)
    refreshTokenHash: String,
    refreshTokenExpires: Date,

    // Multiple refresh tokens (Mongo fallback for multi-device login)
    // NOTE: Redis is preferred when available.
    refreshTokens: [
      {
        hash: String,
        expires: Date,
        createdAt: { type: Date, default: Date.now },
      },
    ],

    // Timestamps
    lastLogin: Date,
    createdAt: {
      type: Date,
      default: Date.now,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Indexes
userSchema.index({ "subscription.status": 1 });
userSchema.index({ "subscription.plan": 1 });
userSchema.index({ createdAt: -1 });

// Virtuals
userSchema.virtual("sessions", {
  ref: "Session",
  foreignField: "user",
  localField: "_id",
});

// Pre-save middleware
userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();

  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.pre("save", function (next) {
  if (!this.isModified("password") || this.isNew) return next();
  this.passwordChangedAt = Date.now() - 1000;
  next();
});

// Methods
userSchema.methods.correctPassword = async function (
  candidatePassword,
  userPassword
) {
  return await bcrypt.compare(candidatePassword, userPassword);
};

userSchema.methods.changedPasswordAfter = function (JWTTimestamp) {
  if (this.passwordChangedAt) {
    const changedTimestamp = parseInt(
      this.passwordChangedAt.getTime() / 1000,
      10
    );
    return JWTTimestamp < changedTimestamp;
  }
  return false;
};

userSchema.methods.createPasswordResetToken = function () {
  const resetToken = crypto.randomBytes(32).toString("hex");
  this.passwordResetToken = crypto
    .createHash("sha256")
    .update(resetToken)
    .digest("hex");
  this.passwordResetExpires = Date.now() + 10 * 60 * 1000; // 10 minutes
  return resetToken;
};

userSchema.methods.createEmailVerificationToken = function () {
  const verificationToken = crypto.randomBytes(32).toString("hex");
  this.emailVerificationToken = crypto
    .createHash("sha256")
    .update(verificationToken)
    .digest("hex");
  this.emailVerificationExpires = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
  return verificationToken;
};

userSchema.methods.canCreateSession = function () {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  if (!this.usage?.lastReset || this.usage.lastReset < startOfMonth) {
    this.usage.sessions.thisMonth = 0;
    this.usage.lastReset = now;
  }

  if (this.role === "admin") return true;
  if (this.role === "premium") return true;

  return this.usage.sessions.thisMonth < this.usage.sessions.limit;
};

userSchema.methods.hasEnoughTokens = function (tokens) {
  return this.usage.tokens.used + tokens <= this.usage.tokens.limit;
};

userSchema.methods.applyPlanLimits = function () {
  const plan = this.subscription?.plan || "free";
  const role = this.role;

  if (role === "admin") {
    this.usage.sessions.limit = 999999;
    this.usage.tokens.limit = 999999999;
    return;
  }

  if (plan === "premium" || role === "premium") {
    this.usage.sessions.limit = 999999;
    this.usage.tokens.limit = 500000;
    return;
  }

  if (plan === "basic") {
    this.usage.sessions.limit = 10;
    this.usage.tokens.limit = 100000;
    return;
  }

  // free
  this.usage.sessions.limit = 3;
  this.usage.tokens.limit = 10000;
};

userSchema.pre("save", function (next) {
  if (this.isModified("subscription.plan") || this.isNew) {
    this.applyPlanLimits();
  }
  next();
});

export default mongoose.model("User", userSchema);
