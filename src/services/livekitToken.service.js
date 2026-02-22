import { AccessToken } from "livekit-server-sdk";
import AppError from "../utils/AppError.js";

const requireLiveKitEnv = () => {
  const apiKey = String(process.env.LIVEKIT_API_KEY || "").trim();
  const apiSecret = String(process.env.LIVEKIT_API_SECRET || "").trim();
  const url = String(process.env.LIVEKIT_URL || "").trim();

  if (!apiKey || !apiSecret || !url) {
    throw new AppError(
      "LiveKit is not configured (missing LIVEKIT_API_KEY/LIVEKIT_API_SECRET/LIVEKIT_URL)",
      500
    );
  }

  return { apiKey, apiSecret, url };
};

export const buildLiveKitToken = async ({
  identity,
  name,
  roomName,
  role,
  ttlSeconds = 2 * 60 * 60,
}) => {
  const { apiKey, apiSecret } = requireLiveKitEnv();

  const safeIdentity = String(identity || "").trim();
  const safeRoom = String(roomName || "").trim();
  const safeRole = String(role || "").trim();

  if (!safeIdentity || !safeRoom || !safeRole) {
    throw new AppError("Invalid token request", 400);
  }

  const canPublish = safeRole === "sharer";
  const canSubscribe = safeRole === "viewer";

  try {
    const token = new AccessToken(apiKey, apiSecret, {
      identity: safeIdentity,
      name: name ? String(name) : undefined,
      ttl: ttlSeconds,
    });

    token.addGrant({
      roomJoin: true,
      room: safeRoom,
      canPublish,
      canSubscribe,
    });

    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    // livekit-server-sdk returns a Promise here.
    const jwt = await token.toJwt();
    const s = String(jwt || "").trim();
    if (!s) {
      throw new AppError("LiveKit token generation failed", 502);
    }
    return { jwt: s, expiresAt };
  } catch (err) {
    throw new AppError(
      err?.message
        ? `LiveKit token generation failed: ${err.message}`
        : "LiveKit token generation failed",
      502
    );
  }
};
