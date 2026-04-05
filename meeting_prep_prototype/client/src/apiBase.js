/**
 * Local dev: leave VITE_API_BASE_URL unset — Vite proxies `/generate` and `/health`.
 * Production (S3): set VITE_API_BASE_URL to your API Gateway invoke URL (no trailing slash).
 */
const raw = import.meta.env.VITE_API_BASE_URL ?? "";
/** Trailing slashes stripped; whitespace trimmed. Empty = same-origin (Vite dev proxy only). */
const base = String(raw).trim().replace(/\/+$/, "");

export function apiUrl(path) {
  const p = path.startsWith("/") ? path : `/${path}`;
  return base ? `${base}${p}` : p;
}

/** For UI/debug: where POST /generate will go. */
export function apiBaseResolved() {
  return base;
}
