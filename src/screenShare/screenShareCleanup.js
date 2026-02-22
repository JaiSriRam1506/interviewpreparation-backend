import cron from "node-cron";
import ScreenShareSession from "../models/ScreenShareSession.model.js";
import { getIO } from "../socket.js";

const DEFAULT_SCHEDULE = "*/10 * * * *"; // every 10 minutes

const markAllLeft = (participants) => {
  const ts = new Date();
  return (participants || []).map((p) => {
    if (!p) return p;
    if (p.leftAt) return p;
    return { ...p, leftAt: ts };
  });
};

export const cleanupExpiredScreenShareSessions = async () => {
  const cutoff = new Date();

  const expired = await ScreenShareSession.find({
    status: "active",
    expiresAt: { $lte: cutoff },
  }).select("_id sessionId participants");

  for (const s of expired) {
    s.status = "expired";
    s.participants = markAllLeft(s.participants);
    await s.save({ validateBeforeSave: false });

    try {
      const io = getIO();
      if (io) {
        const room = `screen_${s.sessionId}`;
        io.to(room).emit("sharing-ended");
        io.in(room).disconnectSockets(true);
      }
    } catch {
      // ignore
    }
  }

  return { expiredCount: expired.length };
};

export const startScreenShareCleanupCron = (logger = console) => {
  const enabled = !["0", "false", "off", "no"].includes(
    String(process.env.SCREEN_SHARE_CLEANUP_ENABLED || "1").toLowerCase()
  );

  if (!enabled) {
    logger?.info?.("Screen share cleanup cron disabled");
    return null;
  }

  const schedule = String(
    process.env.SCREEN_SHARE_CLEANUP_CRON || DEFAULT_SCHEDULE
  ).trim();

  const task = cron.schedule(
    schedule,
    async () => {
      try {
        const result = await cleanupExpiredScreenShareSessions();
        if (result.expiredCount > 0) {
          logger?.info?.(
            `Screen share cleanup: expired ${result.expiredCount} session(s)`
          );
        }
      } catch (e) {
        logger?.error?.("Screen share cleanup failed", e);
      }
    },
    { scheduled: true }
  );

  return task;
};
