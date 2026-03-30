/**
 * Validates Google OAuth access tokens via userinfo; derives stable tenant id (`sub`).
 */

export async function verifyGoogleAccessToken(accessToken) {
  if (!accessToken) throw new Error("missing_token");
  const r = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`auth_failed:${r.status}:${t.slice(0, 200)}`);
  }
  const j = await r.json();
  const sub = j.sub;
  if (!sub) throw new Error("no_sub");
  return {
    sub: String(sub),
    email: j.email ? String(j.email) : "",
    name: j.name ? String(j.name) : "",
  };
}

export function authMiddleware() {
  return async function (req, res, next) {
    try {
      const h = req.headers.authorization || "";
      const m = h.match(/^Bearer\s+(.+)$/i);
      if (!m) {
        res.status(401).json({ error: "unauthorized", message: "Missing Bearer token" });
        return;
      }
      const user = await verifyGoogleAccessToken(m[1].trim());
      req.user = user;
      next();
    } catch (e) {
      res.status(401).json({ error: "unauthorized", message: String(e?.message || e) });
    }
  };
}
