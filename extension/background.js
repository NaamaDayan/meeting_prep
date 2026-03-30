importScripts("calendarIds.js");

/**
 * Meeting Prep — service worker: OAuth, Calendar API, backend HTTP, message router.
 * Content script never talks to the server or Calendar API directly.
 */

const DEFAULT_BASE = "http://127.0.0.1:3847";

const PREP_CACHE_KEY = "mp_prep_cache_v1";
const MAX_CACHE_EVENTS = 200;
const PROACTIVE_ALARM = "mp_prep_proactive_sync";
const NEGATIVE_CACHE_MS = 120000;

const MSG = {
  PREP_MEETING: "PREP_MEETING",
  AUTO_SYNC_EVENT: "AUTO_SYNC_EVENT",
  FETCH_EVENT: "FETCH_EVENT",
  SAVE_PREP_EDITS: "SAVE_PREP_EDITS",
  REFRESH_PREP_CACHE: "REFRESH_PREP_CACHE",
};

async function getBaseUrl() {
  const { meetingPrepBaseUrl } = await chrome.storage.sync.get("meetingPrepBaseUrl");
  const base = (meetingPrepBaseUrl || DEFAULT_BASE).replace(/\/$/, "");
  return base;
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
  const token = await getAuthToken(true);
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    ...(options.headers || {}),
  };
  let r = await fetch(`${base}${path}`, { ...options, headers });
  if (r.status === 401) {
    await removeCachedAuthToken();
    const token2 = await getAuthToken(true);
    headers.Authorization = `Bearer ${token2}`;
    r = await fetch(`${base}${path}`, { ...options, headers });
  }
  return r;
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
  const accessToken = await getAuthToken(true);

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

  const body = {
    calendarEventId: resolvedEventId || undefined,
    calendarId,
    title: title || "(Untitled)",
    participants,
    organizerEmail: normalizeEmail(organizerEmail) || undefined,
    startIso: payload.startIso || undefined,
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
    await putPrepCacheEntry(data.eventId, {
      hasPrep: true,
      prepPayload: {
        eventId: data.eventId,
        prep: data.prep,
        merged: data.prep,
        title: body.title,
        meta: data.meta || {},
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const run = async () => {
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
      if (message?.type === MSG.REFRESH_PREP_CACHE) {
        await runProactivePrepSync();
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
