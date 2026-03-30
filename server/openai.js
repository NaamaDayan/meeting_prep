import OpenAI from "openai";

let client;

function hasOpenAiKey() {
  const k = process.env.OPENAI_API_KEY;
  return typeof k === "string" && k.trim().length > 0;
}

function getClient() {
  if (!hasOpenAiKey()) throw new Error("OPENAI_API_KEY is not set");
  if (!client) {
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY.trim() });
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
  if (!hasOpenAiKey()) {
    return mockResolvePerson({ displayName, email });
  }

  const c = getClient();
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
  if (!hasOpenAiKey()) {
    return mockMeetingPrep({ title, startIso, participantsResolved });
  }

  const c = getClient();
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
