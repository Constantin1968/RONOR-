export default function AnswerPanel({ result }) {
  const a = result.assurance ?? {};
  return (
    <div className="panel">
      <p className="kicker">Response — verified by R-Assurance</p>
      <div className="answer-meta">
        <span className={`pill ${result.model?.simulated ? "sim" : "live"}`}>
          {result.model?.simulated ? "SIMULATED" : "LIVE"}
        </span>
        <span className="pill blue">{result.model?.display_name}</span>
        <span className="pill blue">{result.model?.provider}</span>
        <span className="pill live">{a.verified_confidence}% verified confidence</span>
        <span className="pill blue">trace {result.trace_id}</span>
      </div>
      <div className="gauge" aria-hidden>
        <div style={{ width: `${a.verified_confidence ?? 0}%` }} />
      </div>

      <p className="answer" style={{ marginTop: 14 }}>{result.answer}</p>

      {a.sources?.length > 0 && (
        <div className="sources-list">
          <p className="kicker" style={{ marginTop: 14 }}>Source attribution</p>
          {a.sources.map((s, i) => (
            <div className="src" key={i}>
              <span className="stype">{s.type}</span>
              <span>{s.title}</span>
            </div>
          ))}
        </div>
      )}

      {a.checks?.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <p className="kicker">Assurance checks</p>
          {a.checks.map((c) => (
            <div className="check" key={c.check}>
              <span>{c.check}</span>
              <span className={c.passed ? "ok" : "no"}>
                {c.result} {c.passed ? "✓" : "△"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
