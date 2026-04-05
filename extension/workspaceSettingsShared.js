/**
 * Shared workspace settings defaults and merge (content script + settings page).
 * Persisted under chrome.storage.local as mp_workspace_settings_v1.
 */

/** `var` so importScripts (service worker) exposes this globally across bundled classic scripts. */
var MPWorkspaceSettings = (() => {
  const STORAGE_KEY = "mp_workspace_settings_v1";
  const WORKSPACE_EVENT_SENTINEL = "__mp_workspace__";

  const DEFAULTS = {
    v: 1,
    contextAboutMe: {
      whatIDo: "",
      jobTitle: "",
      myGoal: "",
    },
    sidebarModules: {
      agenda: true,
      participants: true,
      meetingBriefing: true,
      questionsInMeeting: false,
    },
    meetingTemplates: [
      { id: "tpl_default_intro", name: "Intro Meeting", agendaText: "• Goals and introductions\n• Agenda overview\n• Next steps" },
      { id: "tpl_default_discovery", name: "Client Discovery", agendaText: "• Current process\n• Pain points\n• Success criteria\n• Timeline" },
    ],
    delivery: {
      selfEnabled: false,
      selfMinutesBefore: 15,
      participantsEnabled: false,
      participantsMinutesBefore: 30,
      notifyOnRecipientEdits: false,
    },
    sendMeetingPrepAutomatically: false,
    updatedAt: null,
  };

  function clampInt(n, min, max, fallback) {
    const x = Number.parseInt(String(n), 10);
    if (Number.isNaN(x)) return fallback;
    return Math.min(max, Math.max(min, x));
  }

  function newTemplateId() {
    try {
      if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
        return `tpl_${globalThis.crypto.randomUUID()}`;
      }
    } catch {
      /* ignore */
    }
    return `tpl_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  function normalizeTemplate(t, idx) {
    const id = String(t?.id || "").trim() || `tpl_${idx}`;
    return {
      id,
      name: String(t?.name || "").trim() || "Untitled template",
      agendaText: String(t?.agendaText ?? t?.agenda ?? ""),
    };
  }

  function merge(partial) {
    const p = partial && typeof partial === "object" ? partial : {};
    const sm = p.sidebarModules && typeof p.sidebarModules === "object" ? p.sidebarModules : {};
    const del = p.delivery && typeof p.delivery === "object" ? p.delivery : {};
    const cam = p.contextAboutMe && typeof p.contextAboutMe === "object" ? p.contextAboutMe : {};

    let templates = Array.isArray(p.meetingTemplates) ? p.meetingTemplates.map(normalizeTemplate) : null;
    if (!templates || templates.length === 0) templates = DEFAULTS.meetingTemplates.map((x, i) => normalizeTemplate(x, i));

    return {
      v: 1,
      contextAboutMe: {
        whatIDo: String(cam.whatIDo ?? ""),
        jobTitle: String(cam.jobTitle ?? ""),
        myGoal: String(cam.myGoal ?? ""),
      },
      sidebarModules: {
        agenda: sm.agenda !== false,
        participants: sm.participants !== false,
        meetingBriefing: sm.meetingBriefing !== false,
        questionsInMeeting: false,
      },
      meetingTemplates: templates.slice(0, 50),
      delivery: {
        selfEnabled: !!del.selfEnabled,
        selfMinutesBefore: clampInt(del.selfMinutesBefore, 0, 10080, DEFAULTS.delivery.selfMinutesBefore),
        participantsEnabled: !!del.participantsEnabled,
        participantsMinutesBefore: clampInt(del.participantsMinutesBefore, 0, 10080, DEFAULTS.delivery.participantsMinutesBefore),
        notifyOnRecipientEdits: !!del.notifyOnRecipientEdits,
      },
      sendMeetingPrepAutomatically: !!p.sendMeetingPrepAutomatically,
      updatedAt: p.updatedAt != null ? String(p.updatedAt) : null,
    };
  }

  /** Map sidebar module flags to textarea section keys used in prep UI */
  const MODULE_TO_SECTION = {
    agenda: "agenda",
    participants: "participantsInfo",
    meetingBriefing: "questionsBefore",
    questionsInMeeting: "questionsInMeeting",
  };

  const SECTION_LABELS = {
    agenda: "Meeting agenda",
    participantsInfo: "Participants info",
    questionsBefore: "Meeting briefing",
    questionsInMeeting: "Questions in meeting",
  };

  async function loadLocal() {
    try {
      const o = await chrome.storage.local.get(STORAGE_KEY);
      return merge(o[STORAGE_KEY]);
    } catch {
      return merge({});
    }
  }

  async function saveLocal(settings, opts) {
    const bump = !(opts && opts.preserveUpdatedAt);
    const next = merge(settings);
    if (bump) next.updatedAt = new Date().toISOString();
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
    return next;
  }

  return {
    STORAGE_KEY,
    WORKSPACE_EVENT_SENTINEL,
    DEFAULTS,
    merge,
    newTemplateId,
    loadLocal,
    saveLocal,
    MODULE_TO_SECTION,
    SECTION_LABELS,
  };
})();
