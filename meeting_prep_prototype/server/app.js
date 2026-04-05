import Anthropic from "@anthropic-ai/sdk";
import cors from "cors";
import express from "express";
import OpenAI from "openai";
import { enrichParticipants as runSerpEnrichment } from "./enrichmentService.js";
import { resolveAnthropicApiKey } from "./resolveAnthropicApiKey.js";
import { resolveOpenAiApiKey } from "./resolveOpenAiKey.js";

function enrichmentCacheMode() {
  return process.env.ENRICHMENT_CACHE_TABLE?.trim() ? "dynamo" : "file";
}

const BRIEFING_SYSTEM = `You are a meeting preparation assistant. The user message includes instructions and a required OUTPUT FORMAT (JSON schema) for the briefing.

Respond with ONLY valid JSON (no markdown fences). Follow the top-level keys, nesting, and value types defined in those instructions. Do not omit required top-level sections; use empty strings or empty arrays where you have no content instead of null. Be concise and actionable.`;

function stripMarkdownJsonFence(text) {
  let t = String(text ?? "").trim();
  const fence =
    /^```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?```\s*$/im;
  const m = t.match(fence);
  if (m) return m[1].trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/s, "").trim();
  }
  return t;
}

function parseBriefingJson(text) {
  const trimmed = String(text ?? "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    try {
      return JSON.parse(stripMarkdownJsonFence(trimmed));
    } catch {
      const err = new Error("LLM returned invalid JSON");
      err.raw_llm_text = text;
      throw err;
    }
  }
}

function anthropicMessageText(msg) {
  const blocks = msg?.content;
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/**
 * @param {string} userPrompt
 * @param {object} input
 * @param {object} enrichedContext
 * @param {{ provider: 'openai' | 'anthropic', model: string, apiKey: string | null }} opts
 */
async function callLlm(userPrompt, input, enrichedContext, opts) {
  const { provider, model, apiKey } = opts;

  if (!apiKey) {
    const label =
      provider === "anthropic" ? "Anthropic (Claude)" : "OpenAI";
    const briefing = {
      placeholder: true,
      message: `No API key for ${label}. Set llm_api_key in the UI or configure the server environment. This is a mock JSON shape for UI testing.`,
      agenda_highlights: [
        "Confirm goals and success criteria",
        "Align on timeline and stakeholders",
      ],
      talking_points: [
        `Reference ${input?.user?.company ?? "your company"} context`,
        "Ask about their current process and pain points",
      ],
      risks_and_unknowns: [
        "Budget and procurement path unclear",
        "Champion vs economic buyer not confirmed",
      ],
      suggested_questions: [
        "What does a successful outcome look like in 90 days?",
        "Who else needs to be involved in evaluation?",
      ],
    };
    return {
      briefing,
      raw_llm_text: JSON.stringify(briefing, null, 2),
    };
  }

  const userContent = JSON.stringify({
    instructions: userPrompt,
    meeting_input: input,
    enriched_context: enrichedContext,
  });

  if (provider === "anthropic") {
    const client = new Anthropic({ apiKey });
    const msg = await client.messages.create({
      model,
      max_tokens: 8192,
      system: BRIEFING_SYSTEM,
      messages: [{ role: "user", content: userContent }],
      temperature: 0.5,
    });
    const text = anthropicMessageText(msg) || "{}";
    const parsed = parseBriefingJson(text);
    return { briefing: parsed, raw_llm_text: text };
  }

  const client = new OpenAI({ apiKey });
  const completion = await client.chat.completions.create({
    model,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: BRIEFING_SYSTEM },
      { role: "user", content: userContent },
    ],
    temperature: 0.5,
  });

  const text = completion.choices[0]?.message?.content ?? "{}";
  const parsed = parseBriefingJson(text);
  return { briefing: parsed, raw_llm_text: text };
}

/**
 * @param {string | undefined} raw
 * @returns {'openai' | 'anthropic'}
 */
function normalizeLlmProvider(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s === "anthropic" || s === "claude") return "anthropic";
  return "openai";
}

async function resolveLlmApiKey(provider, bodyKey) {
  const trimmed = typeof bodyKey === "string" ? bodyKey.trim() : "";
  if (trimmed) return trimmed;
  if (provider === "anthropic") return resolveAnthropicApiKey();
  return resolveOpenAiApiKey();
}

export function createApp() {
  const app = express();
  app.use(
    cors({
      origin: true,
      credentials: true,
    })
  );
  app.use(express.json({ limit: "2mb" }));

  async function buildEnrichedContext(input) {
    const participants = Array.isArray(input?.participants)
      ? input.participants
      : [];
    const base = await runSerpEnrichment(participants);
    return {
      ...base,
      generated_at: new Date().toISOString(),
    };
  }

  app.post("/generate", async (req, res) => {
    try {
      const {
        prompt: userPrompt,
        input,
        llm_provider,
        llm_model,
        llm_api_key,
      } = req.body ?? {};
      if (typeof userPrompt !== "string") {
        return res.status(400).json({ error: "Missing string field: prompt" });
      }
      let parsedInput = input;
      if (typeof input === "string") {
        try {
          parsedInput = JSON.parse(input);
        } catch {
          return res.status(400).json({ error: "input must be valid JSON" });
        }
      }
      if (parsedInput == null || typeof parsedInput !== "object") {
        return res.status(400).json({ error: "Missing object field: input" });
      }

      const provider = normalizeLlmProvider(llm_provider);
      const modelFromBody =
        typeof llm_model === "string" ? llm_model.trim() : "";
      const model =
        modelFromBody ||
        (provider === "openai"
          ? process.env.OPENAI_MODEL || "gpt-4o-mini"
          : "claude-3-5-haiku-20241022");

      const apiKey = await resolveLlmApiKey(provider, llm_api_key);

      const enriched_context = await buildEnrichedContext(parsedInput);

      let briefing = null;
      let llm_error = null;
      let raw_llm_text = null;
      try {
        const out = await callLlm(userPrompt, parsedInput, enriched_context, {
          provider,
          model,
          apiKey,
        });
        briefing = out.briefing;
        raw_llm_text = out.raw_llm_text;
      } catch (e) {
        llm_error = e.message || String(e);
        raw_llm_text = e.raw_llm_text ?? null;
      }

      res.json({
        enriched_context,
        briefing,
        llm_error,
        raw_llm_text,
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message || "Server error" });
    }
  });

  app.get("/health", async (_, res) => {
    let key = null;
    try {
      key = await resolveOpenAiApiKey();
    } catch (e) {
      console.error("[health] resolveOpenAiApiKey:", e.message || e);
    }
    res.json({
      ok: true,
      service: "meeting_prep_prototype",
      version: 3,
      openai_configured: Boolean(key),
      anthropic_configured: Boolean(resolveAnthropicApiKey()),
      serpapi_configured: Boolean(process.env.SERPAPI_KEY?.trim()),
      enrichment_cache: enrichmentCacheMode(),
    });
  });

  return app;
}
