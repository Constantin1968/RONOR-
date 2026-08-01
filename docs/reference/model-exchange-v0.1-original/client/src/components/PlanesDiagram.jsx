const PLANES = [
  { name: "ACCESS PLANE", desc: "Unified Request API — one contract for every model, agent, tool and task" },
  { name: "POLICY PLANE", desc: "Governance rules: confidentiality, jurisdiction, budget, provider allow-lists" },
  { name: "ROUTING PLANE", desc: "Dynamic Router — scores every eligible engine, selects lowest total-cost intelligence" },
  { name: "EXECUTION PLANE", desc: "Engine adapters: OpenAI, Anthropic, deterministic core — with automatic fallback" },
  { name: "ASSURANCE PLANE", desc: "R-Assurance — verification, confidence calibration, source attribution" },
  { name: "ECONOMIC PLANE", desc: "Cost Ledger — per-token, per-task, per-provider accounting in real time" },
  { name: "EVIDENCE PLANE", desc: "Trace Ledger — append-only, hash-chained audit of every decision and result" },
];

export default function PlanesDiagram({ active }) {
  return (
    <div className="panel">
      <p className="kicker">RONOR Architecture — seven operational planes</p>
      <div className="planes">
        {PLANES.map((p, i) => (
          <div className={`plane ${active === i ? "active" : ""}`} key={p.name}>
            <span className="num">P{i + 1}</span>
            <span className="pname">{p.name}</span>
            <span className="pdesc">{p.desc}</span>
          </div>
        ))}
      </div>
      <p className="footnote">
        Every request traverses all seven planes. During execution the active plane
        is highlighted in real time.
      </p>
    </div>
  );
}
