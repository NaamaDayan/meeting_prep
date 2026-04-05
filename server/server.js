import "./env.js";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { authMiddleware } from "./auth.js";
import { createPersistence } from "./persistence/index.js";
import { createCache } from "./cache.js";
import { resolveParticipants } from "./resolver.js";
import { generateMeetingPrep, generateParticipantDeepInsight } from "./openai.js";
import { resolvePerson } from "./resolvePerson.js";
import { searchWeb } from "./search.js";
import { getConfig } from "./config.js";
import {
  WORKSPACE_SETTINGS_EVENT_ID,
  defaultWorkspaceSettings,
  normalizeWorkspaceSettings,
  rowToSettingsPayload,
} from "./workspaceSettings.js";

const config = getConfig();
const PORT = config.port;
const memoryCache = createCache(2000);

const persistence = createPersistence();

function normalizeEmails(participants) {
  return [...new Set((participants || []).map((p) => String(p.email || "").trim().toLowerCase()).filter(Boolean))].sort();
}

function mergeSections(generated, userEdits) {
  const keys = ["participantsInfo", "agenda", "questionsBefore", "questionsInMeeting"];
  const merged = {};
  for (const k of keys) {
    const ue = userEdits && userEdits[k];
    merged[k] = ue != null && String(ue).length > 0 ? String(ue) : String(generated[k] || "");
  }
  return merged;
}

/** Normalize manualParticipantResolutions keys to lowercased email */
function normalizeManualParticipantResolutions(map) {
  if (!map || typeof map !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(map)) {
    const em = String(k || "")
      .trim()
      .toLowerCase();
    if (!em || !v || typeof v !== "object") continue;
    out[em] = {
      name: String(v.name || "").trim(),
      linkedinUrl: String(v.linkedinUrl || "").trim(),
      company: v.company != null ? String(v.company).trim() : "",
      updatedAt: v.updatedAt || new Date().toISOString(),
    };
  }
  return out;
}

function normalizeEmailKey(e) {
  return String(e || "")
    .trim()
    .toLowerCase();
}

function guessCompanyFromEmail(email) {
  const e = normalizeEmailKey(email);
  const at = e.indexOf("@");
  if (at < 0) return "";
  const domain = e.slice(at + 1);
  if (!domain || domain === "gmail.com" || domain.endsWith(".gmail.com")) return "";
  const part = domain.split(".")[0];
  if (!part || part.length < 2) return "";
  return part.charAt(0).toUpperCase() + part.slice(1);
}

async function loadWorkspaceTemplatesForUser(userSub) {
  let row = null;
  try {
    row = await persistence.get(userSub, WORKSPACE_SETTINGS_EVENT_ID);
  } catch {
    row = null;
  }
  const s = rowToSettingsPayload(row);
  const doc = s || defaultWorkspaceSettings();
  return Array.isArray(doc.meetingTemplates) ? doc.meetingTemplates : [];
}

function pickMeetingTemplate(templates, title, description) {
  const t = String(title || "").toLowerCase();
  const d = String(description || "").toLowerCase();
  const hay = `${t} ${d}`;
  for (const tpl of templates) {
    const name = String(tpl?.name || "").toLowerCase().trim();
    if (name && hay.includes(name)) return String(tpl.id || "");
    const parts = name.split(/\s+/).filter((w) => w.length > 2);
    for (const w of parts) {
      if (hay.includes(w)) return String(tpl.id || "");
    }
  }
  return templates[0] ? String(templates[0].id || "") : "";
}

function buildSidebarState(participantsResolved, meetingTemplates, title, description) {
  const tid = meetingTemplates.length ? pickMeetingTemplate(meetingTemplates, title, description) : null;
  const tpl = meetingTemplates.find((x) => String(x.id) === String(tid));
  const cards = (participantsResolved || []).map((p) => {
    const em = normalizeEmailKey(p.email);
    const co = String(p.company || "").trim() || guessCompanyFromEmail(p.email);
    return {
      email: em,
      displayName: String(p.displayName || "").trim() || (em ? em.split("@")[0] : "Guest"),
      company: co,
      linkedinUrl: "",
      confidence: p.confidence || "medium",
      aboutPerson: String(p.summary || "").trim(),
      aboutCompany: "",
      insightStale: false,
    };
  });
  return {
    selectedTemplateId: tid || null,
    agendaTemplateDefault: String(tpl?.agendaText || ""),
    participantCards: cards,
  };
}

async function ensureSidebarStateForRow(row, userSub) {
  if (row.sidebarState && Array.isArray(row.sidebarState.participantCards)) return row.sidebarState;
  const templates = await loadWorkspaceTemplatesForUser(userSub);
  return buildSidebarState(row.participantsResolved || [], templates, row.title || "", row.meetingDescription || "");
}

function participantsInputFromBodyAndRow(participantsFromBody, row) {
  const byEmail = new Map();
  for (const p of participantsFromBody || []) {
    const em = String(p.email || "")
      .trim()
      .toLowerCase();
    if (em) byEmail.set(em, { email: em, displayName: String(p.displayName || em.split("@")[0]).trim() });
  }
  const sorted = row?.emailsSorted || [];
  for (const em of sorted) {
    const e = String(em || "")
      .trim()
      .toLowerCase();
    if (!e || byEmail.has(e)) continue;
    const fromResolved = (row?.participantsResolved || []).find(
      (x) => String(x.email || "").trim().toLowerCase() === e
    );
    byEmail.set(e, {
      email: e,
      displayName: fromResolved?.displayName || e.split("@")[0],
    });
  }
  return [...byEmail.values()].sort((a, b) => a.email.localeCompare(b.email));
}

function logLine(obj) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...obj });
  console.log(line);
}

function hashId(sub) {
  let h = 0;
  const s = String(sub);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `u${(h >>> 0).toString(16)}`;
}

function httpRequestLogger(req, res, next) {
  const started = Date.now();
  const pathname = (req.originalUrl || req.url || "").split("?")[0];
  res.on("finish", () => {
    const line = {
      http: true,
      method: req.method,
      path: pathname,
      status: res.statusCode,
      ms: Date.now() - started,
    };
    if (req.user && req.user.sub) line.userHash = hashId(req.user.sub);
    logLine(line);
  });
  next();
}

const app = express();
app.use(
  cors({
    origin(origin, cb) {
      if (config.isAllowedOrigin(origin)) {
        cb(null, true);
        return;
      }
      cb(new Error("cors_not_allowed"));
    },
    methods: ["GET", "POST", "PUT", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Admin-Token"],
  })
);
app.use(express.json({ limit: "2mb" }));
app.use(httpRequestLogger);

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "meeting-prep",
    env: config.appEnv,
    persistence: config.persistenceMode,
    time: new Date().toISOString(),
  });
});

app.post("/admin/clear-prep-cache", async (req, res) => {
  const token = req.headers["x-admin-token"];
  if (process.env.ADMIN_TOKEN && token !== process.env.ADMIN_TOKEN) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  memoryCache.clear();
  try {
    await persistence.clearAll();
  } catch (e) {
    logLine({ route: "admin/clear-prep-cache", err: String(e?.message || e) });
    res.status(500).json({ error: "persistence_clear_failed", message: String(e?.message || e) });
    return;
  }
  res.json({ ok: true, cleared: ["memory_cache", "persistent_preps"] });
});

app.use(authMiddleware());

app.get("/workspace-settings", async (req, res) => {
  const user = req.user;
  let row = null;
  try {
    row = await persistence.get(user.sub, WORKSPACE_SETTINGS_EVENT_ID);
  } catch (e) {
    logLine({ route: "workspace-settings-get", err: String(e?.message || e) });
    res.status(500).json({ error: "persistence_error" });
    return;
  }
  const fromRow = rowToSettingsPayload(row);
  res.json({ settings: fromRow || defaultWorkspaceSettings() });
});

app.put("/workspace-settings", async (req, res) => {
  const user = req.user;
  const body = req.body || {};
  const raw = body.settings != null ? body.settings : body;
  const next = normalizeWorkspaceSettings(raw);
  try {
    await persistence.put({
      userSub: user.sub,
      calendarEventId: WORKSPACE_SETTINGS_EVENT_ID,
      recordType: "workspace_settings",
      settings: next,
      updatedAt: next.updatedAt,
    });
  } catch (e) {
    logLine({ route: "workspace-settings-put", err: String(e?.message || e) });
    res.status(500).json({ error: "persistence_error" });
    return;
  }
  res.json({ ok: true, settings: next });
});

app.post("/resolve-person", async (req, res) => {
  const started = Date.now();
  const user = req.user;
  try {
    const { displayName, email } = req.body || {};
    if (!email) {
      res.status(400).json({ error: "email_required" });
      return;
    }
    const r = await resolvePerson({ displayName: displayName || email.split("@")[0], email }, memoryCache);
    logLine({ route: "resolve-person", userHash: hashId(user.sub), ms: Date.now() - started });
    res.json({ ok: true, person: r });
  } catch (e) {
    logLine({ route: "resolve-person", err: String(e?.message || e) });
    res.status(500).json({ error: "resolve_failed", message: String(e?.message || e) });
  }
});

app.post("/manual-prep", async (req, res) => {
  const started = Date.now();
  const user = req.user;
  const body = req.body || {};
  const calendarEventId = body.calendarEventId ? String(body.calendarEventId) : "";
  if (calendarEventId === WORKSPACE_SETTINGS_EVENT_ID) {
    res.status(400).json({ error: "invalid_event_id" });
    return;
  }
  const title = String(body.title || "").trim();
  const meetingDescription = body.meetingDescription != null ? String(body.meetingDescription).slice(0, 16000) : "";
  const participants = Array.isArray(body.participants) ? body.participants : [];
  const startIso = body.startIso ? String(body.startIso) : "";
  const emails = normalizeEmails(participants);

  if (!title && emails.length === 0) {
    res.status(400).json({ error: "needs_input", message: "Title and participants are empty." });
    return;
  }

  const sortedEmails = emails;

  if (!calendarEventId) {
    try {
      const workspaceTemplates = await loadWorkspaceTemplatesForUser(user.sub);
      const resolved = await resolveParticipants(
        participants,
        memoryCache,
        (ev) => logLine({ step: ev.step, email: ev.email, userHash: hashId(user.sub) }),
        {}
      );
      const prepBase = await generateMeetingPrep({
        title: title || "(Untitled)",
        startIso,
        participantsResolved: resolved,
      });
      const sidebarState = buildSidebarState(resolved, workspaceTemplates, title, meetingDescription);
      const tpl = workspaceTemplates.find((x) => String(x.id) === String(sidebarState.selectedTemplateId));
      const agendaFromTemplate = String(tpl?.agendaText || "").trim();
      const prep = {
        ...prepBase,
        agenda: agendaFromTemplate || prepBase.agenda,
      };
      logLine({
        route: "manual-prep",
        eventId: "draft",
        userHash: hashId(user.sub),
        ms: Date.now() - started,
        reused: false,
      });
      res.json({
        ok: true,
        eventId: null,
        prep,
        merged: prep,
        emails: sortedEmails,
        reused: false,
        participantsResolved: resolved,
        sidebarState,
        workspaceTemplates,
      });
      return;
    } catch (e) {
      logLine({ route: "manual-prep", err: String(e?.message || e) });
      res.status(500).json({ error: "generation_failed", message: String(e?.message || e) });
      return;
    }
  }

  let existing = null;
  try {
    existing = await persistence.get(user.sub, calendarEventId);
  } catch (e) {
    logLine({ route: "manual-prep", persist_err: String(e?.message || e) });
    res.status(500).json({ error: "persistence_error" });
    return;
  }

  const sameMeta =
    existing &&
    String(existing.title || "").trim() === title &&
    JSON.stringify(existing.emailsSorted || []) === JSON.stringify(sortedEmails);

  if (existing && sameMeta) {
    const userEdits = existing.userEdits || {};
    const merged = mergeSections(existing.prep || {}, userEdits);
    const manual = normalizeManualParticipantResolutions(existing.manualParticipantResolutions || {});
    let participantsResolved = existing.participantsResolved;
    if (!Array.isArray(participantsResolved) || participantsResolved.length === 0) {
      participantsResolved = await resolveParticipants(
        participants,
        memoryCache,
        (ev) => logLine({ step: ev.step, email: ev.email, userHash: hashId(user.sub) }),
        manual
      );
    }
    const workspaceTemplates = await loadWorkspaceTemplatesForUser(user.sub);
    const sidebarState = await ensureSidebarStateForRow(existing, user.sub);
    logLine({
      route: "manual-prep",
      eventId: calendarEventId,
      userHash: hashId(user.sub),
      ms: Date.now() - started,
      reused: true,
    });
    res.json({
      ok: true,
      eventId: calendarEventId,
      prep: merged,
      merged,
      emails: sortedEmails,
      reused: true,
      participantsResolved,
      meta: existing.meta || {},
      sidebarState,
      workspaceTemplates,
    });
    return;
  }

  let hadUserEdits = false;
  if (existing && existing.userEdits) {
    hadUserEdits = Object.values(existing.userEdits).some((v) => String(v || "").trim().length > 0);
  }

  try {
    const manual = normalizeManualParticipantResolutions(existing?.manualParticipantResolutions || {});
    const resolved = await resolveParticipants(
      participants,
      memoryCache,
      (ev) => logLine({ step: ev.step, email: ev.email, userHash: hashId(user.sub) }),
      manual
    );
    const workspaceTemplates = await loadWorkspaceTemplatesForUser(user.sub);
    const sidebarState = buildSidebarState(resolved, workspaceTemplates, title, meetingDescription);
    const tpl = workspaceTemplates.find((x) => String(x.id) === String(sidebarState.selectedTemplateId));
    const agendaFromTemplate = String(tpl?.agendaText || "").trim();
    const prepBase = await generateMeetingPrep({
      title: title || "(Untitled)",
      startIso,
      participantsResolved: resolved,
    });
    const prep = {
      ...prepBase,
      agenda: agendaFromTemplate || prepBase.agenda,
    };

    const record = {
      userSub: user.sub,
      calendarEventId,
      title,
      emailsSorted: sortedEmails,
      startIso,
      meetingDescription,
      prep,
      userEdits: existing?.userEdits || {},
      manualParticipantResolutions: manual,
      participantsResolved: resolved,
      sidebarState,
      updatedAt: new Date().toISOString(),
      prepVersion: (existing?.prepVersion || 0) + 1,
      meta: {
        editStale: hadUserEdits && !sameMeta,
      },
    };

    await persistence.put(record);

    const merged = mergeSections(prep, record.userEdits);

    logLine({
      route: "manual-prep",
      eventId: calendarEventId,
      userHash: hashId(user.sub),
      ms: Date.now() - started,
      reused: false,
    });

    res.json({
      ok: true,
      eventId: calendarEventId,
      prep: merged,
      merged,
      emails: sortedEmails,
      reused: false,
      meta: record.meta,
      participantsResolved: resolved,
      sidebarState,
      workspaceTemplates,
    });
  } catch (e) {
    logLine({ route: "manual-prep", err: String(e?.message || e) });
    res.status(500).json({ error: "generation_failed", message: String(e?.message || e) });
  }
});

app.get("/get-prep/:eventId", async (req, res) => {
  const started = Date.now();
  const user = req.user;
  const eventId = req.params.eventId;
  if (eventId === WORKSPACE_SETTINGS_EVENT_ID) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  let row = null;
  try {
    row = await persistence.get(user.sub, eventId);
  } catch (e) {
    logLine({ route: "get-prep", err: String(e?.message || e) });
    res.status(500).json({ error: "persistence_error" });
    return;
  }
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const merged = mergeSections(row.prep || {}, row.userEdits || {});
  const workspaceTemplates = await loadWorkspaceTemplatesForUser(user.sub);
  const sidebarState = await ensureSidebarStateForRow(row, user.sub);
  logLine({ route: "get-prep", eventId, userHash: hashId(user.sub), ms: Date.now() - started });
  res.json({
    eventId,
    prep: row.prep,
    merged,
    userEdits: row.userEdits || {},
    meta: row.meta || {},
    title: row.title,
    updatedAt: row.updatedAt,
    participantsResolved: row.participantsResolved || [],
    manualParticipantResolutions: row.manualParticipantResolutions || {},
    sidebarState,
    workspaceTemplates,
  });
});

app.get("/prep/:eventId/combined", async (req, res) => {
  const user = req.user;
  const eventId = req.params.eventId;
  if (eventId === WORKSPACE_SETTINGS_EVENT_ID) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const row = await persistence.get(user.sub, eventId);
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const merged = mergeSections(row.prep || {}, row.userEdits || {});
  res.json({ eventId, merged, meta: row.meta || {} });
});

app.put("/prep/:eventId/edits", async (req, res) => {
  const user = req.user;
  const eventId = req.params.eventId;
  if (eventId === WORKSPACE_SETTINGS_EVENT_ID) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const edits = (req.body && req.body.edits) || {};
  const row = await persistence.get(user.sub, eventId);
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const next = {
    ...row,
    userEdits: { ...row.userEdits, ...edits },
    updatedAt: new Date().toISOString(),
    meta: { ...(row.meta || {}), editStale: false },
  };
  await persistence.put(next);
  const merged = mergeSections(next.prep || {}, next.userEdits || {});
  res.json({ ok: true, merged, meta: next.meta || {} });
});

app.put("/prep/:eventId/session", async (req, res) => {
  const user = req.user;
  const eventId = req.params.eventId;
  if (eventId === WORKSPACE_SETTINGS_EVENT_ID) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const body = req.body || {};
  const edits = body.edits && typeof body.edits === "object" ? body.edits : {};
  const row = await persistence.get(user.sub, eventId);
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const next = {
    ...row,
    userEdits: { ...row.userEdits, ...edits },
    updatedAt: new Date().toISOString(),
    meta: { ...(row.meta || {}), editStale: false },
  };
  if (body.sidebarState && typeof body.sidebarState === "object") {
    next.sidebarState = body.sidebarState;
  }
  if (body.meetingDescription != null) {
    next.meetingDescription = String(body.meetingDescription).slice(0, 16000);
  }
  await persistence.put(next);
  const merged = mergeSections(next.prep || {}, next.userEdits || {});
  const workspaceTemplates = await loadWorkspaceTemplatesForUser(user.sub);
  res.json({
    ok: true,
    merged,
    sidebarState: next.sidebarState || null,
    meta: next.meta || {},
    workspaceTemplates,
  });
});

app.post("/prep/:eventId/participant-regenerate", async (req, res) => {
  const started = Date.now();
  const user = req.user;
  const eventId = req.params.eventId;
  if (eventId === WORKSPACE_SETTINGS_EVENT_ID) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const body = req.body || {};
  const email = normalizeEmailKey(body.email);
  if (!email) {
    res.status(400).json({ error: "email_required" });
    return;
  }
  const displayName = String(body.displayName || "").trim() || email.split("@")[0];
  const company = body.company != null ? String(body.company).trim() : "";
  const linkedinUrl = String(body.linkedinUrl || "").trim();

  let row = null;
  try {
    row = await persistence.get(user.sub, eventId);
  } catch (e) {
    logLine({ route: "participant-regenerate", err: String(e?.message || e) });
    res.status(500).json({ error: "persistence_error" });
    return;
  }
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const ss = row.sidebarState && typeof row.sidebarState === "object" ? { ...row.sidebarState } : {};
  const cards = Array.isArray(ss.participantCards) ? [...ss.participantCards] : [];
  const idx = cards.findIndex((c) => normalizeEmailKey(c.email) === email);
  if (idx < 0) {
    res.status(400).json({ error: "participant_not_in_session" });
    return;
  }

  const q = `${displayName} ${email} ${company} LinkedIn`.trim();
  let hits = [];
  try {
    hits = await searchWeb(q, { maxResults: 6 });
  } catch {
    hits = [];
  }
  const searchContext = hits
    .slice(0, 5)
    .map((h) => `TITLE: ${h.title}\nURL: ${h.url}\n${h.snippet}`)
    .join("\n---\n");

  let insight;
  try {
    insight = await generateParticipantDeepInsight({
      displayName,
      email,
      company,
      linkedinUrl,
      searchContext: searchContext || "No search results.",
    });
  } catch (e) {
    logLine({ route: "participant-regenerate", step: "llm", err: String(e?.message || e) });
    res.status(500).json({ error: "insight_failed", message: String(e?.message || e) });
    return;
  }

  const prev = cards[idx];
  cards[idx] = {
    ...prev,
    displayName,
    company,
    linkedinUrl,
    aboutPerson: insight.aboutPerson,
    aboutCompany: insight.aboutCompany,
    confidence: insight.confidence || prev.confidence || "medium",
    insightStale: false,
  };
  ss.participantCards = cards;

  const next = {
    ...row,
    sidebarState: ss,
    updatedAt: new Date().toISOString(),
  };
  try {
    await persistence.put(next);
  } catch (e) {
    logLine({ route: "participant-regenerate", persist_err: String(e?.message || e) });
    res.status(500).json({ error: "persistence_error" });
    return;
  }

  logLine({ route: "participant-regenerate", eventId, userHash: hashId(user.sub), ms: Date.now() - started });
  res.json({ ok: true, card: cards[idx], sidebarState: ss });
});

app.put("/prep/:eventId/participant-fix", async (req, res) => {
  const started = Date.now();
  const user = req.user;
  const eventId = req.params.eventId;
  if (eventId === WORKSPACE_SETTINGS_EVENT_ID) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const body = req.body || {};
  const email = String(body.email || "")
    .trim()
    .toLowerCase();
  const name = String(body.name || "").trim();
  const linkedinUrl = String(body.linkedinUrl || "").trim();
  const company = body.company != null ? String(body.company).trim() : "";

  if (!email || !name || !linkedinUrl) {
    res.status(400).json({ error: "validation_failed", message: "email, name, and linkedinUrl are required" });
    return;
  }

  let row = null;
  try {
    row = await persistence.get(user.sub, eventId);
  } catch (e) {
    logLine({ route: "participant-fix", err: String(e?.message || e) });
    res.status(500).json({ error: "persistence_error" });
    return;
  }
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const emailsSorted = row.emailsSorted || [];
  const emailSet = new Set(emailsSorted.map((e) => String(e || "").trim().toLowerCase()));
  if (!emailSet.has(email)) {
    res.status(400).json({ error: "email_not_in_event", message: "Email is not a participant for this meeting" });
    return;
  }

  const manual = normalizeManualParticipantResolutions(row.manualParticipantResolutions || {});
  manual[email] = {
    name,
    linkedinUrl,
    company,
    updatedAt: new Date().toISOString(),
  };

  const participantsInput = participantsInputFromBodyAndRow([], row);
  let resolved;
  try {
    resolved = await resolveParticipants(
      participantsInput,
      memoryCache,
      (ev) => logLine({ step: ev.step, email: ev.email, userHash: hashId(user.sub) }),
      manual
    );
  } catch (e) {
    logLine({ route: "participant-fix", step: "resolve_failed", err: String(e?.message || e) });
    res.status(500).json({ error: "resolve_failed", message: String(e?.message || e) });
    return;
  }

  const title = String(row.title || "").trim() || "(Untitled)";
  const startIso = row.startIso ? String(row.startIso) : "";

  let prep;
  try {
    prep = await generateMeetingPrep({
      title,
      startIso,
      participantsResolved: resolved,
    });
  } catch (e) {
    logLine({ route: "participant-fix", step: "generation_failed", err: String(e?.message || e) });
    res.status(500).json({ error: "generation_failed", message: String(e?.message || e) });
    return;
  }

  const next = {
    ...row,
    prep,
    manualParticipantResolutions: manual,
    participantsResolved: resolved,
    updatedAt: new Date().toISOString(),
    prepVersion: (row.prepVersion || 0) + 1,
    meta: { ...(row.meta || {}), editStale: false },
  };
  try {
    await persistence.put(next);
  } catch (e) {
    logLine({ route: "participant-fix", persist_err: String(e?.message || e) });
    res.status(500).json({ error: "persistence_error" });
    return;
  }

  const merged = mergeSections(prep, next.userEdits || {});
  logLine({ route: "participant-fix", eventId, userHash: hashId(user.sub), ms: Date.now() - started });
  res.json({
    ok: true,
    eventId,
    prep: next.prep,
    merged,
    participantsResolved: resolved,
    meta: next.meta || {},
  });
});

app.use((err, _req, res, _next) => {
  if (String(err?.message || err) === "cors_not_allowed") {
    res.status(403).json({ error: "forbidden_origin" });
    return;
  }
  console.error(err);
  res.status(500).json({ error: "internal_error" });
});

const __filename = fileURLToPath(import.meta.url);
const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (isDirectRun) {
  const httpServer = app.listen(PORT, () => {
    console.log(`Meeting Prep server listening on http://127.0.0.1:${PORT}`);
  });
  httpServer.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `Port ${PORT} is already in use (another Meeting Prep server or app). Stop it or pick a free port, e.g. set PORT in server/.env. Find listener: lsof -nP -iTCP:${PORT} -sTCP:LISTEN`
      );
    } else {
      console.error(err);
    }
    process.exit(1);
  });
}

export { app };
