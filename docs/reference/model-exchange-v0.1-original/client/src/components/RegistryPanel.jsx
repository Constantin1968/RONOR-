export default function RegistryPanel({ registry }) {
  if (!registry) {
    return (
      <div className="panel">
        <p className="kicker">Model Registry</p>
        <p className="footnote">Loading registry…</p>
      </div>
    );
  }

  return (
    <div className="panel">
      <p className="kicker">Model Registry — {registry.models.length} engines</p>
      {registry.models.map((m) => (
        <div className="model-card" key={m.id}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <span className="name">{m.display_name}</span>
            <span className={`pill ${m.live ? "live" : "sim"}`}>
              {m.live ? "LIVE" : "SIMULATED"}
            </span>
          </div>
          <div className="meta">
            {m.id} · {m.provider} · sovereignty L{m.sovereignty_level} ·{" "}
            {m.jurisdictions.join("/")}
            <br />
            quality {m.quality_score} · evidence {m.evidence_reliability} · risk{" "}
            {m.operational_risk} · ~{m.latency_avg_ms}ms
            <br />
            ${m.cost_per_1k_input_tokens}/1k in · ${m.cost_per_1k_output_tokens}/1k out
            <br />
            caps: {m.capabilities.join(", ")}
          </div>
          <div className="scorebar" title={`quality ${m.quality_score}/100`}>
            <div style={{ width: `${m.quality_score}%` }} />
          </div>
        </div>
      ))}
      <p className="footnote">
        Router weights: quality {registry.weights.quality} · cost {registry.weights.cost} ·
        latency {registry.weights.latency} · risk {registry.weights.operational_risk} ·
        sovereignty {registry.weights.sovereignty} · evidence {registry.weights.evidence}
      </p>
    </div>
  );
}
