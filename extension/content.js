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
    SEND_EMAIL: "SEND_EMAIL",
    PREP_SESSION_SYNC: "PREP_SESSION_SYNC",
    PARTICIPANT_REGENERATE: "PARTICIPANT_REGENERATE",
    OPEN_BRIEFING_PREVIEW: "OPEN_BRIEFING_PREVIEW",
    STASH_BRIEFING_PREVIEW: "STASH_BRIEFING_PREVIEW",
  };

  /** Paper-plane icon for Send Briefing controls (stroke matches `currentColor`). */
  const MP_SEND_PLANE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;

  /** After extension reload/update, content scripts keep running but `chrome.*` APIs throw or reject. */
  function isExtensionContextAlive() {
    try {
      return Boolean(chrome?.runtime?.id);
    } catch {
      return false;
    }
  }

  function isContextInvalidatedError(err) {
    const m = String(err?.message || err || "");
    return m.includes("Extension context invalidated") || m.includes("message port closed");
  }

  const PREP_USAGE_STORAGE_KEY = "mp_prep_usage_v1";
  const FREE_PREPS_PER_MONTH = 10;

  function prepMonthKeyNow() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }

  async function loadPrepUsageState() {
    const mk = prepMonthKeyNow();
    try {
      if (!isExtensionContextAlive()) {
        return { used: 0, limit: FREE_PREPS_PER_MONTH, monthKey: mk };
      }
      const data = await chrome.storage.local.get(PREP_USAGE_STORAGE_KEY);
      const raw = data[PREP_USAGE_STORAGE_KEY];
      if (!raw || raw.monthKey !== mk) {
        return { used: 0, limit: FREE_PREPS_PER_MONTH, monthKey: mk };
      }
      const used = Math.max(0, Number(raw.count) || 0);
      return { used, limit: FREE_PREPS_PER_MONTH, monthKey: mk };
    } catch (e) {
      if (!isContextInvalidatedError(e)) console.warn("Meeting Prep: usage read failed", e);
      return { used: 0, limit: FREE_PREPS_PER_MONTH, monthKey: mk };
    }
  }

  async function incrementPrepUsageAfterSuccessfulGeneration() {
    const mk = prepMonthKeyNow();
    try {
      if (!isExtensionContextAlive()) return;
      const data = await chrome.storage.local.get(PREP_USAGE_STORAGE_KEY);
      let raw = data[PREP_USAGE_STORAGE_KEY];
      if (!raw || raw.monthKey !== mk) {
        raw = { monthKey: mk, count: 0 };
      }
      raw.count = (Number(raw.count) || 0) + 1;
      raw.monthKey = mk;
      await chrome.storage.local.set({ [PREP_USAGE_STORAGE_KEY]: raw });
    } catch (e) {
      if (!isContextInvalidatedError(e)) console.warn("Meeting Prep: usage increment failed", e);
    }
  }

  async function isProdMode() {
    try {
      const c = await MeetingPrepConfig.load();
      return c.mode === "prod";
    } catch {
      return false;
    }
  }

  function usageRowHtml(usage) {
    if (!usage || usage.limit == null) return "";
    const lim = Math.max(1, Number(usage.limit) || 1);
    const used = Math.max(0, Number(usage.used) || 0);
    const pct = Math.min(100, Math.round((used / lim) * 100));
    return `
      <div class="mp-panel-usage" role="status" aria-label="Free meeting preps used this month">
        <div class="mp-panel-usage-track" aria-hidden="true">
          <div class="mp-panel-usage-fill" style="width:${pct}%"></div>
        </div>
        <span class="mp-panel-usage-label">${escapeHtml(String(used))}/${escapeHtml(String(lim))} free</span>
      </div>`;
  }

  function openBillingPlansModal(panelRoot) {
    if (!panelRoot || !panelRoot.querySelector) return;
    const existing = panelRoot.querySelector("[data-mp-billing-modal]");
    if (existing) {
      existing.remove();
    }
    const wrap = document.createElement("div");
    wrap.setAttribute("data-mp-billing-modal", "1");
    wrap.className = "mp-billing-overlay";
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-modal", "true");
    wrap.setAttribute("aria-labelledby", "mp-billing-title");
    wrap.innerHTML = `
      <div class="mp-billing-backdrop" data-mp-billing-close tabindex="-1"></div>
      <div class="mp-billing-sheet">
        <div class="mp-billing-head">
          <h2 class="mp-billing-title" id="mp-billing-title">Choose a plan</h2>
          <button type="button" class="mp-billing-x" data-mp-billing-close aria-label="Close">×</button>
        </div>
        <p class="mp-billing-sub">Pick the plan that fits your workflow. Checkout is not enabled yet.</p>
        <div class="mp-billing-grid">
          <div class="mp-plan-card mp-plan-card--current">
            <div class="mp-plan-name">Free</div>
            <div class="mp-plan-price">$0<span>/mo</span></div>
            <ul class="mp-plan-features">
              <li>${FREE_PREPS_PER_MONTH} meeting preps per month</li>
              <li>Workspace meeting templates</li>
              <li>Participant intel &amp; regenerate</li>
              <li>Agenda &amp; briefing editor</li>
            </ul>
            <button type="button" class="mp-plan-cta mp-plan-cta--current" data-mp-plan-pick="free">Current plan</button>
          </div>
          <div class="mp-plan-card">
            <div class="mp-plan-name">Paid</div>
            <div class="mp-plan-price">$12<span>/mo</span></div>
            <ul class="mp-plan-features">
              <li>Everything in Free</li>
              <li>Unlimited meeting preps</li>
              <li>Faster generation priority</li>
              <li>Email support</li>
            </ul>
            <button type="button" class="mp-plan-cta" data-mp-plan-pick="paid">Choose Paid</button>
          </div>
          <div class="mp-plan-card mp-plan-card--pro">
            <div class="mp-plan-badge">Pro</div>
            <div class="mp-plan-name">Pro</div>
            <div class="mp-plan-price">$29<span>/mo</span></div>
            <ul class="mp-plan-features">
              <li>Everything in Paid</li>
              <li>Team workspace &amp; sharing</li>
              <li>Admin &amp; usage reporting</li>
              <li>SSO &amp; security reviews (coming soon)</li>
            </ul>
            <button type="button" class="mp-plan-cta mp-plan-cta--pro" data-mp-plan-pick="pro">Choose Pro</button>
          </div>
        </div>
      </div>
    `;
    const close = () => wrap.remove();
    wrap.querySelectorAll("[data-mp-billing-close]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.preventDefault();
        close();
      });
    });
    wrap.querySelectorAll("[data-mp-plan-pick]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        /* Purchase flow not wired yet */
      });
    });
    wrap.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
    });
    const overlay = panelRoot.querySelector(".mp-panel-overlay") || panelRoot;
    overlay.appendChild(wrap);
    wrap.querySelector(".mp-billing-x")?.focus();
  }

  const MPID = globalThis.MPID || {
    mergeCandidateIds: (arr) => [...new Set((arr || []).map((s) => String(s || "").trim()).filter(Boolean))],
  };

  let lastUrl = location.href;
  let autoSyncTimer = null;
  let lastScrapedEventId = null;
  /** True when Google's event editor was open (dialog and/or full-page eventedit); excludes our prep sidebar. */
  let prevCalendarEventEditorOpen = false;
  /** Canonical server event id while prep panel is open (cross-tab refresh). */
  let displayedPrepCanonical = null;

  // "Send briefing" popover state (only one can exist at a time).
  let questionsPopoverEl = null;
  let questionsPopoverAnchorBtn = null;
  let questionsPopoverOutsideHandler = null;
  let questionsPopoverKeyHandler = null;

  function isFullPageEventEditUrl() {
    try {
      return /\/eventedit\//.test(location.pathname);
    } catch {
      return false;
    }
  }

  /** Bubble dialog or full-page editor — not our prep panel (which must not use role="dialog"). */
  function isCalendarEventEditorOpen() {
    if (document.querySelectorAll(`[role="dialog"]:not([${MP.PANEL_ATTR}])`).length > 0) return true;
    return isFullPageEventEditUrl();
  }

  /**
   * Theme follows the user's OS / browser light-dark preference (not Google Calendar's page background),
   * so the sidebar matches light vs dark mode reliably.
   */
  function injectGlobalStyles() {
    if (document.getElementById(MP.STYLE_ID)) return;
    const el = document.createElement("style");
    el.id = MP.STYLE_ID;
    el.textContent = `
      .mp-root {
        --mp-accent: #2563eb;
        --mp-accent-hover: #1d4ed8;
        --mp-panel-bg: #f9fafb;
        --mp-surface: #ffffff;
        --mp-elevated: #f3f4f6;
        --mp-text: #111827;
        --mp-text-secondary: #4b5563;
        --mp-muted: #6b7280;
        --mp-border: #e5e7eb;
        --mp-shadow: 0 1px 3px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.06);
        --mp-header-divider: #e5e7eb;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        font-size: 13px;
        line-height: 1.45;
        color: var(--mp-text);
        box-sizing: border-box;
        -webkit-font-smoothing: antialiased;
      }
      @media (prefers-color-scheme: dark) {
        .mp-root {
          --mp-accent: #3b82f6;
          --mp-accent-hover: #60a5fa;
          --mp-panel-bg: #0c0e12;
          --mp-surface: #161a20;
          --mp-elevated: #1e242d;
          --mp-text: #f3f4f6;
          --mp-text-secondary: #d1d5db;
          --mp-muted: #9ca3af;
          --mp-border: #2d3540;
          --mp-shadow: 0 4px 24px rgba(0,0,0,0.45);
          --mp-header-divider: #2d3540;
        }
      }
      .mp-root * { box-sizing: border-box; }

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
        font-family: inherit;
        font-weight: 600;
        color: #fff !important;
        background-color: #2563eb;
        box-shadow: 0 1px 2px rgba(0,0,0,0.08);
        border-radius: 8px;
      }
      .mp-btn-prep:hover { background-color: #1d4ed8; }
      .mp-btn-prep:active { background-color: #1e40af; }
      .mp-btn-prep:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }
      @media (prefers-color-scheme: dark) {
        .mp-btn-prep {
          background-color: #3b82f6;
          box-shadow: 0 1px 3px rgba(0,0,0,0.35);
        }
        .mp-btn-prep:hover { background-color: #60a5fa; }
        .mp-btn-prep:active { background-color: #2563eb; }
        .mp-btn-prep:focus-visible { outline-color: #60a5fa; }
      }
      .mp-btn-prep.mp-fallback {
        min-height: 36px;
        padding: 0 20px;
        font-size: 14px;
        line-height: 36px;
      }

      .mp-panel-overlay {
        position: fixed; inset: 0; z-index: 2147483000; pointer-events: none;
        isolation: isolate;
      }
      .mp-panel {
        pointer-events: auto;
        position: fixed; top: 0; right: 0;
        width: min(440px, 100vw); height: 100vh;
        background: var(--mp-panel-bg);
        color: var(--mp-text);
        box-shadow: var(--mp-shadow);
        display: flex; flex-direction: column;
        z-index: 2147483001;
        border-left: 1px solid var(--mp-border);
      }
      @media (max-width: 600px) {
        .mp-panel {
          width: 100vw; height: 88vh; top: auto; bottom: 0;
          border-radius: 16px 16px 0 0;
          border-left: none;
          border-top: 1px solid var(--mp-border);
        }
      }

      .mp-panel-header {
        display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
        padding: 14px 16px;
        flex-shrink: 0;
        background: var(--mp-surface);
        border-bottom: 1px solid var(--mp-header-divider);
      }
      .mp-panel-header-primary { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
      .mp-panel-brand { display: flex; align-items: center; gap: 12px; min-width: 0; width: 100%; }
      .mp-panel-logo {
        width: 36px; height: 36px; flex-shrink: 0;
        border-radius: 10px;
        background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%);
        display: flex; align-items: center; justify-content: center;
        color: #fff;
        box-shadow: 0 1px 2px rgba(37,99,235,0.35);
      }
      @media (prefers-color-scheme: dark) {
        .mp-panel-logo {
          background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
        }
      }
      .mp-panel-logo svg { width: 20px; height: 20px; display: block; }
      .mp-panel-brand-text { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
      .mp-panel-brand-name {
        font-weight: 700; font-size: 15px; letter-spacing: -0.02em;
        color: var(--mp-text);
        line-height: 1.2;
      }
      .mp-panel-event-title {
        font-size: 12px; font-weight: 500;
        color: var(--mp-muted);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        max-width: 100%;
      }
      .mp-panel-usage {
        display: flex; align-items: center; gap: 10px;
        width: 100%; max-width: 100%;
      }
      .mp-panel-usage-track {
        flex: 1; min-width: 0; height: 6px;
        background: var(--mp-elevated);
        border-radius: 999px;
        overflow: hidden;
        border: 1px solid var(--mp-border);
      }
      .mp-panel-usage-fill {
        height: 100%;
        border-radius: 999px;
        background: linear-gradient(90deg, #2563eb, #7c3aed);
        transition: width 0.25s ease;
      }
      @media (prefers-color-scheme: dark) {
        .mp-panel-usage-fill {
          background: linear-gradient(90deg, #3b82f6, #a78bfa);
        }
      }
      .mp-panel-usage-label {
        font-size: 11px; font-weight: 600;
        color: var(--mp-muted);
        white-space: nowrap;
        flex-shrink: 0;
      }
      .mp-panel-header-actions { display: flex; align-items: flex-start; gap: 2px; flex-shrink: 0; padding-top: 2px; }
      .mp-icon-btn {
        border: none; background: transparent;
        color: var(--mp-muted);
        cursor: pointer;
        padding: 8px; border-radius: 10px;
        line-height: 1;
        display: inline-flex; align-items: center; justify-content: center;
        transition: background 0.15s, color 0.15s;
      }
      .mp-icon-btn:hover {
        background: var(--mp-elevated);
        color: var(--mp-text);
      }
      .mp-upgrade-btn {
        color: #7c3aed !important;
        background: linear-gradient(135deg, color-mix(in srgb, #a855f7 18%, transparent), color-mix(in srgb, #f59e0b 14%, transparent)) !important;
        gap: 6px;
        padding: 6px 10px 6px 8px;
      }
      .mp-upgrade-btn:hover {
        color: #6d28d9 !important;
        background: linear-gradient(135deg, color-mix(in srgb, #a855f7 28%, transparent), color-mix(in srgb, #f59e0b 22%, transparent)) !important;
      }
      .mp-upgrade-btn .mp-upgrade-label {
        font-size: 12px;
        font-weight: 600;
        letter-spacing: 0.01em;
      }
      @media (prefers-color-scheme: dark) {
        .mp-upgrade-btn { color: #c4b5fd !important; }
        .mp-upgrade-btn:hover { color: #ddd6fe !important; }
      }
      .mp-icon-btn svg { display: block; width: 20px; height: 20px; }
      .mp-icon-btn.mp-close-btn { font-size: 22px; font-weight: 300; color: var(--mp-muted); }

      .mp-panel-body {
        flex: 1; overflow: auto;
        padding: 16px 16px 24px;
        background: var(--mp-panel-bg);
      }

      .mp-section { margin-bottom: 20px; }
      .mp-section:last-of-type { margin-bottom: 0; }
      .mp-section-heading {
        display: flex; align-items: center; gap: 8px;
        margin: 0 0 10px;
      }
      .mp-section-icon {
        width: 28px; height: 28px; flex-shrink: 0;
        border-radius: 8px;
        display: flex; align-items: center; justify-content: center;
        color: var(--mp-accent);
        background: color-mix(in srgb, var(--mp-accent) 12%, transparent);
      }
      @supports not (background: color-mix(in srgb, red 50%, blue)) {
        .mp-section-icon { background: rgba(37, 99, 235, 0.12); }
        @media (prefers-color-scheme: dark) {
          .mp-section-icon { background: rgba(59, 130, 246, 0.18); }
        }
      }
      .mp-section-icon-svg { width: 15px; height: 15px; display: block; }
      .mp-section-label {
        font-size: 11px; font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--mp-muted);
      }
      .mp-section-card {
        background: var(--mp-surface);
        border: 1px solid var(--mp-border);
        border-radius: 12px;
        padding: 2px;
        box-shadow: 0 1px 2px rgba(0,0,0,0.04);
      }
      @media (prefers-color-scheme: dark) {
        .mp-section-card { box-shadow: none; }
      }
      .mp-section-card textarea {
        width: 100%; min-height: 120px;
        padding: 12px 14px;
        border-radius: 10px;
        border: none;
        background: var(--mp-elevated);
        color: var(--mp-text);
        font: inherit;
        resize: vertical;
        line-height: 1.5;
      }
      .mp-section-card textarea:focus {
        outline: 2px solid var(--mp-accent);
        outline-offset: 0;
      }

      /* Meeting agenda: soft slate shell, no card border (Ahead reference layout) */
      .mp-section[data-mp-agenda-section] {
        padding: 14px 14px 16px;
        margin-bottom: 20px;
        background: #f8fafc;
        border-radius: 16px;
        border: none;
        box-shadow: none;
      }
      @media (prefers-color-scheme: dark) {
        .mp-section[data-mp-agenda-section] {
          background: color-mix(in srgb, var(--mp-surface) 88%, var(--mp-panel-bg));
        }
      }
      .mp-section[data-mp-agenda-section] .mp-section-heading {
        margin-bottom: 12px;
      }
      .mp-section[data-mp-agenda-section] .mp-section-icon {
        width: auto;
        height: auto;
        padding: 0;
        border-radius: 0;
        background: transparent;
        color: var(--mp-muted);
      }
      .mp-section[data-mp-agenda-section] .mp-section-icon-svg {
        width: 18px;
        height: 18px;
      }
      .mp-section[data-mp-agenda-section] .mp-section-card {
        border: none;
        background: #f1f5f9;
        border-radius: 12px;
        padding: 10px 10px 12px;
        box-shadow: none;
      }
      @media (prefers-color-scheme: dark) {
        .mp-section[data-mp-agenda-section] .mp-section-card {
          background: var(--mp-elevated);
        }
      }
      .mp-section[data-mp-agenda-section] .mp-template-select {
        border: none;
        background: rgba(255, 255, 255, 0.7);
        margin-bottom: 8px;
        box-shadow: none;
      }
      @media (prefers-color-scheme: dark) {
        .mp-section[data-mp-agenda-section] .mp-template-select {
          background: color-mix(in srgb, var(--mp-surface) 75%, transparent);
        }
      }
      .mp-section[data-mp-agenda-section] textarea[data-mp-agenda-ta] {
        background: #ffffff;
        min-height: 140px;
        scrollbar-width: thin;
        scrollbar-color: #cbd5e1 transparent;
      }
      @media (prefers-color-scheme: dark) {
        .mp-section[data-mp-agenda-section] textarea[data-mp-agenda-ta] {
          background: var(--mp-surface);
          scrollbar-color: var(--mp-border) transparent;
        }
      }
      .mp-section[data-mp-agenda-section] textarea[data-mp-agenda-ta]::-webkit-scrollbar {
        width: 5px;
      }
      .mp-section[data-mp-agenda-section] textarea[data-mp-agenda-ta]::-webkit-scrollbar-track {
        background: transparent;
      }
      .mp-section[data-mp-agenda-section] textarea[data-mp-agenda-ta]::-webkit-scrollbar-thumb {
        background: #cbd5e1;
        border-radius: 999px;
      }
      @media (prefers-color-scheme: dark) {
        .mp-section[data-mp-agenda-section] textarea[data-mp-agenda-ta]::-webkit-scrollbar-thumb {
          background: var(--mp-border);
        }
      }

      .mp-textarea-wrap { position: relative; }
      .mp-textarea-wrap textarea { padding-bottom: 48px; }

      .mp-actions {
        display: flex; flex-direction: column; gap: 8px;
        margin-top: 20px;
        padding-top: 16px;
        border-top: 1px solid var(--mp-border);
      }
      .mp-primary {
        width: 100%;
        background: var(--mp-accent);
        color: #fff;
        border: none;
        border-radius: 12px;
        padding: 12px 16px;
        font-weight: 600;
        font-size: 14px;
        cursor: pointer;
        transition: background 0.15s;
      }
      .mp-primary:hover { background: var(--mp-accent-hover); }
      .mp-primary:disabled { opacity: 0.5; cursor: not-allowed; }
      .mp-muted { font-size: 12px; color: var(--mp-muted); text-align: center; }

      .mp-shimmer {
        border-radius: 12px; height: 88px;
        background: linear-gradient(90deg, var(--mp-elevated) 25%, var(--mp-surface) 50%, var(--mp-elevated) 75%);
        background-size: 400% 100%; animation: mp-sh 1.2s ease-in-out infinite;
      }
      @keyframes mp-sh { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }

      .mp-btn-secondary {
        appearance: none;
        -webkit-appearance: none;
        border: 1px solid var(--mp-border);
        background: var(--mp-surface);
        color: var(--mp-accent);
        border-radius: 999px;
        padding: 7px 12px;
        font-weight: 600;
        font-size: 12px;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 8px;
      }
      .mp-btn-secondary:hover { background: var(--mp-elevated); }
      .mp-btn-secondary:disabled { opacity: 0.6; cursor: not-allowed; }

      .mp-send-briefing-pill {
        appearance: none;
        -webkit-appearance: none;
        border: none;
        background: color-mix(in srgb, var(--mp-accent) 14%, var(--mp-surface));
        color: var(--mp-accent);
        border-radius: 999px;
        padding: 8px 18px;
        font-weight: 700;
        font-size: 12px;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        font-family: inherit;
      }
      .mp-send-briefing-pill svg { width: 15px; height: 15px; flex-shrink: 0; }
      .mp-send-briefing-pill:hover {
        background: color-mix(in srgb, var(--mp-accent) 22%, var(--mp-surface));
      }
      .mp-send-briefing-pill:disabled { opacity: 0.55; cursor: not-allowed; }
      .mp-send-briefing-pill.mp-sent {
        background: #16a34a;
        color: #fff;
        pointer-events: none;
      }

      .mp-questions-send-row {
        position: absolute;
        right: 12px;
        bottom: 12px;
        margin: 0;
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
        justify-content: flex-end;
        max-width: calc(100% - 24px);
      }
      .mp-btn-briefing-preview {
        appearance: none;
        -webkit-appearance: none;
        border: 1px solid var(--mp-border);
        background: var(--mp-surface);
        color: var(--mp-accent);
        border-radius: 999px;
        padding: 7px 12px;
        font-weight: 600;
        font-size: 12px;
        cursor: pointer;
        font-family: inherit;
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .mp-btn-briefing-preview:hover { background: var(--mp-elevated); }
      .mp-btn-briefing-preview svg { width: 14px; height: 14px; flex-shrink: 0; }
      .mp-popover.mp-root {
        background: var(--mp-surface);
        color: var(--mp-text);
        border: 1px solid var(--mp-border);
        border-radius: 14px;
        box-shadow: var(--mp-shadow);
        width: 300px;
        padding: 14px;
        z-index: 2147483002;
        max-height: calc(100vh - 20px);
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }
      .mp-popover, .mp-popover * { font-family: inherit; }
      .mp-popover-title { font-weight: 600; font-size: 14px; margin-bottom: 10px; color: var(--mp-text); }
      .mp-popover-scroll { overflow: auto; padding-right: 2px; }
      .mp-participants { max-height: 160px; overflow: auto; padding-right: 6px; margin-bottom: 10px; }
      .mp-participant-item { display: flex; align-items: center; gap: 8px; margin: 6px 0; font-size: 13px; color: var(--mp-text); }
      .mp-preview-label { font-weight: 600; font-size: 11px; margin: 6px 0 6px; color: var(--mp-muted); text-transform: uppercase; letter-spacing: 0.04em; }
      .mp-preview-text {
        white-space: pre-wrap;
        word-break: break-word;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 12px;
        line-height: 1.45;
        background: var(--mp-elevated);
        border: 1px solid var(--mp-border);
        border-radius: 10px;
        padding: 10px;
        margin: 0;
        color: var(--mp-text);
      }
      .mp-popover-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 10px;
        padding-top: 10px;
        position: sticky;
        bottom: 0;
        background: var(--mp-surface);
      }
      .mp-template-select {
        width: 100%;
        padding: 10px 12px;
        border-radius: 10px;
        border: 1px solid var(--mp-border);
        background: var(--mp-surface);
        color: var(--mp-text);
        font: inherit;
        margin-bottom: 10px;
      }
      .mp-template-select:disabled { opacity: 0.65; cursor: not-allowed; }
      .mp-participants-inner {
        padding: 0;
        background: transparent;
        border: none;
        box-shadow: none;
      }
      .mp-pcard {
        background: var(--mp-surface);
        border: 1px solid var(--mp-border);
        border-radius: 14px;
        padding: 16px 16px 14px;
        margin-bottom: 12px;
        box-shadow: 0 1px 3px rgba(0,0,0,0.06);
      }
      @media (prefers-color-scheme: dark) {
        .mp-pcard { box-shadow: none; }
      }
      .mp-pcard--stale { border-color: color-mix(in srgb, var(--mp-accent) 45%, var(--mp-border)); }
      .mp-pcard-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 6px;
      }
      .mp-pcard-head-text { flex: 1; min-width: 0; }
      .mp-pcard-name {
        width: 100%;
        padding: 2px 0;
        margin: 0;
        border: none;
        border-radius: 6px;
        background: transparent;
        color: var(--mp-text);
        font: inherit;
        font-size: 15px;
        font-weight: 700;
        letter-spacing: -0.02em;
        line-height: 1.25;
      }
      .mp-pcard-name:focus {
        outline: 2px solid var(--mp-accent);
        outline-offset: 2px;
      }
      .mp-pcard-company-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 4px;
      }
      .mp-pcard-company {
        flex: 1;
        min-width: 0;
        padding: 2px 0;
        margin: 0;
        border: none;
        border-radius: 6px;
        background: transparent;
        color: var(--mp-muted);
        font: inherit;
        font-size: 13px;
        font-weight: 500;
        line-height: 1.35;
      }
      .mp-pcard-company:focus {
        outline: 2px solid var(--mp-accent);
        outline-offset: 2px;
        color: var(--mp-text);
      }
      .mp-pcard-li-shell {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-top: 12px;
        padding: 10px 12px;
        border-radius: 10px;
        background: var(--mp-elevated);
        border: 1px solid var(--mp-border);
      }
      .mp-pcard-li-icon {
        flex-shrink: 0;
        color: #0a66c2;
        display: block;
      }
      @media (prefers-color-scheme: dark) {
        .mp-pcard-li-icon { color: #70b7ff; }
      }
      .mp-pcard-linkedin {
        flex: 1;
        min-width: 0;
        padding: 0;
        margin: 0;
        border: none;
        background: transparent;
        color: var(--mp-accent);
        font: inherit;
        font-size: 13px;
        line-height: 1.35;
      }
      .mp-pcard-linkedin::placeholder { color: var(--mp-muted); font-weight: 400; }
      .mp-pcard-linkedin:not(:placeholder-shown) { font-weight: 500; }
      .mp-badge {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        padding: 4px 8px;
        border-radius: 999px;
      }
      .mp-badge-high { background: color-mix(in srgb, #22c55e 18%, transparent); color: #15803d; }
      .mp-badge-med { background: color-mix(in srgb, #f97316 18%, transparent); color: #c2410c; }
      .mp-badge-low { background: color-mix(in srgb, #ef4444 16%, transparent); color: #b91c1c; }
      @media (prefers-color-scheme: dark) {
        .mp-badge-high { color: #86efac; }
        .mp-badge-med { color: #fdba74; }
        .mp-badge-low { color: #fca5a5; }
      }
      .mp-pcard-depth-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 4px;
      }
      .mp-pcard-depth-label {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--mp-muted);
      }
      .mp-pcard-depth-head .mp-regen {
        border: none;
        background: color-mix(in srgb, var(--mp-accent) 16%, var(--mp-elevated));
        color: var(--mp-accent);
        width: 36px;
        height: 36px;
        border-radius: 10px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        transition: background 0.15s, color 0.15s, box-shadow 0.15s, transform 0.1s;
      }
      .mp-pcard-depth-head .mp-regen:hover {
        background: color-mix(in srgb, var(--mp-accent) 26%, var(--mp-elevated));
        color: var(--mp-accent);
      }
      .mp-pcard-depth-head .mp-regen:disabled { opacity: 0.55; cursor: not-allowed; }
      .mp-pcard-depth-head .mp-regen--hot,
      .mp-pcard-depth-head .mp-regen.mp-regen--hot {
        background: color-mix(in srgb, var(--mp-accent) 28%, var(--mp-elevated));
        color: var(--mp-accent);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--mp-accent) 40%, transparent);
      }
      @media (prefers-color-scheme: dark) {
        .mp-pcard-depth-head .mp-regen {
          background: color-mix(in srgb, var(--mp-accent) 22%, var(--mp-surface));
        }
      }
      .mp-pcard-chev {
        border: none;
        background: transparent;
        color: #94a3b8;
        cursor: pointer;
        padding: 2px;
        flex-shrink: 0;
        align-self: center;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        line-height: 0;
        border-radius: 4px;
        transition: color 0.15s ease, background 0.15s ease;
      }
      .mp-pcard-chev:hover {
        color: var(--mp-text-secondary);
        background: color-mix(in srgb, var(--mp-border) 35%, transparent);
      }
      .mp-pcard-chev:focus-visible {
        outline: 2px solid var(--mp-accent);
        outline-offset: 2px;
      }
      .mp-pcard-chev-icon {
        width: 18px;
        height: 18px;
        display: block;
        transition: transform 0.2s ease;
      }
      .mp-pcard-chev--open .mp-pcard-chev-icon {
        transform: rotate(180deg);
      }
      @media (prefers-color-scheme: dark) {
        .mp-pcard-chev { color: var(--mp-muted); }
        .mp-pcard-chev:hover { color: var(--mp-text-secondary); }
      }
      .mp-pcard-expanded { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--mp-border); }
      .mp-pcard-sublabel {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--mp-muted);
        margin: 14px 0 8px;
      }
      .mp-pcard-depth-head + .mp-pcard-sublabel { margin-top: 10px; }
      .mp-pcard-ta-expanded {
        width: 100%;
        min-height: 88px;
        padding: 12px 14px;
        border-radius: 10px;
        border: none;
        background: var(--mp-elevated);
        color: var(--mp-text);
        font: inherit;
        font-size: 13px;
        line-height: 1.5;
        resize: vertical;
      }
      .mp-pcard-ta-expanded:focus {
        outline: 2px solid var(--mp-accent);
        outline-offset: 0;
      }
      .mp-pcard-hint { margin-top: 8px; font-size: 12px; }
      .mp-save-status { font-size: 12px; color: var(--mp-muted); min-height: 16px; }
      .mp-save-status.mp-saving { color: var(--mp-accent); }

      .mp-credits-exhausted { padding: 24px 8px; text-align: center; }
      .mp-credits-exhausted-title { font-size: 16px; font-weight: 700; color: var(--mp-text); margin: 0 0 8px; }
      .mp-credits-exhausted-text { font-size: 13px; color: var(--mp-muted); margin: 0 0 20px; line-height: 1.5; }
      .mp-credits-upgrade-btn { max-width: 280px; margin: 0 auto; }

      .mp-billing-overlay {
        position: absolute; inset: 0; z-index: 2147483010;
        display: flex; align-items: flex-end; justify-content: center;
        pointer-events: auto;
      }
      @media (min-height: 520px) {
        .mp-billing-overlay { align-items: center; }
      }
      .mp-billing-backdrop {
        position: absolute; inset: 0;
        background: rgba(15, 23, 42, 0.45);
        pointer-events: auto;
      }
      @media (prefers-color-scheme: dark) {
        .mp-billing-backdrop { background: rgba(0, 0, 0, 0.55); }
      }
      .mp-billing-sheet {
        position: relative; z-index: 1;
        width: 100%; max-width: 440px; max-height: min(92vh, 640px);
        overflow: auto;
        margin: 0;
        padding: 18px 16px 20px;
        background: var(--mp-surface);
        color: var(--mp-text);
        border-radius: 16px 16px 0 0;
        border: 1px solid var(--mp-border);
        box-shadow: var(--mp-shadow);
        pointer-events: auto;
      }
      @media (min-width: 480px) {
        .mp-billing-sheet {
          border-radius: 16px;
          margin: 16px;
        }
      }
      .mp-billing-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 6px; }
      .mp-billing-title { font-size: 17px; font-weight: 700; margin: 0; letter-spacing: -0.02em; }
      .mp-billing-x {
        border: none; background: transparent; color: var(--mp-muted);
        font-size: 22px; line-height: 1; cursor: pointer; padding: 4px 8px; border-radius: 8px;
      }
      .mp-billing-x:hover { background: var(--mp-elevated); color: var(--mp-text); }
      .mp-billing-sub { font-size: 12px; color: var(--mp-muted); margin: 0 0 16px; line-height: 1.45; }
      .mp-billing-grid { display: flex; flex-direction: column; gap: 12px; }
      .mp-plan-card {
        position: relative;
        border: 1px solid var(--mp-border);
        border-radius: 12px;
        padding: 14px 14px 12px;
        background: var(--mp-panel-bg);
      }
      .mp-plan-card--current { border-color: color-mix(in srgb, var(--mp-accent) 35%, var(--mp-border)); }
      .mp-plan-card--pro { border-color: color-mix(in srgb, #a855f7 40%, var(--mp-border)); }
      .mp-plan-badge {
        position: absolute; top: 10px; right: 12px;
        font-size: 10px; font-weight: 700; letter-spacing: 0.06em;
        text-transform: uppercase;
        color: #7c3aed;
        background: color-mix(in srgb, #a855f7 14%, transparent);
        padding: 3px 8px; border-radius: 999px;
      }
      .mp-plan-name { font-size: 15px; font-weight: 700; margin-bottom: 4px; }
      .mp-plan-price { font-size: 22px; font-weight: 800; letter-spacing: -0.02em; margin-bottom: 10px; }
      .mp-plan-price span { font-size: 13px; font-weight: 600; color: var(--mp-muted); }
      .mp-plan-features {
        list-style: none; margin: 0 0 14px; padding: 0;
        font-size: 12px; color: var(--mp-text-secondary); line-height: 1.5;
      }
      .mp-plan-features li { padding: 4px 0 4px 18px; position: relative; }
      .mp-plan-features li::before {
        content: "✓"; position: absolute; left: 0; color: var(--mp-accent); font-weight: 700; font-size: 11px;
      }
      .mp-plan-cta {
        width: 100%;
        padding: 10px 14px; border-radius: 10px; border: none;
        font-weight: 600; font-size: 13px; cursor: pointer;
        background: var(--mp-elevated); color: var(--mp-text);
        border: 1px solid var(--mp-border);
      }
      .mp-plan-cta:hover { background: var(--mp-border); }
      .mp-plan-cta--current {
        background: color-mix(in srgb, var(--mp-accent) 12%, var(--mp-elevated));
        color: var(--mp-accent); border-color: color-mix(in srgb, var(--mp-accent) 25%, var(--mp-border));
        cursor: default;
      }
      .mp-plan-cta--pro {
        background: linear-gradient(135deg, #7c3aed, #6d28d9);
        color: #fff; border: none;
      }
      .mp-plan-cta--pro:hover { filter: brightness(1.06); }
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
    const dialogs = [...document.querySelectorAll(`[role="dialog"]:not([${MP.PANEL_ATTR}])`)];
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

    function cleanDisplayName(raw, email) {
      const em = String(email || "").trim().toLowerCase();
      let s = String(raw || "").replace(/\s+/g, " ").trim();
      if (!s) return "";

      // Remove the email if it got embedded into the label.
      if (em) {
        const esc = em.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        s = s.replace(new RegExp(`\\b${esc}\\b`, "ig"), "").trim();
      }

      // Google Calendar attendee chips often concatenate control labels.
      // Keep the human name part by splitting on common UI control phrases.
      const splitTokens = [
        "mark as required",
        "mark as optional",
        "required",
        "optional",
        "close",
        "remove",
      ];
      for (const tok of splitTokens) {
        const idx = s.toLowerCase().indexOf(tok);
        if (idx > 0) {
          s = s.slice(0, idx).trim();
        }
      }

      // If it still looks like "Name (stuff)" keep "Name".
      s = s.replace(/\s*\([^)]*\)\s*$/, "").trim();

      // If we ended up with a stray delimiter, clean it.
      s = s.replace(/^[,;:\-–—]+|[,;:\-–—]+$/g, "").trim();
      return s;
    }

    function add(email, displayName) {
      const e = email.trim().toLowerCase();
      if (!e || seen.has(e)) return;
      seen.add(e);
      let dn = cleanDisplayName(displayName, e);
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
      if (!id.includes("@")) return;
      const label = (el.getAttribute("aria-label") || "").trim() || (el.getAttribute("title") || "").trim();
      add(id, label || (el.textContent || "").trim());
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
    let cache;
    try {
      if (!isExtensionContextAlive()) return null;
      const data = await chrome.storage.local.get("mp_prep_cache_v1");
      cache = data.mp_prep_cache_v1;
    } catch (e) {
      if (!isContextInvalidatedError(e)) console.warn("Meeting Prep: read prep cache", e);
      return null;
    }
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

  function scrapeDescription(root) {
    if (!root || !root.querySelectorAll) return "";
    const candidates = root.querySelectorAll('textarea, [contenteditable="true"]');
    for (const el of candidates) {
      const al = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("placeholder") || ""}`.toLowerCase();
      if (al.includes("description") || al.includes("note") || al.includes("details")) {
        const v = "value" in el ? el.value : el.textContent || "";
        const t = String(v || "").trim();
        if (t) return t.slice(0, 8000);
      }
    }
    return "";
  }

  function guessCompanyFromEmailLocal(email) {
    const e = String(email || "")
      .trim()
      .toLowerCase();
    const at = e.indexOf("@");
    if (at < 0) return "";
    const domain = e.slice(at + 1);
    if (!domain || domain === "gmail.com" || domain.endsWith(".gmail.com")) return "";
    const part = domain.split(".")[0];
    if (!part || part.length < 2) return "";
    return part.charAt(0).toUpperCase() + part.slice(1);
  }

  function scrapeOpenEvent() {
    const root = findEventRoot();
    const title = scrapeTitle(root);
    const attendees = scrapeAttendees(root);
    const startIso = scrapeTime(root);
    const description = scrapeDescription(root);
    let calendarEventId = extractEventIdFromDom(root) || extractEventIdFromUrl();
    if (calendarEventId && calendarEventId.length > 512) calendarEventId = calendarEventId.slice(0, 512);

    return {
      title,
      attendees,
      startIso,
      description,
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
    closeQuestionsPopover();
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

  function closeQuestionsPopover() {
    if (questionsPopoverEl) {
      questionsPopoverEl.remove();
    }
    questionsPopoverEl = null;
    questionsPopoverAnchorBtn = null;

    if (questionsPopoverOutsideHandler) {
      document.removeEventListener("mousedown", questionsPopoverOutsideHandler, true);
    }
    if (questionsPopoverKeyHandler) {
      document.removeEventListener("keydown", questionsPopoverKeyHandler, true);
    }
    questionsPopoverOutsideHandler = null;
    questionsPopoverKeyHandler = null;
  }

  /**
   * When the Google Calendar event dialog closes (back to week/grid view), hide prep and reset dismiss
   * so the next open can auto-show prep again. When a dialog opens, retry auto-sync with delays (DOM often
   * lacks event id until after paint).
   */
  function syncPrepPanelWithCalendarDialog() {
    const open = isCalendarEventEditorOpen();
    if (prevCalendarEventEditorOpen && !open) {
      removeExistingPanel();
      clearDismissSessionStorage();
    }
    if (!prevCalendarEventEditorOpen && open) {
      [0, 650, 2000, 4500].forEach((delay) => setTimeout(() => runAutoSync(), delay));
    }
    prevCalendarEventEditorOpen = open;
  }

  function buildPanelShell(title, onClose, shellOpts) {
    const opts = shellOpts || {};
    const showRefresh = typeof opts.onRefresh === "function";
    const usage = opts.usage;
    const usageHtml = usage ? usageRowHtml(usage) : "";
    injectGlobalStyles();
    const wrap = document.createElement("div");
    wrap.setAttribute(MP.PANEL_ATTR, "1");
    wrap.className = "mp-root";
    wrap.setAttribute("role", "complementary");
    wrap.setAttribute("aria-label", "Ahead");
    const eventTitle = escapeHtml(title || "Untitled meeting");
    wrap.innerHTML = `
      <div class="mp-panel-overlay">
        <div class="mp-panel" tabindex="-1">
          <div class="mp-panel-header">
            <div class="mp-panel-header-primary">
              <div class="mp-panel-brand">
                <div class="mp-panel-logo" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.8 5.4L19 10l-5.2 2.6L12 18l-1.8-5.4L5 10l5.2-2.6L12 2z"/></svg>
                </div>
                <div class="mp-panel-brand-text">
                  <span class="mp-panel-brand-name">Ahead</span>
                  <span class="mp-panel-event-title" title="${eventTitle}">${eventTitle}</span>
                </div>
              </div>
              ${usageHtml}
            </div>
            <div class="mp-panel-header-actions">
              ${
                showRefresh
                  ? `<button type="button" class="mp-icon-btn" aria-label="Refresh prep" data-mp-refresh title="Refresh">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                  <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                </svg>
              </button>`
                  : ""
              }
              <button type="button" class="mp-icon-btn mp-upgrade-btn" aria-label="Upgrade plan" data-mp-upgrade title="Upgrade">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="20" height="20">
                  <path d="M12 2l2.4 6.2h6.5l-5.3 3.8 2 6.5L12 15.9l-5.6 4.6 2-6.5L3.1 8.2h6.5L12 2z"/>
                </svg>
                <span class="mp-upgrade-label">Upgrade</span>
              </button>
              <button type="button" class="mp-icon-btn mp-settings-btn" aria-label="Workspace settings" data-mp-settings title="Settings">
                <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
                </svg>
              </button>
              <button type="button" class="mp-icon-btn mp-close-btn" aria-label="Close Ahead" data-mp-close>×</button>
            </div>
          </div>
          <div class="mp-panel-body" data-mp-body></div>
        </div>
      </div>
    `;
    const refreshBtn = wrap.querySelector("[data-mp-refresh]");
    if (refreshBtn && showRefresh) {
      refreshBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        opts.onRefresh();
      });
    }
    const upgradeBtn = wrap.querySelector("[data-mp-upgrade]");
    if (upgradeBtn) {
      upgradeBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openBillingPlansModal(wrap);
      });
    }
    const settingsBtn = wrap.querySelector("[data-mp-settings]");
    if (settingsBtn) {
      settingsBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        chrome.runtime.sendMessage(
          { type: "OPEN_WORKSPACE_SETTINGS", payload: { from: "sidebar" } },
          () => {
            const err = chrome.runtime.lastError;
            if (err && !isContextInvalidatedError(err)) {
              console.warn("Meeting Prep: could not open workspace settings", err.message);
            }
          }
        );
      });
    }
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

  function normalizeEmail(s) {
    return String(s || "")
      .trim()
      .toLowerCase();
  }

  function getCurrentUserProfile() {
    return new Promise((resolve) => {
      try {
        if (!chrome?.identity?.getProfileUserInfo) return resolve({ email: "", name: "" });
        chrome.identity.getProfileUserInfo({ accountStatus: "ANY" }, (info) => {
          const email = normalizeEmail(info?.email);
          const name = String(info?.name || "").trim();
          resolve({ email, name });
        });
      } catch {
        resolve({ email: "", name: "" });
      }
    });
  }

  // Extract bullet list items from the meeting briefing / priorities textareas.
  function extractBulletQuestions(text) {
    const src = String(text || "");
    const out = [];

    // Common patterns: "• question", "- question", "* question", "1. question", "1) question".
    const reBullet = /^[\s]*[•*-]\s+(.*)$/;
    const reNumber = /^[\s]*\d+[\.\)]\s+(.*)$/;

    const lines = src.split(/\r?\n/);
    for (const line of lines) {
      const t = String(line || "").trim();
      if (!t) continue;
      const m1 = t.match(reBullet);
      if (m1 && m1[1]) {
        const q = String(m1[1]).trim();
        if (q) out.push(q);
        continue;
      }
      const m2 = t.match(reNumber);
      if (m2 && m2[1]) {
        const q = String(m2[1]).trim();
        if (q) out.push(q);
      }
    }

    if (!out.length) {
      // Fallback: try to find "• something" inline.
      const inline = [];
      const reInline = /•\s*([^\n•]+)/g;
      let m;
      while ((m = reInline.exec(src))) {
        const q = String(m?.[1] || "").trim();
        if (q) inline.push(q);
      }
      return inline;
    }

    return out;
  }

  function buildQuestionsPreviewText(questions) {
    const qs =
      Array.isArray(questions) && questions.length
        ? questions.map((q) => `• ${String(q).trim()}`).join("\n")
        : "• (no questions found)";
    return `Hi,\nAhead of our meeting:\n\n${qs}\n\nLooking forward.`;
  }

  async function resolveBriefingPreviewUrlForMeeting(eventId) {
    try {
      const cfg = await MeetingPrepConfig.load();
      const idEnc = encodeURIComponent(String(eventId || "").trim() || "unknown");
      if (cfg.mode !== "prod") {
        if (!chrome?.runtime?.getURL) return "";
        return chrome.runtime.getURL("briefing-preview.html");
      }
      const custom = String(cfg.briefingPublicBaseUrl || "").trim().replace(/\/$/, "");
      if (custom) return `${custom}/${idEnc}`;
      const apiBase = String(cfg.prodBaseUrl || "").trim().replace(/\/$/, "");
      return `${apiBase}/briefing/${idEnc}`;
    } catch {
      try {
        return chrome.runtime.getURL("briefing-preview.html");
      } catch {
        return "";
      }
    }
  }

  function truncatePreviewField(s, max) {
    const t = String(s ?? "");
    if (t.length <= max) return t;
    return `${t.slice(0, max)}…`;
  }

  async function collectBriefingPreviewPayload(bodyEl) {
    const panelWrap = bodyEl.closest(`[${MP.PANEL_ATTR}]`);
    const titleEl = panelWrap?.querySelector(".mp-panel-event-title");
    const title =
      (titleEl?.textContent || "").trim() || scrapeOpenEvent().title || "Meeting";
    const snap = scrapeOpenEvent();
    const startIso = snap.startIso || "";
    const briefing =
      panelWrap?.querySelector('textarea[data-section="questionsBefore"]')?.value || "";
    /** Meeting priorities in the preview = bullet lines from Meeting briefing (not “Questions in meeting”). */
    const priorityBullets = extractBulletQuestions(briefing);
    const participants = [];
    panelWrap?.querySelectorAll("[data-mp-pcard]").forEach((row) => {
      participants.push({
        email: normalizeEmail(row.dataset.email),
        displayName: row.querySelector("[data-p-name]")?.value?.trim() || "",
        company: row.querySelector("[data-p-company]")?.value?.trim() || "",
        aboutPerson: row.querySelector("[data-p-about-person]")?.value || "",
        aboutCompany: row.querySelector("[data-p-about-company]")?.value || "",
      });
    });
    const me = await getCurrentUserProfile();
    /** Host = Google profile email match; otherwise first card is primary for layout. */
    let hostIndex = participants.findIndex((c) => c.email && me.email && c.email === me.email);
    if (hostIndex < 0) hostIndex = 0;
    if (participants.length === 0) hostIndex = 0;
    else hostIndex = Math.min(Math.max(0, hostIndex), participants.length - 1);
    return {
      v: 1,
      at: Date.now(),
      title: truncatePreviewField(title, 500),
      startIso: truncatePreviewField(startIso, 120),
      priorityBullets: priorityBullets.map((p) => truncatePreviewField(p, 2000)).slice(0, 80),
      participants: participants.slice(0, 40).map((c) => ({
        email: truncatePreviewField(c.email, 320),
        displayName: truncatePreviewField(c.displayName, 200),
        company: truncatePreviewField(c.company, 200),
        aboutPerson: truncatePreviewField(c.aboutPerson, 6000),
        aboutCompany: truncatePreviewField(c.aboutCompany, 6000),
      })),
      hostIndex,
    };
  }

  async function openBriefingPreviewFromBodyEl(bodyEl) {
    if (!isExtensionContextAlive()) return;
    try {
      const payload = await collectBriefingPreviewPayload(bodyEl);
      // Payload must be stored in the service worker: `chrome.storage.session` is not writable
      // from content scripts unless setAccessLevel(TRUSTED_AND_UNTRUSTED_CONTEXTS) is set.
      const res = await chrome.runtime.sendMessage({
        type: MSG.OPEN_BRIEFING_PREVIEW,
        payload,
      });
      if (res && res.ok === false) {
        window.alert(res.message || "Could not open briefing preview tab.");
      }
    } catch (e) {
      if (!isContextInvalidatedError(e)) console.warn("Meeting Prep: briefing preview", e);
      window.alert("Could not open briefing preview. Try again after refreshing the page.");
    }
  }

  function getQuestionsBeforeTextFromPanel(panelRoot) {
    const ta = panelRoot?.querySelector?.('textarea[data-section="questionsBefore"]');
    return ta ? ta.value || "" : "";
  }

  function getParticipantsForPopover() {
    const snap = scrapeOpenEvent();
    const attendees = Array.isArray(snap?.attendees) ? snap.attendees : [];
    // Ensure each entry has a valid email.
    return attendees
      .filter((p) => p && p.email && String(p.email).includes("@"))
      .map((p) => ({
        email: normalizeEmail(p.email),
        displayName: String(p.displayName || "").trim() || String(p.email || "").split("@")[0] || "Participant",
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  function getSelectedParticipants(popoverEl) {
    const checks = popoverEl?.querySelectorAll?.('input[type="checkbox"][data-mp-email]') || [];
    const out = [];
    checks.forEach((cb) => {
      if (!cb.checked) return;
      const em = normalizeEmail(cb.dataset.mpEmail);
      if (em) out.push(em);
    });
    return out;
  }

  function positionQuestionsPopover(popoverEl, anchorBtn) {
    // Keep width aligned with CSS for predictable placement.
    const width = 300;
    const r = anchorBtn.getBoundingClientRect();
    let left = r.left;

    left = Math.max(10, Math.min(left, window.innerWidth - width - 10));
    popoverEl.style.left = `${left}px`;

    // Prefer below, but clamp to viewport and compute max-height from available space.
    requestAnimationFrame(() => {
      const margin = 10;
      const preferBelowTop = r.bottom + 8;
      const preferAboveTop = r.top - 8;

      const spaceBelow = window.innerHeight - preferBelowTop - margin;
      const spaceAbove = preferAboveTop - margin;

      const placeAbove = spaceBelow < 260 && spaceAbove > spaceBelow;

      if (placeAbove) {
        // Position from top so the popover's bottom stays within viewport.
        const maxH = Math.max(180, Math.min(window.innerHeight - 2 * margin, spaceAbove));
        popoverEl.style.maxHeight = `${maxH}px`;
        // After maxHeight applies, place it so its bottom aligns to anchor top-8 (clamped).
        requestAnimationFrame(() => {
          const pr = popoverEl.getBoundingClientRect();
          const top = Math.max(margin, Math.min(preferAboveTop - pr.height, window.innerHeight - margin - pr.height));
          popoverEl.style.top = `${top}px`;
        });
      } else {
        const maxH = Math.max(180, Math.min(window.innerHeight - 2 * margin, spaceBelow));
        popoverEl.style.maxHeight = `${maxH}px`;
        const top = Math.max(margin, Math.min(preferBelowTop, window.innerHeight - margin - maxH));
        popoverEl.style.top = `${top}px`;
      }
    });
  }

  function renderPopover(anchorBtn) {
    closeQuestionsPopover();
    const panelRoot = anchorBtn.closest(`[${MP.PANEL_ATTR}]`);
    if (!panelRoot) return;

    const popoverEl = document.createElement("div");
    popoverEl.className = "mp-popover mp-root";
    popoverEl.setAttribute("role", "region");
    popoverEl.setAttribute("aria-label", "Send briefing to meeting participants");
    popoverEl.style.position = "fixed";

    const participants = getParticipantsForPopover();

    const titleEl = document.createElement("div");
    titleEl.className = "mp-popover-title";
    titleEl.textContent = "Send briefing to:";

    const listEl = document.createElement("div");
    listEl.className = "mp-participants";

    const makeCheckboxRow = (p) => {
      const row = document.createElement("label");
      row.className = "mp-participant-item";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = true; // Default: all selected.
      cb.dataset.mpEmail = p.email;

      const labelText = document.createElement("span");
      labelText.textContent = `${p.displayName} (${p.email})`;

      row.append(cb, labelText);
      return row;
    };

    participants.forEach((p) => listEl.appendChild(makeCheckboxRow(p)));

    const previewLabelEl = document.createElement("div");
    previewLabelEl.className = "mp-preview-label";
    previewLabelEl.textContent = "Email preview:";

    const previewTextEl = document.createElement("div");
    previewTextEl.className = "mp-preview-text";
    previewTextEl.textContent = "Loading preview…";

    const scrollWrap = document.createElement("div");
    scrollWrap.className = "mp-popover-scroll";

    const actionsEl = document.createElement("div");
    actionsEl.className = "mp-popover-actions";

    const sendBtn = document.createElement("button");
    sendBtn.type = "button";
    sendBtn.className = "mp-send-briefing-pill";
    sendBtn.innerHTML = `${MP_SEND_PLANE_SVG}<span class="mp-send-briefing-label">Send Briefing</span>`;

    let currentSenderName = "your meeting prep agent";

    function updateSendDisabled() {
      const selected = getSelectedParticipants(popoverEl);
      sendBtn.disabled = selected.length === 0;
    }

    listEl.addEventListener("change", () => updateSendDisabled());

    sendBtn.addEventListener("click", async () => {
      const selectedEmails = getSelectedParticipants(popoverEl);
      if (!selectedEmails.length) return;

      const bodyEl = panelRoot.querySelector("[data-mp-body]");
      const eventId = displayedPrepCanonical;
      const briefingUrl = await resolveBriefingPreviewUrlForMeeting(eventId);

      const subject = globalThis.MP_EMAIL_TEMPLATES?.BRIEFING_LINK_SUBJECT || "Meeting briefing";
      const body = globalThis.MP_EMAIL_TEMPLATES?.buildBriefingLinkEmailBody
        ? globalThis.MP_EMAIL_TEMPLATES.buildBriefingLinkEmailBody({
            executiveFullName: currentSenderName,
            briefingUrl,
          })
        : `You can find all the details here: ${briefingUrl}`;

      const labelEl = sendBtn.querySelector(".mp-send-briefing-label");
      const prevLabel = labelEl ? labelEl.textContent : "Send Briefing";
      sendBtn.disabled = true;
      if (labelEl) labelEl.textContent = "Sending…";

      try {
        if (bodyEl && isExtensionContextAlive()) {
          const previewPayload = await collectBriefingPreviewPayload(bodyEl);
          await chrome.runtime.sendMessage({
            type: MSG.STASH_BRIEFING_PREVIEW,
            payload: previewPayload,
          });
        }
        if (!isExtensionContextAlive()) {
          throw new Error("Extension context invalidated");
        }
        const res = await chrome.runtime.sendMessage({
          type: MSG.SEND_EMAIL,
          payload: { toEmails: selectedEmails, subject, body },
        });
        if (!res?.ok) throw new Error(res?.message || res?.error || "send_failed");

        if (labelEl) labelEl.textContent = "Sent";
        sendBtn.classList.add("mp-sent");
        sendBtn.setAttribute("aria-label", "Email sent from Gmail");
        console.log("Email sent via Gmail API.", res?.id || "");

        window.setTimeout(() => {
          closeQuestionsPopover();
        }, 1600);
      } catch (e) {
        if (!isContextInvalidatedError(e)) {
          console.warn("Meeting Prep: Gmail API send failed.", e);
        }
        if (labelEl) labelEl.textContent = prevLabel;
        sendBtn.disabled = false;
        const detail = String(e?.message || e || "Unknown error");
        if (isContextInvalidatedError(e)) {
          window.alert("Meeting Prep was updated. Refresh this page, then try again.");
        } else {
          window.alert(
            `Could not send the email automatically (${detail}). In extension options, set your Gmail Web Client ID, add the redirect URI, and complete sign-in. If you already authorized before, try Send Briefing again so Google can grant the updated scopes (gmail.send + userinfo.email).`
          );
        }
      }
    });

    actionsEl.appendChild(sendBtn);
    scrollWrap.append(listEl, previewLabelEl, previewTextEl);
    popoverEl.append(titleEl, scrollWrap, actionsEl);
    document.documentElement.appendChild(popoverEl);

    questionsPopoverEl = popoverEl;
    questionsPopoverAnchorBtn = anchorBtn;

    // Position right after being added to DOM so we can measure.
    positionQuestionsPopover(popoverEl, anchorBtn);

    // Click outside => close
    questionsPopoverOutsideHandler = (ev) => {
      const t = ev.target;
      if (!t) return;
      if (popoverEl.contains(t)) return;
      if (anchorBtn.contains(t)) return;
      closeQuestionsPopover();
    };
    document.addEventListener("mousedown", questionsPopoverOutsideHandler, true);

    // Escape => close
    questionsPopoverKeyHandler = (ev) => {
      if (ev.key === "Escape") closeQuestionsPopover();
    };
    document.addEventListener("keydown", questionsPopoverKeyHandler, true);

    // Default selection: all participants selected, but exclude current user if we can identify them.
    void (async () => {
      const me = await getCurrentUserProfile();

      if (me?.email) {
        const meEmail = normalizeEmail(me.email);
        listEl.querySelectorAll('input[type="checkbox"][data-mp-email]').forEach((cb) => {
          if (normalizeEmail(cb.dataset.mpEmail) === meEmail) cb.checked = false;
        });
      }

      if (me?.name) currentSenderName = me.name;
      else if (me?.email) currentSenderName = me.email.split("@")[0] || currentSenderName;

      const eventId = displayedPrepCanonical;
      const briefingUrl = await resolveBriefingPreviewUrlForMeeting(eventId);
      const bodyPreview = globalThis.MP_EMAIL_TEMPLATES?.buildBriefingLinkEmailBody
        ? globalThis.MP_EMAIL_TEMPLATES.buildBriefingLinkEmailBody({
            executiveFullName: currentSenderName,
            briefingUrl,
          })
        : "";
      previewTextEl.textContent = bodyPreview || "(Preview unavailable.)";

      updateSendDisabled();
    })();

    // Initialize send button state based on current selection.
    updateSendDisabled();
  }

  function toggleQuestionsPopover(anchorBtn) {
    if (questionsPopoverEl) closeQuestionsPopover();
    else renderPopover(anchorBtn);
  }

  function renderPrepBody(bodyEl, sections, meta, eventId, sidebarModules, ctx) {
    const IC = {
      cal: `<svg class="mp-section-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>`,
      users: `<svg class="mp-section-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
      doc: `<svg class="mp-section-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/></svg>`,
    };
    const ALL_KEYS = [
      { key: "agenda", label: "Meeting agenda", heading: "Meeting agenda", module: "agenda", icon: IC.cal },
      { key: "participantsInfo", label: "Participants info", heading: "Participants", module: "participants", icon: IC.users },
      {
        key: "questionsBefore",
        label: "Meeting briefing",
        heading: "Meeting briefing",
        module: "meetingBriefing",
        icon: IC.doc,
      },
    ];
    const vis = sidebarModules && typeof sidebarModules === "object" ? sidebarModules : {};
    const keys = ALL_KEYS.filter((k) => vis[k.module] !== false);
    const merged = sections || {};
    const stale = meta && meta.editStale;
    const sessionPayload = ctx && ctx.payload ? ctx.payload : {};
    const meetingDescription = ctx && ctx.meetingDescription != null ? String(ctx.meetingDescription) : "";

    let workspaceTemplates = Array.isArray(sessionPayload.workspaceTemplates) ? sessionPayload.workspaceTemplates : [];
    let sidebarState;
    try {
      sidebarState = structuredClone(sessionPayload.sidebarState || {});
    } catch {
      sidebarState = JSON.parse(JSON.stringify(sessionPayload.sidebarState || {}));
    }
    if (!sidebarState.participantCards || !Array.isArray(sidebarState.participantCards)) {
      sidebarState.participantCards = [];
    }
    if (sidebarState.participantCards.length === 0) {
      const resolved = sessionPayload.participantsResolved || [];
      sidebarState.participantCards = resolved.map((p) => {
        const em = normalizeEmail(p.email);
        return {
          email: em,
          displayName: String(p.displayName || "").trim() || (em ? em.split("@")[0] : "Guest"),
          company: String(p.company || "").trim() || guessCompanyFromEmailLocal(p.email),
          linkedinUrl: "",
          confidence: p.confidence || "medium",
          aboutPerson: String(p.summary || "").trim(),
          aboutCompany: "",
          insightStale: false,
        };
      });
    }

    function tplById(id) {
      return workspaceTemplates.find((x) => String(x.id) === String(id));
    }

    function cardsToMarkdown(cards) {
      return (cards || [])
        .map((c) => {
          const lines = [`### ${c.displayName || c.email}`, `*${c.email}*`];
          if (c.company) lines.push(`Company: ${c.company}`);
          if (c.linkedinUrl) lines.push(`LinkedIn: ${c.linkedinUrl}`);
          lines.push("", c.aboutPerson || "", "", c.aboutCompany || "");
          return lines.join("\n").trim();
        })
        .join("\n\n---\n\n");
    }

    function badgeClass(conf) {
      const x = String(conf || "medium").toLowerCase();
      if (x === "high") return "mp-badge mp-badge-high";
      if (x === "low") return "mp-badge mp-badge-low";
      return "mp-badge mp-badge-med";
    }

    function participantCardHtml(c, idx) {
      const conf = String(c.confidence || "medium").toLowerCase();
      const staleC = c.insightStale ? " mp-pcard--stale" : "";
      const hot = c.insightStale ? " mp-regen--hot" : "";
      const expId = `mp-pcx-${idx}`;
      const liIcon = `<svg class="mp-pcard-li-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>`;
      return `
        <div class="mp-pcard${staleC}" data-mp-pcard data-email="${escapeHtml(c.email)}" data-insight-stale="${c.insightStale ? "1" : "0"}" data-mp-confidence="${escapeHtml(conf)}">
          <div class="mp-pcard-head">
            <div class="mp-pcard-head-text">
              <input type="text" class="mp-pcard-name" data-p-name value="${escapeHtml(c.displayName)}" aria-label="Participant name" />
            </div>
            <span class="${badgeClass(conf)}" data-p-badge>${escapeHtml(conf)}</span>
          </div>
          <div class="mp-pcard-company-row">
            <input type="text" class="mp-pcard-company" data-p-company placeholder="company name" value="${escapeHtml(c.company)}" aria-label="Company" />
            <button type="button" class="mp-pcard-chev" data-mp-expand aria-expanded="false" aria-controls="${expId}" aria-label="Expand in-depth details">
              <svg class="mp-pcard-chev-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
            </button>
          </div>
          <div class="mp-pcard-li-shell">
            ${liIcon}
            <input type="url" class="mp-pcard-linkedin" data-p-linkedin placeholder="Add LinkedIn URL…" value="${escapeHtml(c.linkedinUrl)}" aria-label="LinkedIn profile URL" />
          </div>
          <div class="mp-pcard-expanded" id="${expId}" hidden>
            <div class="mp-pcard-depth-head">
              <span class="mp-pcard-depth-label">In-depth details</span>
              <button type="button" class="mp-regen${hot}" data-mp-regen title="Regenerate insight" aria-label="Regenerate participant insight">
                <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true"><path d="M12 2l1.35 4.05L17.5 8l-4.15 1.95L12 14l-1.35-4.05L6.5 8l4.15-1.95L12 2zm0 9.5l.9 2.7L15.5 15l-2.6 1.2L12 18.5l-.9-2.7L8.5 15l2.6-1.2L12 11.5z"/></svg>
              </button>
            </div>
            <div class="mp-pcard-sublabel">About participant</div>
            <textarea class="mp-pcard-ta-expanded" data-p-about-person rows="4" aria-label="About participant">${escapeHtml(c.aboutPerson || "")}</textarea>
            <div class="mp-pcard-sublabel">About company</div>
            <textarea class="mp-pcard-ta-expanded" data-p-about-company rows="3" aria-label="About company">${escapeHtml(c.aboutCompany || "")}</textarea>
            ${
              conf === "low"
                ? `<p class="mp-muted mp-pcard-hint">Low confidence — verify LinkedIn or name/company, then regenerate.</p>`
                : ""
            }
          </div>
        </div>`;
    }

    let agendaUserEdited = false;
    const selId = sidebarState.selectedTemplateId || "";
    const curTpl = tplById(selId);
    const tplDefault = String(curTpl?.agendaText || sidebarState.agendaTemplateDefault || "").trim();
    if (String(merged.agenda || "").trim() !== tplDefault) agendaUserEdited = true;

    let debounceTimer = null;
    const statusElRef = { el: null };

    function readCardsFromDom() {
      const out = [];
      bodyEl.querySelectorAll("[data-mp-pcard]").forEach((row) => {
        const email = normalizeEmail(row.dataset.email);
        out.push({
          email,
          displayName: row.querySelector("[data-p-name]")?.value?.trim() || "",
          company: row.querySelector("[data-p-company]")?.value?.trim() || "",
          linkedinUrl: row.querySelector("[data-p-linkedin]")?.value?.trim() || "",
          confidence: row.dataset.mpConfidence || "medium",
          aboutPerson: row.querySelector("[data-p-about-person]")?.value || "",
          aboutCompany: row.querySelector("[data-p-about-company]")?.value || "",
          insightStale: row.dataset.insightStale === "1",
        });
      });
      return out;
    }

    function markPcardStale(row) {
      row.dataset.insightStale = "1";
      row.dataset.mpConfidence = "low";
      row.classList.add("mp-pcard--stale");
      const b = row.querySelector("[data-p-badge]");
      if (b) {
        b.className = badgeClass("low");
        b.textContent = "low";
      }
      const r = row.querySelector("[data-mp-regen]");
      if (r) r.classList.add("mp-regen--hot");
    }

    function applyCardData(row, c) {
      row.dataset.insightStale = c.insightStale ? "1" : "0";
      row.dataset.mpConfidence = String(c.confidence || "medium").toLowerCase();
      row.classList.toggle("mp-pcard--stale", !!c.insightStale);
      const nm = row.querySelector("[data-p-name]");
      const co = row.querySelector("[data-p-company]");
      const li = row.querySelector("[data-p-linkedin]");
      const ap = row.querySelector("[data-p-about-person]");
      const ac = row.querySelector("[data-p-about-company]");
      if (nm) nm.value = c.displayName || "";
      if (co) co.value = c.company || "";
      if (li) li.value = c.linkedinUrl || "";
      if (ap) ap.value = c.aboutPerson || "";
      if (ac) ac.value = c.aboutCompany || "";
      const b = row.querySelector("[data-p-badge]");
      if (b) {
        b.className = badgeClass(c.confidence);
        b.textContent = String(c.confidence || "medium").toLowerCase();
      }
      const rg = row.querySelector("[data-mp-regen]");
      if (rg) rg.classList.toggle("mp-regen--hot", !!c.insightStale);
    }

    function gatherSessionPayload() {
      const edits = {};
      keys.forEach((k) => {
        if (k.key === "agenda") {
          const ta = bodyEl.querySelector("[data-mp-agenda-ta]");
          if (ta) edits.agenda = ta.value;
        } else if (k.key === "participantsInfo") {
          edits.participantsInfo = cardsToMarkdown(readCardsFromDom());
        } else {
          const ta = bodyEl.querySelector(`textarea[data-section="${k.key}"]`);
          if (ta) edits[k.key] = ta.value;
        }
      });
      const sel = bodyEl.querySelector("[data-mp-template-select]");
      let tid = sel && !sel.disabled ? sel.value : "";
      if (tid === "__none__") tid = "";
      const tpl = tplById(tid);
      const ss = {
        selectedTemplateId: tid || null,
        agendaTemplateDefault: tpl ? String(tpl.agendaText || "") : "",
        participantCards: readCardsFromDom(),
      };
      return { edits, sidebarState: ss };
    }

    async function flushSession(reason) {
      if (!eventId) return;
      const st = statusElRef.el;
      if (st) {
        st.textContent = reason === "manual" ? "Saving…" : "Auto-saving…";
        st.classList.add("mp-saving");
      }
      const { edits, sidebarState: ss } = gatherSessionPayload();
      try {
        if (!isExtensionContextAlive()) {
          if (st) {
            st.classList.remove("mp-saving");
            st.textContent = "Extension was updated — refresh this page to save.";
          }
          return;
        }
        const res = await chrome.runtime.sendMessage({
          type: MSG.PREP_SESSION_SYNC,
          payload: {
            calendarEventId: eventId,
            edits,
            sidebarState: ss,
            meetingDescription,
          },
        });
        if (st) {
          st.classList.remove("mp-saving");
          st.textContent = res?.ok ? "All changes saved." : "Save failed — check connection.";
        }
        Object.assign(sidebarState, ss);
      } catch (e) {
        if (st) st.classList.remove("mp-saving");
        if (isContextInvalidatedError(e)) {
          if (st) st.textContent = "Extension was updated — refresh this page to save.";
          return;
        }
        if (st) st.textContent = "Save failed — check connection.";
        console.warn("Meeting Prep: session sync failed", e);
      }
    }

    function scheduleSync() {
      if (!eventId) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      const st = statusElRef.el;
      if (st) {
        st.textContent = "Auto-saving…";
        st.classList.add("mp-saving");
      }
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void flushSession("debounce");
      }, 850);
    }

    if (!keys.length) {
      bodyEl.innerHTML = `
        ${stale ? `<p class="mp-muted" role="status">Meeting details changed since your last edit.</p>` : ""}
        <p class="mp-muted" role="status">All sidebar sections are hidden. Open <strong>Workspace settings</strong> (settings icon) to show agenda, participants, or other blocks.</p>
      `;
      return;
    }

    const showAgenda = keys.some((k) => k.key === "agenda");
    const showParticipants = keys.some((k) => k.key === "participantsInfo");
    const otherKeys = keys.filter((k) => k.key !== "agenda" && k.key !== "participantsInfo");

    const noTemplates = !workspaceTemplates.length;
    const selectOpts = noTemplates
      ? `<option value="">No templates — add in Workspace settings</option>`
      : `<option value="__none__" ${!selId ? "selected" : ""}>Not selected…</option>${workspaceTemplates
          .map(
            (t) =>
              `<option value="${escapeHtml(t.id)}" ${String(t.id) === String(selId) ? "selected" : ""}>${escapeHtml(t.name)}</option>`
          )
          .join("")}`;

    const agendaVal = merged.agenda || "";
    const agendaDisabled = noTemplates || (!selId && !noTemplates);
    const agendaPlaceholder = noTemplates
      ? "Please add meeting templates in Workspace settings."
      : !selId
        ? "Please select a meeting type above."
        : "";

    const parts = [];
    parts.push(stale ? `<p class="mp-muted" role="status">Meeting details changed since your last edit. Review sections below.</p>` : "");

    if (showAgenda) {
      parts.push(`
        <div class="mp-section" data-mp-agenda-section>
          <div class="mp-section-heading">
            <span class="mp-section-icon">${IC.cal}</span>
            <span class="mp-section-label">Meeting agenda</span>
          </div>
          <div class="mp-section-card">
            <select class="mp-template-select" data-mp-template-select ${noTemplates ? "disabled" : ""} aria-label="Meeting type">${selectOpts}</select>
            <textarea
              class="mp-pcard-ta-expanded"
              data-mp-agenda-ta
              data-section="agenda"
              aria-label="Meeting agenda"
              ${agendaDisabled ? "disabled" : ""}
              placeholder="${escapeHtml(agendaPlaceholder)}"
            >${escapeHtml(agendaDisabled ? "" : agendaVal)}</textarea>
          </div>
        </div>`);
    }

    if (showParticipants) {
      const cardsHtml = sidebarState.participantCards.map((c, i) => participantCardHtml(c, i)).join("");
      parts.push(`
        <div class="mp-section" data-mp-participants-section>
          <div class="mp-section-heading">
            <span class="mp-section-icon">${IC.users}</span>
            <span class="mp-section-label">Participants</span>
          </div>
          <div class="mp-section-card mp-participants-inner">
            ${cardsHtml || `<p class="mp-muted">No participants listed for this event.</p>`}
          </div>
        </div>`);
    }

    otherKeys.forEach((k) => {
      const extra =
        k.key === "questionsBefore"
          ? `<div class="mp-questions-send-row">
              <button type="button" class="mp-btn-briefing-preview" data-mp-briefing-preview aria-label="Preview meeting briefing" title="Open briefing preview">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>
                Preview
              </button>
              <button type="button" class="mp-send-briefing-pill" data-mp-send-briefing aria-label="Send briefing">
                ${MP_SEND_PLANE_SVG}
                <span>Send Briefing</span>
              </button>
            </div>`
          : "";
      parts.push(`
        <div class="mp-section">
          <div class="mp-section-heading">
            <span class="mp-section-icon">${k.icon}</span>
            <span class="mp-section-label">${escapeHtml(k.heading)}</span>
          </div>
          <div class="mp-section-card">
            <div class="mp-textarea-wrap">
              <textarea aria-label="${escapeHtml(k.label)}" data-section="${escapeHtml(k.key)}">${escapeHtml(merged[k.key] || "")}</textarea>
              ${extra}
            </div>
          </div>
        </div>`);
    });

    parts.push(`
      <div class="mp-actions">
        <button type="button" class="mp-primary" data-mp-save ${!eventId ? "disabled" : ""}>Save now</button>
        <div class="mp-save-status" data-mp-save-status aria-live="polite">${eventId ? "" : "Link to a saved calendar event to sync to the server."}</div>
        ${eventId ? `<span class="mp-muted">Edits debounce-sync while you type.</span>` : ""}
      </div>`);

    bodyEl.innerHTML = parts.join("");

    statusElRef.el = bodyEl.querySelector("[data-mp-save-status]");

    const agendaTa = bodyEl.querySelector("[data-mp-agenda-ta]");
    const tplSel = bodyEl.querySelector("[data-mp-template-select]");

    if (agendaTa && !agendaTa.disabled) {
      agendaTa.addEventListener("input", () => {
        agendaUserEdited = true;
        scheduleSync();
      });
    }

    if (tplSel && !tplSel.disabled) {
      tplSel.addEventListener("change", () => {
        const nextId = tplSel.value === "__none__" ? "" : tplSel.value;
        const nextTpl = tplById(nextId);
        const nextAgenda = String(nextTpl?.agendaText || "").trim();
        if (agendaUserEdited && agendaTa && String(agendaTa.value || "").trim() !== nextAgenda) {
          const ok = window.confirm(
            "Switching types will overwrite your manual agenda edits. Proceed?"
          );
          if (!ok) {
            tplSel.value = sidebarState.selectedTemplateId ? String(sidebarState.selectedTemplateId) : "__none__";
            return;
          }
        }
        sidebarState.selectedTemplateId = nextId || null;
        sidebarState.agendaTemplateDefault = nextAgenda;
        if (agendaTa) {
          agendaTa.disabled = !nextId && !noTemplates;
          agendaTa.value = nextId ? nextAgenda : "";
          agendaUserEdited = false;
        }
        scheduleSync();
      });
    }

    bodyEl.querySelectorAll("[data-mp-pcard]").forEach((row) => {
      row.querySelector("[data-p-name]")?.addEventListener("input", () => {
        markPcardStale(row);
        scheduleSync();
      });
      row.querySelector("[data-p-company]")?.addEventListener("input", () => {
        markPcardStale(row);
        scheduleSync();
      });
      row.querySelector("[data-p-linkedin]")?.addEventListener("input", scheduleSync);
      row.querySelector("[data-p-about-person]")?.addEventListener("input", scheduleSync);
      row.querySelector("[data-p-about-company]")?.addEventListener("input", scheduleSync);

      row.querySelector("[data-mp-expand]")?.addEventListener("click", (e) => {
        e.preventDefault();
        const btn = row.querySelector("[data-mp-expand]");
        const exp = row.querySelector(".mp-pcard-expanded");
        if (!exp) return;
        const open = exp.hasAttribute("hidden");
        if (open) exp.removeAttribute("hidden");
        else exp.setAttribute("hidden", "");
        if (btn) {
          btn.setAttribute("aria-expanded", open ? "true" : "false");
          btn.classList.toggle("mp-pcard-chev--open", open);
        }
      });

      row.querySelector("[data-mp-regen]")?.addEventListener("click", (e) => {
        e.preventDefault();
        if (!eventId) {
          window.alert("Save the meeting to your calendar first to regenerate insights.");
          return;
        }
        const email = normalizeEmail(row.dataset.email);
        const card = {
          email,
          displayName: row.querySelector("[data-p-name]")?.value?.trim() || "",
          company: row.querySelector("[data-p-company]")?.value?.trim() || "",
          linkedinUrl: row.querySelector("[data-p-linkedin]")?.value?.trim() || "",
        };
        const rg = row.querySelector("[data-mp-regen]");
        if (rg) rg.disabled = true;
        if (!isExtensionContextAlive()) {
          if (rg) rg.disabled = false;
          return;
        }
        void chrome.runtime.sendMessage(
          {
            type: MSG.PARTICIPANT_REGENERATE,
            payload: { calendarEventId: eventId, card },
          },
          (res) => {
            if (rg) rg.disabled = false;
            const err = chrome.runtime.lastError;
            if (err) {
              if (!isContextInvalidatedError(err)) {
                window.alert(err.message || "Regenerate failed.");
              }
              return;
            }
            if (!res?.ok) {
              window.alert(res?.message || "Regenerate failed.");
              return;
            }
            if (res.card) applyCardData(row, res.card);
            void flushSession("regen");
          }
        );
      });
    });

    keys.forEach((k) => {
      if (k.key === "agenda" || k.key === "participantsInfo") return;
      bodyEl.querySelector(`textarea[data-section="${k.key}"]`)?.addEventListener("input", scheduleSync);
    });

    const saveBtn = bodyEl.querySelector("[data-mp-save]");
    if (saveBtn && eventId) {
      saveBtn.addEventListener("click", async () => {
        saveBtn.disabled = true;
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        try {
          await flushSession("manual");
          saveBtn.textContent = "Saved";
          setTimeout(() => {
            saveBtn.textContent = "Save now";
            saveBtn.disabled = false;
          }, 1400);
        } catch {
          saveBtn.disabled = false;
          window.alert("Could not save. Check the backend URL and sign-in.");
        }
      });
    }

    const previewBriefingBtn = bodyEl.querySelector("[data-mp-briefing-preview]");
    if (previewBriefingBtn) {
      previewBriefingBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        void openBriefingPreviewFromBodyEl(bodyEl);
      });
    }

    const sendBriefingBtn = bodyEl.querySelector("[data-mp-send-briefing]");
    if (sendBriefingBtn) {
      sendBriefingBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleQuestionsPopover(sendBriefingBtn);
      });
    }

    if (eventId && showParticipants && sidebarState.participantCards.length) {
      sidebarState.participantCards.forEach((c, i) => {
        window.setTimeout(() => {
          let row = null;
          const want = normalizeEmail(c.email);
          bodyEl.querySelectorAll("[data-mp-pcard]").forEach((r) => {
            if (normalizeEmail(r.dataset.email) === want) row = r;
          });
          if (!row) return;
        if (!isExtensionContextAlive()) return;
        void chrome.runtime.sendMessage(
          {
            type: MSG.PARTICIPANT_REGENERATE,
            payload: {
              calendarEventId: eventId,
              card: {
                email: c.email,
                displayName: c.displayName,
                company: c.company,
                linkedinUrl: c.linkedinUrl,
              },
            },
          },
          (res) => {
            const err = chrome.runtime.lastError;
            if (err || !res?.ok) return;
            if (res.card) applyCardData(row, res.card);
          }
        );
        }, i * 450);
      });
    }
  }
  function showLoading(title, usage) {
    removeExistingPanel();
    const panel = buildPanelShell(title || "Untitled meeting", () => {
      panel.remove();
    }, { usage: usage || undefined });
    const body = panel.querySelector("[data-mp-body]");
    body.innerHTML = `<div class="mp-shimmer"></div><div class="mp-shimmer" style="margin-top:12px"></div><p class="mp-muted" style="margin-top:16px">Generating prep…</p>`;
    document.documentElement.appendChild(panel);
    panel.querySelector(".mp-panel").focus?.();
    return panel;
  }

  async function showCreditsExhaustedPanel(title, calendarEventId) {
    removeExistingPanel();
    const usage = await loadPrepUsageState();
    const panel = buildPanelShell(title || "Untitled meeting", () => {
      if (calendarEventId) setDismissed(calendarEventId);
      panel.remove();
    }, { usage });
    const body = panel.querySelector("[data-mp-body]");
    body.innerHTML = `
      <div class="mp-credits-exhausted">
        <p class="mp-credits-exhausted-title">You've used all your free credits</p>
        <p class="mp-credits-exhausted-text">You've reached your limit of ${FREE_PREPS_PER_MONTH} meeting preps this month on the Free plan. Upgrade to generate more.</p>
        <button type="button" class="mp-primary mp-credits-upgrade-btn" data-mp-exhausted-upgrade>Upgrade</button>
      </div>`;
    body.querySelector("[data-mp-exhausted-upgrade]")?.addEventListener("click", (e) => {
      e.preventDefault();
      openBillingPlansModal(panel);
    });
    document.documentElement.appendChild(panel);
    displayedPrepCanonical = calendarEventId || null;
    panel.querySelector(".mp-panel")?.focus?.();
  }

  async function runPrepGeneration(snapshot) {
    injectGlobalStyles();
    clearDismissIfEventChanged(snapshot.calendarEventId);
    const prod = await isProdMode();
    const usageBefore = await loadPrepUsageState();
    if (prod && usageBefore.used >= usageBefore.limit) {
      await showCreditsExhaustedPanel(snapshot.title || "Untitled meeting", snapshot.calendarEventId);
      return;
    }
    const loading = showLoading(snapshot.title || "Untitled meeting", usageBefore);
    const prepTimeoutMs = 120000;
    const res = await Promise.race([
      (async () => {
        try {
          if (!isExtensionContextAlive()) {
            return {
              ok: false,
              error: "context_invalidated",
              message: "Extension was updated. Refresh this page to keep using Meeting Prep.",
            };
          }
          return await chrome.runtime.sendMessage({
            type: MSG.PREP_MEETING,
            payload: snapshot,
          });
        } catch (e) {
          if (isContextInvalidatedError(e)) {
            return {
              ok: false,
              error: "context_invalidated",
              message: "Extension was updated. Refresh this page to keep using Meeting Prep.",
            };
          }
          throw e;
        }
      })(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("prep_timeout")), prepTimeoutMs)
      ),
    ]).catch((e) => ({ ok: false, error: "prep_failed", message: String(e?.message || e) }));
    loading.remove();
    if (!res || !res.ok) {
      if (res && res.error === "needs_input") {
        alert(res.message || "Add a title or attendees first.");
        return;
      }
      if (res && res.error === "context_invalidated") {
        alert(res.message || "Extension was updated. Refresh this page.");
        return;
      }
      if (res && res.error === "cors_forbidden") {
        alert(res.message || "Server CORS blocked this extension. Add your chrome-extension:// ID in AWS CORS_ALLOWED_ORIGINS.");
        return;
      }
      if (res && (res.error === "prep_timeout" || res.error === "prep_failed")) {
        alert(res.message || res.error || "Prep failed.");
        return;
      }
      alert(res?.message || res?.error || "Prep failed. Check backend URL and Google sign-in.");
      return;
    }
    const eventId = res.eventId || snapshot.calendarEventId;
    const title = snapshot.title || res.prep?.title || "Untitled meeting";
    await incrementPrepUsageAfterSuccessfulGeneration();
    await showPrepCard(title, res, eventId);
  }

  async function showPrepCard(title, payload, eventId) {
    removeExistingPanel();
    const usage = await loadPrepUsageState();
    const panel = buildPanelShell(title || "Untitled meeting", () => {
      setDismissed(eventId);
      panel.remove();
    }, {
      onRefresh: () =>
        void runPrepGeneration({ ...scrapeOpenEvent(), identifierHints: getMergedIdentifiers() }),
      usage,
    });
    const body = panel.querySelector("[data-mp-body]");
    const prep = payload.merged || payload.prep || {};
    const sections = {
      participantsInfo: prep.participantsInfo || "",
      agenda: prep.agenda || "",
      questionsBefore: prep.questionsBefore || "",
      questionsInMeeting: prep.questionsInMeeting || "",
    };
    let sidebarModules = {};
    let localTemplates = [];
    try {
      const ws = await MPWorkspaceSettings.loadLocal();
      sidebarModules = ws.sidebarModules || {};
      localTemplates = ws.meetingTemplates || [];
    } catch {
      sidebarModules = {};
    }
    const pl = { ...payload };
    if (!Array.isArray(pl.workspaceTemplates) || pl.workspaceTemplates.length === 0) {
      pl.workspaceTemplates = localTemplates;
    }
    const snap = scrapeOpenEvent();
    renderPrepBody(body, sections, pl.meta, eventId, sidebarModules, {
      payload: pl,
      meetingDescription: snap.description || "",
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
      try {
        if (!isExtensionContextAlive()) return;
        const { mp_prep_cache_v1: cache } = await chrome.storage.local.get("mp_prep_cache_v1");
        const row = cache?.byCanonicalId?.[canon];
        if (!row?.hasPrep || !row.prepPayload) return;
        const snapshot = scrapeOpenEvent();
        const title = snapshot.title || row.prepPayload.title || "Untitled meeting";
        await showPrepCard(title, row.prepPayload, canon);
      } catch (e) {
        if (!isContextInvalidatedError(e)) console.warn("Meeting Prep: refresh from storage", e);
      }
    })();
  }

  function refreshPrepPanelFromWorkspaceSettings() {
    const canon = displayedPrepCanonical;
    if (!canon || !document.querySelector(`[${MP.PANEL_ATTR}]`)) return;
    void (async () => {
      try {
        if (!isExtensionContextAlive()) return;
        const { mp_prep_cache_v1: cache } = await chrome.storage.local.get("mp_prep_cache_v1");
        const row = cache?.byCanonicalId?.[canon];
        if (!row?.hasPrep || !row.prepPayload) return;
        const snapshot = scrapeOpenEvent();
        const title = snapshot.title || row.prepPayload.title || "Untitled meeting";
        await showPrepCard(title, row.prepPayload, canon);
      } catch (e) {
        if (!isContextInvalidatedError(e)) console.warn("Meeting Prep: refresh from workspace settings", e);
      }
    })();
  }

  async function onPrepClick() {
    const snapshot = { ...scrapeOpenEvent(), identifierHints: getMergedIdentifiers() };
    await runPrepGeneration(snapshot);
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

    if (!isCalendarEventEditorOpen()) return;

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
        const title = snapshot.title || localHit.prepPayload.title || "Untitled meeting";
        void showPrepCard(title, localHit.prepPayload, eventId);
      }
      return;
    }

    if (candidates.length && candidates.every((c) => isDismissed(c))) return;

    let res;
    try {
      if (!isExtensionContextAlive()) return;
      res = await chrome.runtime.sendMessage({
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
    } catch (e) {
      if (!isContextInvalidatedError(e)) console.warn("Meeting Prep: auto-sync", e);
      return;
    }

    if (!res || res.status !== "found" || !res.prepPayload) return;

    const eventId = res.matchedEventId || res.prepPayload.eventId;
    if (!eventId || isDismissed(eventId)) return;

    const title = snapshot.title || res.prepPayload.title || "Untitled meeting";
    void showPrepCard(title, res.prepPayload, eventId);
  }

  function onUrlChange() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      lastScrapedEventId = null;
      syncPrepPanelWithCalendarDialog();
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
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      lastScrapedEventId = null;
      syncPrepPanelWithCalendarDialog();
    }
    scheduleAutoSync();
  });

  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      lastScrapedEventId = null;
      syncPrepPanelWithCalendarDialog();
      scheduleAutoSync();
    } else {
      syncPrepPanelWithCalendarDialog();
    }
  }, 1200);

  scanAndInject();
  syncPrepPanelWithCalendarDialog();
  scheduleAutoSync();

  chrome.storage.onChanged.addListener((changes, area) => {
    try {
      if (!isExtensionContextAlive()) return;
    } catch {
      return;
    }
    if (area !== "local") return;
    try {
      if (changes.mp_prep_cache_v1) {
        refreshPrepPanelFromStorageIfOpen();
        if (isCalendarEventEditorOpen() && !document.querySelector(`[${MP.PANEL_ATTR}]`)) {
          scheduleAutoSync();
        }
      }
      if (changes.mp_workspace_settings_v1) {
        refreshPrepPanelFromWorkspaceSettings();
      }
    } catch (e) {
      if (!isContextInvalidatedError(e)) console.warn("Meeting Prep: storage listener", e);
    }
  });
})();
