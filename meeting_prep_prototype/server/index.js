import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import OpenAI from "openai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Use override: true so values in server/.env win over empty/mis-set shell vars
// (default dotenv behavior leaves existing process.env entries untouched).
const envPath = path.join(__dirname, ".env");
const envResult = dotenv.config({
  path: envPath,
  override: true,
});
if (envResult.error) {
  console.warn("[meeting_prep_prototype] Could not load .env:", envResult.error.message);
} else {
  console.log("[meeting_prep_prototype] Loaded env from", envPath);
}

/** Dedicated var so a shell `PORT` (e.g. 3847 for the main server) never collides. */
const PORT = Number(process.env.MEETING_PREP_PROTOTYPE_PORT) || 3851;
const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

function enrichParticipants(participants = []) {
  return participants.map((p) => {
    const name = p.name ?? "Unknown";
    if (p.linkedin) {
      return {
        name,
        role: "Head of Sales (mock)",
        background: "Worked in B2B SaaS (mock)",
      };
    }
    return {
      name,
      possible_match: true,
      confidence: "low",
      snippets: [
        `${name} — Sales at ${p.company ?? "their company"}`,
        "Mentioned in company site",
      ],
    };
  });
}

function enrichCompany() {
  return {
    description: "B2B SaaS company (mock)",
    stage: "growth",
    signals: ["hiring", "scaling"],
  };
}

function buildEnrichedContext(input) {
  const participants = Array.isArray(input?.participants)
    ? input.participants
    : [];
  return {
    participants: enrichParticipants(participants),
    company: enrichCompany(),
    generated_at: new Date().toISOString(),
  };
}

async function callLlm(userPrompt, input, enrichedContext) {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    const briefing = {
      placeholder: true,
      message:
        "No OPENAI_API_KEY set. This is a mock JSON shape for UI testing.",
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

  const client = new OpenAI({ apiKey });
  const system = `You are a meeting preparation assistant. Respond with ONLY valid JSON (no markdown fences). 
The JSON must be an object whose top-level keys are section titles for a briefing. Values should be strings, arrays of strings, or nested objects — never null. Be concise and actionable.`;

  const userContent = JSON.stringify({
    instructions: userPrompt,
    meeting_input: input,
    enriched_context: enrichedContext,
  });

  const completion = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: userContent },
    ],
    temperature: 0.5,
  });

  const text = completion.choices[0]?.message?.content ?? "{}";
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const err = new Error("LLM returned invalid JSON");
    err.raw_llm_text = text;
    throw err;
  }
  return { briefing: parsed, raw_llm_text: text };
}

app.post("/generate", async (req, res) => {
  try {
    const { prompt: userPrompt, input } = req.body ?? {};
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

    const enriched_context = buildEnrichedContext(parsedInput);

    let briefing = null;
    let llm_error = null;
    let raw_llm_text = null;
    try {
      const out = await callLlm(userPrompt, parsedInput, enriched_context);
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

app.get("/health", (_, res) =>
  res.json({
    ok: true,
    service: "meeting_prep_prototype",
    version: 2,
    openai_configured: Boolean(process.env.OPENAI_API_KEY?.trim()),
  })
);

app.listen(PORT, () => {
  const hasKey = Boolean(process.env.OPENAI_API_KEY?.trim());
  console.log(`Meeting prep prototype API http://localhost:${PORT}`);
  console.log(
    hasKey
      ? "OpenAI: API key loaded from server/.env"
      : "OpenAI: no API key — briefings use mock JSON"
  );
});
