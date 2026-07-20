import { useState } from "react";

const SAMPLES = [
  { label: "Reasoning → GPT-4.1", q: "Assess the strategic risks of single-provider AI dependency for a national government.", t: "reasoning", c: "public" },
  { label: "Calculation → Deterministic Core", q: "What is (1284.5 * 7.2) / 3.14 + 250?", t: "calculation", c: "public" },
  { label: "Sovereign → on-prem only", q: "What is 42 * 1911?", t: "calculation", c: "sovereign" },
  { label: "Anthropic-only routing", q: "Summarize the case for provider-neutral AI orchestration.", t: "summarization", c: "public", p: "Anthropic" },
];

export default function QueryConsole({ onRun, busy }) {
  const [query, setQuery] = useState("");
  const [taskType, setTaskType] = useState("reasoning");
  const [confidentiality, setConfidentiality] = useState("public");
  const [maxCost, setMaxCost] = useState("");
  const [maxLatency, setMaxLatency] = useState("");
  const [evidence, setEvidence] = useState("");
  const [providers, setProviders] = useState("");

  const submit = (e) => {
    e?.preventDefault();
    if (!query.trim() || busy) return;
    onRun({
      query: query.trim(),
      task_type: taskType,
      confidentiality_level: confidentiality,
      max_cost: maxCost ? Number(maxCost) : undefined,
      max_latency: maxLatency ? Number(maxLatency) : undefined,
      required_evidence_level: evidence ? Number(evidence) : undefined,
      allowed_providers: providers
        ? providers.split(",").map((s) => s.trim()).filter(Boolean)
        : [],
      requester: "dashboard-operator",
    });
  };

  const runSample = (s) => {
    setQuery(s.q);
    setTaskType(s.t);
    setConfidentiality(s.c);
    setProviders(s.p ?? "");
    onRun({
      query: s.q,
      task_type: s.t,
      confidentiality_level: s.c,
      allowed_providers: s.p ? [s.p] : [],
      requester: "dashboard-operator",
    });
  };

  return (
    <div className="panel">
      <p className="kicker">Unified Request API — POST /api/query</p>
      <form onSubmit={submit}>
        <div className="query-row">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Submit an intelligence request to the runtime…"
            aria-label="Query"
          />
          <button className="exec" type="submit" disabled={busy}>
            {busy ? "ROUTING…" : "EXECUTE"}
          </button>
        </div>

        <div className="controls">
          <div className="ctl">
            <label>task_type</label>
            <select value={taskType} onChange={(e) => setTaskType(e.target.value)}>
              {["reasoning", "generation", "analysis", "summarization", "extraction", "calculation", "validation", "lookup"].map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
          <div className="ctl">
            <label>confidentiality_level</label>
            <select value={confidentiality} onChange={(e) => setConfidentiality(e.target.value)}>
              {["public", "internal", "confidential", "sovereign"].map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
          <div className="ctl">
            <label>max_cost (USD)</label>
            <input type="number" step="0.001" min="0" value={maxCost} onChange={(e) => setMaxCost(e.target.value)} placeholder="no limit" />
          </div>
          <div className="ctl">
            <label>max_latency (ms)</label>
            <input type="number" step="100" min="0" value={maxLatency} onChange={(e) => setMaxLatency(e.target.value)} placeholder="no limit" />
          </div>
          <div className="ctl">
            <label>required_evidence_level</label>
            <input type="number" min="0" max="100" value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="0-100" />
          </div>
          <div className="ctl">
            <label>allowed_providers</label>
            <input type="text" value={providers} onChange={(e) => setProviders(e.target.value)} placeholder="e.g. OpenAI, Anthropic" />
          </div>
        </div>
      </form>

      <div className="samples">
        {SAMPLES.map((s) => (
          <button key={s.label} className="chipbtn" onClick={() => runSample(s)} disabled={busy}>
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}
