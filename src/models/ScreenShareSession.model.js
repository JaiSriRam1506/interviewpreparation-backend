import mongoose from "mongoose";

const screenShareSessionSchema = new mongoose.Schema(
  {
    sessionId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    roomName: {
      type: String,
      required: true,
      unique: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    participants: [
      {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        joinedAt: { type: Date, default: Date.now },
        leftAt: Date,
      },
    ],
    status: {
      type: String,
      enum: ["active", "ended", "expired"],
      default: "active",
    },
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 2 * 60 * 60 * 1000),
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

screenShareSessionSchema.index({ createdBy: 1, createdAt: -1 });
screenShareSessionSchema.index({ status: 1, expiresAt: 1 });

export default mongoose.model("ScreenShareSession", screenShareSessionSchema);
