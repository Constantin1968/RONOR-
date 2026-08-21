(function () {
  'use strict';
  var root = '/api/runtime/control';
  var state = { key: sessionStorage.getItem('ronor.control.key') || '', missionId: null, runId: null, poll: null };
  var terminal = ['complete', 'blocked', 'failed', 'cancelled'];
  function el(id) { return document.getElementById(id); }
  function node(tag, text, cls) { var n = document.createElement(tag); if (text) n.textContent = text; if (cls) n.className = cls; return n; }
  async function api(path, options) {
    var response = await fetch(root + path, Object.assign({}, options || {}, { headers: { Authorization: 'Bearer ' + state.key, 'Content-Type': 'application/json' } }));
    var body = await response.json().catch(function () { return { ok: false, error: 'invalid_response' }; });
    if (!response.ok) throw new Error(body.message || body.error || ('HTTP ' + response.status)); return body;
  }
  function card(title, detail, status) { var n = node('article', '', 'card'); n.append(node('b', title), node('span', detail)); if (status) n.append(node('span', status, 'status')); return n; }
  function stopPolling() { if (state.poll) clearTimeout(state.poll); state.poll = null; }
  function show(name) { document.querySelectorAll('.view').forEach(function (v) { v.classList.toggle('active', v.id === name); }); document.querySelectorAll('nav button').forEach(function (b) { b.classList.toggle('active', b.dataset.view === name); }); if (name !== 'missions') stopPolling(); }
  function renderList(target, values, build) { var box = el(target); box.replaceChildren(); values.forEach(function (value) { box.append(build(value)); }); if (!values.length) box.append(card('Niciun element', 'Nu există date pentru această categorie.', 'gol')); }
  function renderOverview(data) {
    var box = el('metrics'); box.replaceChildren(); [['Misiuni', data.missions.total], ['Active', data.missions.active], ['Fabric verificat', data.fabric.verified], ['Integritate eșuată', data.fabric.failed], ['Consiliu AI', data.council.members]].forEach(function (m) { var n = node('article', '', 'metric'); n.append(node('strong', String(m[1])), node('span', m[0])); box.append(n); });
    var auto = el('automation'); auto.replaceChildren(); Object.keys(data.automation.adapters).forEach(function (k) { auto.append(card(k.toUpperCase(), 'Adapter de execuție', data.automation.adapters[k])); }); auto.append(card('RUNNER', 'Politică deny-by-default', data.automation.runner));
    var missions = el('missionList'); missions.replaceChildren(); data.missions.recent.forEach(function (m) { var b = node('button', m.title + '\n' + m.mission_id + ' · ' + m.status, 'mission-button'); b.type = 'button'; b.addEventListener('click', function () { loadMission(m.mission_id); }); missions.append(b); });
  }
  async function loadMission(missionId) {
    stopPolling(); state.missionId = missionId;
    try {
      var data = await api('/missions/' + encodeURIComponent(missionId) + '/fabric'); var fabric = data.fabric; var runs = Object.values(fabric.runs || {}); var run = runs[runs.length - 1] || null;
      el('runDetail').hidden = false; state.runId = run && run.run_id || null; el('runTitle').textContent = state.runId || missionId;
      var stages = run ? Object.entries(run.stage_statuses || {}).map(function (entry) { return { stage: entry[0], status: entry[1], completed: run.completed_assignments, total: run.total_assignments, cost: run.cost_usd }; }) : [];
      renderList('runStages', stages, function (r) { return card(String(r.stage), String(r.completed || 0) + '/' + String(r.total || 0) + ' · cost $' + String(r.cost || 0), String(r.status || 'unknown')); });
      renderList('runApprovals', Object.values(fabric.approvals || {}), function (a) { return card(String(a.approver || 'Merlin'), String(a.resolution || a.status || 'pending'), 'aprobare'); });
      renderList('runEvidence', Object.values(fabric.evidence || {}), function (e) { return card(String(e.kind || 'evidence'), String(e.reference || 'referință indisponibilă'), String(e.digest || '').slice(0, 12)); });
      renderList('runFailures', fabric.failures || [], function (f) { return card(String(f.payload && f.payload.reason || 'failure'), String(f.at || ''), 'FAIL'); });
      var cancellable = run && terminal.indexOf(run.status) === -1; el('cancelRun').hidden = !cancellable; if (cancellable) state.poll = setTimeout(function () { loadMission(missionId); }, 2500);
    } catch (err) { el('result').textContent = 'EROARE: ' + err.message; }
  }
  async function refresh() {
    try { await api('/session'); el('sessionState').textContent = 'VERIFICAT'; var overview = await api('/overview'); renderOverview(overview); var council = await api('/council'); renderList('councilGrid', council.management, function (a) { return card(a.name, a.role, a.email_status + ' · ' + a.email); }); var models = await api('/models'); renderList('modelGrid', models.cabinet, function (m) { return card(m.role, m.model + ' · ' + m.location, m.status + ' · ' + m.mode); }); }
    catch (err) { el('sessionState').textContent = 'ACCES RESPINS'; el('result').textContent = err.message; }
  }
  el('cancelRun').addEventListener('click', async function () { if (!state.runId || !state.missionId || !window.confirm('Anulezi runul activ? Modificările locale deja produse nu sunt rollback automat.')) return; try { await api('/automation/runs/' + encodeURIComponent(state.runId) + '/cancel', { method: 'POST', body: JSON.stringify({ mission_id: state.missionId }) }); el('cancelRun').textContent = 'Anulare solicitată'; el('cancelRun').disabled = true; await loadMission(state.missionId); } catch (err) { el('result').textContent = 'EROARE: ' + err.message; } });
  el('connect').addEventListener('click', function () { state.key = el('apiKey').value.trim(); sessionStorage.setItem('ronor.control.key', state.key); refresh(); });
  el('forget').addEventListener('click', function () { state.key = ''; sessionStorage.removeItem('ronor.control.key'); el('apiKey').value = ''; el('sessionState').textContent = 'NEAUTENTIFICAT'; stopPolling(); });
  el('refresh').addEventListener('click', refresh); document.querySelectorAll('nav button').forEach(function (b) { b.addEventListener('click', function () { show(b.dataset.view); }); });
  el('delegateForm').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var target = el('target').value, mode = el('mode').value, objective = el('objective').value.trim();
    if (!objective) { el('result').textContent = 'EROARE: obiectivul este obligatoriu.'; return; }
    el('result').textContent = 'RONOR procesează mandatul…';
    try {
      if (target === 'codex') {
        el('result').textContent = 'Codex este autoritatea independentă de verificare. Primește automat dovezile produse de OpenHands; nu acceptă instrucțiuni de implementare directă.';
        return;
      }
      if (target === 'langgraph' || mode !== 'delegate') {
        var planningObjective = mode === 'explain' ? 'READ-ONLY. Explain and plan without modifying files: ' + objective : objective;
        var plan = await api('/automation/plan', { method: 'POST', body: JSON.stringify({ objective: planningObjective }) });
        state.missionId = plan.mission_id;
        el('result').textContent = 'LANGGRAPH · PLAN ACCEPTAT\nMisiune: ' + plan.mission_id + '\n' + plan.assignments.map(function (a) { return '• ' + a.id + ': ' + a.instruction + ' [' + a.actions.join(', ') + ']'; }).join('\n');
        await refresh();
        return;
      }
      var delegated = await api('/executive/delegate', { method: 'POST', body: JSON.stringify({ objective: objective }) });
      state.missionId = delegated.delegation.mission_id;
      if (target === 'richard') {
        el('result').textContent = 'RICHARD · MANDAT CREAT\nMisiune: ' + state.missionId + '\nStatus: draft · fără trimitere externă';
        await refresh();
        return;
      }
      var key = 'control-' + (window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : String(Date.now()));
      var execution = await api('/automation/run', { method: 'POST', body: JSON.stringify({ approved: true, mission_id: state.missionId, idempotency_key: key }) });
      state.runId = execution.run.run_id;
      el('result').textContent = 'OPENHANDS · EXECUȚIE FINALIZATĂ\nMisiune: ' + state.missionId + '\nRun: ' + state.runId + '\nStatus: ' + execution.run.status + '\nCost: $' + execution.run.cost_usd;
      show('missions'); await loadMission(state.missionId); await refresh();
    } catch (err) { el('result').textContent = 'EROARE: ' + err.message; }
  });
  document.addEventListener('keydown', function (ev) { if (ev.ctrlKey && ev.key.toLowerCase() === 'k') { ev.preventDefault(); show('switchboard'); el('objective').focus(); } if (ev.key === 'Escape') el('objective').blur(); });
  if (state.key) { el('apiKey').value = state.key; refresh(); }
}());
