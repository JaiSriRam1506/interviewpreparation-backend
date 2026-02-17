import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import AppError from "../utils/AppError.js";

export const getElevenLabsSingleUseScribeToken = async (req, res, next) => {
  try {
    const apiKey = String(process.env.ELEVENLABS_API_KEY || "").trim();
    if (!apiKey) {
      return next(
        new AppError(
          "Speech transcription not configured. Missing ELEVENLABS_API_KEY.",
          501
        )
      );
    }

    const elevenlabs = new ElevenLabsClient({ apiKey });

    // Single-use token for client-side realtime Scribe.
    // Do NOT expose the API key to the browser.
    const tokenResp =
      await elevenlabs.tokens.singleUse.create("realtime_scribe");

    const token =
      (typeof tokenResp === "string" && tokenResp) ||
      tokenResp?.token ||
      tokenResp?.value ||
      tokenResp?.data?.token ||
      null;

    if (!token) {
      return next(new AppError("Failed to create ElevenLabs token", 502));
    }

    return res.status(200).json({ ok: true, token });
  } catch (e) {
    const raw = String(e?.message || "");
    const lower = raw.toLowerCase();

    // The ElevenLabs SDK often throws as a string message like:
    // "Status code: 401\nBody: { \"detail\": { \"status\": \"invalid_api_key\" ... }}"
    // Don't leak the raw upstream blob; return a clean actionable message.
    const statusMatch = raw.match(/status\s*code\s*:\s*(\d{3})/i);
    const statusCode = statusMatch ? Number(statusMatch[1]) : null;

    const isInvalidKey =
      lower.includes("invalid_api_key") ||
      lower.includes("invalid api key") ||
      statusCode === 401;

    if (isInvalidKey) {
      return next(
        new AppError(
          "Invalid ElevenLabs API key. Update ELEVENLABS_API_KEY and restart the backend.",
          401
        )
      );
    }

    const isRateLimited =
      statusCode === 429 ||
      lower.includes("rate") ||
      lower.includes("too many");
    if (isRateLimited) {
      return next(
        new AppError("ElevenLabs rate limited. Try again in a moment.", 429)
      );
    }

    return next(new AppError("Failed to create ElevenLabs token", 502));
  }
};
