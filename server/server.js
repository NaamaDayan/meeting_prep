import "./env.js";
import express from "express";
import cors from "cors";
import { authMiddleware } from "./auth.js";
import { createPersistence } from "./persistence/index.js";
import { createCache } from "./cache.js";
import { resolveParticipants } from "./resolver.js";
import { generateMeetingPrep } from "./openai.js";
import { resolvePerson } from "./resolvePerson.js";

const PORT = Number(process.env.PORT || 3847);
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
    origin: true,
    methods: ["GET", "POST", "PUT", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Admin-Token"],
  })
);
app.use(express.json({ limit: "2mb" }));
app.use(httpRequestLogger);

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "meeting-prep", time: new Date().toISOString() });
});

app.post("/admin/clear-prep-cache", (req, res) => {
  const token = req.headers["x-admin-token"];
  if (process.env.ADMIN_TOKEN && token !== process.env.ADMIN_TOKEN) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  memoryCache.clear();
  res.json({ ok: true, cleared: "memory_cache" });
});

app.use(authMiddleware());

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
  const title = String(body.title || "").trim();
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
      const resolved = await resolveParticipants(participants, memoryCache, (ev) =>
        logLine({ step: ev.step, email: ev.email, userHash: hashId(user.sub) })
      );
      const prep = await generateMeetingPrep({
        title: title || "(Untitled)",
        startIso,
        participantsResolved: resolved,
      });
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
        emails: sortedEmails,
        reused: false,
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
      emails: sortedEmails,
      reused: true,
    });
    return;
  }

  let hadUserEdits = false;
  if (existing && existing.userEdits) {
    hadUserEdits = Object.values(existing.userEdits).some((v) => String(v || "").trim().length > 0);
  }

  try {
    const resolved = await resolveParticipants(participants, memoryCache, (ev) =>
      logLine({ step: ev.step, email: ev.email, userHash: hashId(user.sub) })
    );
    const prep = await generateMeetingPrep({
      title: title || "(Untitled)",
      startIso,
      participantsResolved: resolved,
    });

    const record = {
      userSub: user.sub,
      calendarEventId,
      title,
      emailsSorted: sortedEmails,
      prep,
      userEdits: existing?.userEdits || {},
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
      emails: sortedEmails,
      reused: false,
      meta: record.meta,
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
  logLine({ route: "get-prep", eventId, userHash: hashId(user.sub), ms: Date.now() - started });
  res.json({
    eventId,
    prep: row.prep,
    merged,
    userEdits: row.userEdits || {},
    meta: row.meta || {},
    title: row.title,
    updatedAt: row.updatedAt,
  });
});

app.get("/prep/:eventId/combined", async (req, res) => {
  const user = req.user;
  const eventId = req.params.eventId;
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

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "internal_error" });
});

app.listen(PORT, () => {
  console.log(`Meeting Prep server listening on http://127.0.0.1:${PORT}`);
});
