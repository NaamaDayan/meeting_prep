import { searchWeb } from "./search.js";
import { scoreSearchHit } from "./scorer.js";
import { resolvePersonWithLLM } from "./openai.js";

export async function resolvePerson({ displayName, email }, cache) {
  const key = `person:${email}`;
  if (cache) {
    const hit = cache.get(key);
    if (hit) return hit;
  }

  const q = `${displayName} ${email} LinkedIn`;
  let hits = [];
  try {
    hits = await searchWeb(q, { maxResults: 6 });
  } catch {
    hits = [];
  }

  let best = hits[0] || null;
  let bestScore = -1;
  for (const h of hits) {
    const s = scoreSearchHit(displayName, email, h);
    if (s > bestScore) {
      bestScore = s;
      best = h;
    }
  }

  const searchContext = hits
    .slice(0, 5)
    .map((h) => `TITLE: ${h.title}\nURL: ${h.url}\n${h.snippet}`)
    .join("\n---\n");

  let enriched;
  try {
    enriched = await resolvePersonWithLLM({
      displayName,
      email,
      searchContext: searchContext || "No search results.",
    });
  } catch {
    enriched = { linkedinUrl: best?.url?.includes("linkedin") ? best.url : "", company: "", summary: "" };
  }

  const out = {
    email,
    displayName,
    linkedinUrl: enriched.linkedinUrl || "",
    company: enriched.company || "",
    summary: enriched.summary || "",
  };
  if (cache) cache.set(key, out);
  return out;
}
