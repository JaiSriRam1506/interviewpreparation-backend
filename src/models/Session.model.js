// src/models/Session.model.js
import mongoose from "mongoose";

const sessionSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // Job Details
    job: {
      title: String,
      company: String,
      description: String,
      url: String,
      location: String,
      salary: String,
      requirements: [String],
      scraped: {
        type: Boolean,
        default: false,
      },
    },

    // Resume
    resume: {
      filename: String,
      url: String,
      text: String,
      parsed: Boolean,
    },

    // Session Settings
    settings: {
      sttProvider: {
        type: String,
        default: "elevenlabs_client",
        enum: [
          "groq",
          "assemblyai",
          "elevenlabs",
          "elevenlabs_client",
          "webspeech",
          "deepspeech",
          "openai",
          "fasterwhisper",
        ],
      },
      // Provider-specific model identifier (if applicable).
      // Example: Groq -> whisper-large-v3 / whisper-large-v3-turbo
      sttModel: {
        type: String,
        default: "scribe_v2_realtime",
      },
      language: {
        type: String,
        default: "english",
        enum: ["english", "hindi", "spanish", "french", "german"],
      },
      simpleLanguage: {
        type: Boolean,
        default: true,
      },
      aiModel: {
        type: String,
        default: "openai/gpt-oss-120b",
        enum: [
          "gpt-4.1-smart",
          "gpt-4.1-mini",
          "gpt-5.1",
          "gpt-5.1-mini",
          "claude-4.5-sonnet",
          "claude-4.5-haiku",
          "llama-3.1-8b",
          "llama-3.3-70b",
          // Groq production model IDs
          "llama-3.1-8b-instant",
          "llama-3.3-70b-versatile",
          "openai/gpt-oss-120b",
          "openai/gpt-oss-20b",
          "groq/compound",
          "groq/compound-mini",

          // Back-compat / other providers
          "gpt-oss-120b",
        ],
      },
      extraContext: {
        type: String,
        default: "",
        maxLength: 20000,
      },
      instructions: {
        type: String,
        default: "",
        maxLength: 20000,
      },
      difficulty: {
        type: String,
        enum: ["beginner", "intermediate", "advanced", "expert"],
        default: "intermediate",
      },
      duration: {
        type: Number,
        default: 60, // minutes
      },

      // AI Answer preferences (inherited from profile defaults at session creation)
      aiAnswerDetailLevel: {
        type: String,
        enum: ["short", "medium", "deep"],
        default: "medium",
      },
      aiAnswerIncludeCode: {
        type: Boolean,
        default: true,
      },
      aiAnswerIncludeExtras: {
        type: Boolean,
        default: true,
      },
      aiAnswerMaxTokens: {
        type: Number,
        default: 0,
      },
      aiAnswerTemperature: {
        type: Number,
        default: 0,
      },
    },

    // Session Data
    messages: [
      {
        role: {
          type: String,
          enum: ["user", "assistant", "system"],
        },
        content: String,
        timestamp: {
          type: Date,
          default: Date.now,
        },
        tokens: Number,
        evaluation: {
          score: Number,
          feedback: String,
          suggestions: [String],
        },
      },
    ],

    // Analytics
    analytics: {
      totalTokens: { type: Number, default: 0 },
      totalCost: { type: Number, default: 0 },
      avgResponseTime: Number,
      questionsAsked: { type: Number, default: 0 },
      avgScore: Number,
    },

    // Status
    status: {
      type: String,
      enum: [
        "created",
        "active",
        "paused",
        "completed",
        "expired",
        "cancelled",
      ],
      default: "created",
    },

    // Time Tracking
    startedAt: Date,
    pausedAt: Date,
    endedAt: Date,
    expiresAt: Date,

    // Timestamps
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
sessionSchema.index({ user: 1, status: 1 });
sessionSchema.index({ status: 1 });
sessionSchema.index({ createdAt: -1 });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Virtuals
sessionSchema.virtual("durationUsed").get(function () {
  if (!this.startedAt) return 0;
  const end = this.endedAt || new Date();
  return Math.floor((end - this.startedAt) / 1000 / 60); // minutes
});

sessionSchema.virtual("isExpired").get(function () {
  if (!this.expiresAt) return false;
  return new Date() > this.expiresAt;
});

sessionSchema.virtual("timeRemaining").get(function () {
  if (!this.expiresAt) return this.settings.duration * 60;
  const now = new Date();
  const remaining = Math.max(0, (this.expiresAt - now) / 1000);
  return Math.floor(remaining);
});

// Methods
sessionSchema.methods.addMessage = function (message) {
  this.messages.push(message);
  this.analytics.totalTokens += message.tokens || 0;
  if (message.role === "assistant") {
    this.analytics.questionsAsked++;
  }
  return this;
};

sessionSchema.methods.startSession = function () {
  this.status = "active";
  this.startedAt = new Date();
  this.expiresAt = new Date(Date.now() + this.settings.duration * 60 * 1000);
  return this;
};

sessionSchema.methods.endSession = function () {
  this.status = "completed";
  this.endedAt = new Date();

  // Calculate average score
  const evaluatedMessages = this.messages.filter((m) => m.evaluation?.score);
  if (evaluatedMessages.length > 0) {
    const totalScore = evaluatedMessages.reduce(
      (sum, m) => sum + m.evaluation.score,
      0
    );
    this.analytics.avgScore = totalScore / evaluatedMessages.length;
  }

  return this;
};

// Pre-save middleware
sessionSchema.pre("save", function (next) {
  if (this.isNew && this.settings.duration) {
    this.expiresAt = new Date(Date.now() + this.settings.duration * 60 * 1000);
  }
  next();
});

export default mongoose.model("Session", sessionSchema);
