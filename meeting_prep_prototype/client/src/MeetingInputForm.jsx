function Field({ label, hint, children }) {
  return (
    <div className="form-field">
      <label className="form-label">
        {label}
        {hint ? <span className="form-hint">{hint}</span> : null}
      </label>
      {children}
    </div>
  );
}

export function MeetingInputForm({ value, onChange }) {
  const set = (patch) => onChange({ ...value, ...patch });
  const setUser = (patch) =>
    set({ user: { ...value.user, ...patch } });
  const setProduct = (patch) =>
    set({ product: { ...value.product, ...patch } });

  const agenda = value.agenda_template || [];
  const setAgendaItem = (i, text) => {
    const next = [...agenda];
    next[i] = text;
    set({ agenda_template: next });
  };
  const addAgenda = () =>
    set({ agenda_template: [...agenda, ""] });
  const removeAgenda = (i) => {
    const next = agenda.filter((_, j) => j !== i);
    set({ agenda_template: next.length ? next : [""] });
  };

  const participants = value.participants || [];
  const setParticipant = (i, patch) => {
    const next = participants.map((p, j) =>
      j === i ? { ...p, ...patch } : p
    );
    set({ participants: next });
  };
  const addParticipant = () =>
    set({
      participants: [
        ...participants,
        { name: "", company: "", linkedin: "" },
      ],
    });
  const removeParticipant = (i) => {
    const next = participants.filter((_, j) => j !== i);
    set({
      participants: next.length
        ? next
        : [{ name: "", company: "", linkedin: "" }],
    });
  };

  return (
    <div className="meeting-form">
      <div className="form-section">
        <h3 className="form-section-title">Meeting</h3>
        <Field label="Meeting type">
          <input
            type="text"
            className="form-input"
            value={value.meeting_type}
            onChange={(e) => set({ meeting_type: e.target.value })}
            placeholder="e.g. discovery, renewal, QBR"
          />
        </Field>
        <Field label="Agenda template" hint="One line per item">
          <div className="form-stack">
            {agenda.map((line, i) => (
              <div key={i} className="form-inline-row">
                <input
                  type="text"
                  className="form-input"
                  value={line}
                  onChange={(e) => setAgendaItem(i, e.target.value)}
                  placeholder={`Agenda item ${i + 1}`}
                />
                <button
                  type="button"
                  className="btn-icon"
                  onClick={() => removeAgenda(i)}
                  aria-label="Remove agenda line"
                  disabled={agenda.length <= 1}
                >
                  −
                </button>
              </div>
            ))}
            <button type="button" className="btn-ghost btn-sm" onClick={addAgenda}>
              + Add agenda line
            </button>
          </div>
        </Field>
      </div>

      <div className="form-section">
        <h3 className="form-section-title">Your side (user)</h3>
        <div className="form-grid-2">
          <Field label="Name">
            <input
              type="text"
              className="form-input"
              value={value.user.name}
              onChange={(e) => setUser({ name: e.target.value })}
            />
          </Field>
          <Field label="Role">
            <input
              type="text"
              className="form-input"
              value={value.user.role}
              onChange={(e) => setUser({ role: e.target.value })}
            />
          </Field>
        </div>
        <Field label="Company">
          <input
            type="text"
            className="form-input"
            value={value.user.company}
            onChange={(e) => setUser({ company: e.target.value })}
          />
        </Field>
        <Field label="Company description">
          <textarea
            className="form-textarea form-textarea-sm"
            rows={2}
            value={value.user.company_description}
            onChange={(e) => setUser({ company_description: e.target.value })}
          />
        </Field>
        <Field label="Goal for this meeting">
          <textarea
            className="form-textarea form-textarea-sm"
            rows={2}
            value={value.user.goal}
            onChange={(e) => setUser({ goal: e.target.value })}
          />
        </Field>
      </div>

      <div className="form-section">
        <h3 className="form-section-title">Product</h3>
        <Field label="Product description">
          <textarea
            className="form-textarea"
            rows={3}
            value={value.product.description}
            onChange={(e) => setProduct({ description: e.target.value })}
          />
        </Field>
      </div>

      <div className="form-section">
        <h3 className="form-section-title">Participants</h3>
        <p className="form-section-desc">
          LinkedIn URL triggers structured mock enrichment; leave blank for
          search-style mock snippets.
        </p>
        {participants.map((row, i) => (
          <div key={i} className="participant-card">
            <div className="participant-card-head">
              <span className="participant-card-label">
                Attendee {i + 1}
              </span>
              <button
                type="button"
                className="btn-icon btn-icon-danger"
                onClick={() => removeParticipant(i)}
                aria-label="Remove participant"
                disabled={participants.length <= 1}
              >
                Remove
              </button>
            </div>
            <div className="form-grid-2">
              <Field label="Name">
                <input
                  type="text"
                  className="form-input"
                  value={row.name}
                  onChange={(e) =>
                    setParticipant(i, { name: e.target.value })
                  }
                />
              </Field>
              <Field label="Company">
                <input
                  type="text"
                  className="form-input"
                  value={row.company}
                  onChange={(e) =>
                    setParticipant(i, { company: e.target.value })
                  }
                />
              </Field>
            </div>
            <Field label="LinkedIn (optional)">
              <input
                type="url"
                className="form-input"
                value={row.linkedin}
                onChange={(e) =>
                  setParticipant(i, { linkedin: e.target.value })
                }
                placeholder="https://www.linkedin.com/in/…"
              />
            </Field>
          </div>
        ))}
        <button
          type="button"
          className="btn-ghost btn-sm"
          onClick={addParticipant}
        >
          + Add participant
        </button>
      </div>
    </div>
  );
}
