import crypto from "crypto";
import ScreenShareSession from "../models/ScreenShareSession.model.js";
import AppError from "../utils/AppError.js";
import { buildLiveKitToken } from "../services/livekitToken.service.js";
import { getIO } from "../socket.js";

const now = () => new Date();

const generateSessionId = () => {
  // Short, URL-safe code (alphanumeric). Example: "abc123xyz".
  // Hex is strictly [0-9a-f] so it passes Joi.alphanum().
  return crypto.randomBytes(6).toString("hex").toLowerCase();
};

const isExpired = (session) => {
  const exp = session?.expiresAt ? new Date(session.expiresAt).getTime() : 0;
  return exp > 0 && exp <= Date.now();
};

const markParticipantsLeft = (participants) => {
  const ts = now();
  return (participants || []).map((p) => {
    if (!p) return p;
    if (p.leftAt) return p;
    return { ...p, leftAt: ts };
  });
};

const countActiveViewers = (session) => {
  const creatorId = String(session?.createdBy?._id || session?.createdBy || "");
  const active = (session?.participants || []).filter(
    (p) => p?.userId && !p.leftAt
  );
  return active.filter((p) => String(p.userId) !== creatorId).length;
};

export const createSession = async (req, res, next) => {
  try {
    if (!req.user?._id) return next(new AppError("Not authenticated", 401));

    // Rate limit: max 5 sessions per user per hour.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const createdCount = await ScreenShareSession.countDocuments({
      createdBy: req.user._id,
      createdAt: { $gte: oneHourAgo },
    });
    if (createdCount >= 5) {
      return next(
        new AppError("Rate limit: max 5 screen-share sessions per hour", 429)
      );
    }

    const sessionId = generateSessionId();
    const roomName = `screen_share_${sessionId}`;

    const session = await ScreenShareSession.create({
      sessionId,
      roomName,
      createdBy: req.user._id,
      participants: [{ userId: req.user._id, joinedAt: now() }],
      status: "active",
      expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
    });

    const { jwt: token, expiresAt } = await buildLiveKitToken({
      identity: String(req.user._id),
      name: req.user?.name,
      roomName: session.roomName,
      role: "sharer",
      ttlSeconds: 2 * 60 * 60,
    });

    return res.status(201).json({
      success: true,
      sessionId: session.sessionId,
      roomName: session.roomName,
      token,
      expiresAt,
    });
  } catch (err) {
    next(err);
  }
};

export const joinSession = async (req, res, next) => {
  try {
    if (!req.user?._id) return next(new AppError("Not authenticated", 401));

    const sessionId = String(req.body?.sessionId || "")
      .trim()
      .toLowerCase();
    if (!sessionId) return next(new AppError("sessionId is required", 400));

    const session = await ScreenShareSession.findOne({ sessionId }).populate(
      "createdBy",
      "name"
    );
    if (!session) return next(new AppError("Session not found", 404));

    if (session.status !== "active") {
      return next(new AppError("Session is not active", 410));
    }

    if (isExpired(session)) {
      session.status = "expired";
      session.participants = markParticipantsLeft(session.participants);
      await session.save({ validateBeforeSave: false });
      return next(new AppError("Session expired", 410));
    }

    const userId = String(req.user._id);
    const creatorId = String(session.createdBy?._id || session.createdBy);

    // If the creator is joining from another device/tab, treat as sharer.
    const role = userId === creatorId ? "sharer" : "viewer";

    // Prevent more than 1 viewer (1-to-1 only).
    if (role === "viewer") {
      const activeViewers = countActiveViewers(session);
      const alreadyActive = (session.participants || []).some(
        (p) => String(p?.userId || "") === userId && !p.leftAt
      );

      if (!alreadyActive && activeViewers >= 1) {
        return next(new AppError("Session already has a viewer", 409));
      }
    }

    const alreadyInSession = (session.participants || []).some(
      (p) => String(p?.userId || "") === userId && !p.leftAt
    );

    if (!alreadyInSession) {
      session.participants.push({ userId: req.user._id, joinedAt: now() });
      await session.save();
    }

    const { jwt: token, expiresAt } = await buildLiveKitToken({
      identity: userId,
      name: req.user?.name,
      roomName: session.roomName,
      role,
      ttlSeconds: 2 * 60 * 60,
    });

    return res.status(200).json({
      success: true,
      roomName: session.roomName,
      token,
      sharerName: session.createdBy?.name || "",
      expiresAt,
    });
  } catch (err) {
    next(err);
  }
};

export const getSession = async (req, res, next) => {
  try {
    if (!req.user?._id) return next(new AppError("Not authenticated", 401));
    const sessionId = String(req.params?.sessionId || "")
      .trim()
      .toLowerCase();
    if (!sessionId) return next(new AppError("Invalid sessionId", 400));

    const session = await ScreenShareSession.findOne({ sessionId }).populate(
      "createdBy",
      "name"
    );
    if (!session) return next(new AppError("Session not found", 404));

    const expired = isExpired(session);
    const active = session.status === "active" && !expired;

    return res.status(200).json({
      success: true,
      session: {
        sessionId: session.sessionId,
        roomName: session.roomName,
        status:
          expired && session.status === "active" ? "expired" : session.status,
        expiresAt: session.expiresAt,
        createdAt: session.createdAt,
        createdBy: {
          id: session.createdBy?._id,
          name: session.createdBy?.name,
        },
        active,
        participantCount: (session.participants || []).filter(
          (p) => p && !p.leftAt
        ).length,
        viewerCount: countActiveViewers(session),
      },
    });
  } catch (err) {
    next(err);
  }
};

export const endSession = async (req, res, next) => {
  try {
    if (!req.user?._id) return next(new AppError("Not authenticated", 401));
    const sessionId = String(req.params?.sessionId || "")
      .trim()
      .toLowerCase();
    if (!sessionId) return next(new AppError("Invalid sessionId", 400));

    const session = await ScreenShareSession.findOne({ sessionId });
    if (!session) return next(new AppError("Session not found", 404));

    if (String(session.createdBy) !== String(req.user._id)) {
      return next(new AppError("Only the session creator can end it", 403));
    }

    if (session.status !== "active") {
      return res.status(200).json({ success: true, status: session.status });
    }

    session.status = "ended";
    session.participants = markParticipantsLeft(session.participants);
    await session.save({ validateBeforeSave: false });

    // Notify + disconnect sockets in this screen room.
    try {
      const io = getIO();
      if (io) {
        const room = `screen_${sessionId}`;
        io.to(room).emit("sharing-ended");
        io.in(room).disconnectSockets(true);
      }
    } catch {
      // ignore
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    next(err);
  }
};

export const listMyActiveSessions = async (req, res, next) => {
  try {
    if (!req.user?._id) return next(new AppError("Not authenticated", 401));

    const sessions = await ScreenShareSession.find({
      createdBy: req.user._id,
      status: "active",
      expiresAt: { $gt: new Date() },
    })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    return res.status(200).json({
      success: true,
      sessions: (sessions || []).map((s) => ({
        sessionId: s.sessionId,
        roomName: s.roomName,
        status: s.status,
        expiresAt: s.expiresAt,
        createdAt: s.createdAt,
        viewerCount: countActiveViewers(s),
      })),
    });
  } catch (err) {
    next(err);
  }
};
