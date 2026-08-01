/* RONOR — Governed Intelligence for Energy Operations
 * Web UI logic: decision timeline + audit verifier.
 * No frameworks — vanilla JS, ~200 lines, judge-friendly.
 */

const $ = (id) => document.getElementById(id);

const runBtn = $("runBtn");
const verifyBtn = $("verifyBtn");
const exportBtn = $("exportBtn");
const running = $("runningState");
const summaryPane = $("summaryPane");
const timelinePane = $("timelinePane");
const verifyPane = $("verifyPane");
const timelineList = $("timelineList");
const verifyOut = $("verifyOut");
const policyBadge = $("policyBadge");
const exposureBadge = $("exposureBadge");
const chainBadge = $("chainBadge");

const fmtEur = (v) => `€${Math.round(v).toLocaleString()}`;
const fmtMs = (v) => `${v} ms`;
const fmtHash = (h) => (h ? h.slice(0, 12) + "…" : "—");

async function refreshHead() {
  try {
    const r = await fetch("/api/v1/audit/head").then((x) => x.json());
    policyBadge.textContent = "policy: " + r.policyVersion;
    exposureBadge.textContent = "exposure: " + r.exposureModuleVersion;
    chainBadge.textContent = `chain: ${r.totalRecords} · ${fmtHash(r.headHash)}`;
  } catch (err) {
    chainBadge.textContent = "chain: offline";
  }
}

async function runDecision() {
  runBtn.disabled = true;
  verifyBtn.disabled = true;
  exportBtn.disabled = true;
  running.hidden = false;
  timelineList.innerHTML = "";
  verifyPane.hidden = true;

  try {
    const r = await fetch("/api/v1/decisions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain: "energy.bess.dispatch" }),
    }).then((x) => x.json());

    // ---- KPI ----
    $("kpiGain").textContent = fmtEur(r.verifiedGainEur);
    $("kpiFee").textContent = fmtEur(r.osaasFeeEur);
    $("kpiBaseline").textContent = fmtEur(r.baseline.netEur);
    $("kpiProposed").textContent = fmtEur(r.proposal.expectedNetEur);
    $("kpiModel").textContent = r.proposal.modelUsed;
    $("kpiLatency").textContent = fmtMs(r.proposal.latencyMs);

    // ---- Verdict counters ----
    $("cAllowed").textContent = r.summary.allowed;
    $("cCosign").textContent = r.summary.cosignRequired;
    $("cEscalate").textContent = r.summary.escalated;
    $("cBlocked").textContent = r.summary.blocked;

    // ---- Exposure summary ----
    const es = r.exposureSummary;
    $("exposureSummaryLine").textContent =
      `worst-case ${fmtEur(es.worstCaseEur)}   residual ${fmtEur(es.aggregateResidualEur)}   ` +
      `highest tier: ${es.highestTier}   advisories: ` +
      Object.entries(es.advisoryDistribution)
        .map(([k, v]) => `${k}=${v}`)
        .join("  ");

    $("rationaleBox").textContent = r.proposal.rationale || "(no rationale)";
    summaryPane.hidden = false;

    // ---- Timeline ----
    timelinePane.hidden = false;
    for (const p of r.perAction) {
      const row = document.createElement("div");
      row.className = "timeline-row";
      const ts = p.timestamp ? p.timestamp.slice(11, 16) : "—";
      const vol =
        p.volumeMwh !== undefined
          ? `${p.volumeMwh} MWh`
          : p.volumeMw !== undefined
          ? `${p.volumeMw} MW`
          : "—";
      row.innerHTML = `
        <span class="ts">${ts}</span>
        <span class="type">${p.type}</span>
        <span class="volume">${vol}</span>
        <span class="reason">${p.reason}</span>
        <span class="verdict-chip ${p.mi9Verdict}">${p.mi9Verdict}</span>
        <span class="exposure-chip ${p.exposure.tier}" title="${p.exposure.narrative}">
          ${p.exposure.tier}
        </span>`;
      timelineList.appendChild(row);
    }

    await refreshHead();
  } catch (err) {
    alert("Decision failed: " + err.message);
    console.error(err);
  } finally {
    runBtn.disabled = false;
    verifyBtn.disabled = false;
    exportBtn.disabled = false;
    running.hidden = true;
  }
}

async function verifyChain() {
  verifyBtn.disabled = true;
  verifyPane.hidden = false;
  verifyOut.textContent = "Verifying…";
  try {
    const r = await fetch("/api/v1/audit/verify").then((x) => x.json());
    const status = r.ok ? "✓ CHAIN INTACT" : "✗ CHAIN BROKEN";
    verifyOut.textContent = `${status}
records: ${r.totalRecords}
head:    ${r.headHash}
${r.brokenAtSeq ? `broken at seq: ${r.brokenAtSeq}\nreason: ${r.brokenReason}` : ""}
verified at: ${r.verifiedAt}`;
    await refreshHead();
  } catch (err) {
    verifyOut.textContent = "Verification failed: " + err.message;
  } finally {
    verifyBtn.disabled = false;
  }
}

async function exportChain() {
  const win = window.open("/api/v1/audit/export", "_blank");
  if (!win) alert("Popup blocked — allow popups to download the chain.");
}

runBtn.addEventListener("click", runDecision);
verifyBtn.addEventListener("click", verifyChain);
exportBtn.addEventListener("click", exportChain);

refreshHead();

// ============================================================================
//  Tabs
// ============================================================================
const tabButtons = document.querySelectorAll("#tabs .tab");
const tabMap = {
  decision: ["summaryPane", "timelinePane", "verifyPane", ".pane.control"],
  exchange: ["exchangePane"],
  ledger: ["ledgerPane"],
};
function showTab(name) {
  // Hide everything first.
  document.querySelectorAll("main .pane").forEach((el) => {
    if (el.id === "exchangePane" || el.id === "ledgerPane") {
      el.hidden = true;
    }
  });
  const decisionPane = document.querySelector("main > .pane.control:not(.tab-content)");
  const summary = document.getElementById("summaryPane");
  const timeline = document.getElementById("timelinePane");
  const verify = document.getElementById("verifyPane");
  const exchange = document.getElementById("exchangePane");
  const ledger = document.getElementById("ledgerPane");

  if (name === "decision") {
    if (decisionPane) decisionPane.hidden = false;
    // summary/timeline/verify remain in whatever state they were
  } else {
    if (decisionPane) decisionPane.hidden = true;
    if (summary) summary.hidden = true;
    if (timeline) timeline.hidden = true;
    if (verify) verify.hidden = true;
  }
  if (name === "exchange") exchange.hidden = false;
  if (name === "ledger") ledger.hidden = false;

  tabButtons.forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
}
tabButtons.forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

// ============================================================================
//  Model Exchange UI
// ============================================================================
async function mxFetch(path, opts) {
  const res = await fetch(`/api/v1/model-exchange${path}`, opts);
  return res.json();
}

function renderRegistry(models) {
  const rows = models
    .map(
      (m) =>
        `<tr><td>${m.id}</td><td>sov=${m.sovereignty_level}</td><td>${m.status}</td><td>$${m.cost_per_1k_output_tokens}/1k</td><td>~${m.latency_avg_ms}ms</td></tr>`
    )
    .join("");
  document.getElementById("mxRegistry").innerHTML =
    `<table class="mx-table"><thead><tr><th>Model</th><th>Sov</th><th>Status</th><th>Cost</th><th>Latency</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderRoutingTable(rows, winner) {
  const html = rows
    .map((r) => {
      const cls = r.model_id === winner ? "winner" : "";
      const pin = r.pinned_by_policy ? ` 📌 ${r.pinned_by_policy}` : "";
      const w = r.weighted || {};
      return `<tr class="${cls}"><td>${r.model_id}${pin}</td><td>${r.total.toFixed(1)}</td><td>${(w.quality||0).toFixed(1)}</td><td>${(w.sovereignty||0).toFixed(1)}</td><td>${(w.evidence||0).toFixed(1)}</td><td>${(w.cost||0).toFixed(1)}</td><td>${(w.latency||0).toFixed(1)}</td><td>${(w.operational_risk||0).toFixed(1)}</td><td>$${(r.estimated_cost_usd||0).toFixed(4)}</td></tr>`;
    })
    .join("");
  document.getElementById("mxRouteTable").innerHTML =
    `<table class="mx-table"><thead><tr><th>Model</th><th>Total</th><th>+Q</th><th>+Sov</th><th>+Ev</th><th>−Cost</th><th>−Lat</th><th>−Risk</th><th>Est cost</th></tr></thead><tbody>${html}</tbody></table>`;
}

function currentMxBody() {
  return {
    query: document.getElementById("mxQuery").value,
    task_type: document.getElementById("mxTaskType").value,
    confidentiality_level: document.getElementById("mxConf").value,
    operator_id: "merlin",
  };
}

document.getElementById("mxRegistryBtn").addEventListener("click", async () => {
  const d = await mxFetch("/registry");
  renderRegistry(d.models || []);
});

document.getElementById("mxRouteBtn").addEventListener("click", async () => {
  const d = await mxFetch("/route", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(currentMxBody()),
  });
  if (d.routing_table) renderRoutingTable(d.routing_table, d.chosen_model_id);
  document.getElementById("mxResult").textContent = JSON.stringify(
    { chosen: d.chosen_model_id, eligible: d.eligible_models, dry_run: true },
    null,
    2
  );
});

document.getElementById("mxQueryBtn").addEventListener("click", async () => {
  document.getElementById("mxResult").textContent = "Running governed query…";
  const d = await mxFetch("/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(currentMxBody()),
  });
  if (d.routing_table) renderRoutingTable(d.routing_table, d.chosen_model_id);
  const summary = {
    status: d.status,
    model: d.chosen_model_id,
    latency_ms: d.latency_ms,
    cost_usd: d.cost_usd,
    mi9_verdict: d.mi9 && d.mi9.verdict,
    block_reason: d.mi9 && d.mi9.blockReason,
    assurance: d.assurance && {
      verified_confidence: d.assurance.verified_confidence,
      evidence_reliability: d.assurance.evidence_reliability,
    },
    audit_seq: d.audit_record && d.audit_record.seq,
    audit_chain_hash: d.audit_record && d.audit_record.chainHash,
    answer_preview: (d.execution && d.execution.answer && d.execution.answer.slice(0, 240)) || null,
  };
  document.getElementById("mxResult").textContent = JSON.stringify(summary, null, 2);
  refreshHead();
});

document.getElementById("mxLedgerBtn").addEventListener("click", async () => {
  const d = await mxFetch("/ledger/cost");
  document.getElementById("mxLedger").textContent = JSON.stringify(d, null, 2);
});
