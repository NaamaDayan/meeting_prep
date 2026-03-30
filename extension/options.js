const DEFAULT_BASE = "http://127.0.0.1:3847";

function $(id) {
  return document.getElementById(id);
}

async function load() {
  const { meetingPrepBaseUrl, meetingPrepLastDiag } = await chrome.storage.sync.get([
    "meetingPrepBaseUrl",
    "meetingPrepLastDiag",
  ]);
  $("baseUrl").value = meetingPrepBaseUrl || DEFAULT_BASE;
  $("diag").textContent =
    meetingPrepLastDiag != null ? JSON.stringify(meetingPrepLastDiag, null, 2) : "(none)";
}

$("save").addEventListener("click", async () => {
  const base = $("baseUrl").value.trim().replace(/\/$/, "");
  $("status").textContent = "";
  $("status").className = "";
  try {
    await chrome.storage.sync.set({ meetingPrepBaseUrl: base || DEFAULT_BASE });
    $("status").textContent = "Saved.";
    $("status").className = "ok";
  } catch (e) {
    $("status").textContent = String(e?.message || e);
    $("status").className = "err";
  }
});

$("ping").addEventListener("click", async () => {
  const base = ($("baseUrl").value.trim().replace(/\/$/, "")) || DEFAULT_BASE;
  $("status").textContent = "Pinging…";
  $("status").className = "";
  try {
    const r = await fetch(`${base}/health`, { method: "GET" });
    const body = await r.text();
    const diag = { ok: r.ok, status: r.status, body: body.slice(0, 2000) };
    await chrome.storage.sync.set({ meetingPrepLastDiag: diag });
    $("diag").textContent = JSON.stringify(diag, null, 2);
    $("status").textContent = r.ok ? "Server reachable." : `HTTP ${r.status}`;
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
