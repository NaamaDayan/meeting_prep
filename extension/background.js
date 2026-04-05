importScripts("calendarIds.js", "runtimeConfig.js", "workspaceSettingsShared.js");

/**
 * Meeting Prep — service worker: OAuth, Calendar API, backend HTTP, message router.
 * Content script never talks to the server or Calendar API directly.
 */

const PREP_CACHE_KEY = "mp_prep_cache_v1";
const MAX_CACHE_EVENTS = 200;
const PROACTIVE_ALARM = "mp_prep_proactive_sync";
const NEGATIVE_CACHE_MS = 120000;

const MSG = {
  PREP_MEETING: "PREP_MEETING",
  AUTO_SYNC_EVENT: "AUTO_SYNC_EVENT",
  FETCH_EVENT: "FETCH_EVENT",
  SAVE_PREP_EDITS: "SAVE_PREP_EDITS",
  SAVE_PARTICIPANT_FIX: "SAVE_PARTICIPANT_FIX",
  REFRESH_PREP_CACHE: "REFRESH_PREP_CACHE",
  SEND_EMAIL: "SEND_EMAIL",
  WORKSPACE_SETTINGS_GET: "WORKSPACE_SETTINGS_GET",
  WORKSPACE_SETTINGS_SAVE: "WORKSPACE_SETTINGS_SAVE",
  OPEN_WORKSPACE_SETTINGS: "OPEN_WORKSPACE_SETTINGS",
  OPEN_BRIEFING_PREVIEW: "OPEN_BRIEFING_PREVIEW",
  STASH_BRIEFING_PREVIEW: "STASH_BRIEFING_PREVIEW",
  PREP_SESSION_SYNC: "PREP_SESSION_SYNC",
  PARTICIPANT_REGENERATE: "PARTICIPANT_REGENERATE",
};

async function getBaseUrl() {
  const settings = await MeetingPrepConfig.load();
  return settings.activeBaseUrl;
}

async function getAuthToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: !!interactive }, (token) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(token);
    });
  });
}

/** Prefer cached token so Calendar + backend flows don't block on OAuth unless needed. */
async function getAuthTokenPreferCached() {
  try {
    return await getAuthToken(false);
  } catch {
    return await getAuthToken(true);
  }
}

async function removeCachedAuthToken() {
  return new Promise((resolve) => {
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
      if (token) chrome.identity.removeCachedAuthToken({ token }, () => resolve());
      else resolve();
    });
  });
}

async function fetchUserIdentity(accessToken) {
  const r = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) throw new Error(`userinfo failed: ${r.status}`);
  return r.json();
}

/**
 * Gmail send uses launchWebAuthFlow. The Chrome-extension-type OAuth client does NOT accept
 * that redirect_uri for this flow — use a separate "Web application" client ID (see options page)
 * with Authorized redirect URI = chrome.identity.getRedirectURL() exactly.
 */
async function getGmailWebOAuthClientId() {
  const { meetingPrepGmailWebClientId } = await chrome.storage.sync.get("meetingPrepGmailWebClientId");
  const id = String(meetingPrepGmailWebClientId || "").trim();
  if (id) return id;
  return chrome.runtime.getManifest().oauth2.client_id;
}

/**
 * Gmail send scope is NOT in manifest oauth2.scopes so "Prep meeting" never waits on Gmail consent.
 * User authorizes Gmail only when sending email (separate token via web auth flow).
 */
/** Scopes for Send Briefing: send mail + read account email (same token). `gmail.send` alone does NOT allow `users/me/profile` → 403. */
const GMAIL_SEND_AUTH_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

async function getGmailAccessTokenViaWebAuthFlow() {
  const clientId = await getGmailWebOAuthClientId();
  const redirectUri = chrome.identity.getRedirectURL();
  const scope = encodeURIComponent(GMAIL_SEND_AUTH_SCOPES);
  const authUrl =
    `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${encodeURIComponent(clientId)}` +
    `&response_type=token` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${scope}`;
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, (redirectedTo) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      if (!redirectedTo) {
        reject(new Error("no_redirect"));
        return;
      }
      try {
        const u = new URL(redirectedTo);
        const oauthErr = u.searchParams.get("error");
        if (oauthErr) {
          reject(new Error(u.searchParams.get("error_description") || oauthErr));
          return;
        }
        const frag = u.hash && u.hash.startsWith("#") ? u.hash.slice(1) : "";
        const params = new URLSearchParams(frag);
        const token = params.get("access_token");
        if (!token) reject(new Error("no_access_token"));
        else resolve(token);
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function fetchSenderEmailForGmail(accessToken) {
  const r = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) {
    const hint = r.status === 403 ? " (add userinfo.email to this client’s scopes / re-authorize)" : "";
    throw new Error(`userinfo failed: ${r.status}${hint}`);
  }
  const j = await r.json();
  return normalizeEmail(j.email || "");
}

function base64UrlEncodeBytes(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = btoa(bin);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * Gmail API expects a base64url-encoded RFC 822 message (UTF-8).
 */
function buildGmailRawMessage({ fromEmail, toEmails, subject, bodyText }) {
  const to = (toEmails || []).map((e) => normalizeEmail(e)).filter(Boolean).join(", ");
  const subj = String(subject || "").replace(/\r?\n/g, " ").trim();
  const from = normalizeEmail(fromEmail) || "me";
  const body = String(bodyText || "").replace(/\r\n/g, "\n");

  const msg =
    `From: ${from}\r\n` +
    `To: ${to}\r\n` +
    `Subject: ${subj}\r\n` +
    "MIME-Version: 1.0\r\n" +
    'Content-Type: text/plain; charset=UTF-8\r\n' +
    "Content-Transfer-Encoding: 8bit\r\n" +
    "\r\n" +
    body;

  return base64UrlEncodeBytes(new TextEncoder().encode(msg));
}

async function gmailSendMessage(accessToken, raw) {
  const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`gmail send failed: ${r.status} ${t}`);
  }
  return r.json();
}

async function handleSendEmail(payload) {
  const toEmails = Array.isArray(payload?.toEmails) ? payload.toEmails : [];
  const subject = String(payload?.subject || "").trim();
  const bodyText = String(payload?.body || "").trim();
  if (!toEmails.length) return { ok: false, error: "no_recipients" };
  if (!subject) return { ok: false, error: "no_subject" };
  if (!bodyText) return { ok: false, error: "no_body" };

  const accessToken = await getGmailAccessTokenViaWebAuthFlow();
  const fromEmail = await fetchSenderEmailForGmail(accessToken);
  const raw = buildGmailRawMessage({ fromEmail, toEmails, subject, bodyText });
  const sent = await gmailSendMessage(accessToken, raw);
  return { ok: true, id: sent?.id || null };
}

function normalizeEmail(e) {
  return String(e || "")
    .trim()
    .toLowerCase();
}

function isLowQualityDisplayName(name, email) {
  const n = String(name || "").trim();
  if (!n) return true;
  const local = (email || "").split("@")[0] || "";
  if (n.toLowerCase() === local.toLowerCase()) return true;
  if (/^user\d+$/i.test(n)) return true;
  return false;
}

/**
 * Merge DOM snapshot with Calendar API attendees: prefer UI name when API name is low-quality.
 */
function mergeParticipants(domList, apiList, organizerEmail) {
  const org = normalizeEmail(organizerEmail);
  const byEmail = new Map();

  for (const p of domList || []) {
    const em = normalizeEmail(p.email);
    if (!em) continue;
    byEmail.set(em, {
      email: em,
      displayName: String(p.displayName || "").trim() || em.split("@")[0],
    });
  }

  for (const p of apiList || []) {
    const em = normalizeEmail(p.email);
    if (!em) continue;
    const existing = byEmail.get(em);
    const apiName = String(p.displayName || "").trim();
    if (!existing) {
      byEmail.set(em, {
        email: em,
        displayName: apiName || em.split("@")[0],
      });
    } else {
      if (isLowQualityDisplayName(apiName, em) && !isLowQualityDisplayName(existing.displayName, em)) {
        // keep UI
      } else if (apiName && (!existing.displayName || isLowQualityDisplayName(existing.displayName, em))) {
        existing.displayName = apiName;
      }
    }
  }

  const out = [];
  for (const [, v] of byEmail) {
    if (org && v.email === org) continue;
    out.push(v);
  }
  out.sort((a, b) => a.email.localeCompare(b.email));
  return out;
}

async function calFetch(path, accessToken, init) {
  const url = path.startsWith("http") ? path : `https://www.googleapis.com/calendar/v3${path}`;
  const r = await fetch(url, {
    ...init,
    headers: {
      ...(init && init.headers),
      Authorization: `Bearer ${accessToken}`,
    },
  });
  return r;
}

async function tryEventsGet(accessToken, calendarId, eventId) {
  const path = `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
  const r = await calFetch(path, accessToken);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Calendar events.get failed: ${r.status}`);
  return r.json();
}

async function listCalendars(accessToken) {
  const r = await calFetch("/users/me/calendarList", accessToken);
  if (!r.ok) throw new Error(`calendarList failed: ${r.status}`);
  const j = await r.json();
  return j.items || [];
}

async function listEventsWindow(accessToken, calendarId, timeMinIso, timeMaxIso, q) {
  const u = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`
  );
  u.searchParams.set("timeMin", timeMinIso);
  u.searchParams.set("timeMax", timeMaxIso);
  u.searchParams.set("singleEvents", "true");
  u.searchParams.set("orderBy", "startTime");
  u.searchParams.set("maxResults", "80");
  if (q) u.searchParams.set("q", q);
  const r = await fetch(u.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) throw new Error(`events.list failed: ${r.status}`);
  const j = await r.json();
  return j.items || [];
}

function eventWindowFromStartIso(startIso) {
  const d = startIso ? new Date(startIso) : new Date();
  if (Number.isNaN(d.getTime())) {
    const n = new Date();
    const min = new Date(n.getTime() - 86400000);
    const max = new Date(n.getTime() + 86400000);
    return { timeMin: min.toISOString(), timeMax: max.toISOString() };
  }
  const min = new Date(d.getTime() - 12 * 3600000);
  const max = new Date(d.getTime() + 12 * 3600000);
  return { timeMin: min.toISOString(), timeMax: max.toISOString() };
}

function attendeeEmailsFromEvent(ev) {
  const atts = ev.attendees || [];
  return atts.map((a) => normalizeEmail(a.email)).filter(Boolean);
}

function scoreEventMatch(ev, title, attendeeEmails) {
  let score = 0;
  const t = String(ev.summary || "").trim().toLowerCase();
  if (title && t === String(title).trim().toLowerCase()) score += 5;
  const want = new Set((attendeeEmails || []).map(normalizeEmail));
  const got = new Set(attendeeEmailsFromEvent(ev));
  for (const e of want) {
    if (got.has(e)) score += 2;
  }
  return score;
}

/**
 * When the page does not expose a stable event id, list events in a time window and score by title + attendees.
 */
async function findEventIdsFromListSnapshot(accessToken, snapshot) {
  const title = String(snapshot?.title || "").trim();
  const attendeeEmails = (snapshot?.attendees || []).map((a) => normalizeEmail(a.email)).filter(Boolean);
  if (!title && !attendeeEmails.length) return [];

  const { timeMin, timeMax } = eventWindowFromStartIso(snapshot?.startIso);
  let cals = [];
  try {
    cals = await listCalendars(accessToken);
  } catch {
    cals = [];
  }

  const scored = [];
  for (const c of [{ id: "primary" }, ...cals]) {
    const calId = c.id || "primary";
    let items = [];
    try {
      items = await listEventsWindow(accessToken, calId, timeMin, timeMax, title ? title.slice(0, 80) : undefined);
      if (!items.length && title) {
        items = await listEventsWindow(accessToken, calId, timeMin, timeMax, undefined);
      }
    } catch {
      continue;
    }
    for (const ev of items) {
      const sc = scoreEventMatch(ev, title, attendeeEmails);
      if (sc >= 2) scored.push({ id: ev.id, sc });
    }
  }
  scored.sort((a, b) => b.sc - a.sc);
  const out = [];
  const seen = new Set();
  for (const row of scored) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row.id);
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * Resolve event: try events.get on primary and listed calendars; fall back to events.list + scoring.
 */
async function resolveCalendarEvent(accessToken, calendarIdHint, eventId, snapshot) {
  if (!eventId) return { event: null, calendarId: calendarIdHint || "primary" };

  const tryIds = [];
  if (calendarIdHint) tryIds.push(calendarIdHint);
  tryIds.push("primary");

  for (const calId of tryIds) {
    try {
      const ev = await tryEventsGet(accessToken, calId, eventId);
      if (ev) return { event: ev, calendarId: calId };
    } catch {
      /* continue */
    }
  }

  let cals = [];
  try {
    cals = await listCalendars(accessToken);
  } catch {
    cals = [];
  }
  const seen = new Set(tryIds);
  for (const c of cals) {
    const id = c.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    try {
      const ev = await tryEventsGet(accessToken, id, eventId);
      if (ev) return { event: ev, calendarId: id };
    } catch {
      /* continue */
    }
  }

  const { timeMin, timeMax } = eventWindowFromStartIso(snapshot?.startIso);
  const title = snapshot?.title || "";
  const emails = snapshot?.attendeeEmails || [];

  for (const c of [{ id: "primary" }, ...cals]) {
    const calId = c.id || "primary";
    let items = [];
    try {
      items = await listEventsWindow(accessToken, calId, timeMin, timeMax, title ? title.slice(0, 80) : undefined);
    } catch {
      continue;
    }
    let best = null;
    let bestScore = -1;
    for (const ev of items) {
      if (ev.id !== eventId && ev.recurringEventId !== eventId) continue;
      const sc = scoreEventMatch(ev, title, emails);
      if (sc > bestScore) {
        bestScore = sc;
        best = ev;
      }
    }
    if (best) return { event: best, calendarId: calId };

    for (const ev of items) {
      const sc = scoreEventMatch(ev, title, emails);
      if (sc > bestScore) {
        bestScore = sc;
        best = ev;
      }
    }
    if (best && bestScore >= 4) return { event: best, calendarId: calId };
  }

  return { event: null, calendarId: calendarIdHint || "primary" };
}

async function serverFetch(path, options = {}) {
  const base = await getBaseUrl();
  let token = await getAuthTokenPreferCached();
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    ...(options.headers || {}),
  };
  const controller = new AbortController();
  const timeoutMs = 120000;
  const t = setTimeout(() => controller.abort(), timeoutMs);
  let r;
  try {
    r = await fetch(`${base}${path}`, { ...options, headers, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
  if (r.status === 401) {
    await removeCachedAuthToken();
    const token2 = await getAuthToken(true);
    headers.Authorization = `Bearer ${token2}`;
    const c2 = new AbortController();
    const t2 = setTimeout(() => c2.abort(), timeoutMs);
    try {
      r = await fetch(`${base}${path}`, { ...options, headers, signal: c2.signal });
    } finally {
      clearTimeout(t2);
    }
  }
  return r;
}

async function workspaceSettingsFetch(path, options = {}) {
  const base = await getBaseUrl();
  let token = await getAuthTokenPreferCached();
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    ...(options.headers || {}),
  };
  const controller = new AbortController();
  const timeoutMs = 60000;
  const t = setTimeout(() => controller.abort(), timeoutMs);
  let r;
  try {
    r = await fetch(`${base}${path}`, { ...options, headers, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
  if (r.status === 401) {
    await removeCachedAuthToken();
    const token2 = await getAuthToken(true);
    headers.Authorization = `Bearer ${token2}`;
    const c2 = new AbortController();
    const t2 = setTimeout(() => c2.abort(), timeoutMs);
    try {
      r = await fetch(`${base}${path}`, { ...options, headers, signal: c2.signal });
    } finally {
      clearTimeout(t2);
    }
  }
  return r;
}

async function handleWorkspaceSettingsGet() {
  const r = await workspaceSettingsFetch("/workspace-settings", { method: "GET" });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = {};
  }
  if (!r.ok) {
    return { ok: false, status: r.status, message: data.message || text || "get_failed" };
  }
  const merged = MPWorkspaceSettings.merge(data.settings || {});
  await MPWorkspaceSettings.saveLocal(merged, { preserveUpdatedAt: true });
  return { ok: true, settings: merged };
}

async function handleWorkspaceSettingsSave(payload) {
  const raw = payload?.settings != null ? payload.settings : payload;
  const mergedLocal = MPWorkspaceSettings.merge(raw || {});
  const r = await workspaceSettingsFetch("/workspace-settings", {
    method: "PUT",
    body: JSON.stringify({ settings: mergedLocal }),
  });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = {};
  }
  if (!r.ok) {
    return { ok: false, status: r.status, message: data.message || text || "save_failed" };
  }
  const saved = MPWorkspaceSettings.merge(data.settings || mergedLocal);
  await MPWorkspaceSettings.saveLocal(saved, { preserveUpdatedAt: true });
  return { ok: true, settings: saved };
}

function emptyPrepCache() {
  return { v: 1, byCanonicalId: {}, aliasToCanonical: {}, lastProactiveSyncAt: 0 };
}

async function loadPrepCache() {
  const o = await chrome.storage.local.get(PREP_CACHE_KEY);
  const c = o[PREP_CACHE_KEY];
  if (!c || typeof c !== "object") return emptyPrepCache();
  c.byCanonicalId = c.byCanonicalId || {};
  c.aliasToCanonical = c.aliasToCanonical || {};
  return c;
}

async function savePrepCache(cache) {
  await chrome.storage.local.set({ [PREP_CACHE_KEY]: cache });
}

function resolveCanonicalFromCache(cache, candidateIds) {
  if (!candidateIds || !candidateIds.length) return null;
  for (const id of candidateIds) {
    const c = cache.aliasToCanonical[String(id).toLowerCase()];
    if (c && cache.byCanonicalId[c]) return c;
  }
  for (const id of candidateIds) {
    if (cache.byCanonicalId[id]) return id;
  }
  return null;
}

function prunePrepCacheIfNeeded(cache) {
  const ids = Object.keys(cache.byCanonicalId);
  if (ids.length <= MAX_CACHE_EVENTS) return cache;
  const rows = ids.map((id) => ({ id, t: cache.byCanonicalId[id].updatedAt || 0 }));
  rows.sort((a, b) => a.t - b.t);
  const drop = rows.slice(0, ids.length - MAX_CACHE_EVENTS);
  for (const { id } of drop) {
    delete cache.byCanonicalId[id];
  }
  const aliasKeys = Object.keys(cache.aliasToCanonical);
  for (const low of aliasKeys) {
    const c = cache.aliasToCanonical[low];
    if (!cache.byCanonicalId[c]) delete cache.aliasToCanonical[low];
  }
  return cache;
}

async function registerPrepAliases(canonical, extraIds) {
  const cache = await loadPrepCache();
  const c = String(canonical);
  const merged = MPID.mergeCandidateIds([c, ...(extraIds || [])]);
  for (const id of merged) {
    cache.aliasToCanonical[String(id).toLowerCase()] = c;
  }
  await savePrepCache(cache);
}

async function putPrepCacheEntry(canonical, { hasPrep, prepPayload }) {
  const cache = await loadPrepCache();
  const c = String(canonical);
  cache.byCanonicalId[c] = {
    hasPrep: !!hasPrep,
    prepPayload: prepPayload || null,
    updatedAt: Date.now(),
  };
  cache.aliasToCanonical[c.toLowerCase()] = c;
  prunePrepCacheIfNeeded(cache);
  await savePrepCache(cache);
}

async function fetchGetPrepToCache(eventId, mergeAliasList) {
  const r = await serverFetch(`/get-prep/${encodeURIComponent(eventId)}`, { method: "GET" });
  if (r.status === 404) {
    if (MPID.looksLikeApiEventId(eventId)) {
      await putPrepCacheEntry(eventId, { hasPrep: false, prepPayload: null });
    }
    return { hit: false };
  }
  if (!r.ok) {
    const t = await r.text();
    return { hit: false, httpError: t, httpStatus: r.status };
  }
  const data = await r.json();
  const canonical = String(data.eventId || eventId);
  await putPrepCacheEntry(canonical, { hasPrep: true, prepPayload: data });
  await registerPrepAliases(
    canonical,
    MPID.mergeCandidateIds([canonical, eventId, ...(mergeAliasList || [])])
  );
  return { hit: true, data, canonical };
}

async function listUniqueUpcomingEvents(accessToken, hoursAhead) {
  const now = new Date();
  const timeMin = now.toISOString();
  const timeMax = new Date(now.getTime() + hoursAhead * 3600000).toISOString();
  const byId = new Map();
  let calList = [];
  try {
    calList = await listCalendars(accessToken);
  } catch {
    calList = [];
  }
  const toScan = [{ id: "primary" }];
  for (const c of calList) {
    if (c && c.id && c.id !== "primary") toScan.push({ id: c.id });
  }
  for (const { id: calId } of toScan) {
    try {
      const items = await listEventsWindow(accessToken, calId, timeMin, timeMax, undefined);
      for (const ev of items) {
        if (ev && ev.id && !byId.has(ev.id)) byId.set(ev.id, ev);
      }
    } catch {
      /* ignore */
    }
  }
  return [...byId.values()];
}

async function runProactivePrepSync() {
  let accessToken;
  try {
    accessToken = await getAuthToken(false);
  } catch {
    try {
      accessToken = await getAuthToken(true);
    } catch {
      return;
    }
  }
  const events = await listUniqueUpcomingEvents(accessToken, 48);
  const cache = await loadPrepCache();
  cache.lastProactiveSyncAt = Date.now();
  await savePrepCache(cache);

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (i > 0) await new Promise((res) => setTimeout(res, 80));
    try {
      await fetchGetPrepToCache(ev.id, MPID.aliasesFromApiEvent(ev));
    } catch {
      /* ignore */
    }
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(PROACTIVE_ALARM, { periodInMinutes: 30 });
  runProactivePrepSync();
});

chrome.runtime.onStartup.addListener(() => {
  runProactivePrepSync();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PROACTIVE_ALARM) runProactivePrepSync();
});

async function getOrganizerEmailFallback() {
  return new Promise((resolve) => {
    try {
      chrome.identity.getProfileUserInfo({ accountStatus: "ANY" }, (info) => {
        resolve((info && info.email) || "");
      });
    } catch {
      resolve("");
    }
  });
}

async function handlePrepMeeting(payload) {
  const accessToken = await getAuthTokenPreferCached();

  const calendarEventId = payload.calendarEventId || null;
  const calendarId = payload.calendarId || "primary";

  let apiAttendees = [];
  let resolvedEventId = calendarEventId;

  if (calendarEventId) {
    const { event } = await resolveCalendarEvent(accessToken, calendarId, calendarEventId, {
      title: payload.title,
      startIso: payload.startIso,
      attendeeEmails: (payload.attendees || []).map((a) => a.email).filter(Boolean),
    });
    if (event) {
      resolvedEventId = event.id || calendarEventId;
      apiAttendees = (event.attendees || []).map((a) => ({
        email: a.email,
        displayName: a.displayName || "",
      }));
    }
  }

  const domList = payload.attendees || [];
  let organizerEmail = payload.organizerEmail || "";
  if (!organizerEmail) organizerEmail = await getOrganizerEmailFallback();
  const participants = mergeParticipants(domList, apiAttendees, organizerEmail);

  const title = String(payload.title || "").trim();
  const emails = participants.map((p) => p.email);
  if (!title && emails.length === 0) {
    return { ok: false, error: "needs_input", message: "Add a title or attendees before generating prep." };
  }

  const meetingDescriptionRaw =
    payload.meetingDescription != null
      ? String(payload.meetingDescription)
      : payload.description != null
        ? String(payload.description)
        : "";
  const body = {
    calendarEventId: resolvedEventId || undefined,
    calendarId,
    title: title || "(Untitled)",
    participants,
    organizerEmail: normalizeEmail(organizerEmail) || undefined,
    startIso: payload.startIso || undefined,
    meetingDescription: meetingDescriptionRaw
      ? meetingDescriptionRaw.slice(0, 16000)
      : undefined,
  };

  const r = await serverFetch("/manual-prep", {
    method: "POST",
    body: JSON.stringify(body),
  });

  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!r.ok) {
    return {
      ok: false,
      status: r.status,
      error: data.error || "server_error",
      message: data.message || text,
    };
  }

  if (data.eventId) {
    const hints = MPID.mergeCandidateIds([
      ...(payload.identifierHints || []),
      calendarEventId,
      resolvedEventId,
      data.eventId,
    ]);
    await registerPrepAliases(data.eventId, hints);
    const mergedText = data.merged != null ? data.merged : data.prep;
    await putPrepCacheEntry(data.eventId, {
      hasPrep: true,
      prepPayload: {
        eventId: data.eventId,
        prep: mergedText,
        merged: mergedText,
        title: body.title,
        meta: data.meta || {},
        participantsResolved: data.participantsResolved || [],
        sidebarState: data.sidebarState || null,
        workspaceTemplates: data.workspaceTemplates || [],
      },
    });
  }

  return { ok: true, ...data };
}

async function handleAutoSync(payload) {
  const raw = payload.calendarEventIds ?? payload.calendarEventId;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  let candidates = MPID.mergeCandidateIds(list.map((s) => String(s || "").trim()).filter(Boolean));

  const snap = payload.snapshot || {};
  const hasSnap =
    (snap.title && String(snap.title).trim()) || (Array.isArray(snap.attendees) && snap.attendees.length > 0);

  if (hasSnap) {
    try {
      const accessToken = await getAuthToken(true);
      const fromCal = await findEventIdsFromListSnapshot(accessToken, {
        title: snap.title,
        startIso: snap.startIso,
        attendees: snap.attendees || [],
      });
      candidates = MPID.mergeCandidateIds([...candidates, ...fromCal]);
    } catch {
      /* Calendar lookup is best-effort */
    }
  }

  if (!candidates.length) return { status: "skipped", reason: "no_event_id" };

  const cache = await loadPrepCache();
  const canon = resolveCanonicalFromCache(cache, candidates);
  if (canon) {
    const row = cache.byCanonicalId[canon];
    if (row && row.hasPrep && row.prepPayload) {
      return {
        status: "found",
        prepPayload: row.prepPayload,
        matchedEventId: canon,
        source: "local_cache",
      };
    }
    if (row && row.hasPrep === false) {
      const age = Date.now() - (row.updatedAt || 0);
      if (age < NEGATIVE_CACHE_MS) {
        return { status: "skipped", reason: "cache_negative", matchedEventId: canon };
      }
    }
  }

  let lastHttpErr = null;
  for (const eventId of candidates) {
    try {
      const res = await fetchGetPrepToCache(eventId, candidates);
      if (res.hit) {
        return {
          status: "found",
          prepPayload: res.data,
          matchedEventId: res.canonical,
          source: "network",
        };
      }
      if (res.httpError) lastHttpErr = res;
    } catch (e) {
      return { status: "error", error: String(e?.message || e) };
    }
  }
  if (lastHttpErr) {
    return {
      status: "error",
      error: lastHttpErr.httpError,
      httpStatus: lastHttpErr.httpStatus,
      tried: candidates.length,
    };
  }
  return { status: "skipped", reason: "not_found", tried: candidates.length };
}

async function handleSavePrepEdits(payload) {
  const eventId = payload.calendarEventId;
  if (!eventId) return { ok: false, error: "no_event_id" };
  const r = await serverFetch(`/prep/${encodeURIComponent(eventId)}/edits`, {
    method: "PUT",
    body: JSON.stringify({ edits: payload.edits || {} }),
  });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!r.ok) {
    return { ok: false, status: r.status, message: data.message || text };
  }
  try {
    const cache = await loadPrepCache();
    const prev = cache.byCanonicalId[eventId]?.prepPayload || {};
    await putPrepCacheEntry(eventId, {
      hasPrep: true,
      prepPayload: {
        ...prev,
        eventId,
        merged: data.merged,
        prep: prev.prep || data.merged,
        participantsResolved: prev.participantsResolved,
      },
    });
    await registerPrepAliases(eventId, [eventId]);
  } catch {
    /* ignore cache update errors */
  }
  return { ok: true, ...data };
}

async function handlePrepSessionSync(payload) {
  const eventId = payload.calendarEventId;
  if (!eventId) return { ok: false, error: "no_event_id" };
  const r = await serverFetch(`/prep/${encodeURIComponent(eventId)}/session`, {
    method: "PUT",
    body: JSON.stringify({
      edits: payload.edits || {},
      sidebarState: payload.sidebarState,
      meetingDescription: payload.meetingDescription,
    }),
  });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!r.ok) {
    return { ok: false, status: r.status, message: data.message || text };
  }
  try {
    const cache = await loadPrepCache();
    const prev = cache.byCanonicalId[eventId]?.prepPayload || {};
    await putPrepCacheEntry(eventId, {
      hasPrep: true,
      prepPayload: {
        ...prev,
        eventId,
        merged: data.merged,
        prep: prev.prep || data.merged,
        sidebarState: data.sidebarState != null ? data.sidebarState : prev.sidebarState,
        workspaceTemplates: data.workspaceTemplates || prev.workspaceTemplates,
        participantsResolved: prev.participantsResolved,
        meta: data.meta || prev.meta,
      },
    });
    await registerPrepAliases(eventId, [eventId]);
  } catch {
    /* ignore */
  }
  return { ok: true, ...data };
}

async function handleParticipantRegenerate(payload) {
  const eventId = payload.calendarEventId;
  if (!eventId) return { ok: false, error: "no_event_id" };
  const r = await serverFetch(`/prep/${encodeURIComponent(eventId)}/participant-regenerate`, {
    method: "POST",
    body: JSON.stringify(payload.card || {}),
  });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!r.ok) {
    return { ok: false, status: r.status, message: data.message || text };
  }
  try {
    const cache = await loadPrepCache();
    const prev = cache.byCanonicalId[eventId]?.prepPayload || {};
    await putPrepCacheEntry(eventId, {
      hasPrep: true,
      prepPayload: {
        ...prev,
        eventId,
        sidebarState: data.sidebarState || prev.sidebarState,
      },
    });
    await registerPrepAliases(eventId, [eventId]);
  } catch {
    /* ignore */
  }
  return { ok: true, ...data };
}

async function handleSaveParticipantFix(payload) {
  const eventId = payload.calendarEventId;
  if (!eventId) return { ok: false, error: "no_event_id" };
  const r = await serverFetch(`/prep/${encodeURIComponent(eventId)}/participant-fix`, {
    method: "PUT",
    body: JSON.stringify({
      email: payload.email,
      name: payload.name,
      linkedinUrl: payload.linkedinUrl,
      company: payload.company != null ? payload.company : "",
    }),
  });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!r.ok) {
    return {
      ok: false,
      status: r.status,
      error: data.error || "server_error",
      message: data.message || text,
    };
  }
  try {
    const cache = await loadPrepCache();
    const prev = cache.byCanonicalId[eventId]?.prepPayload || {};
    await putPrepCacheEntry(eventId, {
      hasPrep: true,
      prepPayload: {
        ...prev,
        eventId,
        prep: data.prep,
        merged: data.merged,
        participantsResolved: data.participantsResolved || [],
        meta: data.meta || prev.meta || {},
      },
    });
    await registerPrepAliases(eventId, [eventId]);
  } catch {
    /* ignore cache update errors */
  }
  return { ok: true, ...data };
}

async function handleFetchEvent(payload) {
  const accessToken = await getAuthToken(true);
  const { event, calendarId } = await resolveCalendarEvent(
    accessToken,
    payload.calendarId || "primary",
    payload.calendarEventId,
    payload.snapshot || {}
  );
  if (!event) return { ok: false, error: "not_found" };
  return {
    ok: true,
    calendarId,
    event: {
      id: event.id,
      summary: event.summary,
      start: event.start,
      end: event.end,
      attendees: event.attendees || [],
    },
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const run = async () => {
    const _sender = sender;
    try {
      if (message?.type === MSG.PREP_MEETING) {
        return await handlePrepMeeting(message.payload || {});
      }
      if (message?.type === MSG.AUTO_SYNC_EVENT) {
        return await handleAutoSync(message.payload || {});
      }
      if (message?.type === MSG.FETCH_EVENT) {
        return await handleFetchEvent(message.payload || {});
      }
      if (message?.type === MSG.SAVE_PREP_EDITS) {
        return await handleSavePrepEdits(message.payload || {});
      }
      if (message?.type === MSG.SAVE_PARTICIPANT_FIX) {
        return await handleSaveParticipantFix(message.payload || {});
      }
      if (message?.type === MSG.REFRESH_PREP_CACHE) {
        await runProactivePrepSync();
        return { ok: true };
      }
      if (message?.type === MSG.SEND_EMAIL) {
        return await handleSendEmail(message.payload || {});
      }
      if (message?.type === MSG.WORKSPACE_SETTINGS_GET) {
        return await handleWorkspaceSettingsGet();
      }
      if (message?.type === MSG.WORKSPACE_SETTINGS_SAVE) {
        return await handleWorkspaceSettingsSave(message.payload || {});
      }
      if (message?.type === MSG.PREP_SESSION_SYNC) {
        return await handlePrepSessionSync(message.payload || {});
      }
      if (message?.type === MSG.PARTICIPANT_REGENERATE) {
        return await handleParticipantRegenerate(message.payload || {});
      }
      if (message?.type === MSG.OPEN_WORKSPACE_SETTINGS) {
        const fromRaw = String(message.payload?.from || "sidebar");
        const from = fromRaw === "options" ? "options" : "sidebar";
        const url = chrome.runtime.getURL(`workspace-settings.html?from=${encodeURIComponent(from)}`);
        const openerTabId = _sender.tab?.id;
        if (from === "sidebar" && openerTabId != null && chrome.storage.session) {
          await chrome.storage.session.set({ mp_workspace_settings_opener_tab_id: openerTabId });
        }
        await chrome.tabs.create({ url });
        return { ok: true };
      }
      if (message?.type === MSG.STASH_BRIEFING_PREVIEW) {
        const payload = message.payload;
        if (payload && typeof payload === "object" && chrome.storage?.session) {
          await chrome.storage.session.set({ mp_briefing_preview_v1: payload });
        }
        return { ok: true };
      }
      if (message?.type === MSG.OPEN_BRIEFING_PREVIEW) {
        const payload = message.payload;
        if (payload && typeof payload === "object" && chrome.storage?.session) {
          await chrome.storage.session.set({ mp_briefing_preview_v1: payload });
        }
        const url = chrome.runtime.getURL("briefing-preview.html");
        await chrome.tabs.create({ url });
        return { ok: true };
      }
      return { ok: false, error: "unknown_message" };
    } catch (e) {
      return { ok: false, error: "exception", message: String(e?.message || e) };
    }
  };

  run().then(sendResponse);
  return true;
});
