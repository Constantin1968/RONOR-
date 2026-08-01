export default function TracePanel({ traces }) {
  return (
    <div className="panel">
      <p className="kicker">Trace Ledger — append-only, hash-chained</p>
      {traces.length === 0 && <p className="footnote">Ledger empty. Execute a request to create the first trace.</p>}
      {traces.map((t) => (
        <div className="trace" key={t.trace_id}>
          <div>
            <span className="tid">{t.trace_id}</span>{" "}
            <span className="thash">#{t.hash}</span>{" "}
            <span className={`pill ${t.outcome === "OK" ? "live" : "red"}`}>{t.outcome}</span>
          </div>
          <div className="row2">
            {t.timestamp} · {t.requester} · {t.task_type} ·{" "}
            {t.model_used ?? "no engine"} · ${t.cost_usd}
            {t.verified_confidence != null && ` · ${t.verified_confidence}% verified`}
            {t.simulated && " · SIMULATED"}
          </div>
          <div className="row2">"{(t.query ?? "").slice(0, 90)}{(t.query?.length ?? 0) > 90 ? "…" : ""}"</div>
        </div>
      ))}
    </div>
  );
}
