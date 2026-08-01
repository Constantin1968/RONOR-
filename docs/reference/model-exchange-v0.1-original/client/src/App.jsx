/* RONOR Model Exchange v0.1 — Operator Dashboard */
import { useEffect, useState, useCallback } from "react";
import QueryConsole from "./components/QueryConsole.jsx";
import RoutingPanel from "./components/RoutingPanel.jsx";
import AnswerPanel from "./components/AnswerPanel.jsx";
import CostPanel from "./components/CostPanel.jsx";
import TracePanel from "./components/TracePanel.jsx";
import RegistryPanel from "./components/RegistryPanel.jsx";
import PlanesDiagram from "./components/PlanesDiagram.jsx";

export default function App() {
  const [registry, setRegistry] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [traces, setTraces] = useState([]);
  const [costs, setCosts] = useState(null);
  const [activePlane, setActivePlane] = useState(-1);

  const refresh = useCallback(async () => {
    try {
      const [r, t, c] = await Promise.all([
        fetch("/api/registry").then((x) => x.json()),
        fetch("/api/traces?limit=20").then((x) => x.json()),
        fetch("/api/costs").then((x) => x.json()),
      ]);
      setRegistry(r);
      setTraces(t.traces ?? []);
      setCosts(c);
    } catch {
      /* backend not up yet */
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const runQuery = async (payload) => {
    setBusy(true);
    setError(null);
    setResult(null);

    // Animate the seven planes as the request flows through the runtime
    let plane = 0;
    setActivePlane(0);
    const planeTimer = setInterval(() => {
      plane = Math.min(plane + 1, 6);
      setActivePlane(plane);
    }, 450);

    try {
      const res = await fetch("/api/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok && data?.status !== "rejected") {
        setError(data?.reason || data?.error || `Request failed (${res.status})`);
        setResult(data?.routing || data?.policy_evaluations ? data : null);
      } else {
        setResult(data);
      }
    } catch (err) {
      setError(`Network error: ${err.message}`);
    } finally {
      clearInterval(planeTimer);
      setActivePlane(-1);
      setBusy(false);
      refresh();
    }
  };

  return (
    <div className="app">
      <header className="hdr">
        <h1>
          RONOR<span>_</span>MODEL EXCHANGE
        </h1>
        <span className="tag">
          v0.1 · Sovereign Generative Intelligence Runtime · provider-neutral ·
          model-portable · evidence-governed
        </span>
      </header>

      <QueryConsole onRun={runQuery} busy={busy} />

      {error && (
        <div className="panel err">
          <strong>Runtime notice:</strong> {error}
        </div>
      )}

      {result && result.status === "rejected" && (
        <div className="panel err">
          <strong>Rejected by Policy Engine:</strong> {result.reason}
          <div className="footnote">trace_id: {result.trace_id}</div>
        </div>
      )}

      {result && result.status === "ok" && <AnswerPanel result={result} />}

      {result && (result.routing || result.policy_evaluations) && (
        <RoutingPanel result={result} />
      )}

      <div className="grid grid-2">
        <div>
          <CostPanel costs={costs} lastResult={result} />
          <TracePanel traces={traces} />
        </div>
        <div>
          <RegistryPanel registry={registry} />
          <PlanesDiagram active={activePlane} />
        </div>
      </div>
    </div>
  );
}
