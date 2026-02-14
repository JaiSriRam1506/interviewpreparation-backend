import express from "express";
import aiService from "../services/ai.service.js";
import { protect } from "../middleware/auth.js";

const router = express.Router();

const normalizeAiAnswerTranscript = (input) => {
  let text = String(input || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";

  const rules = [
    [/\bnode\s*js\b/gi, "Node.js"],
    [/\bnext\s*js\b/gi, "Next.js"],
    [/\breact\s*js\b/gi, "React"],
    [/\bjavascript\b/gi, "JavaScript"],
    [/\btypescript\b/gi, "TypeScript"],
    [/\bmongo\s*db\b/gi, "MongoDB"],
    [/\bci\s*cd\b/gi, "CI/CD"],
    [/\brest\s*api\b/gi, "REST API"],
    [/\bsocket\s*io\b/gi, "Socket.IO"],
    [/\baws\b/gi, "AWS"],
    [/\bk\s*8\s*s\b/gi, "Kubernetes"],
  ];

  for (const [re, replacement] of rules) {
    text = text.replace(re, replacement);
  }

  return text;
};

const buildParakeetJsonPrompt = ({ cleanedText, rawASR }) => {
  const system =
    "You are a helpful, concise technical interview assistant. " +
    "Return a structured JSON response only (no surrounding commentary). " +
    "Do not include any extra keys beyond those requested.";

  const user =
    `User transcript (cleaned): """${String(cleanedText || "").trim()}"""\n` +
    `User raw ASR (verbatim): """${String(rawASR || "").trim()}"""\n\n` +
    "Produce a JSON object with these exact keys:\n\n" +
    "{\n" +
    '  "tl_dr": "one-line TL;DR summary",\n' +
    '  "star_answer": "one- or two-sentence concise answer (suitable to say in interview)",\n' +
    '  "key_steps": ["step 1","step 2","..."],\n' +
    '  "detailed_explanation": "longer technical explanation (2-6 short paragraphs).",\n' +
    '  "code_example": { "language": "javascript", "code": "```js\\n...\\n```" },\n' +
    '  "technical_terms": [{"term":"X","definition":"1-sentence def"}],\n' +
    '  "common_pitfalls": ["pitfall 1", "pitfall 2"],\n' +
    '  "interview_tips": ["what to say in an interview (short)"],\n' +
    '  "follow_up_questions": ["possible follow-ups interviewer might ask"],\n' +
    '  "notes_for_candidate": "short practical tips / tradeoffs to mention",\n' +
    '  "verbatim_asr": "the original raw ASR transcript (exact string passed in rawASR field)"\n' +
    "}\n\n" +
    "Requirements:\n" +
    "- Output must be valid JSON only (no markdown or extra text).\n" +
    "- IMPORTANT: JSON strings must not contain literal newlines. Use \\n escapes inside strings instead.\n" +
    "- Keep 'star_answer' short and speakable (one or two sentences).\n" +
    "- 'key_steps' should be 3-6 short actionable steps.\n" +
    "- 'code_example.code' must be a valid fenced code string if applicable; otherwise set code_example to null.\n" +
    "- 'verbatim_asr' must be EXACTLY the rawASR string provided above.\n\n" +
    "Return the JSON object only.";

  return { system, user };
};

const parseJsonFromModel = (content) => {
  let raw = String(content || "").trim();
  if (!raw) throw new Error("LLM returned empty response");

  raw = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const escapeNewlinesInJsonStrings = (s) => {
    const input = String(s || "");
    let out = "";
    let inString = false;
    let escaped = false;

    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (inString) {
        if (escaped) {
          out += ch;
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          out += ch;
          escaped = true;
          continue;
        }
        if (ch === '"') {
          out += ch;
          inString = false;
          continue;
        }
        if (ch === "\n") {
          out += "\\n";
          continue;
        }
        if (ch === "\r") continue;
        out += ch;
        continue;
      }
      if (ch === '"') {
        out += ch;
        inString = true;
        continue;
      }
      out += ch;
    }
    return out;
  };

  const tryParse = (s) => {
    const cleaned = String(s || "")
      .trim()
      .replace(/,\s*([}\]])/g, "$1")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2018\u2019]/g, "'");
    return JSON.parse(escapeNewlinesInJsonStrings(cleaned));
  };

  try {
    return tryParse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    const candidate =
      start >= 0 && end > start ? raw.slice(start, end + 1) : "";
    if (!candidate) throw new Error("LLM returned non-JSON content");
    return tryParse(candidate);
  }
};

const coerceParakeetShape = ({ parsed, rawASR }) => {
  const obj = parsed && typeof parsed === "object" ? parsed : {};
  const safeArray = (v) =>
    Array.isArray(v) ? v.filter(Boolean).map(String) : [];
  const safeStr = (v) =>
    typeof v === "string" ? v : v == null ? "" : String(v);

  const out = {
    tl_dr: safeStr(obj.tl_dr).trim(),
    star_answer: safeStr(obj.star_answer).trim(),
    key_steps: safeArray(obj.key_steps).slice(0, 10),
    detailed_explanation: safeStr(obj.detailed_explanation).trim(),
    code_example:
      obj.code_example && typeof obj.code_example === "object"
        ? {
            language:
              safeStr(obj.code_example.language || "").trim() || "javascript",
            code: safeStr(obj.code_example.code || "").trim(),
          }
        : null,
    technical_terms: Array.isArray(obj.technical_terms)
      ? obj.technical_terms
          .filter((t) => t && typeof t === "object")
          .slice(0, 30)
          .map((t) => ({
            term: safeStr(t.term).trim(),
            definition: safeStr(t.definition).trim(),
          }))
          .filter((t) => t.term && t.definition)
      : [],
    common_pitfalls: safeArray(obj.common_pitfalls).slice(0, 20),
    interview_tips: safeArray(obj.interview_tips).slice(0, 20),
    follow_up_questions: safeArray(obj.follow_up_questions).slice(0, 20),
    notes_for_candidate: safeStr(obj.notes_for_candidate).trim(),
    verbatim_asr: String(rawASR || ""),
  };

  if (out.code_example && !out.code_example.code) out.code_example = null;
  return out;
};

const pickDefaultModelForParakeet = () => {
  const override = String(
    process.env.AI_ANSWER_PARAKEET_MODEL_OVERRIDE || ""
  ).trim();
  if (override) return override;
  if (process.env.GROQ_API_KEY) return "llama-3.1-8b";
  if (process.env.OPENAI_API_KEY) return "gpt-4.1-mini";
  if (process.env.ANTHROPIC_API_KEY) return "claude-4.5-haiku";
  if (process.env.CEREBRAS_API_KEY) return "gpt-oss-120b";
  return "";
};

router.get("/models", (req, res) => {
  res.status(200).json({
    status: "success",
    models: [
      { id: "gpt-4.1-smart", label: "GPT-4.1 Smart", speed: "Smart" },
      { id: "gpt-4.1-mini", label: "GPT-4.1 Mini", speed: "Fast" },
      { id: "gpt-5.1", label: "GPT-5.1", speed: "Smart" },
      { id: "gpt-5.1-mini", label: "GPT-5.1 Mini", speed: "Fast" },
      { id: "claude-4.5-sonnet", label: "Claude 4.5 Sonnet", speed: "Slow" },
      { id: "claude-4.5-haiku", label: "Claude 4.5 Haiku", speed: "Slow" },
      // Groq production models (aliases used by the app)
      { id: "llama-3.1-8b", label: "Llama 3.1 8B (Groq)", speed: "Fast" },
      { id: "llama-3.3-70b", label: "Llama 3.3 70B (Groq)", speed: "Smart" },

      // Groq production model IDs (direct)
      {
        id: "llama-3.1-8b-instant",
        label: "Llama 3.1 8B Instant (Groq)",
        speed: "Fast",
      },
      {
        id: "llama-3.3-70b-versatile",
        label: "Llama 3.3 70B Versatile (Groq)",
        speed: "Smart",
      },
      {
        id: "openai/gpt-oss-120b",
        label: "GPT-OSS 120B (Groq)",
        speed: "Smart",
      },
      {
        id: "openai/gpt-oss-20b",
        label: "GPT-OSS 20B (Groq)",
        speed: "Fast",
      },
      { id: "groq/compound", label: "Groq Compound", speed: "Smart" },
      {
        id: "groq/compound-mini",
        label: "Groq Compound Mini",
        speed: "Smart",
      },
    ],
  });
});

// Standalone Parakeet-style AI Answer (auth required)
// POST /api/v1/ai/answer
router.post("/answer", protect, async (req, res) => {
  try {
    const text = String(req.body?.text || req.body?.question || "");
    const rawASR = String(req.body?.rawASR || "");
    const cleanedOverride = String(req.body?.cleaned || "").trim();

    if (!text && !rawASR && !cleanedOverride) {
      return res.status(400).json({
        status: "error",
        message:
          'Provide at least "text" or "rawASR" (or "cleaned") in request body.',
      });
    }

    const cleaned = cleanedOverride
      ? cleanedOverride
      : normalizeAiAnswerTranscript(text || rawASR);
    const rawForReturn = rawASR || text || "";

    const model = pickDefaultModelForParakeet();
    if (!model) {
      return res.status(501).json({
        status: "error",
        message:
          "AI Answer not configured. Set a provider API key (e.g., GROQ_API_KEY or OPENAI_API_KEY).",
      });
    }

    const provider = aiService.getProviderByModel(model);
    const { system, user } = buildParakeetJsonPrompt({
      cleanedText: cleaned,
      rawASR: rawForReturn,
    });

    let response;
    switch (provider) {
      case "openai":
        response = await aiService.callOpenAI(model, user, {
          systemPrompt: system,
          temperature: 0.05,
          top_p: 1,
          max_tokens: 900,
        });
        break;
      case "groq":
        response = await aiService.callGroq(model, user, {
          systemPrompt: system,
          temperature: 0.05,
          top_p: 1,
          max_tokens: 900,
          retries: 1,
        });
        break;
      case "anthropic":
        response = await aiService.callAnthropic(model, user, {
          systemPrompt: system,
          temperature: 0,
          max_tokens: 900,
        });
        break;
      case "cerebras":
        response = await aiService.callCerebras(model, user, {
          systemPrompt: system,
          temperature: 0.05,
          max_tokens: 900,
        });
        break;
      default:
        throw new Error(`Unsupported provider for model: ${model}`);
    }

    const parsed = parseJsonFromModel(response?.content);
    const parakeet = coerceParakeetShape({ parsed, rawASR: rawForReturn });

    return res.status(200).json({
      status: "success",
      cleaned,
      parakeet,
      model: response?.model || model,
      usage: response?.usage,
    });
  } catch (err) {
    return res.status(500).json({
      status: "error",
      message: err?.message || "AI answer failed",
    });
  }
});

export default router;
