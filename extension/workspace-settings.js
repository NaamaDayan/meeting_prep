const MSG = {
  GET: "WORKSPACE_SETTINGS_GET",
  SAVE: "WORKSPACE_SETTINGS_SAVE",
};

const SESSION_OPENER_TAB_KEY = "mp_workspace_settings_opener_tab_id";

function $(id) {
  return document.getElementById(id);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getFromParam() {
  try {
    return new URLSearchParams(window.location.search).get("from") || "";
  } catch {
    return "";
  }
}

async function navigateBack() {
  const from = getFromParam();

  if (from === "options") {
    await chrome.storage.session.remove(SESSION_OPENER_TAB_KEY).catch(() => {});
    window.location.href = chrome.runtime.getURL("options.html");
    return;
  }

  const sess = await chrome.storage.session.get(SESSION_OPENER_TAB_KEY);
  const openerTabId = sess[SESSION_OPENER_TAB_KEY];

  let selfTabId = null;
  try {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    selfTabId = t?.id ?? null;
  } catch {
    /* ignore */
  }

  if (openerTabId != null) {
    try {
      await chrome.tabs.update(openerTabId, { active: true });
    } catch {
      /* opener tab may have been closed */
    }
    await chrome.storage.session.remove(SESSION_OPENER_TAB_KEY).catch(() => {});
    if (selfTabId != null && selfTabId !== openerTabId) {
      try {
        await chrome.tabs.remove(selfTabId);
      } catch {
        /* ignore */
      }
    }
    return;
  }

  if (window.opener && !window.opener.closed) {
    try {
      window.opener.focus();
    } catch {
      /* ignore */
    }
    window.close();
    return;
  }

  window.location.href = chrome.runtime.getURL("options.html");
}

/** @type {Array<{id:string,name:string,agendaText:string}>} */
let templateList = [];

function collectSidebarModulesFromDom() {
  return {
    agenda: $("mod_agenda").checked,
    participants: $("mod_participants").checked,
    meetingBriefing: $("mod_briefing").checked,
    questionsInMeeting: false,
  };
}

async function persistSidebarModulesImmediate() {
  const cur = await MPWorkspaceSettings.loadLocal();
  const next = {
    ...cur,
    sidebarModules: collectSidebarModulesFromDom(),
  };
  await MPWorkspaceSettings.saveLocal(MPWorkspaceSettings.merge(next), { preserveUpdatedAt: true });
}

function readTemplatesFromDom() {
  const cards = [...document.querySelectorAll("[data-tpl-id]")];
  return cards.map((card, idx) => {
    const id = card.getAttribute("data-tpl-id") || `tpl_${idx}`;
    const nameEl = card.querySelector("[data-tpl-name]");
    const agendaEl = card.querySelector("[data-tpl-agenda]");
    return {
      id,
      name: (nameEl && nameEl.value) || "",
      agendaText: (agendaEl && agendaEl.value) || "",
    };
  });
}

function collectSettingsFromForm() {
  return {
    contextAboutMe: {
      whatIDo: $("whatIDo").value,
      jobTitle: $("jobTitle").value,
      myGoal: $("myGoal").value,
    },
    sidebarModules: collectSidebarModulesFromDom(),
    meetingTemplates: readTemplatesFromDom(),
    delivery: {
      selfEnabled: $("del_self").checked,
      selfMinutesBefore: $("del_self_min").value,
      participantsEnabled: $("del_part").checked,
      participantsMinutesBefore: $("del_part_min").value,
      notifyOnRecipientEdits: $("del_notify_edits").checked,
    },
    sendMeetingPrepAutomatically: $("share_auto").checked,
  };
}

function applyForm(s) {
  const m = MPWorkspaceSettings.merge(s);
  $("whatIDo").value = m.contextAboutMe.whatIDo;
  $("jobTitle").value = m.contextAboutMe.jobTitle;
  $("myGoal").value = m.contextAboutMe.myGoal;

  $("mod_agenda").checked = m.sidebarModules.agenda;
  $("mod_participants").checked = m.sidebarModules.participants;
  $("mod_briefing").checked = m.sidebarModules.meetingBriefing;

  $("del_self").checked = m.delivery.selfEnabled;
  $("del_self_min").value = String(m.delivery.selfMinutesBefore);
  $("del_part").checked = m.delivery.participantsEnabled;
  $("del_part_min").value = String(m.delivery.participantsMinutesBefore);
  $("del_notify_edits").checked = m.delivery.notifyOnRecipientEdits;

  $("share_auto").checked = m.sendMeetingPrepAutomatically;
}

function renderTemplates() {
  const host = $("tplList");
  host.innerHTML = templateList
    .map(
      (t) => `
    <div class="tpl-card" data-tpl-id="${escapeHtml(t.id)}">
      <div class="tpl-head">
        <input type="text" data-tpl-name placeholder="Template name" value="${escapeHtml(t.name)}" aria-label="Template name" />
        <button type="button" class="icon-btn" data-tpl-delete aria-label="Delete template" title="Delete">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M3 6h18M8 6V4h8v2M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M10 11v6M14 11v6"/>
          </svg>
        </button>
      </div>
      <label class="lbl" for="agenda-${escapeHtml(t.id)}">Agenda (default bullets)</label>
      <textarea id="agenda-${escapeHtml(t.id)}" data-tpl-agenda rows="4" placeholder="• First item">${escapeHtml(t.agendaText)}</textarea>
    </div>
  `
    )
    .join("");

  host.querySelectorAll("[data-tpl-delete]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const card = btn.closest("[data-tpl-id]");
      const id = card && card.getAttribute("data-tpl-id");
      templateList = templateList.filter((x) => x.id !== id);
      renderTemplates();
    });
  });
}

function showToast() {
  const el = $("toast");
  el.classList.add("show");
  window.setTimeout(() => el.classList.remove("show"), 2200);
}

async function load() {
  const local = await MPWorkspaceSettings.loadLocal();
  templateList = local.meetingTemplates.map((t) => ({ ...t }));
  applyForm(local);
  renderTemplates();

  const res = await chrome.runtime.sendMessage({ type: MSG.GET });
  if (res && res.ok && res.settings) {
    const m = MPWorkspaceSettings.merge(res.settings);
    templateList = m.meetingTemplates.map((t) => ({ ...t }));
    applyForm(m);
    renderTemplates();
  }
}

$("btnBack").addEventListener("click", () => void navigateBack());

$("btnAddTpl").addEventListener("click", () => {
  templateList.push({
    id: MPWorkspaceSettings.newTemplateId(),
    name: "New template",
    agendaText: "• ",
  });
  renderTemplates();
});

["mod_agenda", "mod_participants", "mod_briefing"].forEach((id) => {
  $(id).addEventListener("change", () => {
    void persistSidebarModulesImmediate();
  });
});

$("btnSave").addEventListener("click", async () => {
  const btn = $("btnSave");
  btn.disabled = true;
  try {
    const raw = collectSettingsFromForm();
    const res = await chrome.runtime.sendMessage({ type: MSG.SAVE, payload: { settings: raw } });
    if (!res || !res.ok) {
      window.alert(res?.message || "Could not save settings. Check sign-in and backend URL.");
      return;
    }
    if (res.settings) {
      templateList = res.settings.meetingTemplates.map((t) => ({ ...t }));
      applyForm(res.settings);
      renderTemplates();
    }
    showToast();
    window.setTimeout(() => void navigateBack(), 650);
  } finally {
    btn.disabled = false;
  }
});

load();
