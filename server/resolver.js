import { resolvePerson } from "./resolvePerson.js";

function normalizeEmailKey(e) {
  return String(e || "")
    .trim()
    .toLowerCase();
}

/**
 * @param {Array<{email:string,displayName?:string}>} participants
 * @param {*} cache
 * @param {(ev:object)=>void} [log]
 * @param {Record<string, {name?:string, linkedinUrl?:string, company?:string}>} [manualOverrides] keyed by lowercased email
 */
export async function resolveParticipants(participants, cache, log, manualOverrides = {}) {
  const overrides = manualOverrides && typeof manualOverrides === "object" ? manualOverrides : {};
  const resolved = [];
  for (const p of participants) {
    const email = String(p.email || "").trim();
    const displayName = String(p.displayName || email.split("@")[0] || "Guest").trim();
    const key = normalizeEmailKey(email);
    const manual = key ? overrides[key] : null;

    if (manual && String(manual.name || "").trim() && String(manual.linkedinUrl || "").trim()) {
      resolved.push({
        email,
        displayName: String(manual.name).trim(),
        linkedinUrl: String(manual.linkedinUrl).trim(),
        company: String(manual.company || "").trim(),
        summary: "Manually verified identity.",
        confidence: "high",
        manuallyResolved: true,
      });
      if (log) log({ step: "resolve_person_manual", email });
      continue;
    }

    if (!email) {
      resolved.push({
        email: "",
        displayName,
        linkedinUrl: "",
        company: "",
        summary: "Unresolved attendee (no email in UI).",
        confidence: "low",
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
        confidence: "low",
      });
    }
  }
  return resolved;
}
