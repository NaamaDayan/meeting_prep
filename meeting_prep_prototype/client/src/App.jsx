import { useCallback, useMemo, useState } from "react";
import { DynamicOutput } from "./DynamicOutput.jsx";
import { MeetingInputForm } from "./MeetingInputForm.jsx";
import {
  meetingInputToPayload,
  normalizeMeetingInput,
} from "./meetingInput.js";

const DEFAULT_PROMPT = `You are preparing a sales / customer meeting briefing.

Using the meeting_input and enriched_context, produce a JSON object only.
Use top-level keys as section titles (use snake_case keys). Each section value should be a string, array of strings, or nested object as appropriate.

Cover: context summary, goals alignment, participant angles, suggested agenda flow, questions to ask, risks/unknowns, and next-step ideas. Be specific to the data provided.`;

const DEFAULT_INPUT = {
  meeting_type: "discovery",
  agenda_template: [
    "Intros & context (5m)",
    "Their priorities & process (15m)",
    "Our fit & questions (15m)",
    "Next steps (5m)",
  ],
  user: {
    name: "Alex Rivera",
    role: "Account Executive",
    company: "Northwind Analytics",
    company_description:
      "Analytics platform for revenue teams; mid-market focus.",
    goal: "Qualify fit and book a technical deep-dive.",
  },
  product: {
    description:
      "Pipeline forecasting with CRM sync and scenario modeling.",
  },
  participants: [
    {
      name: "Jordan Lee",
      company: "Contoso Ltd",
      linkedin: "https://www.linkedin.com/in/example-jordan",
    },
    {
      name: "Sam Patel",
      company: "Contoso Ltd",
    },
  ],
};

function formatJson(obj) {
  return JSON.stringify(obj, null, 2);
}

export default function App() {
  const [inputMode, setInputMode] = useState("form");
  const [formData, setFormData] = useState(() =>
    normalizeMeetingInput(DEFAULT_INPUT)
  );
  const [inputJson, setInputJson] = useState(() =>
    formatJson(meetingInputToPayload(normalizeMeetingInput(DEFAULT_INPUT)))
  );
  const [modeSwitchError, setModeSwitchError] = useState(null);

  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [enriched, setEnriched] = useState(null);
  const [briefing, setBriefing] = useState(null);
  const [llmError, setLlmError] = useState(null);
  const [rawLlm, setRawLlm] = useState(null);
  const [showRaw, setShowRaw] = useState(false);
  const [copyOk, setCopyOk] = useState(false);

  const inputParseError = useMemo(() => {
    try {
      JSON.parse(inputJson);
      return null;
    } catch (e) {
      return e.message;
    }
  }, [inputJson]);

  const switchToJson = useCallback(() => {
    setModeSwitchError(null);
    setInputJson(formatJson(meetingInputToPayload(formData)));
    setInputMode("json");
  }, [formData]);

  const switchToForm = useCallback(() => {
    setModeSwitchError(null);
    try {
      const parsed = JSON.parse(inputJson);
      setFormData(normalizeMeetingInput(parsed));
      setInputMode("form");
    } catch (e) {
      setModeSwitchError(`Fix JSON before switching: ${e.message}`);
    }
  }, [inputJson]);

  const getPayload = useCallback(() => {
    if (inputMode === "form") {
      return meetingInputToPayload(formData);
    }
    return JSON.parse(inputJson);
  }, [inputMode, formData, inputJson]);

  const onGenerate = useCallback(async () => {
    setError(null);
    setLlmError(null);
    let parsed;
    try {
      parsed = getPayload();
    } catch (e) {
      setError(e.message || "Invalid input");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, input: parsed }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || `HTTP ${res.status}`);
        return;
      }
      setEnriched(body.enriched_context ?? null);
      setBriefing(body.briefing ?? null);
      setLlmError(body.llm_error || null);
      setRawLlm(body.raw_llm_text ?? null);
    } catch (e) {
      setError(e.message || "Request failed");
    } finally {
      setLoading(false);
    }
  }, [prompt, getPayload]);

  const copyOutputJson = useCallback(async () => {
    const text =
      rawLlm ||
      (briefing ? formatJson(briefing) : "") ||
      formatJson({ enriched, briefing, llmError });
    try {
      await navigator.clipboard.writeText(text);
      setCopyOk(true);
      setTimeout(() => setCopyOk(false), 1500);
    } catch {
      setError("Could not copy to clipboard");
    }
  }, [rawLlm, briefing, enriched, llmError]);

  const participants = enriched?.participants;
  const companyBlock = enriched?.company;

  const generateDisabled =
    loading || (inputMode === "json" && !!inputParseError);

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header-brand">
          <div className="app-logo" aria-hidden />
          <div>
            <h1>Meeting Prep AI</h1>
            <p className="app-tagline">Prompt lab · enrichment · briefing</p>
          </div>
        </div>
        <div className="app-header-actions">
          <label className="toggle-pill">
            <input
              type="checkbox"
              checked={showRaw}
              onChange={(e) => setShowRaw(e.target.checked)}
            />
            <span>Raw LLM JSON</span>
          </label>
          <button
            type="button"
            className="btn-header"
            onClick={copyOutputJson}
            disabled={!briefing && !rawLlm && !enriched}
          >
            {copyOk ? "Copied" : "Copy output"}
          </button>
        </div>
      </header>

      <div className="panels">
        <section className="panel panel-inputs">
          <div className="panel-header">
            <span className="panel-title">Inputs</span>
            <span className="panel-badge">1</span>
          </div>
          <div className="panel-body">
            {loading && (
              <div className="banner banner-warn">
                <span className="banner-spinner" aria-hidden />
                Running enrichment and LLM…
              </div>
            )}
            {error && <div className="banner banner-error">{error}</div>}
            {modeSwitchError && (
              <div className="banner banner-error">{modeSwitchError}</div>
            )}
            {inputMode === "json" && inputParseError && (
              <div className="banner banner-error">
                Invalid JSON: {inputParseError}
              </div>
            )}

            <div className="card card-tight">
              <label className="form-label">System / user prompt</label>
              <textarea
                className="code-area code-area-prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                spellCheck={false}
              />
            </div>

            <div className="card">
              <div className="card-head-row">
                <div>
                  <h2 className="card-title">Meeting input</h2>
                  <p className="card-sub">
                    Structured form or raw JSON — same payload to the API.
                  </p>
                </div>
              </div>
              <div
                className="segmented"
                role="tablist"
                aria-label="Meeting input format"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={inputMode === "form"}
                  className={
                    inputMode === "form" ? "segmented-item is-active" : "segmented-item"
                  }
                  onClick={() => {
                    if (inputMode === "json") switchToForm();
                    else setInputMode("form");
                  }}
                >
                  Form
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={inputMode === "json"}
                  className={
                    inputMode === "json" ? "segmented-item is-active" : "segmented-item"
                  }
                  onClick={() => {
                    if (inputMode === "form") switchToJson();
                    else setInputMode("json");
                  }}
                >
                  JSON
                </button>
              </div>

              {inputMode === "form" ? (
                <MeetingInputForm value={formData} onChange={setFormData} />
              ) : (
                <div className="json-editor-wrap">
                  <textarea
                    className="code-area code-area-json"
                    value={inputJson}
                    onChange={(e) => setInputJson(e.target.value)}
                    spellCheck={false}
                  />
                </div>
              )}
            </div>

            <button
              type="button"
              className="btn-generate"
              onClick={onGenerate}
              disabled={generateDisabled}
            >
              {loading ? "Generating…" : "Generate briefing"}
            </button>
          </div>
        </section>

        <section className="panel panel-enrich">
          <div className="panel-header">
            <span className="panel-title">Enrichment</span>
            <span className="panel-badge">2</span>
          </div>
          <div className="panel-body">
            {!enriched && !loading && (
              <p className="empty-state">
                Generate a briefing to inspect mock enrichment (participants
                and company).
              </p>
            )}
            {companyBlock && (
              <div className="card enrich-card">
                <h3 className="enrich-card-title">Company signals</h3>
                <pre className="code-preview">{formatJson(companyBlock)}</pre>
              </div>
            )}
            {Array.isArray(participants) && participants.length > 0 && (
              <div className="enrich-participants">
                <h3 className="enrich-section-label">Participants</h3>
                {participants.map((p, i) => (
                  <details
                    key={i}
                    className="disclosure"
                    open={i === 0}
                  >
                    <summary className="disclosure-summary">
                      <span className="disclosure-chevron" aria-hidden />
                      {p.name || `Participant ${i + 1}`}
                    </summary>
                    <pre className="code-preview code-preview-inset">
                      {formatJson(p)}
                    </pre>
                  </details>
                ))}
              </div>
            )}
          </div>
        </section>

        <section className="panel panel-brief">
          <div className="panel-header">
            <span className="panel-title">Briefing</span>
            <span className="panel-badge">3</span>
          </div>
          <div className="panel-body panel-body-brief">
            {llmError && (
              <div className="banner banner-error">LLM: {llmError}</div>
            )}
            {showRaw && rawLlm && (
              <div className="card">
                <h3 className="enrich-card-title">Raw model output</h3>
                <pre className="code-preview">{rawLlm}</pre>
              </div>
            )}
            {!briefing && !loading && !llmError && (
              <p className="empty-state">
                Your structured briefing will show here. Sections follow the
                JSON keys returned by the model.
              </p>
            )}
            {briefing && (
              <div className="briefing-stack">
                {typeof briefing === "object" && !Array.isArray(briefing) ? (
                  Object.keys(briefing).map((key) => (
                    <article key={key} className="brief-card">
                      <h3 className="brief-card-title">
                        {String(key).replace(/_/g, " ")}
                      </h3>
                      <div className="brief-card-body">
                        <DynamicOutput data={briefing[key]} />
                      </div>
                    </article>
                  ))
                ) : (
                  <article className="brief-card">
                    <div className="brief-card-body">
                      <DynamicOutput data={briefing} />
                    </div>
                  </article>
                )}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
