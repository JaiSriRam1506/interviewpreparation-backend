import jwt from "jsonwebtoken";
import ScreenShareSession from "../models/ScreenShareSession.model.js";
import User from "../models/User.model.js";

const makeSocketLimiter = ({ windowMs, max }) => {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const windowStart = now - windowMs;
    const arr = hits.get(key) || [];
    const next = arr.filter((t) => t >= windowStart);
    next.push(now);
    hits.set(key, next);
    return next.length <= max;
  };
};

const canProceed = makeSocketLimiter({ windowMs: 60_000, max: 30 });

export const setupScreenShareSignalingServer = (io) => {
  // Optional stronger auth (server.js already decodes and sets socket.data.userId).
  io.use((socket, next) => {
    try {
      if (socket.data?.userId) return next();
      const token = socket.handshake?.auth?.token;
      if (!token) return next();
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.data.userId = decoded?.id;
      return next();
    } catch {
      return next();
    }
  });

  io.on("connection", (socket) => {
    const userId = socket.data?.userId;

    socket.on("join-screen-room", async ({ sessionId }) => {
      try {
        if (!canProceed(socket.id)) {
          socket.emit("error", { message: "Too many socket requests" });
          return;
        }

        if (!userId) {
          socket.emit("error", { message: "Authentication required" });
          return;
        }

        const id = String(sessionId || "")
          .trim()
          .toLowerCase();
        if (!id) {
          socket.emit("error", { message: "sessionId is required" });
          return;
        }

        const session = await ScreenShareSession.findOne({
          sessionId: id,
          status: "active",
          expiresAt: { $gt: new Date() },
        }).lean();

        if (!session) {
          socket.emit("error", { message: "Invalid or expired session" });
          return;
        }

        // Leave previous rooms (except own socket room)
        for (const room of socket.rooms) {
          if (room !== socket.id) socket.leave(room);
        }

        const roomName = `screen_${id}`;
        socket.join(roomName);

        const user = await User.findById(userId).select("name").lean();

        socket.to(roomName).emit("user-joined", {
          userId,
          name: user?.name || "",
        });

        const activeParticipants = (session.participants || []).filter(
          (p) => p && !p.leftAt
        );

        socket.emit("room-joined", {
          roomName,
          participants: activeParticipants.length,
        });
      } catch {
        socket.emit("error", { message: "Failed to join room" });
      }
    });

    // Generic WebRTC signaling relay (not required for LiveKit streaming, but kept for compatibility).
    socket.on("signal", ({ to, signal }) => {
      try {
        if (!canProceed(socket.id)) return;
        if (!userId) return;
        if (!to) return;
        io.to(to).emit("signal", { from: userId, signal });
      } catch {
        // ignore
      }
    });

    socket.on("sharing-started", ({ sessionId }) => {
      try {
        if (!userId) return;
        const id = String(sessionId || "")
          .trim()
          .toLowerCase();
        socket.to(`screen_${id}`).emit("sharing-active", { sharerId: userId });
      } catch {
        // ignore
      }
    });

    socket.on("sharing-stopped", ({ sessionId }) => {
      try {
        if (!userId) return;
        const id = String(sessionId || "")
          .trim()
          .toLowerCase();
        socket.to(`screen_${id}`).emit("sharing-ended");
      } catch {
        // ignore
      }
    });

    socket.on("leave-screen-room", async ({ sessionId }) => {
      try {
        if (!userId) return;
        const id = String(sessionId || "")
          .trim()
          .toLowerCase();
        const roomName = `screen_${id}`;
        socket.leave(roomName);

        const user = await User.findById(userId).select("name").lean();
        socket.to(roomName).emit("user-left", {
          userId,
          name: user?.name || "",
        });
      } catch {
        // ignore
      }
    });

    socket.on("disconnect", () => {
      try {
        if (!userId) return;
        for (const room of socket.rooms) {
          if (room !== socket.id) {
            socket.to(room).emit("user-disconnected", { userId });
          }
        }
      } catch {
        // ignore
      }
    });
  });

  return io;
};
