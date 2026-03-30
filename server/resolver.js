import { resolvePerson } from "./resolvePerson.js";

export async function resolveParticipants(participants, cache, log) {
  const resolved = [];
  for (const p of participants) {
    const email = String(p.email || "").trim();
    const displayName = String(p.displayName || email.split("@")[0] || "Guest").trim();
    if (!email) {
      resolved.push({
        email: "",
        displayName,
        linkedinUrl: "",
        company: "",
        summary: "Unresolved attendee (no email in UI).",
      });
      continue;
    }
    try {
      if (log) log({ step: "resolve_person_start", email });
      const r = await resolvePerson({ displayName, email }, cache);
      resolved.push(r);
      if (log) log({ step: "resolve_person_ok", email });
    } catch (e) {
      if (log) log({ step: "resolve_person_err", email, err: String(e?.message || e) });
      resolved.push({
        email,
        displayName,
        linkedinUrl: "",
        company: "",
        summary: `Could not auto-resolve: ${String(e?.message || e)}`,
      });
    }
  }
  return resolved;
}
