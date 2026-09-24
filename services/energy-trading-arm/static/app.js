const $ = (id) => document.getElementById(id);
const state = { trades: [], book: [] };

async function api(path, opts) {
  const r = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

function fmt(n, d = 2) {
  return Number(n).toLocaleString("en-IE", { minimumFractionDigits: d, maximumFractionDigits: d });
}

async function refreshHealth() {
  try {
    const h = await api("/api/health");
    $("healthText").textContent = `online · ${h.zones.length} zones · ${h.time.slice(11, 19)}Z`;
    document.querySelector(".dot").classList.add("ok");
  } catch {
    $("healthText").textContent = "offline — start: uvicorn energy_trading.api:app";
  }
}

async function refreshBorders() {
  const d = await api("/api/interconnectors");
  $("borders").innerHTML = d.items.map((b) => `
    <div class="border"><b>${b.id}</b> · ${b.coupling}<small>${b.from_zone} → ${b.to_zone} · ${b.capacity_mw} MW · fee €${b.tariff_eur_mwh} · loss ${b.loss_pct}%</small></div>
  `).join("");
}

async function refreshBook() {
  const d = await api("/api/book");
  state.book = d.trades;
  $("bookRows").innerHTML = d.trades.length ? d.trades.map((t) => `
    <tr><td>${t.id}</td><td>${t.delivery_start.slice(11, 16)}</td><td>${t.interconnector_id}</td>
    <td>${t.volume_mw}</td><td>${fmt(t.buy_price)}→${fmt(t.sell_price)}</td>
    <td>€${fmt(t.expected_pnl)}</td><td><span class="pill ${t.status}">${t.status}</span></td></tr>
  `).join("") : `<tr><td colspan="7" class="muted">Book is empty.</td></tr>`;
  $("kBook").textContent = "€" + fmt(d.summary.total_expected_pnl, 0);
}

async function runAgent(extra) {
  const btn = $("runBtn");
  btn.disabled = true; btn.textContent = "⏳ Scanning…";
  try {
    const d = await api("/api/run", { method: "POST", body: JSON.stringify({
      day: $("day").value || "2026-09-12",
      min_net_spread: Number($("minSpread").value),
      volume_mw: Number($("volume").value),
      max_trades: Number($("maxTrades").value),
      ...(extra || {}),
    })});
    state.trades = d.trades;
    $("oppRows").innerHTML = d.trades.length ? d.trades.map((t) => `
      <tr><td>${t.delivery_start.slice(0, 16).replace("T", " ")}</td><td>${t.interconnector_id}</td>
      <td>${t.from_zone}→${t.to_zone}</td><td>${fmt(t.buy_price)}</td><td>${fmt(t.sell_price)}</td>
      <td style="color:#34d399">+${fmt(t.sell_price - t.buy_price - t.transport_cost)}</td>
      <td>${t.volume_mw}</td><td>€${fmt(t.expected_pnl)}</td></tr>
    `).join("") : `<tr><td colspan="8" class="muted">No spread above threshold. Lower min spread or check availability.</td></tr>`;
    $("kScanned").textContent = d.log.opportunities_scanned;
    $("kProposed").textContent = d.log.trades_proposed;
    $("kPnl").textContent = "€" + fmt(d.log.total_expected_pnl, 0);
    $("logPre").textContent = JSON.stringify(d.log, null, 2);
    await refreshBook();
  } catch (e) { alert("Run failed: " + e.message); }
  finally { btn.disabled = false; btn.textContent = "▶ Run agent"; }
}

document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
  b.classList.add("active");
  ["opps", "book", "log"].forEach((t) => $("tab-" + t).classList.toggle("hidden", t !== b.dataset.tab));
}));

$("runBtn").addEventListener("click", () => runAgent());
$("nominateBtn").addEventListener("click", async () => {
  const ids = state.book.filter((t) => t.status === "proposed").map((t) => t.id);
  if (!ids.length) return alert("Nothing to nominate — run the agent first.");
  await api("/api/nominate", { method: "POST", body: JSON.stringify({ trade_ids: ids }) });
  await refreshBook();
});
$("settleBtn").addEventListener("click", async () => {
  const d = await api("/api/settle", { method: "POST" });
  alert(`Settled €${fmt(d.total_net_eur)} across ${d.lines.length} trades`);
  await refreshBook();
});
$("resetBtn").addEventListener("click", async () => { await api("/api/reset", { method: "POST" }); await refreshBook(); });

async function parseOps() {
  const d = await api("/api/ops-parse", { method: "POST", body: JSON.stringify({
    day: $("day").value || "2026-09-12",
    text: $("opsText").value,
  })});
  const pre = $("opsPre");
  pre.classList.remove("hidden");
  pre.textContent = JSON.stringify(d, null, 2);
  return d;
}
$("parseBtn").addEventListener("click", async () => { try { await parseOps(); } catch (e) { alert("Parse failed: " + e.message); } });
$("parseRunBtn").addEventListener("click", async () => {
  try {
    const d = await parseOps();
    await runAgent({ availability: d.availability, prices_override: d.prices_override });
  } catch (e) { alert("Parse+Run failed: " + e.message); }
});

async function uploadOps() {
  const f = $("opsFile").files[0];
  if (!f) { alert("Alege fișierul Excel mai întâi."); throw new Error("no file"); }
  const fd = new FormData();
  fd.append("file", f);
  const r = await fetch(`/api/ops-upload?day=${$("day").value || "2026-09-12"}`, { method: "POST", body: fd });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  const d = await r.json();
  const pre = $("opsPre");
  pre.classList.remove("hidden");
  pre.textContent = JSON.stringify(d, null, 2);
  return d;
}
$("uploadBtn").addEventListener("click", async () => { try { await uploadOps(); } catch (e) { alert("Upload failed: " + e.message); } });
$("uploadRunBtn").addEventListener("click", async () => {
  try {
    const d = await uploadOps();
    await runAgent({ availability: d.availability, prices_override: d.prices_override });
  } catch (e) { alert("Upload+Run failed: " + e.message); }
});

refreshHealth(); refreshBorders(); refreshBook();
