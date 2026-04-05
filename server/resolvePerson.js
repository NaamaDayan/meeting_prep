import { searchWeb } from "./search.js";
import { scoreSearchHit } from "./scorer.js";
import { resolvePersonWithLLM } from "./openai.js";

/**
 * @param {number} bestScore
 * @param {string} linkedinUrl
 * @returns {"high"|"medium"|"low"}
 */
export function computeConfidenceFromSignals(bestScore, linkedinUrl) {
  const li = String(linkedinUrl || "").toLowerCase().includes("linkedin.com");
  if (bestScore >= 7 && li) return "high";
  if (bestScore >= 4 || li) return "medium";
  return "low";
}

export async function resolvePerson({ displayName, email }, cache) {
  const key = `person:${email}`;
  if (cache) {
    const hit = cache.get(key);
    if (hit) {
      if (hit.confidence) return hit;
      const migrated = {
        ...hit,
        confidence: computeConfidenceFromSignals(0, hit.linkedinUrl || ""),
      };
      cache.set(key, migrated);
      return migrated;
    }
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

  const linkedinUrl = enriched.linkedinUrl || "";
  const confidence = computeConfidenceFromSignals(bestScore, linkedinUrl);

  const out = {
    email,
    displayName,
    linkedinUrl,
    company: enriched.company || "",
    summary: enriched.summary || "",
    confidence,
  };
  if (cache) cache.set(key, out);
  return out;
}
