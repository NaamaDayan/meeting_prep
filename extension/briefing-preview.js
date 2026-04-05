/**
 * Meeting briefing preview tab — reads payload from chrome.storage.session (set by content script).
 */
(function () {
  const STORAGE_KEY = "mp_briefing_preview_v1";

  const INTRO_COPY =
    "This pre-meeting briefing was created to align our focus for our upcoming session. If you could kindly walk through the sections below and highlight what's most relevant to you, it would be highly appreciated and help ensure I make the absolute best use of your time.";

  const IC = {
    calendar:
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
    users:
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    shield:
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M12 8v4M12 16h.01"/></svg>',
    message:
      '<svg width="120" height="120" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    trash:
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
    send:
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
  };

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** Calendar meeting date (date-focused; uses event start from sidebar scrape). */
  function fmtMeetingDate(iso) {
    if (!iso) return "Date to be confirmed";
    const d = new Date(String(iso));
    if (Number.isNaN(d.getTime())) return esc(String(iso));
    return esc(
      d.toLocaleDateString(undefined, {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    );
  }

  function initials(name) {
    const p = String(name || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!p.length) return "?";
    if (p.length === 1) return esc(p[0].slice(0, 2).toUpperCase());
    return esc((p[0][0] + p[p.length - 1][0]).toUpperCase());
  }

  function bioText(p) {
    const a = String(p.aboutPerson || "").trim();
    const b = String(p.aboutCompany || "").trim();
    if (a && b) return `${a}\n\n${b}`;
    return a || b || "No bio yet.";
  }

  let priorityState = [];
  let seq = 1;

  function uid() {
    return `bp_${Date.now()}_${seq++}`;
  }

  function seedPriorities(bullets) {
    priorityState = (bullets || []).map((title) => ({
      id: uid(),
      title: String(title || ""),
      description: "",
      checked: false,
      comments: "",
      isDraft: false,
      deleteConfirm: false,
      commentsVisible: false,
    }));
  }

  function renderPriorities() {
    const root = document.getElementById("bp-priorities-list");
    if (!root) return;
    root.innerHTML = priorityState
      .map((item) => {
        if (item.isDraft) {
          return `
            <div class="bp-priority bp-priority--draft" data-bp-id="${esc(item.id)}">
              <input type="text" class="bp-priority-title bp-input" data-field="title" placeholder="TITLE" value="${esc(item.title)}" />
              <textarea class="bp-priority-desc bp-input" data-field="description" rows="2" placeholder="Description">${esc(item.description)}</textarea>
              <div class="bp-priority-footer">
                <span></span>
                <div class="bp-priority-actions">
                  <button type="button" class="bp-btn-mini bp-btn-confirm" data-action="confirm-draft">Confirm</button>
                  <button type="button" class="bp-btn-mini bp-btn-discard" data-action="discard-draft">Discard</button>
                </div>
              </div>
            </div>`;
        }
        const checkOn = item.checked ? " bp-priority-check--on" : "";
        const checkMark = item.checked ? "✓" : "";
        const delBlock = item.deleteConfirm
          ? `<div class="bp-delete-confirm">
               <button type="button" class="bp-btn-mini" data-action="cancel-delete">Cancel</button>
               <button type="button" class="bp-btn-mini bp-btn-danger" data-action="confirm-delete">Delete</button>
             </div>`
          : `<button type="button" class="bp-icon-trash" data-action="trash" aria-label="Delete">${IC.trash}</button>`;
        const commentsBlock = item.commentsVisible
          ? `<textarea class="bp-priority-comments bp-input" data-field="comments" rows="2" placeholder="Comment">${esc(item.comments)}</textarea>`
          : "";
        return `
          <div class="bp-priority ${item.checked ? "bp-priority--done" : ""}" data-bp-id="${esc(item.id)}">
            <div class="bp-priority-top">
              <button type="button" class="bp-priority-check${checkOn}" data-action="toggle-check" aria-label="Toggle complete">
                <span class="bp-check-icon">${checkMark}</span>
              </button>
              <div class="bp-priority-fields">
                <input type="text" class="bp-priority-title bp-input" data-field="title" value="${esc(item.title)}" />
                <textarea class="bp-priority-desc bp-input" data-field="description" rows="2">${esc(item.description)}</textarea>
              </div>
            </div>
            <div class="bp-priority-footer">
              <button type="button" class="bp-btn-link" data-action="toggle-comment">Add / edit comment</button>
              ${delBlock}
            </div>
            ${commentsBlock}
          </div>`;
      })
      .join("");
  }

  function setupPriorityDelegation() {
    const root = document.getElementById("bp-priorities-list");
    if (!root || root.dataset.bpBound === "1") return;
    root.dataset.bpBound = "1";
    root.addEventListener("input", (e) => {
      const inp = e.target.closest("[data-field]");
      if (!inp || !root.contains(inp)) return;
      const card = inp.closest("[data-bp-id]");
      const id = card?.dataset.bpId;
      const item = priorityState.find((x) => x.id === id);
      if (!item) return;
      item[inp.dataset.field] = inp.value;
    });
    root.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn || !root.contains(btn)) return;
      const card = btn.closest("[data-bp-id]");
      const id = card?.dataset.bpId;
      const item = priorityState.find((x) => x.id === id);
      const action = btn.dataset.action;
      if (!item) return;
      if (action === "toggle-check" && !item.isDraft) {
        item.checked = !item.checked;
        renderPriorities();
      } else if (action === "trash") {
        item.deleteConfirm = true;
        renderPriorities();
      } else if (action === "cancel-delete") {
        item.deleteConfirm = false;
        renderPriorities();
      } else if (action === "confirm-delete") {
        priorityState = priorityState.filter((x) => x.id !== id);
        renderPriorities();
      } else if (action === "toggle-comment") {
        item.commentsVisible = !item.commentsVisible;
        renderPriorities();
      } else if (action === "confirm-draft") {
        item.isDraft = false;
        item.title = (item.title || "").trim() || "Untitled priority";
        renderPriorities();
      } else if (action === "discard-draft") {
        priorityState = priorityState.filter((x) => x.id !== id);
        renderPriorities();
      }
    });
  }

  function participantCard(p, isHost) {
    const role = isHost ? "Host" : "Guest";
    const cardCls = isHost ? "bp-card bp-card--host" : "bp-card";
    return `
      <article class="${cardCls}">
        <div class="bp-card-head">
          <div class="bp-avatar" aria-hidden="true">${initials(p.displayName || p.email)}</div>
          <div>
            <h3 class="bp-pname">${esc(p.displayName || p.email || "Participant")}</h3>
            <p class="bp-prole">${role}</p>
            ${p.company ? `<p class="bp-pcompany">${esc(p.company)}</p>` : ""}
            ${p.email ? `<p class="bp-pcompany">${esc(p.email)}</p>` : ""}
          </div>
        </div>
        <div class="bp-bio">${esc(bioText(p))}</div>
      </article>`;
  }

  function participantsBlock(data) {
    const parts = Array.isArray(data.participants) ? data.participants : [];
    if (!parts.length) {
      return '<p class="bp-muted">No participants in this prep.</p>';
    }
    let hi = Number.isFinite(data.hostIndex) ? data.hostIndex : 0;
    hi = Math.min(Math.max(0, hi), parts.length - 1);
    const host = parts[hi];
    const guests = parts.filter((_, i) => i !== hi);
    const cards = [participantCard(host, true), ...guests.map((g) => participantCard(g, false))];
    return `<div class="bp-pgrid">${cards.join("")}</div>`;
  }

  function buildPage(data) {
    return `
      <div class="bp-wrap">
        <div class="bp-container">
          <header>
            <h1 class="bp-title">${esc(data.title || "Meeting")}</h1>
            <div class="bp-date-row">${IC.calendar}<span>${fmtMeetingDate(data.startIso)}</span></div>
            <p class="bp-intro">${esc(INTRO_COPY)}</p>
          </header>

          <section>
            <div class="bp-section-head">
              <div class="bp-section-icon bp-section-icon--indigo">${IC.users}</div>
              <h2 class="bp-section-title">The participants</h2>
            </div>
            ${participantsBlock(data)}
          </section>

          <section>
            <div class="bp-priorities-shell">
              <div class="bp-priorities-top">
                <div class="bp-section-head" style="margin:0;border:none;padding:0">
                  <div class="bp-section-icon bp-section-icon--rose">${IC.shield}</div>
                  <h2 class="bp-section-title" style="font-size:1.35rem">Meeting priorities</h2>
                </div>
                <div class="bp-priorities-actions">
                  <button type="button" class="bp-btn-dark" id="bp-add-item">Add item</button>
                  <button type="button" class="bp-btn-dark" id="bp-add-challenge">Add personal challenge</button>
                </div>
              </div>
              <div class="bp-priority-grid" id="bp-priorities-list"></div>
            </div>

            <div class="bp-custom-box">
              <div class="bp-custom-watermark">${IC.message}</div>
              <h3>Custom requests</h3>
              <div class="bp-custom-inner">
                <textarea class="bp-custom-ta" id="bp-custom-requests" placeholder="Add notes for your team (preview only — not sent)…"></textarea>
                <button type="button" class="bp-send-organizer" id="bp-send-organizer" title="Not available in preview">${IC.send}<span>Send to meeting organizer</span></button>
              </div>
            </div>
          </section>
        </div>
      </div>`;
  }

  async function main() {
    const app = document.getElementById("app");
    let data = null;
    try {
      const r = await chrome.storage.session.get(STORAGE_KEY);
      data = r[STORAGE_KEY];
      await chrome.storage.session.remove(STORAGE_KEY);
    } catch (e) {
      console.warn("Briefing preview storage", e);
    }

    if (!data || typeof data !== "object") {
      app.innerHTML =
        '<div class="bp-empty"><p>No preview data. Open Meeting Prep in Google Calendar and click <strong>Preview</strong> on the meeting briefing section.</p></div>';
      return;
    }

    app.innerHTML = buildPage(data);
    seedPriorities(data.priorityBullets);
    if (!priorityState.length) {
      priorityState.push({
        id: uid(),
        title: "Add bullet items to Meeting briefing in the sidebar, or use Add item",
        description: "",
        checked: false,
        comments: "",
        isDraft: false,
        deleteConfirm: false,
        commentsVisible: false,
      });
    }
    renderPriorities();
    setupPriorityDelegation();

    function addDraft() {
      priorityState.push({
        id: uid(),
        title: "",
        description: "",
        checked: false,
        comments: "",
        isDraft: true,
        deleteConfirm: false,
        commentsVisible: false,
      });
      renderPriorities();
    }

    document.getElementById("bp-add-item")?.addEventListener("click", addDraft);
    document.getElementById("bp-add-challenge")?.addEventListener("click", addDraft);
    document.getElementById("bp-send-organizer")?.addEventListener("click", (e) => {
      e.preventDefault();
    });
  }

  document.addEventListener("DOMContentLoaded", main);
})();
