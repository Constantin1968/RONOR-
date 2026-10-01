const $ = (id) => document.getElementById(id);
const eur = (n) => "€" + Math.round(n).toLocaleString("ro-RO");

async function api(path, opts) {
  const r = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  return r.json();
}

function today(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

function shiftDay(delta) {
  const d = new Date($("day").value || today());
  d.setDate(d.getDate() + delta);
  $("day").value = d.toISOString().slice(0, 10);
  loadDay();
}

async function refreshHealth() {
  try {
    const h = await api("/api/health");
    $("health").querySelector(".dot").classList.add("ok");
    $("healthText").textContent = h.scheduler ? "agent activ · rulează singur" : "agent în pauză";
    $("activateBtn").textContent = h.scheduler ? "Agent activ ✓" : "Activează agentul";
  } catch {
    $("healthText").textContent = "deconectat";
  }
}

function renderBorders(view) {
  const box = $("borders");
  box.innerHTML = "";
  for (const d of view.decisions) {
    const t = document.createElement("span");
    t.className = "tag closed";
    t.textContent = "🚫 " + d.split(" (")[0];
    box.appendChild(t);
  }
  const decided = new Set(view.decisions.map((d) => d.split(" ")[0]));
  for (const a of view.borders) {
    if (decided.has(a.context.border)) continue;
    const t = document.createElement("span");
    const closed = !a.context.usable_hours.length;
    t.className = "tag " + (closed ? "closed" : "thin");
    t.title = a.message;
    t.textContent = (closed ? "🚫 " : "🟠 ") + a.context.border + (closed ? " închis" : " subțire");
    box.appendChild(t);
  }
}

function renderPending(view) {
  const box = $("pending");
  box.innerHTML = "";
  $("pendingCount").textContent = view.pending.length || "";
  if (!view.pending.length) {
    box.innerHTML = '<div class="empty">Nimic de autorizat pentru această zi.</div>';
    $("authAllBtn").disabled = true;
  } else {
    $("authAllBtn").disabled = false;
    const groups = {};
    for (const t of view.pending) {
      const k = `${t.from_zone}→${t.to_zone}`;
      (groups[k] ||= []).push(t);
    }
    for (const [k, ts] of Object.entries(groups).sort((a, b) => sum(b[1]) - sum(a[1]))) {
      const g = document.createElement("div");
      g.className = "group";
      const ids = ts.map((t) => t.id);
      g.innerHTML = `
        <header>
          <label><input type="checkbox" class="grp" data-ids="${ids.join(",")}" checked /> ${k}</label>
          <span class="sum">${ts.length}h · ${Math.round(ts.reduce((s, t) => s + t.volume_mw, 0))} MWh · ${eur(sum(ts))}</span>
        </header>
        <div class="rows">${ts
          .sort((a, b) => new Date(a.delivery_start) - new Date(b.delivery_start))
          .map(
            (t) =>
              `<label class="row"><input type="checkbox" class="trade" value="${t.id}" checked /> ${String(new Date(t.delivery_start).getUTCHours()).padStart(2, "0")}h · ${t.volume_mw} MW · ${eur(t.expected_pnl)}</label>`
          )
          .join("")}</div>`;
      box.appendChild(g);
    }
    box.querySelectorAll(".grp").forEach((cb) =>
      cb.addEventListener("change", () => {
        const ids = new Set(cb.dataset.ids.split(","));
        box.querySelectorAll(".trade").forEach((t) => ids.has(t.value) && (t.checked = cb.checked));
      })
    );
  }
  const nom = view.nominated;
  $("nominated").innerHTML = nom.length
    ? nom
        .map(
          (t) =>
            `${t.id} ${t.from_zone}→${t.to_zone} ${String(new Date(t.delivery_start).getUTCHours()).padStart(2, "0")}h [${t.status}]` +
            (t.nominated_by ? ` <span class="who">${t.nominated_by}</span>` : "")
        )
        .join(" · ")
    : "—";
}

const sum = (ts) => ts.reduce((s, t) => s + t.expected_pnl, 0);

async function loadDay(refresh = false) {
  const day = $("day").value || today();
  $("brief").textContent = "Se încarcă…";
  try {
    const view = await api(`/api/day?day=${day}${refresh ? "&refresh=1" : ""}`);
    const real = view.evidence === "operator_provided";
    const ev = $("evidence");
    ev.className = "evidence " + (real ? "real" : "sim");
    ev.textContent = real
      ? `Prețuri reale · NTC ${view.sources.ntc || "—"} · prețuri ${view.sources.prices}`
      : `Prețuri simulate — trimite prețurile zilei ca să fie real · NTC ${view.sources.ntc || "lipsă"}${view.sources.ntc_fallback ? " (al altei zile)" : ""}`;
    $("brief").textContent = view.brief;
    renderBorders(view);
    renderPending(view);
  } catch (e) {
    $("brief").textContent = "Nu am putut încărca ziua: " + e.message;
  }
}

function addMsg(text, who) {
  const m = document.createElement("div");
  m.className = "msg " + who;
  m.textContent = text;
  $("chatLog").appendChild(m);
  $("chatLog").scrollTop = $("chatLog").scrollHeight;
}

async function ask(text) {
  if (!text.trim()) return;
  addMsg(text, "me");
  $("chatInput").value = "";
  try {
    const r = await api("/api/operator", { method: "POST", body: JSON.stringify({ text, chat_id: "dashboard" }) });
    addMsg(r.reply || "(nimic de spus)", "bot");
    if (r.who) $("healthText").dataset.who = r.who;
    if (/autoriz|nominal|skip|activ|opre/i.test(text) || r.kind === "text") {
      await loadDay();
      await refreshHealth();
    }
  } catch (e) {
    addMsg("Eroare: " + e.message, "bot");
  }
}

async function authorizeChecked() {
  const ids = [...document.querySelectorAll("#pending .trade:checked")].map((c) => c.value);
  if (!ids.length) return;
  await ask(`autorizez ${ids.join(" ")}`);
}

$("day").value = today();
$("prevDay").onclick = () => shiftDay(-1);
$("nextDay").onclick = () => shiftDay(1);
$("day").onchange = () => loadDay();
$("refreshBtn").onclick = () => loadDay(true);
$("authAllBtn").onclick = authorizeChecked;
$("activateBtn").onclick = () => ask("RONOR, activează agentul");
$("chatForm").onsubmit = (e) => {
  e.preventDefault();
  ask($("chatInput").value);
};
document.querySelectorAll(".chip").forEach((c) => (c.onclick = () => ask(c.dataset.q)));

refreshHealth();
loadDay();
setInterval(refreshHealth, 30000);
