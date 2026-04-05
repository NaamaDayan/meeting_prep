const MeetingPrepConfig = (() => {
  const DEFAULTS = {
    mode: "dev",
    devBaseUrl: "http://127.0.0.1:3847",
    prodBaseUrl: "https://api.example.com",
  };

  function normalizeMode(value) {
    return String(value || "").trim().toLowerCase() === "prod" ? "prod" : "dev";
  }

  function normalizeBaseUrl(value, fallback) {
    return String(value || fallback || "")
      .trim()
      .replace(/\/$/, "");
  }

  function inferModeFromLegacyBase(baseUrl) {
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(baseUrl)) return "dev";
    if (/^https:\/\//i.test(baseUrl)) return "prod";
    return DEFAULTS.mode;
  }

  async function load() {
    const stored = await chrome.storage.sync.get([
      "meetingPrepMode",
      "meetingPrepDevBaseUrl",
      "meetingPrepProdBaseUrl",
      "meetingPrepBaseUrl",
      "meetingPrepLastDiag",
      "meetingPrepGmailWebClientId",
      "meetingPrepBriefingPublicBaseUrl",
    ]);

    const legacyBaseUrl = normalizeBaseUrl(stored.meetingPrepBaseUrl, "");
    const mode = normalizeMode(stored.meetingPrepMode || inferModeFromLegacyBase(legacyBaseUrl));
    const devBaseUrl = normalizeBaseUrl(
      stored.meetingPrepDevBaseUrl || (mode === "dev" ? legacyBaseUrl : ""),
      DEFAULTS.devBaseUrl
    );
    const prodBaseUrl = normalizeBaseUrl(
      stored.meetingPrepProdBaseUrl || (mode === "prod" ? legacyBaseUrl : ""),
      DEFAULTS.prodBaseUrl
    );

    return {
      mode,
      devBaseUrl,
      prodBaseUrl,
      activeBaseUrl: mode === "prod" ? prodBaseUrl : devBaseUrl,
      lastDiag: stored.meetingPrepLastDiag || null,
      gmailWebClientId: String(stored.meetingPrepGmailWebClientId || "").trim(),
      briefingPublicBaseUrl: normalizeBaseUrl(stored.meetingPrepBriefingPublicBaseUrl || "", ""),
    };
  }

  async function save(next) {
    const mode = normalizeMode(next.mode);
    const devBaseUrl = normalizeBaseUrl(next.devBaseUrl, DEFAULTS.devBaseUrl);
    const prodBaseUrl = normalizeBaseUrl(next.prodBaseUrl, DEFAULTS.prodBaseUrl);
    const activeBaseUrl = mode === "prod" ? prodBaseUrl : devBaseUrl;

    const briefingPublicBaseUrl = normalizeBaseUrl(next.briefingPublicBaseUrl || "", "");

    await chrome.storage.sync.set({
      meetingPrepMode: mode,
      meetingPrepDevBaseUrl: devBaseUrl,
      meetingPrepProdBaseUrl: prodBaseUrl,
      meetingPrepBaseUrl: activeBaseUrl,
      meetingPrepGmailWebClientId: String(next.gmailWebClientId || "").trim(),
      meetingPrepBriefingPublicBaseUrl: briefingPublicBaseUrl,
    });

    return { mode, devBaseUrl, prodBaseUrl, activeBaseUrl, briefingPublicBaseUrl };
  }

  return {
    DEFAULTS,
    load,
    save,
  };
})();
