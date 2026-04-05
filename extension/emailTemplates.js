/**
 * Email templates used by the Calendar prep UI.
 * Loaded as part of the MV3 content scripts (see manifest.json).
 */
(function () {
  const SUBJECT = "Meeting briefing ahead of our session";
  const BRIEFING_LINK_SUBJECT = "Meeting briefing";

  function buildPrepQuestionsEmailBody({ senderName, questions }) {
    const safeSender = String(senderName || "").trim() || "your meeting prep agent";
    const qs =
      Array.isArray(questions) && questions.length
        ? questions.map((q) => `• ${String(q).trim()}`).filter(Boolean).join("\n")
        : "• (no questions found)";

    // Keep the body formatting mailto-friendly (use plain newlines).
    return (
      "Hi,\n" +
      `I'm ${safeSender},\n` +
      "Ahead of our meeting, it would help if you could review the following briefing items:\n" +
      `${qs}\n` +
      "Looking forward."
    );
  }

  function buildBriefingLinkEmailBody({ executiveFullName, briefingUrl }) {
    const name = String(executiveFullName || "").trim() || "your executive";
    const link = String(briefingUrl || "").trim() || "(briefing link unavailable)";
    return (
      `Hey, I'm ${name} Chief of Staff. To make sure your time is used in the most effective way, ${name} asked me to share a short briefing with you at the link below.\n\n` +
      `You can find all the details here: ${link}`
    );
  }

  globalThis.MP_EMAIL_TEMPLATES = Object.assign(globalThis.MP_EMAIL_TEMPLATES || {}, {
    PREP_QUESTIONS_SUBJECT: SUBJECT,
    BRIEFING_LINK_SUBJECT,
    buildPrepQuestionsEmailBody,
    buildBriefingLinkEmailBody,
  });
})();

