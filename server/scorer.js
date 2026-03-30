/**
 * Score search hits for person resolution (higher is better).
 */

export function scoreSearchHit(queryName, queryEmail, hit) {
  let s = 0;
  const title = String(hit.title || "").toLowerCase();
  const snippet = String(hit.snippet || "").toLowerCase();
  const url = String(hit.url || "").toLowerCase();
  const local = String(queryEmail || "")
    .split("@")[0]
    .toLowerCase();
  const name = String(queryName || "").toLowerCase();

  if (name && title.includes(name)) s += 4;
  if (name && snippet.includes(name)) s += 2;
  if (url.includes("linkedin.com")) s += 3;
  if (local && (snippet.includes(local) || title.includes(local))) s += 1;
  return s;
}
