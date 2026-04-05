/**
 * Web search via Tavily (preferred) or SerpAPI fallback.
 */
import { resolveEnvSecret } from "./secrets.js";

export async function searchWeb(query, opts = {}) {
  const { maxResults = 6 } = opts;
  const tavily = await resolveEnvSecret("TAVILY_API_KEY");
  const serp = await resolveEnvSecret("SERPAPI_KEY");

  if (tavily) {
    const r = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: tavily,
        query,
        search_depth: "basic",
        max_results: maxResults,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error(`Tavily HTTP ${r.status}`);
    const j = await r.json();
    const results = (j.results || []).map((x) => ({
      title: x.title,
      url: x.url,
      snippet: x.content || x.snippet || "",
    }));
    return results;
  }

  if (serp) {
    const u = new URL("https://serpapi.com/search.json");
    u.searchParams.set("engine", "google");
    u.searchParams.set("q", query);
    u.searchParams.set("api_key", serp);
    u.searchParams.set("num", String(maxResults));
    const r = await fetch(u.toString(), { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`SerpAPI HTTP ${r.status}`);
    const j = await r.json();
    const organic = j.organic_results || [];
    return organic.map((x) => ({
      title: x.title,
      url: x.link,
      snippet: x.snippet || "",
    }));
  }

  return [
    {
      title: `Search not configured for: ${query.slice(0, 80)}`,
      url: "https://example.com",
      snippet:
        "Set TAVILY_API_KEY or SERPAPI_KEY for live web search. Using placeholder context.",
    },
  ];
}
