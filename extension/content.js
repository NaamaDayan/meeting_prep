/**
 * Meeting Prep — content script: DOM scrape, inject controls, prep panel UI.
 * No direct server or Calendar API calls; uses chrome.runtime.sendMessage only.
 */

(function () {
  const MP = {
    BTN_ATTR: "data-mp-prep-btn",
    PANEL_ATTR: "data-mp-prep-root",
    STYLE_ID: "mp-meeting-prep-styles",
  };

  const MSG = {
    PREP_MEETING: "PREP_MEETING",
    AUTO_SYNC_EVENT: "AUTO_SYNC_EVENT",
    SAVE_PREP_EDITS: "SAVE_PREP_EDITS",
  };

  const MPID = globalThis.MPID || {
    mergeCandidateIds: (arr) => [...new Set((arr || []).map((s) => String(s || "").trim()).filter(Boolean))],
  };

  let lastUrl = location.href;
  let autoSyncTimer = null;
  let lastScrapedEventId = null;
  let prevCalendarDialogCount = 0;
  /** Canonical server event id while prep panel is open (cross-tab refresh). */
  let displayedPrepCanonical = null;

  function isDarkTheme() {
    const bg = getComputedStyle(document.documentElement).backgroundColor || "";
    const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return false;
    const [r, g, b] = m.slice(1, 4).map(Number);
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return lum < 0.45;
  }

  function injectGlobalStyles() {
    if (document.getElementById(MP.STYLE_ID)) return;
    const dark = isDarkTheme();
    const bg = dark ? "#202124" : "#fff";
    const fg = dark ? "#e8eaed" : "#202124";
    const border = dark ? "#5f6368" : "#dadce0";
    const accent = "#1a73e8";
    const el = document.createElement("style");
    el.id = MP.STYLE_ID;
    el.textContent = `
      .mp-root { font-family: "Google Sans", Roboto, Arial, sans-serif; font-size: 13px; color: ${fg}; box-sizing: border-box; }
      .mp-root * { box-sizing: border-box; }
      /* Primary-style control: matches Calendar Save (Material), darker blue */
      .mp-btn-prep {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        appearance: none;
        -webkit-appearance: none;
        vertical-align: middle;
        white-space: nowrap;
        flex-shrink: 0;
        border: none;
        cursor: pointer;
        font-family: "Google Sans", Roboto, Arial, sans-serif;
        font-weight: 500;
        color: #fff !important;
        background-color: #1557b0;
        box-shadow: 0 1px 2px 0 rgba(60, 64, 67, 0.3), 0 1px 3px 1px rgba(60, 64, 67, 0.15);
      }
      .mp-btn-prep:hover { background-color: #133f91; }
      .mp-btn-prep:active { background-color: #103f75; }
      .mp-btn-prep:focus-visible { outline: 2px solid #1557b0; outline-offset: 2px; }
      .mp-btn-prep.mp-dark {
        background-color: #174ea6;
        box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.3), 0 1px 3px 1px rgba(0, 0, 0, 0.15);
      }
      .mp-btn-prep.mp-dark:hover { background-color: #133d7e; }
      .mp-btn-prep.mp-dark:active { background-color: #103b6f; }
      .mp-btn-prep.mp-fallback {
        min-height: 36px;
        padding: 0 24px;
        border-radius: 4px;
        font-size: 14px;
        line-height: 36px;
      }
      .mp-panel-overlay {
        position: fixed; inset: 0; z-index: 2147483000; pointer-events: none;
      }
      .mp-panel {
        pointer-events: auto;
        position: fixed; top: 0; right: 0; width: min(420px, 100vw); height: 100vh;
        background: ${bg}; color: ${fg};
        box-shadow: -2px 0 12px rgba(0,0,0,0.25);
        display: flex; flex-direction: column;
        z-index: 2147483001;
        border-left: 1px solid ${border};
      }
      @media (max-width: 600px) {
        .mp-panel { width: 100vw; height: 85vh; top: auto; bottom: 0; border-radius: 12px 12px 0 0; border-left: none; border-top: 1px solid ${border}; }
      }
      .mp-panel-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 12px 14px; border-bottom: 1px solid ${border}; flex-shrink: 0;
      }
      .mp-panel-title { font-weight: 600; font-size: 15px; }
      .mp-icon-btn {
        border: none; background: transparent; color: ${fg}; cursor: pointer; padding: 6px; border-radius: 4px;
        font-size: 18px; line-height: 1;
      }
      .mp-icon-btn:hover { background: ${dark ? "#303134" : "#f1f3f4"}; }
      .mp-panel-body { flex: 1; overflow: auto; padding: 12px 14px 20px; }
      .mp-section { margin-bottom: 16px; }
      .mp-section h3 { margin: 0 0 8px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: ${dark ? "#9aa0a6" : "#5f6368"}; }
      .mp-section textarea {
        width: 100%; min-height: 100px; padding: 10px; border-radius: 8px;
        border: 1px solid ${border}; background: ${dark ? "#303134" : "#fff"}; color: ${fg};
        font: inherit; resize: vertical;
      }
      .mp-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
      .mp-primary {
        background: ${accent}; color: #fff; border: none; border-radius: 8px; padding: 8px 14px; font-weight: 500; cursor: pointer;
      }
      .mp-primary:hover { filter: brightness(1.05); }
      .mp-primary:disabled { opacity: 0.6; cursor: not-allowed; }
      .mp-muted { font-size: 12px; color: ${dark ? "#9aa0a6" : "#5f6368"}; }
      .mp-shimmer {
        border-radius: 8px; height: 80px;
        background: linear-gradient(90deg, ${dark ? "#303134" : "#f1f3f4"} 25%, ${dark ? "#3c4043" : "#e8eaed"} 50%, ${dark ? "#303134" : "#f1f3f4"} 75%);
        background-size: 400% 100%; animation: mp-sh 1.2s ease-in-out infinite;
      }
      @keyframes mp-sh { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }
    `;
    document.documentElement.appendChild(el);
  }

  const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

  function collectEmailsFromText(text) {
    const set = new Set();
    let m;
    const re = new RegExp(EMAIL_RE.source, "g");
    while ((m = re.exec(text))) set.add(m[0].toLowerCase());
    return [...set];
  }

  function findEventRoot() {
    const dialogs = [...document.querySelectorAll('[role="dialog"]')];
    if (dialogs.length) return dialogs[dialogs.length - 1];
    const main = document.querySelector('[role="main"]');
    if (main) return main;
    return document.body;
  }

  function scrapeTitle(root) {
    const selectors = [
      'input[aria-label*="itle" i]',
      'input[placeholder*="itle" i]',
      'input[type="text"]',
      'textarea[aria-label*="itle" i]',
      '[data-placeholder*="itle" i]',
    ];
    for (const sel of selectors) {
      const el = root.querySelector(sel);
      if (el && (el.value || el.textContent || "").trim()) {
        return (el.value || el.textContent || "").trim();
      }
    }
    const h = root.querySelector('h1, h2, [role="heading"]');
    if (h && h.textContent && h.textContent.trim().length < 200) return h.textContent.trim();
    return "";
  }

  function scrapeAttendees(root) {
    const out = [];
    const seen = new Set();

    function add(email, displayName) {
      const e = email.trim().toLowerCase();
      if (!e || seen.has(e)) return;
      seen.add(e);
      let dn = (displayName || "").trim();
      if (!dn) dn = e.split("@")[0];
      out.push({ email: e, displayName: dn });
    }

    root.querySelectorAll('a[href^="mailto:"]').forEach((a) => {
      const email = decodeURIComponent((a.getAttribute("href") || "").replace(/^mailto:/i, "").split("?")[0]);
      const label = (a.textContent || "").trim() || (a.getAttribute("aria-label") || "").trim();
      if (email.includes("@")) add(email, label.replace(/\s*<[^>]+>\s*$/, "").trim());
    });

    root.querySelectorAll("[data-hovercard-id]").forEach((el) => {
      const id = el.getAttribute("data-hovercard-id") || "";
      if (id.includes("@")) add(id, (el.textContent || "").trim());
    });

    root.querySelectorAll("[aria-label],[title]").forEach((el) => {
      const t = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""}`;
      const m = t.match(/([^<]+)\s*<\s*([^>]+@[^>]+)\s*>/);
      if (m) add(m[2].trim(), m[1].trim());
    });

    const blockText = root.innerText || "";
    collectEmailsFromText(blockText).forEach((em) => {
      if (!seen.has(em)) add(em, em.split("@")[0]);
    });

    return out;
  }

  function scrapeTime(root) {
    const timeEls = root.querySelectorAll('input[type="date"], input[type="time"], [data-start-time], time, [datetime]');
    for (const el of timeEls) {
      const v = el.value || el.getAttribute("datetime") || el.dateTime;
      if (v && /\d{4}-\d{2}-\d{2}/.test(v)) return new Date(v).toISOString();
    }
    const text = root.innerText || "";
    const isoLike = text.match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    if (isoLike) return new Date(isoLike[0]).toISOString();
    return new Date().toISOString();
  }

  function extractEventIdFromUrl() {
    try {
      const u = new URL(location.href);
      const eid = u.searchParams.get("eid") || u.searchParams.get("ei");
      if (eid) return decodeURIComponent(eid);
    } catch {
      /* ignore */
    }
    const m = location.href.match(/[?&]eid=([^&]+)/);
    if (m) {
      try {
        return decodeURIComponent(m[1]);
      } catch {
        return m[1];
      }
    }
    const path = location.pathname.match(/\/eventedit\/([^/?]+)/);
    if (path) return decodeURIComponent(path[1]);
    const recur = location.href.match(/eventedit\/([^/?]+)/);
    if (recur) return decodeURIComponent(recur[1]);
    return null;
  }

  function extractEventIdFromDom(root) {
    const cand = root.querySelector("[data-event-id], [data-eventid], [data-key*='event']");
    if (cand) {
      const v =
        cand.getAttribute("data-event-id") ||
        cand.getAttribute("data-eventid") ||
        cand.getAttribute("data-key");
      if (v && v.length > 6 && !v.includes(" ")) return v;
    }
    const links = root.querySelectorAll('a[href*="eventedit"], a[href*="eid="]');
    for (const a of links) {
      const href = a.getAttribute("href") || "";
      const m = href.match(/eid=([^&]+)/);
      if (m) {
        try {
          return decodeURIComponent(m[1]);
        } catch {
          return m[1];
        }
      }
      const m2 = href.match(/eventedit\/([^/?]+)/);
      if (m2) {
        try {
          return decodeURIComponent(m2[1]);
        } catch {
          return m2[1];
        }
      }
    }
    return extractEventIdFromUrl();
  }

  function looksLikeEventId(s) {
    if (!s || typeof s !== "string") return false;
    const t = s.trim();
    if (t.length < 16 || t.length > 64) return false;
    return /^[a-z0-9_-]+$/i.test(t);
  }

  function extractEventIdLikeFromString(str) {
    if (!str || typeof str !== "string") return [];
    const out = [];
    const flat = str.replace(/\0/g, " ");
    const re = /[a-z0-9][a-z0-9_-]{15,}([a-z0-9])/gi;
    let m;
    while ((m = re.exec(flat))) {
      if (looksLikeEventId(m[0])) out.push(m[0]);
    }
    return out;
  }

  function decodeGoogleEidCandidates(eidParam) {
    if (!eidParam) return [];
    const raw = String(eidParam).trim();
    if (!raw || raw.length < 8) return [];
    const out = [];
    try {
      let s = raw.replace(/-/g, "+").replace(/_/g, "/");
      const pad = (4 - (s.length % 4)) % 4;
      s += "=".repeat(pad);
      const bin = atob(s);
      out.push(...extractEventIdLikeFromString(bin));
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      out.push(...extractEventIdLikeFromString(utf8));
    } catch {
      /* ignore */
    }
    return out;
  }

  function collectEventIdCandidates() {
    const seen = new Set();
    function add(v) {
      if (!v) return;
      const t = String(v).trim();
      if (!t || t.length > 512) return;
      if (looksLikeEventId(t)) seen.add(t);
      decodeGoogleEidCandidates(t).forEach((x) => {
        if (looksLikeEventId(x)) seen.add(x);
      });
    }

    const root = findEventRoot();
    add(extractEventIdFromDom(root));
    add(extractEventIdFromUrl());

    try {
      const u = new URL(location.href);
      const eid = u.searchParams.get("eid") || u.searchParams.get("ei");
      if (eid) add(decodeURIComponent(eid));
    } catch {
      /* ignore */
    }

    try {
      const h = location.hash || "";
      const m = h.match(/eid=([^&]+)/);
      if (m) add(decodeURIComponent(m[1]));
      extractEventIdLikeFromString(h).forEach((x) => {
        if (looksLikeEventId(x)) seen.add(x);
      });
    } catch {
      /* ignore */
    }

    document.querySelectorAll('a[href*="eventedit"], a[href*="eid="], a[href*="&eid="]').forEach((a) => {
      const href = a.getAttribute("href") || "";
      const em = href.match(/eid=([^&]+)/);
      if (em) {
        try {
          add(decodeURIComponent(em[1]));
        } catch {
          add(em[1]);
        }
      }
      const m2 = href.match(/eventedit\/([^/?]+)/);
      if (m2) {
        try {
          add(decodeURIComponent(m2[1]));
        } catch {
          add(m2[1]);
        }
      }
    });

    return [...seen];
  }

  function getMergedIdentifiers() {
    return MPID.mergeCandidateIds(collectEventIdCandidates());
  }

  async function readLocalPrepCacheFromStorage(candidateIds) {
    if (!candidateIds || !candidateIds.length) return null;
    const { mp_prep_cache_v1: cache } = await chrome.storage.local.get("mp_prep_cache_v1");
    if (!cache || !cache.byCanonicalId) return null;
    const aliases = cache.aliasToCanonical || {};
    let canonical = null;
    for (const id of candidateIds) {
      const c = aliases[String(id).toLowerCase()];
      if (c && cache.byCanonicalId[c]) {
        canonical = c;
        break;
      }
    }
    if (!canonical) {
      for (const id of candidateIds) {
        if (cache.byCanonicalId[id]) {
          canonical = id;
          break;
        }
      }
    }
    if (!canonical) return null;
    const row = cache.byCanonicalId[canonical];
    if (!row || !row.hasPrep || !row.prepPayload) return null;
    return { canonicalId: canonical, hasPrep: true, prepPayload: row.prepPayload };
  }

  function scrapeOpenEvent() {
    const root = findEventRoot();
    const title = scrapeTitle(root);
    const attendees = scrapeAttendees(root);
    const startIso = scrapeTime(root);
    let calendarEventId = extractEventIdFromDom(root) || extractEventIdFromUrl();
    if (calendarEventId && calendarEventId.length > 512) calendarEventId = calendarEventId.slice(0, 512);

    return {
      title,
      attendees,
      startIso,
      calendarEventId,
      calendarId: "primary",
      organizerEmail: "",
    };
  }

  function dismissKey(eventId) {
    return `mp_dismiss_${eventId || "none"}`;
  }

  function isDismissed(eventId) {
    if (!eventId) return false;
    try {
      return sessionStorage.getItem(dismissKey(eventId)) === "1";
    } catch {
      return false;
    }
  }

  function setDismissed(eventId) {
    if (!eventId) return;
    try {
      sessionStorage.setItem(dismissKey(eventId), "1");
    } catch {
      /* ignore */
    }
  }

  function clearDismissIfEventChanged(eventId) {
    if (eventId !== lastScrapedEventId) {
      lastScrapedEventId = eventId;
    }
  }

  function removeExistingPanel() {
    const p = document.querySelector(`[${MP.PANEL_ATTR}]`);
    if (p) {
      p.remove();
      displayedPrepCanonical = null;
    }
  }

  function clearDismissSessionStorage() {
    try {
      Object.keys(sessionStorage).forEach((k) => {
        if (k.startsWith("mp_dismiss_")) sessionStorage.removeItem(k);
      });
    } catch {
      /* ignore */
    }
  }

  /**
   * When the Google Calendar event dialog closes (back to week/grid view), hide prep and reset dismiss
   * so the next open can auto-show prep again. When a dialog opens, retry auto-sync with delays (DOM often
   * lacks event id until after paint).
   */
  function syncPrepPanelWithCalendarDialog() {
    const dc = document.querySelectorAll('[role="dialog"]').length;
    if (prevCalendarDialogCount > 0 && dc === 0) {
      removeExistingPanel();
      clearDismissSessionStorage();
    }
    if (prevCalendarDialogCount === 0 && dc > 0) {
      [0, 650, 2000, 4500].forEach((delay) => setTimeout(() => runAutoSync(), delay));
    }
    prevCalendarDialogCount = dc;
  }

  function buildPanelShell(dark, title, onClose) {
    injectGlobalStyles();
    const wrap = document.createElement("div");
    wrap.setAttribute(MP.PANEL_ATTR, "1");
    wrap.className = "mp-root";
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-label", "Meeting prep");
    wrap.innerHTML = `
      <div class="mp-panel-overlay">
        <div class="mp-panel">
          <div class="mp-panel-header">
            <span class="mp-panel-title">${escapeHtml(title || "Meeting prep")}</span>
            <button type="button" class="mp-icon-btn" aria-label="Close meeting prep" data-mp-close>×</button>
          </div>
          <div class="mp-panel-body" data-mp-body></div>
        </div>
      </div>
    `;
    wrap.querySelector("[data-mp-close]").addEventListener("click", onClose);
    wrap.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") onClose();
    });
    return wrap;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderPrepBody(bodyEl, sections, meta, eventId, onSave) {
    const keys = [
      { key: "participantsInfo", label: "Participants info" },
      { key: "agenda", label: "Meeting agenda" },
      { key: "questionsBefore", label: "Questions before meeting" },
      { key: "questionsInMeeting", label: "Questions in meeting" },
    ];
    const merged = sections || {};
    const stale = meta && meta.editStale;
    bodyEl.innerHTML = `
      ${stale ? `<p class="mp-muted" role="status">Meeting details changed since your last edit. Review sections below.</p>` : ""}
      ${keys
        .map(
          (k) => `
        <div class="mp-section">
          <h3>${escapeHtml(k.label)}</h3>
          <textarea aria-label="${escapeHtml(k.label)}" data-section="${escapeHtml(k.key)}">${escapeHtml(
            merged[k.key] || ""
          )}</textarea>
        </div>
      `
        )
        .join("")}
      <div class="mp-actions">
        <button type="button" class="mp-primary" data-mp-save ${!eventId ? "disabled" : ""}>Save edits</button>
        <span class="mp-muted">${eventId ? "Edits sync to your account." : "Save the event to persist prep across devices."}</span>
      </div>
    `;
    const saveBtn = bodyEl.querySelector("[data-mp-save]");
    if (saveBtn && eventId) {
      saveBtn.addEventListener("click", async () => {
        saveBtn.disabled = true;
        const edits = {};
        keys.forEach((k) => {
          const ta = bodyEl.querySelector(`textarea[data-section="${k.key}"]`);
          if (ta) edits[k.key] = ta.value;
        });
        try {
          await onSave(edits);
          saveBtn.textContent = "Saved";
          setTimeout(() => {
            saveBtn.textContent = "Save edits";
            saveBtn.disabled = false;
          }, 1600);
        } catch {
          saveBtn.disabled = false;
          alert("Could not save edits. Check the backend URL and sign-in.");
        }
      });
    }
  }

  function showLoading(title) {
    removeExistingPanel();
    const dark = isDarkTheme();
    const panel = buildPanelShell(dark, title || "Meeting prep", () => {
      panel.remove();
    });
    const body = panel.querySelector("[data-mp-body]");
    body.innerHTML = `<div class="mp-shimmer"></div><div class="mp-shimmer" style="margin-top:10px"></div><p class="mp-muted">Generating prep…</p>`;
    document.documentElement.appendChild(panel);
    panel.querySelector(".mp-panel").focus?.();
    return panel;
  }

  function showPrepCard(title, payload, eventId) {
    removeExistingPanel();
    const panel = buildPanelShell(isDarkTheme(), title || "Meeting prep", () => {
      setDismissed(eventId);
      panel.remove();
    });
    const body = panel.querySelector("[data-mp-body]");
    const prep = payload.merged || payload.prep || {};
    const sections = {
      participantsInfo: prep.participantsInfo || "",
      agenda: prep.agenda || "",
      questionsBefore: prep.questionsBefore || "",
      questionsInMeeting: prep.questionsInMeeting || "",
    };
    renderPrepBody(body, sections, payload.meta, eventId, async (edits) => {
      const res = await chrome.runtime.sendMessage({
        type: MSG.SAVE_PREP_EDITS,
        payload: { calendarEventId: eventId, edits },
      });
      if (!res || !res.ok) throw new Error("save failed");
    });
    document.documentElement.appendChild(panel);
    displayedPrepCanonical = eventId || null;
    const first = panel.querySelector("textarea,button");
    if (first) first.focus();
  }

  function refreshPrepPanelFromStorageIfOpen() {
    const canon = displayedPrepCanonical;
    if (!canon || !document.querySelector(`[${MP.PANEL_ATTR}]`)) return;
    void (async () => {
      const { mp_prep_cache_v1: cache } = await chrome.storage.local.get("mp_prep_cache_v1");
      const row = cache?.byCanonicalId?.[canon];
      if (!row?.hasPrep || !row.prepPayload) return;
      const snapshot = scrapeOpenEvent();
      const title = snapshot.title || row.prepPayload.title || "Meeting prep";
      showPrepCard(title, row.prepPayload, canon);
    })();
  }

  async function onPrepClick() {
    injectGlobalStyles();
    const snapshot = { ...scrapeOpenEvent(), identifierHints: getMergedIdentifiers() };
    clearDismissIfEventChanged(snapshot.calendarEventId);

    const loading = showLoading(snapshot.title || "Meeting prep");

    const res = await chrome.runtime.sendMessage({
      type: MSG.PREP_MEETING,
      payload: snapshot,
    });

    loading.remove();

    if (!res || !res.ok) {
      if (res && res.error === "needs_input") {
        alert(res.message || "Add a title or attendees first.");
        return;
      }
      alert(res?.message || res?.error || "Prep failed. Check backend URL and Google sign-in.");
      return;
    }

    const eventId = res.eventId || snapshot.calendarEventId;
    const title = snapshot.title || res.prep?.title || "Meeting prep";
    showPrepCard(title, res, eventId);
  }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const st = getComputedStyle(el);
    if (st.visibility === "hidden" || st.display === "none" || st.opacity === "0") return false;
    return true;
  }

  /**
   * Google Calendar labels Save with aria-label (all locales) and/or visible "Save" text.
   */
  function findGoogleCalendarSaveButton(root) {
    if (!root || !root.querySelectorAll) return null;
    const nodes = root.querySelectorAll('button, [role="button"], div[role="button"]');
    for (const b of nodes) {
      if (!isVisible(b)) continue;
      const al = (b.getAttribute("aria-label") || "").toLowerCase();
      if (al.includes("save")) return b;
      const t = (b.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (t === "save") return b;
    }
    return null;
  }

  /**
   * Prefer the header Save (toolbar/banner) in full-page event edit; otherwise the topmost visible Save.
   * Avoids matching a secondary "Save" deeper in the form and fixes flex alignment with the real header row.
   */
  function findPrimarySaveButton(root) {
    if (!root || !root.querySelectorAll) return null;
    const inScope = (el) => findGoogleCalendarSaveButton(el);
    const toolbar = root.querySelector('[role="toolbar"]');
    if (toolbar) {
      const s = inScope(toolbar);
      if (s) return s;
    }
    const banner = root.querySelector('[role="banner"]');
    if (banner) {
      const s = inScope(banner);
      if (s) return s;
    }
    const nodes = root.querySelectorAll('button, [role="button"], div[role="button"]');
    let best = null;
    let bestTop = Infinity;
    for (const b of nodes) {
      if (!isVisible(b)) continue;
      const al = (b.getAttribute("aria-label") || "").toLowerCase();
      const t = (b.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      const isSave = al.includes("save") || t === "save";
      if (!isSave) continue;
      const top = b.getBoundingClientRect().top;
      if (top < bestTop) {
        bestTop = top;
        best = b;
      }
    }
    return best;
  }

  function syncPrepButtonGeometryFromSave(saveBtn, prepBtn) {
    const cs = getComputedStyle(saveBtn);
    const copy = [
      "height",
      "minHeight",
      "maxHeight",
      "padding",
      "paddingTop",
      "paddingRight",
      "paddingBottom",
      "paddingLeft",
      "fontSize",
      "fontWeight",
      "fontFamily",
      "lineHeight",
      "letterSpacing",
      "textTransform",
      "borderRadius",
      "boxSizing",
      "minWidth",
      "maxWidth",
    ];
    for (const p of copy) {
      const v = cs[p];
      if (v !== undefined && v !== "") prepBtn.style[p] = v;
    }
    const disp = cs.display;
    prepBtn.style.display = disp && disp !== "none" ? disp : "inline-flex";
    prepBtn.style.alignItems = "center";
    prepBtn.style.justifyContent = "center";
    prepBtn.style.marginLeft = "8px";
    prepBtn.style.marginRight = "0px";
    prepBtn.style.marginTop = "0px";
    prepBtn.style.marginBottom = "0px";
    prepBtn.style.verticalAlign = "middle";
    prepBtn.style.flexShrink = "0";
    prepBtn.style.alignSelf = "center";
    prepBtn.style.border = "none";
  }

  function pruneOrphanPrepButtons(activeRoot) {
    if (!activeRoot) return;
    document.querySelectorAll(`[${MP.BTN_ATTR}]`).forEach((btn) => {
      if (!activeRoot.contains(btn)) btn.remove();
    });
  }

  function attachPrepButton() {
    const root = findEventRoot();
    pruneOrphanPrepButtons(root);

    const saveBtn = findPrimarySaveButton(root);
    const dark = isDarkTheme();

    if (saveBtn && saveBtn.parentNode) {
      const parent = saveBtn.parentNode;
      let prep = parent.querySelector(`[${MP.BTN_ATTR}]`);
      if (!prep) {
        prep = document.createElement("button");
        prep.type = "button";
        prep.setAttribute(MP.BTN_ATTR, "1");
        prep.className = "mp-btn-prep";
        prep.setAttribute("aria-label", "Prep meeting");
        prep.textContent = "Prep meeting";
        prep.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          void onPrepClick();
        });
        parent.insertBefore(prep, saveBtn.nextSibling);
      } else if (prep.previousElementSibling !== saveBtn) {
        parent.insertBefore(prep, saveBtn.nextSibling);
      }
      prep.classList.toggle("mp-dark", dark);
      prep.classList.remove("mp-fallback");
      syncPrepButtonGeometryFromSave(saveBtn, prep);
      requestAnimationFrame(() => syncPrepButtonGeometryFromSave(saveBtn, prep));
      return;
    }

    const dialog =
      root && root.getAttribute && root.getAttribute("role") === "dialog"
        ? root
        : root && root.closest
          ? root.closest("[role='dialog']")
          : null;
    const scope = dialog || root;
    if (!scope || !scope.querySelectorAll) return;

    const toolbar =
      scope.querySelector('[role="toolbar"]') ||
      scope.querySelector('[role="dialog"] [role="toolbar"]') ||
      scope.querySelector('div[role="dialog"] [role="toolbar"]');

    if (!toolbar) return;

    let prep = toolbar.querySelector(`[${MP.BTN_ATTR}]`);
    if (prep) {
      prep.classList.toggle("mp-dark", dark);
      const anchor = findPrimarySaveButton(scope);
      if (anchor && anchor !== prep) {
        syncPrepButtonGeometryFromSave(anchor, prep);
        prep.classList.remove("mp-fallback");
      }
      return;
    }

    prep = document.createElement("button");
    prep.type = "button";
    prep.setAttribute(MP.BTN_ATTR, "1");
    prep.className = "mp-btn-prep mp-fallback";
    prep.setAttribute("aria-label", "Prep meeting");
    prep.textContent = "Prep meeting";
    prep.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void onPrepClick();
    });
    const anchor = findPrimarySaveButton(scope);
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(prep, anchor.nextSibling);
    } else {
      toolbar.appendChild(prep);
    }
    prep.classList.toggle("mp-dark", dark);
    if (anchor && anchor !== prep) {
      syncPrepButtonGeometryFromSave(anchor, prep);
      prep.classList.remove("mp-fallback");
    }
    requestAnimationFrame(() => {
      const a = findPrimarySaveButton(scope);
      if (a && a !== prep && prep.isConnected) syncPrepButtonGeometryFromSave(a, prep);
    });
  }

  function scanAndInject() {
    injectGlobalStyles();
    attachPrepButton();
  }

  function scheduleAutoSync() {
    if (autoSyncTimer) clearTimeout(autoSyncTimer);
    autoSyncTimer = setTimeout(runAutoSync, 600);
  }

  async function runAutoSync() {
    if (document.querySelector(`[${MP.PANEL_ATTR}]`)) return;

    const hasDialog = document.querySelectorAll('[role="dialog"]').length > 0;
    if (!hasDialog) return;

    const snapshot = scrapeOpenEvent();
    const candidates = getMergedIdentifiers();
    const hasSnap =
      (snapshot.title && String(snapshot.title).trim()) ||
      (snapshot.attendees && snapshot.attendees.length > 0);

    if (!candidates.length && !hasSnap) return;

    const localHit = await readLocalPrepCacheFromStorage(candidates);
    if (localHit && localHit.hasPrep && localHit.prepPayload) {
      const eventId = localHit.canonicalId;
      if (!isDismissed(eventId)) {
        const title = snapshot.title || localHit.prepPayload.title || "Meeting prep";
        showPrepCard(title, localHit.prepPayload, eventId);
      }
      return;
    }

    if (candidates.length && candidates.every((c) => isDismissed(c))) return;

    const res = await chrome.runtime.sendMessage({
      type: MSG.AUTO_SYNC_EVENT,
      payload: {
        calendarEventIds: candidates,
        snapshot: {
          title: snapshot.title,
          startIso: snapshot.startIso,
          attendees: snapshot.attendees,
        },
      },
    });

    if (!res || res.status !== "found" || !res.prepPayload) return;

    const eventId = res.matchedEventId || res.prepPayload.eventId;
    if (!eventId || isDismissed(eventId)) return;

    const title = snapshot.title || res.prepPayload.title || "Meeting prep";
    showPrepCard(title, res.prepPayload, eventId);
  }

  function onUrlChange() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      lastScrapedEventId = null;
    }
  }

  const observer = new MutationObserver(() => {
    onUrlChange();
    scanAndInject();
    syncPrepPanelWithCalendarDialog();
    scheduleAutoSync();
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });

  window.addEventListener("popstate", () => {
    onUrlChange();
    syncPrepPanelWithCalendarDialog();
    scheduleAutoSync();
  });

  window.addEventListener("hashchange", () => {
    lastUrl = location.href;
    syncPrepPanelWithCalendarDialog();
    scheduleAutoSync();
  });

  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      scheduleAutoSync();
    }
    syncPrepPanelWithCalendarDialog();
  }, 1200);

  scanAndInject();
  syncPrepPanelWithCalendarDialog();
  scheduleAutoSync();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.mp_prep_cache_v1) return;
    refreshPrepPanelFromStorageIfOpen();
    if (document.querySelectorAll('[role="dialog"]').length > 0 && !document.querySelector(`[${MP.PANEL_ATTR}]`)) {
      scheduleAutoSync();
    }
  });
})();
