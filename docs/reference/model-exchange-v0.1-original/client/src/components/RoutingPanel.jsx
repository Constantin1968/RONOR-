export default function RoutingPanel({ result }) {
  const routing = result.routing;
  const policy = result.policy?.evaluations ?? result.policy_evaluations ?? [];

  return (
    <div className="panel">
      <p className="kicker">Dynamic Router — decision transparency</p>

      {routing?.formula && <div className="formula">{routing.formula}</div>}

      {routing?.scores?.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Engine</th>
                <th>+Quality</th>
                <th>−Cost</th>
                <th>−Latency</th>
                <th>−Op.Risk</th>
                <th>+Sovereignty</th>
                <th>+Evidence</th>
                <th>Total</th>
                <th>Est. $</th>
              </tr>
            </thead>
            <tbody>
              {routing.scores.map((s) => {
                const selected = s.model_id === routing.selected;
                return (
                  <tr key={s.model_id} className={selected ? "selected" : ""}>
                    <td>
                      {s.display_name}
                      {selected && <span className="pill live" style={{ marginLeft: 6 }}>SELECTED</span>}
                      {s.pinned_by_policy && <span className="pill blue" style={{ marginLeft: 6 }}>PINNED {s.pinned_by_policy}</span>}
                    </td>
                    <td className="pos">+{s.weighted.quality}</td>
                    <td className="neg">{s.weighted.cost}</td>
                    <td className="neg">{s.weighted.latency}</td>
                    <td className="neg">{s.weighted.operational_risk}</td>
                    <td className="pos">+{s.weighted.sovereignty}</td>
                    <td className="pos">+{s.weighted.evidence}</td>
                    <td className="total">{s.total}</td>
                    <td>${s.estimated_cost_usd}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {routing?.fallback_attempts?.length > 1 && (
        <div style={{ marginTop: 10 }}>
          <p className="kicker">Fallback chain</p>
          {routing.fallback_attempts.map((a, i) => (
            <div className="check" key={i}>
              <span>#{i + 1} {a.model_id}</span>
              <span className={a.ok ? "ok" : "no"}>
                {a.ok ? `OK (${a.latency_ms}ms)` : `FAILED → ${a.error}`}
              </span>
            </div>
          ))}
        </div>
      )}

      {policy.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <p className="kicker">Policy Engine evaluations</p>
          {policy.map((p) => (
            <div className="policy-item" key={p.rule}>
              <div className="rule">{p.rule}</div>
              <div className="desc">{p.description}</div>
              {p.excluded?.length > 0 && (
                <div className="excl">excluded: {p.excluded.join(", ")}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
