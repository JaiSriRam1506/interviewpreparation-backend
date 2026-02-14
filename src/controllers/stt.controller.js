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
    return next(
      new AppError(
        String(e?.message || "Failed to create ElevenLabs token"),
        502
      )
    );
  }
};
