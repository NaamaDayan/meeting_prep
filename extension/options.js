function $(id) {
  return document.getElementById(id);
}

async function load() {
  const settings = await MeetingPrepConfig.load();
  try {
    const id = chrome.runtime.id || "";
    $("extensionId").value = id || "(unavailable)";
    const origin = id ? `chrome-extension://${id}` : "chrome-extension://…";
    $("extensionOriginHint").textContent = origin;
  } catch {
    $("extensionId").value = "(unavailable)";
  }
  $("mode").value = settings.mode;
  $("devBaseUrl").value = settings.devBaseUrl;
  $("prodBaseUrl").value = settings.prodBaseUrl;
  $("activeBaseUrl").value = settings.activeBaseUrl;
  $("diag").textContent = settings.lastDiag != null ? JSON.stringify(settings.lastDiag, null, 2) : "(none)";
  try {
    $("gmailRedirectUri").value = chrome.identity.getRedirectURL();
  } catch {
    $("gmailRedirectUri").value = "(open extension service worker and run: chrome.identity.getRedirectURL())";
  }
  $("gmailWebClientId").value = settings.gmailWebClientId || "";
  $("briefingPublicBaseUrl").value = settings.briefingPublicBaseUrl || "";
}

$("save").addEventListener("click", async () => {
  $("status").textContent = "";
  $("status").className = "";
  try {
    const saved = await MeetingPrepConfig.save({
      mode: $("mode").value,
      devBaseUrl: $("devBaseUrl").value,
      prodBaseUrl: $("prodBaseUrl").value,
      gmailWebClientId: $("gmailWebClientId").value,
      briefingPublicBaseUrl: $("briefingPublicBaseUrl").value,
    });
    $("activeBaseUrl").value = saved.activeBaseUrl;
    $("status").textContent = "Saved.";
    $("status").className = "ok";
  } catch (e) {
    $("status").textContent = String(e?.message || e);
    $("status").className = "err";
  }
});

$("ping").addEventListener("click", async () => {
  const saved = await MeetingPrepConfig.save({
    mode: $("mode").value,
    devBaseUrl: $("devBaseUrl").value,
    prodBaseUrl: $("prodBaseUrl").value,
    gmailWebClientId: $("gmailWebClientId").value,
    briefingPublicBaseUrl: $("briefingPublicBaseUrl").value,
  });
  const base = saved.activeBaseUrl;
  $("activeBaseUrl").value = base;
  $("status").textContent = "Pinging…";
  $("status").className = "";
  try {
    const r = await fetch(`${base}/health`, { method: "GET" });
    const body = await r.text();
    const diag = { ok: r.ok, status: r.status, body: body.slice(0, 2000) };
    if (!r.ok && r.status === 403 && body.includes("forbidden_origin")) {
      diag.hint =
        "CORS: add this browser’s chrome-extension://… origin (see “This extension’s ID” above) to CORS_ALLOWED_ORIGINS on AWS, redeploy, then ping again.";
    }
    await chrome.storage.sync.set({ meetingPrepLastDiag: diag });
    $("diag").textContent = JSON.stringify(diag, null, 2);
    let statusLine = r.ok ? "Server reachable." : `HTTP ${r.status}`;
    if (diag.hint) statusLine += ` — ${diag.hint}`;
    $("status").textContent = statusLine;
    $("status").className = r.ok ? "ok" : "err";
  } catch (e) {
    const diag = { error: String(e?.message || e) };
    await chrome.storage.sync.set({ meetingPrepLastDiag: diag });
    $("diag").textContent = JSON.stringify(diag, null, 2);
    $("status").textContent = diag.error;
    $("status").className = "err";
  }
});

load();
