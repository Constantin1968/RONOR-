export default function CostPanel({ costs, lastResult }) {
  const last = lastResult?.cost;
  return (
    <div className="panel">
      <p className="kicker">Cost Ledger</p>

      {last && (
        <>
          <div className="cost-cards">
            <div className="cost-card">
              <div className="v">${last.this_request_usd}</div>
              <div className="l">this request</div>
            </div>
            <div className="cost-card">
              <div className="v">{last.input_tokens}</div>
              <div className="l">input tokens</div>
            </div>
            <div className="cost-card">
              <div className="v">{last.output_tokens}</div>
              <div className="l">output tokens</div>
            </div>
            <div className="cost-card">
              <div className="v">{lastResult.engine_latency_ms ?? "—"}ms</div>
              <div className="l">engine latency</div>
            </div>
          </div>
          <p className="footnote">
            rate: ${last.cost_per_1k_input}/1k in · ${last.cost_per_1k_output}/1k out
          </p>
        </>
      )}

      {costs && (
        <div style={{ marginTop: last ? 14 : 0 }}>
          <div className="cost-cards">
            <div className="cost-card">
              <div className="v">{costs.total_requests}</div>
              <div className="l">session requests</div>
            </div>
            <div className="cost-card">
              <div className="v">${costs.total_cost_usd}</div>
              <div className="l">session cost</div>
            </div>
          </div>

          {Object.keys(costs.by_model ?? {}).length > 0 && (
            <div style={{ marginTop: 12, overflowX: "auto" }}>
              <table>
                <thead>
                  <tr>
                    <th>Engine</th>
                    <th>Req</th>
                    <th>Tok In</th>
                    <th>Tok Out</th>
                    <th>Cost $</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(costs.by_model).map(([id, m]) => (
                    <tr key={id}>
                      <td>{id}</td>
                      <td>{m.requests}</td>
                      <td>{m.input_tokens}</td>
                      <td>{m.output_tokens}</td>
                      <td>{m.cost_usd}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {!costs && !last && <p className="footnote">No requests recorded yet.</p>}
    </div>
  );
}
