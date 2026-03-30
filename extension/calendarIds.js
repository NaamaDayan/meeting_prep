/**
 * Shared Calendar event identity helpers (content script + service worker via importScripts).
 * Normalizes URL fragments, base64 eid blobs, and DOM ids into API-style opaque ids where possible.
 */
(function (g) {
  const root = g || (typeof self !== "undefined" ? self : globalThis);

  function b64urlDecode(s) {
    if (!s) return null;
    try {
      let t = String(s).trim().replace(/-/g, "+").replace(/_/g, "/");
      const pad = (4 - (t.length % 4)) % 4;
      t += "=".repeat(pad);
      const bin = atob(t);
      try {
        const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
        return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      } catch {
        return bin;
      }
    } catch {
      return null;
    }
  }

  function looksLikeApiEventId(s) {
    if (!s || typeof s !== "string") return false;
    const t = s.trim();
    if (t.length < 10 || t.length > 280) return false;
    return /^[a-z0-9_-]+$/i.test(t);
  }

  function extractTokensFromDecodedString(decoded) {
    if (!decoded) return [];
    const out = [];
    const flat = String(decoded).replace(/\0/g, " ");
    const parts = flat.split(/[\s\u0000,;|]+/).map((x) => x.trim()).filter(Boolean);
    for (const p of parts) {
      if (looksLikeApiEventId(p)) out.push(p);
      const at = p.split("@")[0];
      if (at && looksLikeApiEventId(at)) out.push(at);
    }
    const re = /[a-z0-9][a-z0-9_-]{9,}/gi;
    let m;
    while ((m = re.exec(flat))) {
      if (looksLikeApiEventId(m[0])) out.push(m[0]);
    }
    return [...new Set(out)];
  }

  /**
   * Flatten raw strings (paths, eid params, base64, etc.) into unique candidate ids.
   */
  function mergeCandidateIds(strings) {
    const out = [];
    const seen = new Set();

    function pushOne(t) {
      if (!t) return;
      const s = String(t).trim();
      if (!s || s.length > 512) return;
      const low = s.toLowerCase();
      if (seen.has(low)) return;
      seen.add(low);
      out.push(s);
    }

    function expand(s) {
      pushOne(s);
      try {
        const d = decodeURIComponent(s);
        if (d !== s) pushOne(d);
      } catch {
        /* ignore */
      }
      const decoded = b64urlDecode(s);
      if (decoded) {
        for (const x of extractTokensFromDecodedString(decoded)) pushOne(x);
      }
      for (const x of extractTokensFromDecodedString(s)) pushOne(x);
    }

    for (const raw of strings || []) {
      if (raw == null) continue;
      expand(raw);
    }
    return out;
  }

  function collectFromHref(href, baseOrigin) {
    const raw = [];
    try {
      const u = new URL(href, baseOrigin || "https://calendar.google.com");
      const eid = u.searchParams.get("eid") || u.searchParams.get("ei");
      if (eid) raw.push(decodeURIComponent(eid));
      const path = u.pathname.match(/\/eventedit\/([^/?]+)/);
      if (path) raw.push(decodeURIComponent(path[1]));
    } catch {
      /* ignore */
    }
    return raw;
  }

  /**
   * Optional: extra aliases from a Calendar API event resource.
   */
  function aliasesFromApiEvent(ev) {
    if (!ev) return [];
    const ids = [ev.id, ev.recurringEventId].filter(Boolean);
    if (ev.iCalUID) {
      ids.push(ev.iCalUID);
      const local = String(ev.iCalUID).split("@")[0];
      if (local && local !== ev.iCalUID) ids.push(local);
    }
    return [...new Set(ids.map(String))];
  }

  root.MPID = {
    b64urlDecode,
    looksLikeApiEventId,
    extractTokensFromDecodedString,
    mergeCandidateIds,
    collectFromHref,
    aliasesFromApiEvent,
  };
})(typeof self !== "undefined" ? self : globalThis);
