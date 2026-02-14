// src/services/ai.service.js
import axios from "axios";
import { isRedisReady, redisClient } from "../config/redis.js";

class AIService {
  constructor() {
    this.providers = {
      openai: {
        baseURL: "https://api.openai.com/v1",
        headers: (apiKey) => ({
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        }),
        models: {
          "gpt-4.1-smart": {
            costPer1KInput: 0.06,
            costPer1KOutput: 0.12,
            maxTokens: 128000,
            contextWindow: 128000,
          },
          "gpt-4.1-mini": {
            costPer1KInput: 0.03,
            costPer1KOutput: 0.06,
            maxTokens: 128000,
            contextWindow: 128000,
          },
          "gpt-5.1": {
            costPer1KInput: 0.1,
            costPer1KOutput: 0.2,
            maxTokens: 256000,
            contextWindow: 256000,
          },
          "gpt-5.1-mini": {
            costPer1KInput: 0.05,
            costPer1KOutput: 0.1,
            maxTokens: 128000,
            contextWindow: 128000,
          },
        },
      },

      anthropic: {
        baseURL: "https://api.anthropic.com/v1",
        headers: (apiKey) => ({
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        }),
        models: {
          "claude-4.5-sonnet": {
            costPer1KInput: 0.015,
            costPer1KOutput: 0.075,
            maxTokens: 200000,
            contextWindow: 200000,
          },
          "claude-4.5-haiku": {
            costPer1KInput: 0.0008,
            costPer1KOutput: 0.004,
            maxTokens: 200000,
            contextWindow: 200000,
          },
        },
      },

      groq: {
        baseURL: "https://api.groq.com/openai/v1",
        headers: (apiKey) => ({
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        }),
        models: {
          "llama-3.1-8b": {
            // Alias used by the app; maps to llama-3.1-8b-instant on Groq
            costPer1M: 0.05,
            maxTokens: 8192,
            contextWindow: 8192,
          },
          "llama-3.3-70b": {
            // Alias used by the app; maps to llama-3.3-70b-versatile on Groq
            costPer1M: 0.59,
            maxTokens: 8192,
            contextWindow: 8192,
          },

          // Direct Groq model IDs (production)
          "llama-3.1-8b-instant": {
            costPer1M: 0.05,
            maxTokens: 131072,
            contextWindow: 131072,
          },
          "llama-3.3-70b-versatile": {
            costPer1M: 0.59,
            maxTokens: 32768,
            contextWindow: 131072,
          },
          "openai/gpt-oss-120b": {
            costPer1M: 0.15,
            maxTokens: 65536,
            contextWindow: 131072,
          },
          "openai/gpt-oss-20b": {
            costPer1M: 0.075,
            maxTokens: 65536,
            contextWindow: 131072,
          },
          "groq/compound": {
            costPer1M: 0,
            maxTokens: 8192,
            contextWindow: 131072,
          },
          "groq/compound-mini": {
            costPer1M: 0,
            maxTokens: 8192,
            contextWindow: 131072,
          },
        },
      },

      cerebras: {
        baseURL: "https://api.cerebras.ai/v1",
        headers: (apiKey) => ({
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        }),
        models: {
          "gpt-oss-120b": {
            costPer1K: 0.0012,
            maxTokens: 32000,
            contextWindow: 32000,
          },
        },
      },
    };
  }

  getModelContextWindow(model) {
    const m = String(model || "").trim();
    if (!m) return null;
    let provider;
    try {
      provider = this.getProviderByModel(m);
    } catch {
      return null;
    }

    const config = this.providers?.[provider]?.models?.[m];
    const win = Number(config?.contextWindow);
    return Number.isFinite(win) && win > 0 ? win : null;
  }

  validateAnswerFormat(text) {
    const raw = String(text ?? "");
    const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = normalized.split("\n");

    const line1 = (lines[0] ?? "").trim();
    const line2 = (lines[1] ?? "").trim();
    if (!line1) return { ok: false, reason: "missing-first-line" };
    if (line2 !== "") return { ok: false, reason: "second-line-not-blank" };

    const rest = lines.slice(2);
    const nonEmpty = rest.filter((l) => String(l).trim() !== "");
    if (!nonEmpty.length) return { ok: false, reason: "missing-bullets" };

    // Every non-empty line after line 2 must be a bullet.
    if (nonEmpty.some((l) => !String(l).startsWith("- "))) {
      return { ok: false, reason: "non-bullet-lines-present" };
    }

    const bulletCount = nonEmpty.length;
    if (bulletCount < 4 || bulletCount > 6) {
      return { ok: false, reason: "bullet-count-out-of-range" };
    }

    return { ok: true };
  }

  async refineToneSecondPass(session, question, answer, options = {}) {
    const enabled = options?.enabled === true;
    if (!enabled) return String(answer ?? "");

    // Hook for optional second pass refinement.
    // Intentionally disabled by default to avoid extra cost/latency.
    // In the future this can call a cheaper model to make tone more spoken,
    // while preserving the strict output format.
    return String(answer ?? "");
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  isTransientHttpStatus(status) {
    const code = Number(status);
    return (
      code === 429 ||
      code === 498 ||
      code === 500 ||
      code === 502 ||
      code === 503 ||
      code === 504
    );
  }

  getAnswerModel(session) {
    const override = String(process.env.AI_ANSWER_MODEL_OVERRIDE || "").trim();
    if (override) return override;

    const configured = String(session?.settings?.aiModel || "").trim();
    if (!configured) return configured;

    const preferFastGroq = ["1", "true", "yes", "on"].includes(
      String(process.env.AI_ANSWER_PREFER_FAST_GROQ || "").toLowerCase()
    );

    if (!preferFastGroq) return configured;

    try {
      const provider = this.getProviderByModel(configured);
      if (provider !== "groq") return configured;

      const fastModel =
        String(process.env.AI_ANSWER_FAST_GROQ_MODEL || "").trim() ||
        "llama-3.1-8b";

      // If user already selected an 8B/instant-ish model, keep it.
      const lower = configured.toLowerCase();
      const alreadyFast =
        lower.includes("8b") ||
        lower.includes("instant") ||
        lower.includes("mini");
      return alreadyFast ? configured : fastModel;
    } catch {
      return configured;
    }
  }

  buildAnswerPrompts(session, question, draft = "", options = {}) {
    const jobTitle = session.job?.title || "";
    const jobCompany = session.job?.company || "";

    // Use user/session preferences for detail, code, extras
    const settings = session?.settings || {};
    const detailLevel = String(settings.aiAnswerDetailLevel || "medium")
      .trim()
      .toLowerCase();
    const includeCode =
      typeof settings.aiAnswerIncludeCode === "boolean"
        ? settings.aiAnswerIncludeCode
        : true;
    const includeExtras =
      typeof settings.aiAnswerIncludeExtras === "boolean"
        ? settings.aiAnswerIncludeExtras
        : true;

    const contextWindow = Number(options?.contextWindow);
    let resumeMax = 500;
    let extraMax = 20000;
    let instructionsMax = 20000;

    if (Number.isFinite(contextWindow) && contextWindow > 0) {
      if (contextWindow < 32000) {
        resumeMax = 250;
        extraMax = 8000;
        instructionsMax = 8000;
      }
      if (contextWindow < 16000) {
        resumeMax = 200;
        extraMax = 4000;
        instructionsMax = 4000;
      }
      if (contextWindow < 10000) {
        resumeMax = 150;
        extraMax = 2500;
        instructionsMax = 2500;
      }
    }

    const resumeText = session.resume?.text
      ? String(session.resume.text).slice(0, resumeMax)
      : "";
    const extraContext = session.settings?.extraContext
      ? String(session.settings.extraContext).slice(0, extraMax)
      : "";
    const instructions = session.settings?.instructions
      ? String(session.settings.instructions).slice(0, instructionsMax)
      : "";
    const combinedOverrides = [extraContext, instructions]
      .map((s) => String(s || "").trim())
      .filter(Boolean)
      .join("\n\n");

    let baseSystemPrompt =
      "You are a software engineer answering in a live product-company interview.\n\n" +
      "How you must sound:\n" +
      "- Like you actively build and debug real systems.\n" +
      "- Natural, conversational, and spontaneous.\n" +
      "- Practical, not academic.\n" +
      "- Never like a teacher, article, or AI.\n\n" +
      "Speaking style:\n" +
      "- First person.\n" +
      "- Simple spoken English.\n" +
      "- Short, sharp, confident.\n" +
      "- No lecturing or advising tone.\n\n" +
      "Hard bans (must never appear):\n" +
      "- 'you should', 'one can', 'choose based on'\n" +
      "- 'from my experience', 'in my company'\n" +
      "- No company names, projects, metrics\n" +
      "- No mentioning AI or assistance\n\n" +
      "What interviewers like to hear:\n" +
      "- Strong production awareness\n" +
      "- Performance, scalability, reliability\n" +
      "- Clean and maintainable design\n" +
      "- Tradeoffs without theory speeches\n\n";

    // Add answer format rules based on user preferences
    if (detailLevel === "short") {
      baseSystemPrompt +=
        "Answer format:\n" +
        "- Start with one clear sentence answering the question.\n" +
        "- Blank line.\n" +
        "- Provide 3–4 bullets starting with '- '.\n" +
        "- Each bullet must be concise and add something new.\n" +
        "- Stop after bullets.\n\n";
    } else if (detailLevel === "deep") {
      baseSystemPrompt +=
        "Answer format:\n" +
        "- Start with one clear sentence answering the question.\n" +
        "- Blank line.\n" +
        "- Provide 6–8 bullets starting with '- '.\n" +
        "- Each bullet must add something new and go into more depth.\n" +
        "- Stop after bullets.\n\n";
    } else {
      baseSystemPrompt +=
        "Answer format:\n" +
        "- Start with one clear sentence answering the question.\n" +
        "- Blank line.\n" +
        "- Provide 4–6 bullets starting with '- '.\n" +
        "- Each bullet must add something new.\n" +
        "- Stop after bullets.\n\n";
    }

    baseSystemPrompt +=
      "Writing rules:\n" +
      "- Use **bold** for important terms naturally.\n" +
      "- Use `backticks` for code elements.\n" +
      "- Keep explanations tight and verbal.\n\n";

    if (includeCode) {
      baseSystemPrompt +=
        "Code rules:\n" +
        "- Include a code bullet if it genuinely helps clarify.\n" +
        "- Maximum one code bullet.\n" +
        "- Must start with '- **Code**:' and use ```js```.\n\n";
    } else {
      baseSystemPrompt +=
        "Code rules:\n" + "- Do not include any code bullets.\n\n";
    }

    if (includeExtras) {
      baseSystemPrompt +=
        "Extras:\n" +
        "- If relevant, add a short 'Pitfall' bullet and a 'Follow-up' bullet at the end.\n\n";
    }

    baseSystemPrompt +=
      "Target impression:\n" +
      "The interviewer should feel this person has done the work and is explaining it comfortably.";

    const systemPrompt =
      baseSystemPrompt +
      (combinedOverrides ? `\n\nUser instructions:\n${combinedOverrides}` : "");

    const prompt =
      `Role interviewing for: ${jobTitle}${jobCompany ? ` at ${jobCompany}` : ""}\n\n` +
      "Question:\n<<<QUESTION>>>\n" +
      `${String(question || "").trim()}\n` +
      "<<<END_QUESTION>>>\n\n" +
      (draft
        ? "Candidate draft (optional):\n<<<DRAFT>>>\n" +
          `${String(draft).trim()}\n` +
          "<<<END_DRAFT>>>\n\n"
        : "") +
      (resumeText
        ? "Private resume context (do NOT quote or reference directly; use only to avoid contradictions):\n" +
          "<<<RESUME>>>\n" +
          `${resumeText}\n` +
          "<<<END_RESUME>>>\n\n"
        : "") +
      "Return the answer now using the OUTPUT RULES.";

    return { systemPrompt, prompt };
  }

  async generateInterviewQuestion(session, userQuestion = null) {
    try {
      const model = session.settings.aiModel;
      const provider = this.getProviderByModel(model);

      // Check cache first
      const cacheKey = `ai:question:${session._id}:${model}:${userQuestion?.slice(0, 50)}`;
      if (isRedisReady()) {
        try {
          const cached = await redisClient.get(cacheKey);
          if (cached) return JSON.parse(cached);
        } catch (e) {
          // Redis is optional in dev; never fail AI due to cache issues
          console.warn("Redis cache get failed; continuing without cache.");
        }
      }

      // Prepare prompt based on session context
      const prompt = this.createInterviewPrompt(session, userQuestion);

      let response;
      switch (provider) {
        case "openai":
          response = await this.callOpenAI(model, prompt);
          break;
        case "anthropic":
          response = await this.callAnthropic(model, prompt);
          break;
        case "groq":
          response = await this.callGroq(model, prompt);
          break;
        case "cerebras":
          response = await this.callCerebras(model, prompt);
          break;
        default:
          throw new Error(`Unsupported provider for model: ${model}`);
      }

      // Calculate cost
      const cost = this.calculateCost(model, response.usage);

      // Cache the response
      if (isRedisReady()) {
        try {
          await redisClient.setEx(
            cacheKey,
            3600,
            JSON.stringify({ ...response, cost })
          );
        } catch {
          console.warn("Redis cache set failed; continuing without cache.");
        }
      }

      return { ...response, cost };
    } catch (error) {
      console.error("AI Service Error:", error);
      throw new Error(
        `Failed to generate interview question: ${error.message}`
      );
    }
  }

  async evaluateAnswer(question, answer, criteria = {}) {
    try {
      const prompt = `
        Question: ${question}
        Candidate Answer: ${answer}
        Evaluation Criteria: ${JSON.stringify(criteria, null, 2)}
        
        Please evaluate this answer for a technical interview.
        Provide your evaluation in the following JSON format:
        {
          "score": 0-10,
          "feedback": "Detailed feedback about the answer",
          "strengths": ["List of strengths"],
          "improvements": ["Areas for improvement"],
          "suggestedAnswer": "A better answer you would suggest",
          "keywordsFound": ["Relevant keywords found in answer"],
          "completeness": 0-100,
          "technicalAccuracy": 0-100,
          "communication": 0-100
        }
        
        Be critical but constructive. Focus on technical accuracy, completeness, and communication skills.
      `;

      // Use Claude 4.5 Sonnet for evaluation (most accurate)
      const response = await this.callAnthropic("claude-4.5-sonnet", prompt);

      // Parse JSON response
      try {
        const evaluation = JSON.parse(response.content);
        return evaluation;
      } catch (parseError) {
        // Fallback: Extract JSON from text
        const jsonMatch = response.content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          return JSON.parse(jsonMatch[0]);
        }
        throw new Error("Failed to parse evaluation response");
      }
    } catch (error) {
      console.error("Evaluation Error:", error);
      throw error;
    }
  }

  async callOpenAI(model, prompt, options = {}) {
    const config = this.providers.openai;
    const url = `${config.baseURL}/chat/completions`;

    const systemPrompt =
      options.systemPrompt ||
      "You are an expert technical interviewer. Ask relevant, challenging questions and evaluate answers professionally.";

    const response = await axios.post(
      url,
      {
        model,
        messages: [
          {
            role: "system",
            content: systemPrompt,
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: options.temperature || 0.7,
        top_p:
          typeof options.top_p === "number" && Number.isFinite(options.top_p)
            ? options.top_p
            : undefined,
        max_tokens: options.max_tokens || 1000,
        response_format: options.response_format || undefined,
        stream: options.stream || false,
      },
      {
        headers: config.headers(process.env.OPENAI_API_KEY),
      }
    );

    return {
      content: response.data.choices[0].message.content,
      usage: response.data.usage,
      model: response.data.model,
    };
  }

  async callAnthropic(model, prompt, options = {}) {
    const config = this.providers.anthropic;
    const url = `${config.baseURL}/messages`;

    const response = await axios.post(
      url,
      {
        model,
        system: options.systemPrompt || undefined,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
        max_tokens: options.max_tokens || 1000,
        temperature: options.temperature || 0.7,
      },
      {
        headers: config.headers(process.env.ANTHROPIC_API_KEY),
      }
    );

    return {
      content: response.data.content[0].text,
      usage: response.data.usage,
      model: response.data.model,
    };
  }

  async callGroq(model, prompt, options = {}) {
    const config = this.providers.groq;
    const url = `${config.baseURL}/chat/completions`;

    const messages = [];
    if (options.systemPrompt) {
      messages.push({ role: "system", content: options.systemPrompt });
    }
    messages.push({ role: "user", content: prompt });

    const maxRetries = Number.isFinite(Number(options.retries))
      ? Number(options.retries)
      : 2;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const response = await axios.post(
          url,
          {
            model:
              model === "llama-3.1-8b"
                ? "llama-3.1-8b-instant"
                : model === "llama-3.3-70b"
                  ? "llama-3.3-70b-versatile"
                  : model,
            messages,
            temperature: options.temperature || 0.7,
            top_p:
              typeof options.top_p === "number" &&
              Number.isFinite(options.top_p)
                ? options.top_p
                : undefined,
            max_tokens: options.max_tokens || 1000,
            response_format: options.response_format || undefined,
            // Best default for interactive apps.
            service_tier: options.service_tier || "on_demand",
          },
          {
            headers: config.headers(process.env.GROQ_API_KEY),
            timeout: options.timeout || 20000,
          }
        );

        return {
          content: response.data.choices[0].message.content,
          usage: response.data.usage,
          model: response.data.model,
        };
      } catch (error) {
        const status = error?.response?.status;
        const msg =
          error?.response?.data?.error?.message ||
          error?.response?.data?.message ||
          error?.message ||
          "Groq request failed";

        const canRetry =
          attempt < maxRetries && this.isTransientHttpStatus(status);

        if (canRetry) {
          const base = 300;
          const backoff = base * Math.pow(2, attempt);
          const jitter = Math.floor(Math.random() * 120);
          await this.sleep(backoff + jitter);
          continue;
        }

        const suffix = status ? ` (HTTP ${status})` : "";
        throw new Error(`${msg}${suffix}`);
      }
    }
  }

  getProviderByModel(model) {
    if (model.startsWith("gpt-")) return "openai";
    if (model.startsWith("claude-")) return "anthropic";
    if (model.startsWith("llama-")) return "groq";
    if (model.startsWith("openai/")) return "groq";
    if (model.startsWith("groq/")) return "groq";
    if (model.startsWith("gpt-oss-")) return "cerebras";
    throw new Error(`Unknown model: ${model}`);
  }

  calculateCost(model, usage) {
    const provider = this.getProviderByModel(model);
    const modelConfig = this.providers[provider].models[model];

    if (!modelConfig) return 0;

    if (provider === "groq") {
      // Groq charges per million tokens
      const totalTokens = usage?.total_tokens || 0;
      return (totalTokens / 1000000) * modelConfig.costPer1M;
    } else {
      // Others charge per 1K tokens
      const inputTokens = usage?.prompt_tokens || 0;
      const outputTokens = usage?.completion_tokens || 0;

      const inputCost =
        (inputTokens / 1000) * (modelConfig.costPer1KInput || 0);
      const outputCost =
        (outputTokens / 1000) *
        (modelConfig.costPer1KOutput || modelConfig.costPer1K || 0);

      return inputCost + outputCost;
    }
  }

  createInterviewPrompt(session, userQuestion = null) {
    const { job, resume, settings } = session;
    const combinedOverrides = [settings?.extraContext, settings?.instructions]
      .map((s) => String(s || "").trim())
      .filter(Boolean)
      .join("\n\n");

    let systemPrompt = combinedOverrides;
    if (combinedOverrides) {
      systemPrompt += `
  
  Additional Instructions from User:
  ${combinedOverrides}
  
  IMPORTANT: Follow these instructions carefully throughout the interview.
  `;
    }

    let prompt = `
      You are conducting a technical interview for the position of "${job.title}" at "${job.company}".
      
      Job Description:
      ${job.description}
      
      Job Requirements:
      ${job.requirements?.join("\n") || "Not specified"}
      
      Candidate's Resume Summary:
      ${resume?.text?.substring(0, 1000) || "Not provided"}
      
      Interview Settings:
      - Difficulty: ${settings.difficulty}
      - Language: ${settings.language}
      - Extra Context / Instructions: ${systemPrompt || "None"}
      
      Interview Instructions:
      1. Ask technical questions relevant to the position
      2. Start with basics and progress to advanced topics
      3. Evaluate answers based on technical accuracy, problem-solving, and communication
      4. Provide constructive feedback
      5. Adapt to the candidate's experience level
    `;

    if (userQuestion) {
      prompt += `
      
      Candidate's Previous Question/Answer:
      ${userQuestion}
      
      Provide a relevant follow-up question or evaluate their answer.
      `;
    } else {
      prompt += `
      
      Please start the interview with an appropriate opening question.
      `;
    }

    return prompt;
  }

  async callCerebras(model, prompt, options = {}) {
    const config = this.providers.cerebras;
    const url = `${config.baseURL}/chat/completions`;

    const messages = [];
    if (options.systemPrompt) {
      messages.push({ role: "system", content: options.systemPrompt });
    }
    messages.push({ role: "user", content: prompt });

    const response = await axios.post(
      url,
      {
        model,
        messages,
        temperature: options.temperature || 0.7,
        max_tokens: options.max_tokens || 1000,
      },
      {
        headers: config.headers(process.env.CEREBRAS_API_KEY),
      }
    );

    return {
      content: response.data.choices[0].message.content,
      usage: response.data.usage,
      model: response.data.model,
    };
  }

  async generateAnswer(session, question, draft = "") {
    try {
      const model = this.getAnswerModel(session);
      const provider = this.getProviderByModel(model);

      const contextWindow = this.getModelContextWindow(model);

      // Extract user/session preferences
      const settings = session?.settings || {};
      const maxTokens =
        Number.isFinite(Number(settings.aiAnswerMaxTokens)) &&
        Number(settings.aiAnswerMaxTokens) > 0
          ? Math.min(4000, Math.floor(Number(settings.aiAnswerMaxTokens)))
          : undefined;
      const temperature =
        Number.isFinite(Number(settings.aiAnswerTemperature)) &&
        Number(settings.aiAnswerTemperature) >= 0
          ? Math.min(2, Math.max(0, Number(settings.aiAnswerTemperature)))
          : undefined;

      const { systemPrompt, prompt } = this.buildAnswerPrompts(
        session,
        question,
        draft,
        { contextWindow }
      );

      const callOnce = async (userPrompt) => {
        const opts = {
          systemPrompt,
          temperature,
          max_tokens: maxTokens,
          top_p: 0.9,
        };
        switch (provider) {
          case "openai":
            return await this.callOpenAI(model, userPrompt, opts);
          case "anthropic":
            return await this.callAnthropic(model, userPrompt, opts);
          case "groq":
            return await this.callGroq(model, userPrompt, opts);
          case "cerebras":
            return await this.callCerebras(model, userPrompt, opts);
          default:
            throw new Error(`Unsupported provider for model: ${model}`);
        }
      };

      let response = await callOnce(prompt);
      const check1 = this.validateAnswerFormat(response?.content);
      if (!check1.ok) {
        response = await callOnce(
          `${prompt}\n\nFormat incorrect. Return again with required format only.`
        );
      }

      // Optional hook for a future second pass tone refinement.
      response.content = await this.refineToneSecondPass(
        session,
        question,
        response.content,
        { enabled: false, model, provider }
      );

      return response;
    } catch (error) {
      console.error("AI Answer Error:", error);
      throw new Error(`Failed to generate answer: ${error.message}`);
    }
  }

  async *streamAnswer(session, question, draft = "", options = {}) {
    const model = this.getAnswerModel(session);
    const provider = this.getProviderByModel(model);

    const contextWindow = this.getModelContextWindow(model);
    const { systemPrompt, prompt } = this.buildAnswerPrompts(
      session,
      question,
      draft,
      { contextWindow }
    );

    switch (provider) {
      case "openai":
        yield* this.streamOpenAI(model, prompt, {
          ...options,
          systemPrompt,
          temperature: 0.35,
          top_p: 0.9,
          max_tokens: 700,
        });
        break;
      case "groq":
        yield* this.streamGroq(model, prompt, {
          ...options,
          systemPrompt,
          temperature: 0.35,
          top_p: 0.9,
          max_tokens: 700,
        });
        break;
      case "anthropic":
      case "cerebras":
      default: {
        const resp = await this.generateAnswer(session, question, draft);
        yield String(resp?.content || "");
      }
    }
  }

  // Streaming response for real-time chat
  async *streamResponse(model, prompt, options = {}) {
    const provider = this.getProviderByModel(model);

    switch (provider) {
      case "openai":
        yield* this.streamOpenAI(model, prompt, options);
        break;
      case "groq":
        yield* this.streamGroq(model, prompt, options);
        break;
      default: {
        // Fallback to non-streaming for other providers
        const response = await this.generateInterviewQuestion(
          {
            settings: { aiModel: model },
          },
          prompt
        );
        yield response.content;
      }
    }
  }

  async *streamOpenAI(model, prompt, options = {}) {
    const config = this.providers.openai;
    const url = `${config.baseURL}/chat/completions`;

    const messages = [];
    if (options.systemPrompt) {
      messages.push({ role: "system", content: options.systemPrompt });
    }
    messages.push({ role: "user", content: prompt });

    const response = await fetch(url, {
      method: "POST",
      headers: config.headers(process.env.OPENAI_API_KEY),
      body: JSON.stringify({
        model,
        messages,
        temperature: options.temperature || 0.7,
        top_p:
          typeof options.top_p === "number" && Number.isFinite(options.top_p)
            ? options.top_p
            : undefined,
        max_tokens: options.max_tokens || 1000,
        stream: true,
      }),
      signal: options.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(text || `OpenAI stream failed (${response.status})`);
    }

    if (typeof options.onResponse === "function") {
      try {
        options.onResponse({ provider: "openai", model, response });
      } catch {
        // ignore
      }
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        let lineEnd;
        while ((lineEnd = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, lineEnd).trimEnd();
          buffer = buffer.slice(lineEnd + 1);

          if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;

          const payload = line.slice(6).trim();
          if (!payload) continue;

          try {
            const data = JSON.parse(payload);
            if (data.choices[0]?.delta?.content) {
              yield data.choices[0].delta.content;
            }
          } catch {
            // ignore
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async *streamGroq(model, prompt, options = {}) {
    const config = this.providers.groq;
    const url = `${config.baseURL}/chat/completions`;

    const messages = [];
    if (options.systemPrompt) {
      messages.push({ role: "system", content: options.systemPrompt });
    }
    messages.push({ role: "user", content: prompt });

    const groqModel =
      model === "llama-3.1-8b"
        ? "llama-3.1-8b-instant"
        : model === "llama-3.3-70b"
          ? "llama-3.3-70b-versatile"
          : model;

    const maxRetries = Number.isFinite(Number(options.retries))
      ? Number(options.retries)
      : 2;

    let response;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      response = await fetch(url, {
        method: "POST",
        headers: config.headers(process.env.GROQ_API_KEY),
        body: JSON.stringify({
          model: groqModel,
          messages,
          temperature: options.temperature || 0.7,
          top_p:
            typeof options.top_p === "number" && Number.isFinite(options.top_p)
              ? options.top_p
              : undefined,
          max_tokens: options.max_tokens || 1000,
          stream: true,
          // best default for interactive apps; Groq ignores if unsupported
          service_tier: options.service_tier || "on_demand",
        }),
        signal: options.signal,
      });

      if (response.ok) break;

      const status = response.status;
      const text = await response.text().catch(() => "");
      const canRetry =
        attempt < maxRetries && this.isTransientHttpStatus(status);

      if (canRetry) {
        const base = 300;
        const backoff = base * Math.pow(2, attempt);
        const jitter = Math.floor(Math.random() * 120);
        await this.sleep(backoff + jitter);
        continue;
      }

      throw new Error(text || `Groq stream failed (${status})`);
    }

    if (!response || !response.ok) {
      throw new Error("Groq stream failed");
    }

    if (typeof options.onResponse === "function") {
      try {
        options.onResponse({ provider: "groq", model: groqModel, response });
      } catch {
        // ignore
      }
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        let lineEnd;
        while ((lineEnd = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, lineEnd).trimEnd();
          buffer = buffer.slice(lineEnd + 1);

          if (!line.startsWith("data: ")) continue;
          if (line.includes("[DONE]")) continue;

          const payload = line.slice(6).trim();
          if (!payload) continue;

          try {
            const data = JSON.parse(payload);
            const delta = data?.choices?.[0]?.delta?.content;
            if (delta) yield delta;
          } catch {
            // ignore
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

export default new AIService();
