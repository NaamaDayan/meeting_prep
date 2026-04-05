/** Normalize arbitrary parsed JSON into the meeting input shape. */
export function normalizeMeetingInput(raw) {
  const u = raw?.user && typeof raw.user === "object" ? raw.user : {};
  const p = raw?.product && typeof raw.product === "object" ? raw.product : {};
  let agenda = raw?.agenda_template;
  if (!Array.isArray(agenda)) agenda = [];
  agenda = agenda.map((x) => String(x ?? "").trim()).filter(Boolean);
  if (agenda.length === 0) agenda = [""];

  let participants = raw?.participants;
  if (!Array.isArray(participants)) participants = [];
  participants = participants.map((row) => ({
    name: row?.name != null ? String(row.name) : "",
    company: row?.company != null ? String(row.company) : "",
    linkedin: row?.linkedin != null ? String(row.linkedin) : "",
  }));
  if (participants.length === 0) {
    participants = [{ name: "", company: "", linkedin: "" }];
  }

  return {
    meeting_type: raw?.meeting_type != null ? String(raw.meeting_type) : "",
    agenda_template: agenda,
    user: {
      name: u.name != null ? String(u.name) : "",
      role: u.role != null ? String(u.role) : "",
      company: u.company != null ? String(u.company) : "",
      company_description:
        u.company_description != null ? String(u.company_description) : "",
      goal: u.goal != null ? String(u.goal) : "",
    },
    product: {
      description: p.description != null ? String(p.description) : "",
    },
    participants,
  };
}

export function meetingInputToPayload(form) {
  const agenda = (form.agenda_template || [])
    .map((x) => String(x ?? "").trim())
    .filter(Boolean);
  const participants = (form.participants || [])
    .map((row) => {
      const o = {
        name: String(row.name ?? "").trim(),
        company: String(row.company ?? "").trim(),
      };
      const li = String(row.linkedin ?? "").trim();
      if (li) o.linkedin = li;
      return o;
    })
    .filter((p) => p.name || p.company || p.linkedin);

  return {
    meeting_type: String(form.meeting_type ?? "").trim() || "meeting",
    agenda_template: agenda.length ? agenda : ["Agenda TBD"],
    user: {
      name: String(form.user?.name ?? "").trim(),
      role: String(form.user?.role ?? "").trim(),
      company: String(form.user?.company ?? "").trim(),
      company_description: String(form.user?.company_description ?? "").trim(),
      goal: String(form.user?.goal ?? "").trim(),
    },
    product: {
      description: String(form.product?.description ?? "").trim(),
    },
    participants: participants.length
      ? participants
      : [{ name: "", company: "" }],
  };
}
