/** User workspace settings document (API + persistence). Kept in sync with extension/workspaceSettingsShared.js shape. */

export const WORKSPACE_SETTINGS_EVENT_ID = "__mp_workspace__";

export function defaultWorkspaceSettings() {
  return {
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
      {
        id: "tpl_default_intro",
        name: "Intro Meeting",
        agendaText: "• Goals and introductions\n• Agenda overview\n• Next steps",
      },
      {
        id: "tpl_default_discovery",
        name: "Client Discovery",
        agendaText: "• Current process\n• Pain points\n• Success criteria\n• Timeline",
      },
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
}

function clampInt(n, min, max, fallback) {
  const x = Number.parseInt(String(n), 10);
  if (Number.isNaN(x)) return fallback;
  return Math.min(max, Math.max(min, x));
}

function normalizeTemplate(t, idx) {
  const id = String(t?.id || "").trim() || `tpl_${idx}`;
  return {
    id,
    name: String(t?.name || "").trim() || "Untitled template",
    agendaText: String(t?.agendaText ?? t?.agenda ?? ""),
  };
}

export function normalizeWorkspaceSettings(input) {
  const p = input && typeof input === "object" ? input : {};
  const sm = p.sidebarModules && typeof p.sidebarModules === "object" ? p.sidebarModules : {};
  const del = p.delivery && typeof p.delivery === "object" ? p.delivery : {};
  const cam = p.contextAboutMe && typeof p.contextAboutMe === "object" ? p.contextAboutMe : {};

  let templates = Array.isArray(p.meetingTemplates) ? p.meetingTemplates.map(normalizeTemplate) : null;
  if (!templates || templates.length === 0) templates = defaultWorkspaceSettings().meetingTemplates.map((x, i) => normalizeTemplate(x, i));

  return {
    v: 1,
    contextAboutMe: {
      whatIDo: String(cam.whatIDo ?? "").slice(0, 8000),
      jobTitle: String(cam.jobTitle ?? "").slice(0, 500),
      myGoal: String(cam.myGoal ?? "").slice(0, 500),
    },
    sidebarModules: {
      agenda: sm.agenda !== false,
      participants: sm.participants !== false,
      meetingBriefing: sm.meetingBriefing !== false,
      questionsInMeeting: false,
    },
    meetingTemplates: templates.slice(0, 50).map((t) => ({
      ...t,
      name: t.name.slice(0, 200),
      agendaText: t.agendaText.slice(0, 32000),
    })),
    delivery: {
      selfEnabled: !!del.selfEnabled,
      selfMinutesBefore: clampInt(del.selfMinutesBefore, 0, 10080, 15),
      participantsEnabled: !!del.participantsEnabled,
      participantsMinutesBefore: clampInt(del.participantsMinutesBefore, 0, 10080, 30),
      notifyOnRecipientEdits: !!del.notifyOnRecipientEdits,
    },
    sendMeetingPrepAutomatically: !!p.sendMeetingPrepAutomatically,
    updatedAt: new Date().toISOString(),
  };
}

export function rowToSettingsPayload(row) {
  if (!row || row.recordType !== "workspace_settings") return null;
  return row.settings && typeof row.settings === "object" ? row.settings : null;
}
