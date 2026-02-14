import fs from "fs";
import path from "path";
import pdf from "pdf-parse";
import mammoth from "mammoth";

const clampText = (v, max) => {
  const s = String(v ?? "");
  if (!max || !Number.isFinite(max)) return s;
  return s.length > max ? s.slice(0, max) : s;
};

const extractResumeText = async ({ filePath, originalname } = {}) => {
  if (!filePath) return { text: "", parsed: false };
  const buffer = await fs.promises.readFile(filePath);
  const ext = path.extname(originalname || "").toLowerCase();

  if (ext === ".pdf") {
    const parsed = await pdf(buffer);
    return { text: String(parsed?.text || ""), parsed: true };
  }

  if (ext === ".txt") {
    return { text: buffer.toString("utf8"), parsed: true };
  }

  if (ext === ".docx") {
    const result = await mammoth.extractRawText({ buffer });
    return { text: String(result?.value || ""), parsed: true };
  }

  return { text: "", parsed: false };
};

export const getMe = async (req, res) => {
  res.status(200).json({
    status: "success",
    data: { user: req.user },
  });
};

export const updateMe = async (req, res, next) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({
        status: "error",
        message: "Not authenticated",
      });
    }

    const {
      name,
      jobTitle,
      jobDescription,
      extraContext,
      instructions,
      aiAnswerDetailLevel,
      aiAnswerIncludeCode,
      aiAnswerIncludeExtras,
      aiAnswerMaxTokens,
      aiAnswerTemperature,
    } = req.body || {};

    if (typeof name === "string") {
      const trimmed = name.trim();
      if (trimmed) user.name = trimmed.slice(0, 120);
    }

    if (!user.profileDefaults) user.profileDefaults = {};
    if (jobTitle !== undefined)
      user.profileDefaults.jobTitle = clampText(jobTitle, 300);
    if (jobDescription !== undefined)
      user.profileDefaults.jobDescription = clampText(jobDescription, 20000);
    if (extraContext !== undefined)
      user.profileDefaults.extraContext = clampText(extraContext, 20000);
    if (instructions !== undefined)
      user.profileDefaults.instructions = clampText(instructions, 20000);

    if (!user.profileDefaults.aiAnswer) user.profileDefaults.aiAnswer = {};

    if (aiAnswerDetailLevel !== undefined) {
      const v = String(aiAnswerDetailLevel || "")
        .trim()
        .toLowerCase();
      user.profileDefaults.aiAnswer.detailLevel = [
        "short",
        "medium",
        "deep",
      ].includes(v)
        ? v
        : "medium";
    }

    if (aiAnswerIncludeCode !== undefined) {
      const raw = String(aiAnswerIncludeCode).toLowerCase();
      user.profileDefaults.aiAnswer.includeCode = [
        "1",
        "true",
        "yes",
        "on",
      ].includes(raw);
    }

    if (aiAnswerIncludeExtras !== undefined) {
      const raw = String(aiAnswerIncludeExtras).toLowerCase();
      user.profileDefaults.aiAnswer.includeExtras = [
        "1",
        "true",
        "yes",
        "on",
      ].includes(raw);
    }

    if (aiAnswerMaxTokens !== undefined) {
      const n = Number(aiAnswerMaxTokens);
      user.profileDefaults.aiAnswer.maxTokens =
        Number.isFinite(n) && n >= 0 ? Math.min(4000, Math.floor(n)) : 0;
    }

    if (aiAnswerTemperature !== undefined) {
      const n = Number(aiAnswerTemperature);
      user.profileDefaults.aiAnswer.temperature =
        Number.isFinite(n) && n >= 0 ? Math.min(2, Math.max(0, n)) : 0;
    }

    if (req.file) {
      const diskPath = req.file.path;
      const url = `/uploads/${path.basename(diskPath)}`;

      let extracted = { text: "", parsed: false };
      try {
        extracted = await extractResumeText({
          filePath: diskPath,
          originalname: req.file.originalname,
        });
      } catch {
        extracted = { text: "", parsed: false };
      }

      user.profileDefaults.resume = {
        filename: String(req.file.originalname || ""),
        url,
        text: clampText(extracted.text, 20000),
        parsed: !!extracted.parsed,
        mimetype: String(req.file.mimetype || ""),
        size: Number(req.file.size || 0) || 0,
        uploadedAt: new Date(),
      };
    }

    await user.save({ validateBeforeSave: false });
    user.password = undefined;

    res.status(200).json({
      status: "success",
      data: { user },
    });
  } catch (err) {
    next(err);
  }
};
