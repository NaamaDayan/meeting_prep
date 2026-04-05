import { useCallback, useMemo, useState } from "react";
import { DynamicOutput } from "./DynamicOutput.jsx";
import { MeetingInputForm } from "./MeetingInputForm.jsx";
import { apiBaseResolved, apiUrl } from "./apiBase.js";
import {
  DEFAULT_LLM_PROVIDER,
  DEFAULT_OPENAI_MODEL,
  LLM_PROVIDERS,
  coerceModelForProvider,
  modelsForProvider,
} from "./llmOptions.js";
import {
  meetingInputToPayload,
  normalizeMeetingInput,
} from "./meetingInput.js";

const DEFAULT_PROMPT = `You are an expert sales strategist helping a sales professional prepare for a high-stakes discovery call.

Your goal is NOT just to summarize information — but to generate sharp, actionable insights that will help the user:
1. Understand the prospect deeply
2. Ask better questions
3. Impress the prospect
4. Increase the chances of a successful sale

You must base your answers ONLY on the provided data (meeting_input and enriched_context).
If something is unknown, make a reasonable hypothesis and clearly label it as a hypothesis.

---

## INSTRUCTIONS

Think step by step before answering.

Analyze:
1. Who is the person (seniority, priorities, likely motivations)
2. What is the company (stage, challenges, business model)
3. Where is the strongest potential fit between the product and the prospect
4. What are the most likely pain points (even if not explicitly stated)
5. What could impress this specific person

Avoid:
- Generic statements
- Repeating obvious facts without insight
- Hallucinating specific facts (funding, metrics, etc.)

---

## OUTPUT FORMAT (STRICT JSON)

Return ONLY valid JSON. No explanations outside JSON. Use exactly these top-level keys (snake_case) so downstream UIs can render each key as its own briefing section. Nested objects and arrays should follow the shapes below.

{
  "summary": {
    "one_liner": "...",
    "opportunity": "...",
    "risk": "..."
  },

  "participant_profile": {
    "name": "...",
    "role": "...",
    "seniority_level": "...",
    "background_summary": "...",
    "key_signals": [
      "...",
      "..."
    ]
  },

  "company_profile": {
    "name": "...",
    "what_they_do": "...",
    "stage": "...",
    "key_insights": [
      "...",
      "..."
    ]
  },

  "pain_point_hypotheses": [
    {
      "pain": "...",
      "why_likely": "..."
    },
    {
      "pain": "...",
      "why_likely": "..."
    }
  ],

  "qualification_questions": [
    "...",
    "...",
    "..."
  ],

  "personalized_angles": [
    "...",
    "..."
  ],

  "icebreakers": [
    "...",
    "..."
  ],

  "suggested_agenda": [
    "...",
    "..."
  ],

  "pre_meeting_message": "..."
}`;

const DEFAULT_INPUT = {
  meeting_type: "discovery",
  agenda_template: [
    "Intro & context (5m)",
    "Understand current workflows (15m)",
    "Identify pain points (10m)",
    "Explore potential fit (5m)",
    "Next steps (5m)",
  ],
  user: {
    name: "Yael Ben David",
    role: "Account Executive",
    company: "monday.com",
    company_description:
      "Work operating system that enables teams to build custom workflows, manage projects, and collaborate across departments.",
    goal: "Understand the prospect’s workflow challenges and qualify if monday.com can replace scattered tools and improve efficiency.",
  },
  product: {
    description:
      "Flexible work management platform that replaces spreadsheets and disconnected tools with customizable workflows, automation, and real-time collaboration.",
  },
  participants: [
    {
      name: "Rachel Kim",
      company: "Wix",
      linkedin: "https://www.linkedin.com/in/rachel-kim-ux/",
    },
    {
      name: "David Levy",
      company: "Wix",
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
  const [llmProvider, setLlmProvider] = useState(DEFAULT_LLM_PROVIDER);
  const [llmModel, setLlmModel] = useState(DEFAULT_OPENAI_MODEL);
  const [llmApiKey, setLlmApiKey] = useState("");
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
    const generateUrl = apiUrl("/generate");
    try {
      const res = await fetch(generateUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          input: parsed,
          llm_provider: llmProvider,
          llm_model: llmModel,
          llm_api_key: llmApiKey.trim(),
        }),
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
      const msg = e.message || "Request failed";
      const usingRelative = !apiBaseResolved();
      const hint = usingRelative
        ? " The app is calling a relative URL (/generate), which hits your static host—not API Gateway. Rebuild the client with VITE_API_BASE_URL set to your HTTP API invoke URL (no trailing slash), then sync dist/ to S3 again."
        : " Usually CORS on API Gateway: open the HTTP API → CORS → allow your page’s exact Origin (see Request Headers on the failed request), methods GET/POST/OPTIONS, header content-type. See DEPLOY_AWS.md Step 7.";
      setError(`${msg} (${generateUrl}).${hint}`);
    } finally {
      setLoading(false);
    }
  }, [prompt, getPayload, llmProvider, llmModel, llmApiKey]);

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
  const companies = enriched?.companies;
  const rawSources = enriched?.raw_sources;
  const enrichmentNotice =
    enriched?.enrichment_skipped_reason || enriched?.enrichment_error;

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

            <div className="card card-tight llm-settings-card">
              <h2 className="card-title card-title-inline">LLM</h2>
              <p className="card-sub card-sub-tight">
                Optional API key overrides server environment for this request
                only.
              </p>
              <div className="llm-settings-grid">
                <div>
                  <label className="form-label" htmlFor="llm-provider">
                    LLM provider
                  </label>
                  <select
                    id="llm-provider"
                    className="form-select"
                    value={llmProvider}
                    onChange={(e) => {
                      const next = e.target.value;
                      setLlmProvider(next);
                      setLlmModel((prev) =>
                        coerceModelForProvider(next, prev)
                      );
                    }}
                  >
                    {LLM_PROVIDERS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="form-label" htmlFor="llm-model">
                    Model
                  </label>
                  <select
                    id="llm-model"
                    className="form-select"
                    value={coerceModelForProvider(llmProvider, llmModel)}
                    onChange={(e) => setLlmModel(e.target.value)}
                  >
                    {modelsForProvider(llmProvider).map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="llm-settings-key">
                  <label className="form-label" htmlFor="llm-api-key">
                    API key
                  </label>
                  <input
                    id="llm-api-key"
                    type="password"
                    className="form-input"
                    autoComplete="off"
                    placeholder="Enter your API key"
                    value={llmApiKey}
                    onChange={(e) => setLlmApiKey(e.target.value)}
                  />
                </div>
              </div>
            </div>

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
                Generate a briefing to see SerpAPI enrichment: participants,
                companies, and raw search sources.
              </p>
            )}
            {enrichmentNotice && (
              <div className="banner banner-warn">{enrichmentNotice}</div>
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
                      {p.confidence ? (
                        <span className="enrich-confidence">{p.confidence}</span>
                      ) : null}
                    </summary>
                    <pre className="code-preview code-preview-inset">
                      {formatJson(p)}
                    </pre>
                  </details>
                ))}
              </div>
            )}
            {Array.isArray(companies) && companies.length > 0 && (
              <div className="enrich-participants">
                <h3 className="enrich-section-label">Companies</h3>
                {companies.map((c, i) => (
                  <details
                    key={`c-${i}`}
                    className="disclosure"
                    open={i === 0 && !(participants?.length > 0)}
                  >
                    <summary className="disclosure-summary">
                      <span className="disclosure-chevron" aria-hidden />
                      {c.name || `Company ${i + 1}`}
                    </summary>
                    <pre className="code-preview code-preview-inset">
                      {formatJson(c)}
                    </pre>
                  </details>
                ))}
              </div>
            )}
            {Array.isArray(rawSources) && rawSources.length > 0 && (
              <details className="disclosure enrich-raw-sources">
                <summary className="disclosure-summary">
                  <span className="disclosure-chevron" aria-hidden />
                  Raw sources ({rawSources.length})
                </summary>
                <pre className="code-preview code-preview-inset">
                  {formatJson(rawSources)}
                </pre>
              </details>
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
