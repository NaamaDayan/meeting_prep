import { createEnrichmentCache } from "./enrichmentCache.js";

const SERP_URL = "https://serpapi.com/search";

const ROLE_WORDS =
  /\b(manager|director|head|vp|vice president|vice-president|lead|chief|ceo|cto|cfo|coo|president|engineer|designer|analyst|consultant|founder|partner)\b/i;

const GENERIC_PATTERNS = [
  /zoominfo\.com/i,
  /rocketreach\.co/i,
  /spokeo\.com/i,
  /whitepages\.com/i,
  /peekyou\.com/i,
  /crunchbase\.com\/people/i,
  /linkedin\.com\/pub\/dir/i,
  /linkedin\.com\/directory/i,
];

const SOCIAL_HOST =
  /linkedin\.com|facebook\.com|twitter\.com|^https?:\/\/(www\.)?x\.com\/|instagram\.com/i;

function normalizeKeyPart(s) {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function personCacheKey(name, company) {
  return `person:${normalizeKeyPart(name)}|${normalizeKeyPart(company)}`;
}

function companyCacheKey(company) {
  return `company:${normalizeKeyPart(company)}`;
}

function normalizeLink(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    const path = u.pathname.replace(/\/$/, "") || "";
    return `${host}${path}`.toLowerCase();
  } catch {
    return String(url).toLowerCase();
  }
}

function organicToResult(item) {
  const link = item.link || item.url || "";
  return {
    title: String(item.title ?? ""),
    snippet: String(item.snippet ?? ""),
    link,
  };
}

/**
 * @param {string} q
 * @param {string} apiKey
 */
async function serpSearch(q, apiKey) {
  const url = new URL(SERP_URL);
  url.searchParams.set("engine", "google");
  url.searchParams.set("q", q);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("num", "10");
  const res = await fetch(url.toString());
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `SerpAPI HTTP ${res.status}`);
  }
  if (data.error) {
    throw new Error(String(data.error));
  }
  const organic = data.organic_results ?? [];
  return organic.map(organicToResult);
}

/**
 * @param {number} maxConcurrent
 */
function createLimiter(maxConcurrent) {
  let running = 0;
  /** @type {{ fn: () => Promise<any>, resolve: (v: any) => void, reject: (e: any) => void }[]} */
  const queue = [];
  function pump() {
    while (running < maxConcurrent && queue.length > 0) {
      const job = queue.shift();
      if (!job) break;
      running++;
      Promise.resolve()
        .then(job.fn)
        .then(
          (v) => {
            running--;
            job.resolve(v);
            pump();
          },
          (e) => {
            running--;
            job.reject(e);
            pump();
          }
        );
    }
  }
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      pump();
    });
}

/**
 * @param {{ title: string, snippet: string, link: string }} r
 * @param {{ companyNorm: string, otherCompanyNorms: string[] }} ctx
 */
function scoreResult(r, { companyNorm, otherCompanyNorms }) {
  const text = `${r.title} ${r.snippet} ${r.link}`.toLowerCase();
  const linkLower = r.link.toLowerCase();
  let score = 0;

  if (linkLower.includes("linkedin.com")) score += 3;

  if (companyNorm && companyNorm.length >= 2) {
    if (text.includes(companyNorm)) score += 2;
  }

  if (ROLE_WORDS.test(r.title) || ROLE_WORDS.test(r.snippet)) score += 1;

  for (const pattern of GENERIC_PATTERNS) {
    if (pattern.test(linkLower) || pattern.test(text)) {
      score -= 2;
      break;
    }
  }

  if (companyNorm) {
    for (const other of otherCompanyNorms) {
      if (!other || other === companyNorm || other.length < 3) continue;
      if (text.includes(other)) {
        score -= 3;
        break;
      }
    }
  }

  return score;
}

/**
 * @param {{ title: string, snippet: string, link: string }[]} topResults
 * @param {string} companyNorm
 */
function confidenceFromResults(topResults, companyNorm) {
  const hasLi = topResults.some((r) =>
    r.link.toLowerCase().includes("linkedin.com")
  );
  const textBlob = topResults
    .map((r) => `${r.title} ${r.snippet}`.toLowerCase())
    .join(" ");
  const companyHit =
    companyNorm && companyNorm.length >= 2 && textBlob.includes(companyNorm);

  if (hasLi && (companyHit || !companyNorm)) return "high";
  if (companyHit) return "medium";
  return "low";
}

/**
 * @param {{ title: string, snippet: string, link: string }} r
 * @param {Set<string>} seen
 * @param {unknown[]} allRawSources
 * @param {{ query: string, participant_name?: string, company?: string }} meta
 */
function pushRawSource(r, seen, allRawSources, meta) {
  const link = r.link;
  if (!link) return;
  const canon = normalizeLink(link);
  if (seen.has(canon)) return;
  seen.add(canon);
  allRawSources.push({
    ...meta,
    title: r.title,
    snippet: r.snippet,
    link,
  });
}

/**
 * @param {any} p
 * @param {any} ctx
 */
async function enrichOnePerson(p, ctx) {
  const name = String(p.name ?? "").trim();
  const company = String(p.company ?? "").trim();
  const linkedin = p.linkedin ? String(p.linkedin).trim() : "";

  if (!name) {
    return {
      name,
      company,
      ...(linkedin ? { linkedin } : {}),
      top_results: [],
      confidence: "low",
    };
  }

  const companyNorm = normalizeKeyPart(company);
  const cacheKey = personCacheKey(name, company);
  const { apiKey, limiter, cache, globalSeenLinks, allRawSources } = ctx;

  const otherCompanyNorms = ctx.allCompanyNorms.filter(
    (c) => c && c !== companyNorm
  );

  let queryResults = [];

  const cached = await cache.get(cacheKey);
  if (cached?.queries?.length) {
    queryResults = cached.queries;
  } else {
    const queries = [];
    if (company) {
      queries.push(`"${name}" ${company} LinkedIn`);
      queries.push(`"${name}" ${company}`);
      queries.push(`"${name}" role ${company}`);
    } else {
      queries.push(`"${name}"`);
      queries.push(`"${name}" LinkedIn`);
    }

    for (const q of queries) {
      try {
        const full = await limiter(() => serpSearch(q, apiKey));
        const forScore = full.slice(0, 5);
        queryResults.push({ query: q, results: forScore, full });
      } catch (e) {
        console.error("[enrichment] SerpAPI person query failed:", q, e.message);
        queryResults.push({ query: q, results: [], full: [] });
      }
    }

    const toStore = queryResults.map(({ query, results, full }) => ({
      query,
      results,
      full,
    }));
    await cache.set(cacheKey, { version: 1, queries: toStore });
  }

  for (const block of queryResults) {
    const fullList = block.full ?? block.results ?? [];
    for (const r of fullList) {
      pushRawSource(r, globalSeenLinks, allRawSources, {
        query: block.query,
        participant_name: name,
        ...(company ? { company } : {}),
      });
    }
  }

  const rawForScoring = [];
  for (const block of queryResults) {
    const list = block.results ?? block.full?.slice(0, 5) ?? [];
    for (const r of list) {
      rawForScoring.push(r);
    }
  }

  const byLink = new Map();
  for (const r of rawForScoring) {
    if (!r.link) continue;
    const canon = normalizeLink(r.link);
    const sc = scoreResult(r, { companyNorm, otherCompanyNorms });
    const prev = byLink.get(canon);
    if (!prev || sc > prev.score) {
      byLink.set(canon, {
        title: r.title,
        snippet: r.snippet,
        link: r.link,
        score: sc,
      });
    }
  }

  const sorted = [...byLink.values()].sort((a, b) => b.score - a.score);
  const top = sorted.slice(0, 5).map(({ title, snippet, link }) => ({
    title,
    snippet,
    link,
  }));

  const confidence = confidenceFromResults(top, companyNorm);

  return {
    name,
    company,
    ...(linkedin ? { linkedin } : {}),
    top_results: top,
    confidence,
  };
}

/**
 * @param {string} companyName
 * @param {any} ctx
 */
async function enrichOneCompany(companyName, ctx) {
  const name = String(companyName).trim();
  if (!name) {
    return {
      name,
      website: "",
      description: "",
      top_results: [],
    };
  }

  const cacheKey = companyCacheKey(name);
  const { apiKey, limiter, cache, globalSeenLinks, allRawSources } = ctx;
  let organic = [];

  const cached = await cache.get(cacheKey);
  if (cached?.organic?.length) {
    organic = cached.organic;
  } else {
    try {
      organic = await limiter(() => serpSearch(`"${name}"`, apiKey));
      await cache.set(cacheKey, { version: 1, organic });
    } catch (e) {
      console.error("[enrichment] SerpAPI company query failed:", name, e.message);
      return {
        name,
        website: "",
        description: "",
        top_results: [],
      };
    }
  }

  for (const r of organic) {
    pushRawSource(r, globalSeenLinks, allRawSources, {
      query: name,
      company: name,
    });
  }

  let website = "";
  let description = "";
  const topResults = organic.slice(0, 5).map((r) => ({
    title: r.title,
    snippet: r.snippet,
    link: r.link,
  }));

  for (const r of organic) {
    if (!r.link || SOCIAL_HOST.test(r.link)) continue;
    if (GENERIC_PATTERNS.some((p) => p.test(r.link))) continue;
    website = r.link;
    description = r.snippet || r.title || "";
    break;
  }

  return {
    name,
    website,
    description,
    top_results: topResults,
  };
}

/**
 * SerpAPI-backed enrichment: participants, unique companies, and deduped raw_sources (pre-ranking pool).
 * @param {unknown[] | undefined} participantsInput
 */
export async function enrichParticipants(participantsInput = []) {
  const participants = Array.isArray(participantsInput) ? participantsInput : [];
  const apiKey = process.env.SERPAPI_KEY?.trim();

  if (!apiKey) {
    return {
      participants: participants.map((p) => ({
        name: String(p.name ?? "").trim(),
        company: String(p.company ?? "").trim(),
        ...(p.linkedin ? { linkedin: String(p.linkedin).trim() } : {}),
        top_results: [],
        confidence: "low",
      })),
      companies: [],
      raw_sources: [],
      enrichment_skipped_reason: "SERPAPI_KEY is not set",
    };
  }

  const cache = createEnrichmentCache();
  const limiter = createLimiter(3);
  const globalSeenLinks = new Set();
  const allRawSources = [];
  const allCompanyNorms = [
    ...new Set(
      participants.map((p) => normalizeKeyPart(p.company)).filter(Boolean)
    ),
  ];

  const ctx = {
    apiKey,
    cache,
    limiter,
    globalSeenLinks,
    allRawSources,
    allCompanyNorms,
  };

  const enrichedPeople = [];
  for (const p of participants) {
    enrichedPeople.push(await enrichOnePerson(p, ctx));
  }

  const uniqueCompanies = [
    ...new Set(
      participants.map((p) => String(p.company ?? "").trim()).filter(Boolean)
    ),
  ];

  const enrichedCompanies = [];
  for (const c of uniqueCompanies) {
    enrichedCompanies.push(await enrichOneCompany(c, ctx));
  }

  return {
    participants: enrichedPeople,
    companies: enrichedCompanies,
    raw_sources: allRawSources,
  };
}
