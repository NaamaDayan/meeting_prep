import OpenAI from "openai";
import { resolveEnvSecret } from "./secrets.js";

let client;

async function getOpenAiKey() {
  const k = await resolveEnvSecret("OPENAI_API_KEY");
  return typeof k === "string" ? k.trim() : "";
}

async function hasOpenAiKey() {
  const k = await getOpenAiKey();
  return typeof k === "string" && k.trim().length > 0;
}

async function getClient() {
  const apiKey = await getOpenAiKey();
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  if (!client) {
    client = new OpenAI({ apiKey });
  }
  return client;
}

function mockResolvePerson({ displayName, email }) {
  return {
    linkedinUrl: "",
    company: "",
    summary: `[Mock — no OPENAI_API_KEY] Placeholder profile for ${displayName} (${email}). Configure OPENAI_API_KEY for AI-enriched summaries.`,
  };
}

function mockMeetingPrep({ title, startIso, participantsResolved }) {
  const names = participantsResolved.map((p) => p.displayName || p.email || "Guest").join(", ");
  return {
    participantsInfo: `[Mock — no OPENAI_API_KEY]\n\nPlanned attendees: ${names || "None listed"}.\nMeeting: ${title}\nStart: ${startIso || "unknown"}\n\nSet OPENAI_API_KEY to generate real prep content.`,
    agenda: `• [Mock] Opening and goals\n• [Mock] Discussion topics\n• [Mock] Next steps`,
    questionsBefore: `• [Mock] What outcome do we want from this meeting?\n• [Mock] What context should everyone have beforehand?`,
    questionsInMeeting: `• [Mock] What blockers need resolution?\n• [Mock] Who owns follow-up items?`,
  };
}

export async function resolvePersonWithLLM({ displayName, email, searchContext }) {
  if (!(await hasOpenAiKey())) {
    return mockResolvePerson({ displayName, email });
  }

  const c = await getClient();
  const prompt = `You help enrich a meeting participant from web snippets.
Return a JSON object ONLY with keys: linkedinUrl (string or empty), company (string or empty), summary (2-4 sentences, professional).
Participant: ${displayName} <${email}>
Snippets:
${searchContext}`;

  const res = await c.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    temperature: 0.2,
    messages: [
      { role: "system", content: "Respond with valid JSON only. No markdown." },
      { role: "user", content: prompt },
    ],
    max_tokens: 400,
  });
  const text = res.choices[0]?.message?.content || "{}";
  try {
    return JSON.parse(text.replace(/^```json\s*/i, "").replace(/```\s*$/i, ""));
  } catch {
    return { linkedinUrl: "", company: "", summary: text.slice(0, 800) };
  }
}

export async function generateMeetingPrep({ title, startIso, participantsResolved }) {
  if (!(await hasOpenAiKey())) {
    return mockMeetingPrep({ title, startIso, participantsResolved });
  }

  const c = await getClient();
  const lines = participantsResolved
    .map(
      (p) =>
        `- ${p.displayName} <${p.email}> — ${p.company || "Unknown company"}. ${p.summary || ""} LinkedIn: ${p.linkedinUrl || "n/a"}`
    )
    .join("\n");

  const prompt = `Create meeting preparation as JSON ONLY with keys:
participantsInfo (string, markdown-ish paragraphs summarizing who is attending),
agenda (string, bullet list),
questionsBefore (string, bullet list),
questionsInMeeting (string, bullet list).
Meeting title: ${title}
Start: ${startIso || "unknown"}
Participants:
${lines}`;

  const res = await c.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    temperature: 0.35,
    messages: [
      { role: "system", content: "Output valid JSON only. No markdown fences." },
      { role: "user", content: prompt },
    ],
    max_tokens: 2000,
  });
  const text = res.choices[0]?.message?.content || "{}";
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^```json\s*/i, "").replace(/```\s*$/i, ""));
  } catch {
    parsed = {
      participantsInfo: text,
      agenda: "",
      questionsBefore: "",
      questionsInMeeting: "",
    };
  }
  return {
    participantsInfo: String(parsed.participantsInfo || ""),
    agenda: String(parsed.agenda || ""),
    questionsBefore: String(parsed.questionsBefore || ""),
    questionsInMeeting: String(parsed.questionsInMeeting || ""),
  };
}

/**
 * Rich participant + company blurbs for sidebar cards (separate from resolvePerson summary).
 * @param {{ displayName: string, email: string, company?: string, linkedinUrl?: string, searchContext: string }} p
 */
export async function generateParticipantDeepInsight(p) {
  const displayName = String(p.displayName || "").trim() || "Unknown";
  const email = String(p.email || "").trim();
  const company = String(p.company || "").trim();
  const linkedinUrl = String(p.linkedinUrl || "").trim();
  const searchContext = String(p.searchContext || "No search results.");

  if (!(await hasOpenAiKey())) {
    return {
      aboutPerson: `[Mock — no OPENAI_API_KEY] ${displayName} <${email}>. Add a key for AI-generated bios.`,
      aboutCompany: company ? `[Mock] Company context for ${company}.` : "",
      confidence: "low",
    };
  }

  const c = await getClient();
  const prompt = `You are preparing a meeting attendee brief. Use ONLY plausible professional inferences from the facts and snippets; if uncertain, say so briefly.

Return JSON ONLY with keys:
- aboutPerson (string, 2-5 sentences: role, background, why they may matter in a meeting)
- aboutCompany (string, 1-4 sentences about the organization if known from context; else empty string)
- confidence ("high"|"medium"|"low") — your confidence in the factual accuracy of the text

Facts:
Name: ${displayName}
Email: ${email}
Company (may be incomplete or guessed from email domain): ${company || "unknown"}
LinkedIn URL (user-verified if present): ${linkedinUrl || "none"}

Web/snippets:
${searchContext}`;

  const res = await c.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    temperature: 0.25,
    messages: [
      { role: "system", content: "Respond with valid JSON only. No markdown fences." },
      { role: "user", content: prompt },
    ],
    max_tokens: 600,
  });
  const text = res.choices[0]?.message?.content || "{}";
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^```json\s*/i, "").replace(/```\s*$/i, ""));
  } catch {
    return {
      aboutPerson: text.slice(0, 800),
      aboutCompany: "",
      confidence: "low",
    };
  }
  let conf = String(parsed.confidence || "medium").toLowerCase();
  if (!["high", "medium", "low"].includes(conf)) conf = "medium";
  return {
    aboutPerson: String(parsed.aboutPerson || "").trim(),
    aboutCompany: String(parsed.aboutCompany || "").trim(),
    confidence: conf,
  };
}
