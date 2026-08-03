/*
  RONOR Operator Console — client
  ───────────────────────────────
  No framework, no build step. Every DOM insertion goes through `text()` or the
  `el()` helper, which set textContent rather than innerHTML.

  That choice is load-bearing rather than stylistic. This console renders content
  that ORIGINATED FROM MODELS AND FETCHED WEB PAGES: worker narratives, tool
  output, provider error messages, mission findings. Interpolating any of that into
  innerHTML would make the console a stored-XSS sink reachable by anyone who can
  get text into a model's output — which, for a runtime that fetches public URLs,
  is anyone with a web server. The one place markup is constructed from a template
  literal is `escapeHtml`-free by construction: it contains no interpolation.

  Prepared by AMB.
*/

(function () {
  'use strict';

  var API = '/api/runtime';
  var KEY_STORAGE = 'ronor.console.key';
  var REFRESH_MS = 15000;

  var state = {
    key: null,
    workOffset: 0,
    workLimit: 25,
    workTotal: null,
    activeTab: 'overview',
    timer: null,
  };

  // ── DOM helpers ──────────────────────────────────────────────────────────

  function $(id) {
    return document.getElementById(id);
  }

  function el(tag, className, textContent) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (textContent !== undefined && textContent !== null) {
      node.textContent = String(textContent);
    }
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function setText(id, value, className) {
    var node = $(id);
    if (!node) return;
    node.textContent = value === null || value === undefined ? '—' : String(value);
    if (className !== undefined) {
      node.className = 'value' + (className ? ' ' + className : '');
    }
  }

  function emptyRow(tbody, colspan, message) {
    var tr = el('tr');
    var td = el('td', 'empty', message);
    td.colSpan = colspan;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  function cell(tr, value, className) {
    var td = el('td', className, value === null || value === undefined ? '—' : value);
    tr.appendChild(td);
    return td;
  }

  function tagged(tr, label, tone) {
    var td = el('td');
    td.appendChild(el('span', 'tag tag-' + tone, label));
    tr.appendChild(td);
    return td;
  }

  // ── Formatting ───────────────────────────────────────────────────────────

  function usd(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    var v = Number(n);
    if (v === 0) return '$0.00';
    // Sub-cent spend is the normal case for a single request. Rounding it to two
    // decimals would display every individual request as $0.00 and make the
    // dashboard useless for exactly the figures it exists to show.
    if (Math.abs(v) < 0.01) return '$' + v.toFixed(6);
    if (Math.abs(v) < 1) return '$' + v.toFixed(4);
    return '$' + v.toFixed(2);
  }

  function ms(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    var v = Number(n);
    if (v < 1000) return Math.round(v) + ' ms';
    return (v / 1000).toFixed(2) + ' s';
  }

  function pct(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return (Number(n) * 100).toFixed(1) + '%';
  }

  function when(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleString();
  }

  function shortHash(h) {
    if (!h) return '—';
    return String(h).slice(0, 12) + '…';
  }

  function num(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return Number(n).toLocaleString();
  }

  // ── Transport ────────────────────────────────────────────────────────────

  function headers(withBody) {
    var h = {};
    if (withBody) h['Content-Type'] = 'application/json';
    if (state.key) h['Authorization'] = 'Bearer ' + state.key;
    return h;
  }

  /**
   * Fetch JSON and NEVER throw for an HTTP status.
   *
   * A non-2xx is returned as data with its status attached, because most of this
   * console's meaningful responses are non-2xx: 409 for a broken audit chain, 422
   * for a governance refusal, 503 for a degraded runtime. Treating those as
   * exceptions would discard the payload that explains what happened, which is the
   * only part an operator actually needs.
   */
  async function api(path, options) {
    var opts = options || {};
    try {
      var res = await fetch(API + path, {
        method: opts.method || 'GET',
        headers: headers(!!opts.body),
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      var payload = null;
      var text = await res.text();
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch (e) {
          payload = { ok: false, error: 'non_json_response', message: text.slice(0, 500) };
        }
      }
      return { status: res.status, ok: res.ok, data: payload || {} };
    } catch (err) {
      // A network-level failure is distinct from a rejected request and is
      // labelled as such, so an operator does not read a dropped connection as a
      // policy refusal.
      return {
        status: 0,
        ok: false,
        data: { ok: false, error: 'network_unreachable', message: String(err && err.message) },
      };
    }
  }

  // ── Auth ─────────────────────────────────────────────────────────────────

  function loadKey() {
    try {
      state.key = sessionStorage.getItem(KEY_STORAGE);
    } catch (e) {
      state.key = null;
    }
    if (state.key) $('apiKey').value = state.key;
    renderAuthBanner();
  }

  function saveKey() {
    var value = $('apiKey').value.trim();
    if (!value) return;
    state.key = value;
    try {
      // sessionStorage, not localStorage: a credential that survives the tab is a
      // credential left behind on a shared machine.
      sessionStorage.setItem(KEY_STORAGE, value);
    } catch (e) {
      /* Private-browsing mode. The key still works for this session in memory. */
    }
    renderAuthBanner();
    refreshAll();
  }

  function clearKey() {
    state.key = null;
    $('apiKey').value = '';
    try {
      sessionStorage.removeItem(KEY_STORAGE);
    } catch (e) {
      /* nothing to remove */
    }
    renderAuthBanner();
  }

  function renderAuthBanner() {
    var banner = $('authBanner');
    if (state.key) {
      banner.hidden = true;
      return;
    }
    banner.hidden = false;
    banner.textContent =
      'No operator API key set. Health is public, but every other panel will return 401 ' +
      'until you connect. Use a value from RONOR_API_KEYS.';
  }

  // ── Health and status ────────────────────────────────────────────────────

  async function refreshHealth() {
    var r = await api('/health');
    var d = r.data || {};
    var badge = $('badgeHealth');

    if (r.status === 0) {
      badge.textContent = 'runtime: unreachable';
      badge.className = 'badge bad';
      setText('kpiStatus', 'unreachable', 'bad');
      return;
    }

    // 503 with status=degraded is a legitimate, informative answer here: the
    // process is live but has no generative engine. Both facts are shown.
    var status = d.status || 'unknown';
    badge.textContent = 'runtime: ' + status;
    badge.className = 'badge ' + (status === 'ready' ? 'ok' : 'warn');
    setText('kpiStatus', status, status === 'ready' ? 'ok' : 'warn');

    if (d.providers) {
      var p = d.providers;
      $('badgeProviders').textContent =
        'providers: ' + p.generative_invocable + '/' + p.total + ' generative';
      $('badgeProviders').className =
        'badge ' + (p.generative_invocable > 0 ? 'ok' : 'warn');
      setText(
        'kpiProviders',
        p.generative_invocable + ' of ' + p.total,
        p.generative_invocable > 0 ? 'ok' : 'warn',
      );
    }

    if (d.policy_version) $('badgePolicy').textContent = 'policy: ' + d.policy_version;

    if (d.audit_chain) {
      $('badgeChain').textContent = 'chain: ' + shortHash(d.audit_chain.head_hash);
      setText('kpiAudit', num(d.audit_chain.records));
    }

    if (d.knowledge) {
      var k = d.knowledge;
      setText(
        'kpiKnowledge',
        k.enabled ? 'enabled (L' + (k.degradation_level === null ? '?' : k.degradation_level) + ')' : 'disabled',
        k.enabled && k.degradation_level === 0 ? 'ok' : k.enabled ? 'warn' : '',
      );
    }

    // Security findings render at the top of the page and are never collapsed.
    var sec = $('securityBanner');
    var findings = d.security_findings || [];
    if (findings.length) {
      sec.hidden = false;
      sec.textContent = 'SECURITY: ' + findings.join(' · ');
    } else {
      sec.hidden = true;
    }

    if (Array.isArray((d.providers || {}).detail)) {
      renderProviderSummary(d.providers.detail);
    }
  }

  function renderProviderSummary(detail) {
    var host = $('overviewProviders');
    clear(host);
    detail.forEach(function (p) {
      var item = el('div', 'item');
      var head = el('div', 'item-head');
      head.appendChild(el('span', 'item-title', p.provider));
      var live = p.state && p.state.indexOf('live') === 0;
      head.appendChild(el('span', 'tag tag-' + (live ? 'ok' : 'warn'), p.state));
      item.appendChild(head);
      item.appendChild(
        el(
          'div',
          'item-body',
          live
            ? 'Reachable via ' + p.transport + ' transport.'
            : 'Adapter implemented; no credential present, so nothing is routed here.',
        ),
      );
      host.appendChild(item);
    });
    if (!detail.length) host.appendChild(el('div', 'empty', 'No providers registered.'));
  }

  async function refreshStatus() {
    if (!state.key) return;
    var r = await api('/status');
    if (!r.ok) return;
    var d = r.data;
    if (d.economics) {
      setText('kpiRequests', num(d.economics.total_requests));
      setText('kpiSpend', usd(d.economics.total_cost_usd));
      setText(
        'kpiWaste',
        usd(d.economics.wasted_cost_usd),
        d.economics.wasted_cost_usd > 0 ? 'warn' : '',
      );
      setText('kpiFallback', pct(d.economics.fallback_rate));
    }
    if (Array.isArray(d.agents)) {
      var host = $('overviewAgents');
      clear(host);
      d.agents.forEach(function (a) {
        var item = el('div', 'item');
        var head = el('div', 'item-head');
        head.appendChild(el('span', 'item-title', a.name));
        head.appendChild(
          el('span', 'tag tag-' + (a.status === 'operational' ? 'ok' : 'warn'), a.status),
        );
        item.appendChild(head);
        item.appendChild(el('div', 'item-body', a.id));
        host.appendChild(item);
      });
    }
  }

  // ── Agents ───────────────────────────────────────────────────────────────

  async function refreshAgents() {
    if (!state.key) return;
    var r = await api('/agents');
    var host = $('agentCards');
    clear(host);
    if (!r.ok) {
      host.appendChild(el('div', 'empty', 'Unable to load agents (' + r.status + ').'));
      return;
    }
    (r.data.agents || []).forEach(function (a) {
      var card = el('div', 'card');
      var head = el('div', 'item-head');
      head.appendChild(el('span', 'item-title', a.name + ' · v' + a.version));
      head.appendChild(
        el('span', 'tag tag-' + (a.status === 'operational' ? 'ok' : 'warn'), a.status),
      );
      card.appendChild(head);
      card.appendChild(el('p', 'lede', a.mandate));

      var dl = el('dl', 'kv');
      function kv(k, v) {
        dl.appendChild(el('dt', null, k));
        dl.appendChild(el('dd', null, v));
      }
      kv('Agent id', a.agent_id);
      kv('Confidentiality ceiling', a.max_confidentiality);
      kv('Capabilities', (a.capabilities || []).join(', '));
      kv('Allowed tools', (a.allowed_tools || []).join(', ') || 'none');
      kv('Router task type', a.router_task_type);
      kv(
        'Evidence floor',
        a.required_evidence_level === null ? 'none' : String(a.required_evidence_level),
      );
      kv('Reasoning effort', a.reasoning_effort);
      kv('May lower confidence', a.may_lower_confidence ? 'yes' : 'no');
      kv('Preferred models', (a.preferred_models || []).join(', ') || '—');
      card.appendChild(dl);

      if (a.max_confidentiality !== 'sovereign') {
        card.appendChild(
          el(
            'p',
            'note',
            'Capped below sovereign because this worker performs or depends on outbound ' +
              'egress. A worker that reaches the network must not hold material that ' +
              'forbids reaching the network.',
          ),
        );
      }
      host.appendChild(card);
    });
  }

  // ── Providers and catalogue ──────────────────────────────────────────────

  async function refreshProviders() {
    if (!state.key) return;

    var pr = await api('/providers');
    var tbody = $('providerTable').querySelector('tbody');
    clear(tbody);
    if (!pr.ok) {
      emptyRow(tbody, 5, 'Unable to load providers (' + pr.status + ').');
    } else {
      var providers = pr.data.providers || [];
      if (!providers.length) emptyRow(tbody, 5, 'No providers registered.');
      providers.forEach(function (p) {
        var tr = el('tr');
        cell(tr, p.displayName || p.provider);
        tagged(tr, p.credentialState, p.invocable ? 'ok' : 'warn');
        cell(tr, p.transport);
        cell(tr, (p.models || []).length, 'num');
        cell(
          tr,
          p.invocable
            ? (p.searchAugmented ? 'search-augmented · ' : '') +
                'jurisdictions: ' +
                (p.jurisdictions || []).join(', ')
            : 'Adapter present, credential absent — activates when a key is set.',
        );
        tbody.appendChild(tr);
      });
    }

    var cr = await api('/catalogue');
    var ctbody = $('catalogueTable').querySelector('tbody');
    clear(ctbody);
    if (!cr.ok) {
      emptyRow(ctbody, 9, 'Unable to load catalogue (' + cr.status + ').');
      return;
    }
    var models = cr.data.models || [];
    if (!models.length) emptyRow(ctbody, 9, 'Catalogue is empty.');
    models.forEach(function (m) {
      var tr = el('tr');
      cell(tr, m.displayName || m.id).className = 'mono';
      cell(tr, m.provider);
      cell(tr, m.quality_score, 'num');
      cell(tr, ms(m.observed_latency_ms), 'num');
      // The basis of the latency figure is shown next to the figure itself. A
      // seeded estimate presented as a measurement would let an operator believe
      // the router had noticed a degradation it has no data about.
      tagged(tr, m.latency_observed ? 'observed' : 'catalogue', m.latency_observed ? 'ok' : 'neutral');
      cell(tr, m.samples > 0 ? pct(m.success_rate) : 'no data', 'num');
      cell(tr, num(m.samples), 'num');
      cell(tr, '$' + m.input_cost_per_1m + ' / $' + m.output_cost_per_1m, 'num');
      tagged(tr, m.invocable ? 'yes' : 'no', m.invocable ? 'ok' : 'warn');
      ctbody.appendChild(tr);
    });
  }

  // ── Cost ─────────────────────────────────────────────────────────────────

  async function refreshCost() {
    if (!state.key) return;
    var r = await api('/ledger/cost');
    if (!r.ok) return;
    var c = r.data.cost || {};

    setText('costTotal', usd(c.total_cost_usd));
    setText('costMeasured', usd(c.measured_cost_usd), 'ok');
    setText('costEstimated', usd(c.estimated_cost_usd), c.estimated_cost_usd > 0 ? 'warn' : '');
    setText('costWasted', usd(c.wasted_cost_usd), c.wasted_cost_usd > 0 ? 'warn' : '');
    setText('costAvg', usd(c.avg_cost_per_request_usd));
    setText('costLatency', ms(c.avg_latency_ms));

    var mt = $('costModelTable').querySelector('tbody');
    clear(mt);
    var byModel = c.by_model || [];
    if (!byModel.length) emptyRow(mt, 6, 'No attempts recorded yet.');
    byModel.forEach(function (m) {
      var tr = el('tr');
      cell(tr, m.model_id, 'mono');
      cell(tr, num(m.requests), 'num');
      cell(tr, usd(m.cost_usd), 'num');
      cell(tr, usd(m.estimated_cost_usd), 'num');
      cell(tr, ms(m.avg_latency_ms), 'num');
      var td = cell(tr, pct(m.success_rate), 'num');
      if (m.success_rate < 0.9) td.style.color = 'var(--error)';
      mt.appendChild(tr);
    });

    var pt = $('costProviderTable').querySelector('tbody');
    clear(pt);
    var byProvider = c.by_provider || [];
    if (!byProvider.length) emptyRow(pt, 4, 'No attempts recorded yet.');
    byProvider.forEach(function (p) {
      var tr = el('tr');
      cell(tr, p.provider);
      cell(tr, num(p.requests), 'num');
      cell(tr, usd(p.cost_usd), 'num');
      cell(tr, pct(p.success_rate), 'num');
      pt.appendChild(tr);
    });

    var vr = await api('/ledger/value');
    var host = $('valueSummary');
    clear(host);
    if (!vr.ok) {
      host.appendChild(el('div', 'empty', 'Unable to load value summary.'));
      return;
    }
    var v = vr.data.value || {};
    var dl = el('dl', 'kv');
    function kv(k, val) {
      dl.appendChild(el('dt', null, k));
      dl.appendChild(el('dd', null, val));
    }
    kv('Requests valued', num(v.requests_valued));
    kv('Actual spend', usd(v.total_cost_usd));
    kv('Premium-path cost', usd(v.total_premium_cost_usd));
    kv('Cost avoided by routing', usd(v.total_cost_avoided_usd));
    kv('Avg quality delta', v.avg_quality_delta === null ? '—' : Number(v.avg_quality_delta).toFixed(2));
    kv(
      'Avg verified confidence',
      v.avg_verified_confidence === null ? 'not yet verified' : Number(v.avg_verified_confidence).toFixed(1),
    );
    kv('Declared value', usd(v.declared_value_usd));
    kv('Value multiple', v.value_multiple === null ? 'undeclared' : Number(v.value_multiple).toFixed(2) + '×');
    host.appendChild(dl);

    if (v.avg_quality_delta < 0) {
      host.appendChild(
        el(
          'p',
          'note',
          'Average quality delta is negative: routing bought cheaper answers than the ' +
            'premium path would have produced. Shown plainly, because a saving that ' +
            'degraded every answer is not a saving an operator would have authorised ' +
            'had they been shown the trade.',
        ),
      );
    }
  }

  // ── Work ledger ──────────────────────────────────────────────────────────

  async function refreshWork() {
    if (!state.key) return;
    var r = await api('/ledger/work?limit=' + state.workLimit + '&offset=' + state.workOffset);
    var tbody = $('workTable').querySelector('tbody');
    clear(tbody);
    if (!r.ok) {
      emptyRow(tbody, 10, 'Unable to load the work ledger (' + r.status + ').');
      return;
    }
    var rows = r.data.work || [];
    $('workTotal').textContent =
      'Showing ' +
      (rows.length ? state.workOffset + 1 : 0) +
      '–' +
      (state.workOffset + rows.length);
    if (!rows.length) {
      emptyRow(tbody, 10, 'No work recorded yet. Submit a query to populate the ledger.');
    }
    rows.forEach(function (w) {
      var tr = el('tr', 'clickable');
      cell(tr, when(w.created_at));
      cell(tr, w.request_id, 'mono');
      cell(tr, w.surface);
      cell(tr, w.agent_id || '—');
      var tone =
        w.status === 'completed'
          ? 'ok'
          : w.status === 'completed-after-fallback'
            ? 'warn'
            : 'bad';
      tagged(tr, w.status, tone);
      cell(tr, w.chosen_model_id || '—', 'mono');
      cell(tr, num(w.input_tokens) + ' / ' + num(w.output_tokens), 'num');
      cell(tr, usd(w.cost_usd), 'num');
      cell(tr, ms(w.latency_ms), 'num');
      cell(tr, w.mi9_verdict || '—');
      tr.addEventListener('click', function () {
        showWorkDetail(w.request_id);
      });
      tbody.appendChild(tr);
    });

    $('workPrevBtn').disabled = state.workOffset === 0;
    $('workNextBtn').disabled = rows.length < state.workLimit;
  }

  async function showWorkDetail(requestId) {
    var host = $('workDetail');
    var r = await api('/ledger/work/' + encodeURIComponent(requestId));
    clear(host);
    host.hidden = false;
    var card = el('div', 'card');
    card.appendChild(el('h3', null, 'Request ' + requestId));

    if (!r.ok) {
      card.appendChild(el('div', 'empty', 'Unable to load request detail (' + r.status + ').'));
      host.appendChild(card);
      return;
    }

    var w = r.data.work || {};
    var dl = el('dl', 'kv');
    function kv(k, v) {
      dl.appendChild(el('dt', null, k));
      dl.appendChild(el('dd', null, v));
    }
    kv('Status', w.status);
    kv('Surface', w.surface);
    kv('Task type', w.task_type);
    kv('Confidentiality', w.confidentiality);
    kv('Agent', w.agent_id || '—');
    kv('Mission', w.mission_id || '—');
    kv('Model', w.chosen_model_id || '—');
    kv('Transport', w.transport || '—');
    kv('Tokens', num(w.input_tokens) + ' in / ' + num(w.output_tokens) + ' out');
    kv('Usage basis', w.usage_estimated ? 'estimated from characters' : 'vendor-reported');
    kv('Cost', usd(w.cost_usd));
    kv('Latency', ms(w.latency_ms));
    kv('Attempts', num(w.attempts));
    kv('Fallback used', w.fallback_used ? 'yes' : 'no');
    kv('Citations', num(w.citations_count));
    kv('MI9 verdict', w.mi9_verdict || '—');
    kv('Prompt digest', w.prompt_digest || '—');
    kv('Audit trace', w.trace_hash ? shortHash(w.trace_hash) : '—');
    card.appendChild(dl);

    card.appendChild(
      el(
        'p',
        'note',
        'The prompt itself is not stored. The digest above proves two requests were ' +
          'identical without the ledger holding their content.',
      ),
    );

    var attempts = r.data.attempts || [];
    card.appendChild(el('h3', null, 'Provider attempts (' + attempts.length + ')'));
    if (!attempts.length) {
      card.appendChild(el('div', 'empty', 'No provider attempts — this request never reached an engine.'));
    } else {
      var wrap = el('div', 'table-wrap');
      var table = el('table');
      var thead = el('thead');
      var htr = el('tr');
      ['#', 'Model', 'Outcome', 'Latency', 'Tokens', 'Cost', 'Failure', 'Why this engine'].forEach(
        function (h) {
          htr.appendChild(el('th', null, h));
        },
      );
      thead.appendChild(htr);
      table.appendChild(thead);
      var tb = el('tbody');
      attempts.forEach(function (a) {
        var tr = el('tr');
        cell(tr, a.attempt_no, 'num');
        cell(tr, a.model_id, 'mono');
        tagged(tr, a.ok ? 'ok' : 'failed', a.ok ? 'ok' : 'bad');
        cell(tr, ms(a.latency_ms), 'num');
        cell(tr, num(a.input_tokens) + ' / ' + num(a.output_tokens), 'num');
        cell(tr, usd(a.cost_usd), 'num');
        cell(tr, a.failure_kind ? a.failure_kind + ': ' + (a.failure_message || '') : '—');
        cell(tr, a.fallback_reason || 'primary selection');
        tb.appendChild(tr);
      });
      table.appendChild(tb);
      wrap.appendChild(table);
      card.appendChild(wrap);
      card.appendChild(
        el(
          'p',
          'note',
          'Failed attempts carry real cost and are listed with it. A ledger that showed ' +
            'only the winning engine would make a failing provider look free.',
        ),
      );
    }
    host.appendChild(card);
    host.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ── Audit ────────────────────────────────────────────────────────────────

  async function refreshAudit() {
    if (!state.key) return;
    var r = await api('/audit?limit=50');
    var tbody = $('auditTable').querySelector('tbody');
    clear(tbody);
    if (!r.ok) {
      emptyRow(tbody, 7, 'Unable to load audit records (' + r.status + ').');
      return;
    }
    var records = r.data.records || [];
    if (!records.length) emptyRow(tbody, 7, 'The audit chain holds no records yet.');
    records.forEach(function (rec) {
      var payload = rec.payload || {};
      var mi9 = payload.mi9Result || {};
      var outcome = payload.outcome || {};
      var tr = el('tr');
      cell(tr, rec.seq, 'num');
      cell(tr, when(rec.timestamp));
      cell(tr, payload.decisionId, 'mono');
      cell(tr, payload.decisionType);
      var tone =
        mi9.verdict === 'allow' ? 'ok' : mi9.verdict === 'block' ? 'bad' : 'warn';
      tagged(tr, mi9.verdict || '—', tone);
      cell(tr, outcome.action || '—');
      cell(tr, shortHash(rec.chainHash), 'mono');
      tbody.appendChild(tr);
    });
  }

  async function verifyChain() {
    var host = $('chainVerdict');
    clear(host);
    host.appendChild(el('div', 'hint', 'Verifying…'));
    var r = await api('/audit/verify');
    clear(host);

    // The endpoint answers 409 on a broken chain. That is not a failed request:
    // it is a successful verification with a bad result, and it must be rendered
    // as a finding rather than swallowed as an error.
    if (r.status === 0) {
      host.appendChild(el('div', 'empty', 'Runtime unreachable — verification not performed.'));
      return;
    }
    if (r.status === 401 || r.status === 403) {
      host.appendChild(el('div', 'empty', 'Not authorised to verify the chain.'));
      return;
    }

    var v = (r.data && r.data.verification) || {};
    var intact = r.status === 200 && v.ok === true;

    var item = el('div', 'item');
    var head = el('div', 'item-head');
    head.appendChild(el('span', 'item-title', intact ? 'Chain intact' : 'CHAIN BROKEN'));
    head.appendChild(el('span', 'tag tag-' + (intact ? 'ok' : 'bad'), intact ? 'verified' : 'tampered'));
    item.appendChild(head);

    var dl = el('dl', 'kv');
    function kv(k, val) {
      dl.appendChild(el('dt', null, k));
      dl.appendChild(el('dd', null, val));
    }
    kv('Records verified', num(v.totalRecords));
    kv('Head hash', v.headHash || '—');
    kv('Verified at', when(v.verifiedAt));
    if (!intact) {
      kv('Broken at sequence', v.brokenAtSeq === undefined ? '—' : String(v.brokenAtSeq));
      kv('Reason', v.brokenReason || 'unspecified');
    }
    item.appendChild(dl);
    host.appendChild(item);

    $('badgeChain').textContent = 'chain: ' + (intact ? shortHash(v.headHash) : 'BROKEN');
    $('badgeChain').className = 'badge chain ' + (intact ? 'ok' : 'bad');

    if (!intact) {
      host.appendChild(
        el(
          'p',
          'note',
          'A broken chain means a stored record no longer hashes to its committed value. ' +
            'Treat every downstream figure as unverified until the cause is established.',
        ),
      );
    }
  }

  // ── Query ────────────────────────────────────────────────────────────────

  async function submitQuery() {
    var text = $('queryText').value.trim();
    if (!text) {
      $('queryStatus').textContent = 'Enter a query first.';
      return;
    }
    var btn = $('queryBtn');
    btn.disabled = true;
    $('queryStatus').textContent = 'Routing…';

    var body = {
      query: text,
      confidentiality_level: $('queryConfidentiality').value,
      use_knowledge: $('queryKnowledge').checked,
      dry_run: $('queryDryRun').checked,
    };
    var j = $('queryJurisdiction').value;
    if (j && j !== 'any') body.jurisdiction_pin = j;
    var t = $('queryTaskType').value;
    if (t) body.task_type = t;

    var r = await api('/query', { method: 'POST', body: body });
    btn.disabled = false;
    $('queryStatus').textContent = 'HTTP ' + r.status;
    renderQueryResult(r);
  }

  function renderQueryResult(r) {
    var host = $('queryResult');
    clear(host);
    host.hidden = false;
    var d = r.data || {};

    if (r.status === 0) {
      host.appendChild(el('div', 'card')).appendChild(
        el('div', 'empty', 'Runtime unreachable.'),
      );
      return;
    }
    if (r.status === 401 || r.status === 403) {
      var authCard = el('div', 'card');
      authCard.appendChild(el('h3', null, 'Not authorised'));
      authCard.appendChild(
        el(
          'div',
          'item-body',
          (d.message || 'Connect with a key holding the required scope.') +
            (d.required_scope ? ' Required scope: ' + d.required_scope + '.' : ''),
        ),
      );
      host.appendChild(authCard);
      return;
    }
    if (r.status === 429) {
      var rl = el('div', 'card');
      rl.appendChild(el('h3', null, 'Rate limited'));
      rl.appendChild(
        el(
          'div',
          'item-body',
          'Retry in ' + (d.retry_after_seconds || '?') + ' s. This limit is per instance.',
        ),
      );
      host.appendChild(rl);
      return;
    }

    // ---- Answer or refusal ----
    var main = el('div', 'card');
    var head = el('div', 'item-head');
    head.appendChild(el('span', 'item-title', d.ok ? 'Answer' : 'Refused'));
    head.appendChild(el('span', 'tag tag-' + (d.ok ? 'ok' : 'bad'), d.status || 'unknown'));
    main.appendChild(head);

    if (d.ok && d.answer) {
      main.appendChild(el('div', 'answer', d.answer));
    } else {
      main.appendChild(
        el('div', 'answer', d.rejection_reason || d.message || 'No answer was produced.'),
      );
    }

    if (d.citations && d.citations.length) {
      main.appendChild(el('h3', null, 'Citations (' + d.citations.length + ')'));
      var ul = el('ul', 'plain');
      d.citations.forEach(function (c) {
        var li = el('li');
        li.appendChild(el('span', null, c.title || 'untitled'));
        if (c.url) {
          li.appendChild(document.createTextNode(' — '));
          var a = el('a', null, c.url);
          a.href = c.url;
          a.rel = 'noreferrer noopener';
          a.target = '_blank';
          li.appendChild(a);
        }
        ul.appendChild(li);
      });
      main.appendChild(ul);
    }
    host.appendChild(main);

    // ---- Economics, classification, governance, knowledge ----
    var grid = el('div', 'two-col');

    var econ = el('div', 'card');
    econ.appendChild(el('h3', null, 'Economics'));
    var edl = el('dl', 'kv');
    function ekv(k, v) {
      edl.appendChild(el('dt', null, k));
      edl.appendChild(el('dd', null, v));
    }
    var e = d.economics || {};
    ekv('Cost', usd(e.cost_usd));
    ekv('Tokens', num(e.input_tokens) + ' in / ' + num(e.output_tokens) + ' out');
    ekv('Usage basis', e.usage_estimated ? 'estimated from characters' : 'vendor-reported');
    ekv('Latency', ms(e.latency_ms));
    ekv('Premium-path cost', usd(e.premium_cost_usd));
    ekv('Cost avoided', usd(e.cost_avoided_usd));
    econ.appendChild(edl);
    grid.appendChild(econ);

    var gov = el('div', 'card');
    gov.appendChild(el('h3', null, 'Governance · MI9'));
    var g = d.governance || {};
    var ghead = el('div', 'item-head');
    ghead.appendChild(el('span', 'item-title', 'Verdict'));
    ghead.appendChild(
      el(
        'span',
        'tag tag-' + (g.verdict === 'allow' ? 'ok' : g.verdict === 'block' ? 'bad' : 'warn'),
        g.verdict || '—',
      ),
    );
    gov.appendChild(ghead);
    if (g.human_cosign_required) {
      gov.appendChild(el('div', 'item-body', 'Human co-signature required before action.'));
    }
    if (g.block_reason) {
      gov.appendChild(el('div', 'item-body', 'Block reason: ' + g.block_reason));
    }
    if (g.findings && g.findings.length) {
      var gul = el('ul', 'plain');
      g.findings.forEach(function (f) {
        gul.appendChild(
          el('li', null, 'Gate ' + f.gate + ' ' + f.name + ' — ' + f.verdict + ': ' + f.reason),
        );
      });
      gov.appendChild(gul);
    }
    grid.appendChild(gov);

    var cls = el('div', 'card');
    cls.appendChild(el('h3', null, 'Classification'));
    var c = d.classification || {};
    var cdl = el('dl', 'kv');
    function ckv(k, v) {
      cdl.appendChild(el('dt', null, k));
      cdl.appendChild(el('dd', null, v));
    }
    ckv('Task type', c.task_type);
    ckv('Basis', c.explicit ? 'stated by caller' : 'inferred by classifier');
    ckv('Complexity', c.complexity);
    ckv('Requires search', c.requires_search ? 'yes' : 'no');
    ckv('Requires decomposition', c.requires_decomposition ? 'yes' : 'no');
    ckv('Reasoning effort', c.reasoning_effort);
    ckv('Signals', (c.signals || []).join(', ') || '—');
    cls.appendChild(cdl);
    grid.appendChild(cls);

    var kn = el('div', 'card');
    kn.appendChild(el('h3', null, 'Knowledge grounding'));
    var k = d.knowledge || {};
    var kdl = el('dl', 'kv');
    function kkv(kk, v) {
      kdl.appendChild(el('dt', null, kk));
      kdl.appendChild(el('dd', null, v));
    }
    kkv('Used', k.used ? 'yes' : 'no');
    kkv('Available', k.available ? 'yes' : 'no');
    kkv('Results retrieved', num(k.results));
    kkv('Degradation level', k.degradation === null ? '—' : String(k.degradation));
    kkv('Reason', k.reason || '—');
    kn.appendChild(kdl);
    if (!k.used) {
      kn.appendChild(
        el(
          'p',
          'note',
          'An empty retrieval is reported explicitly rather than silently falling back to ' +
            'model memory. Knowing an answer was ungrounded is the point.',
        ),
      );
    }
    grid.appendChild(kn);
    host.appendChild(grid);

    // ---- Routing table ----
    var routing = d.routing || {};
    var rt = el('div', 'card');
    rt.appendChild(
      el(
        'h3',
        null,
        'Routing · ' + (routing.chosen_model_id || 'no engine selected') +
          (routing.fallback_used ? ' (after fallback)' : ''),
      ),
    );
    var table = routing.table || [];
    if (!table.length) {
      rt.appendChild(el('div', 'empty', 'No candidate was scored.'));
    } else {
      var wrap = el('div', 'table-wrap');
      var t = el('table');
      var th = el('thead');
      var htr = el('tr');
      ['Model', 'Score', 'Quality', 'Cost', 'Latency', 'Risk', 'Sovereignty', 'Evidence', 'Est. cost', 'Basis'].forEach(
        function (h) {
          htr.appendChild(el('th', null, h));
        },
      );
      th.appendChild(htr);
      t.appendChild(th);
      var tb = el('tbody');
      table.forEach(function (row, i) {
        var tr = el('tr');
        var nameTd = cell(tr, row.model_id, 'mono');
        if (i === 0) nameTd.style.fontWeight = '700';
        cell(tr, Number(row.total).toFixed(4), 'num');
        var w = row.weighted || {};
        cell(tr, Number(w.quality || 0).toFixed(3), 'num');
        cell(tr, Number(w.cost || 0).toFixed(3), 'num');
        cell(tr, Number(w.latency || 0).toFixed(3), 'num');
        cell(tr, Number(w.operational_risk || 0).toFixed(3), 'num');
        cell(tr, Number(w.sovereignty || 0).toFixed(3), 'num');
        cell(tr, Number(w.evidence || 0).toFixed(3), 'num');
        cell(tr, usd(row.estimated_cost_usd), 'num');
        tagged(tr, row.latency_observed ? 'observed' : 'seeded', row.latency_observed ? 'ok' : 'neutral');
        tb.appendChild(tr);
      });
      t.appendChild(tb);
      wrap.appendChild(t);
      rt.appendChild(wrap);
      rt.appendChild(
        el(
          'p',
          'note',
          'Six weighted dimensions. Quality is discounted by measured success rate, so a ' +
            'degrading engine loses traffic without anyone editing a config.',
        ),
      );
    }

    var evals = routing.policy_evaluations || [];
    if (evals.length) {
      rt.appendChild(el('h3', null, 'Policy filter'));
      var pul = el('ul', 'plain');
      evals.forEach(function (ev) {
        var line = ev.rule + ' — ' + ev.description + ': ' + ev.passed.length + ' passed';
        if (ev.excluded.length) line += ', excluded ' + ev.excluded.join(', ');
        pul.appendChild(el('li', null, line));
      });
      rt.appendChild(pul);
    }

    var attempts = routing.attempts || [];
    if (attempts.length) {
      rt.appendChild(el('h3', null, 'Attempts'));
      var aul = el('ul', 'plain');
      attempts.forEach(function (a) {
        var line =
          '#' + a.attempt + ' ' + a.model_id + ' via ' + a.transport + ' — ' +
          (a.ok ? 'ok' : 'FAILED') + ' in ' + ms(a.latency_ms) + ', ' + usd(a.cost_usd);
        if (a.failure_kind) line += ' (' + a.failure_kind + ': ' + (a.failure_message || '') + ')';
        if (a.fallback_reason) line += ' — routed here because: ' + a.fallback_reason;
        aul.appendChild(el('li', null, line));
      });
      rt.appendChild(aul);
    }
    host.appendChild(rt);

    // ---- Provenance ----
    var prov = d.provenance || {};
    var pc = el('div', 'card');
    pc.appendChild(el('h3', null, 'Provenance'));
    var pdl = el('dl', 'kv');
    function pkv(k, v) {
      pdl.appendChild(el('dt', null, k));
      pdl.appendChild(el('dd', null, v));
    }
    pkv('Request id', prov.request_id || d.request_id);
    pkv('Received at', when(prov.received_at));
    pkv('Sanitisation verdict', prov.sanitisation_verdict || '—');
    pkv('Sanitisation findings', (prov.sanitisation_findings || []).join(', ') || 'none');
    pkv('Audit record', prov.audit_record_id || '—');
    pkv('Audit chain hash', prov.audit_chain_hash ? shortHash(prov.audit_chain_hash) : '—');
    pc.appendChild(pdl);
    host.appendChild(pc);

    host.scrollIntoView({ behavior: 'smooth', block: 'start' });
    refreshHealth();
    refreshStatus();
  }

  // ── Missions ─────────────────────────────────────────────────────────────

  async function dispatchMission() {
    var objective = $('missionObjective').value.trim();
    if (!objective) {
      $('missionStatus').textContent = 'State an objective first.';
      return;
    }
    var btn = $('missionBtn');
    btn.disabled = true;
    $('missionStatus').textContent = 'Decomposing and executing — this takes a while…';

    var body = {
      objective: objective,
      confidentiality_level: $('missionConfidentiality').value,
      max_tasks: Number($('missionMaxTasks').value) || 3,
      require_evidence: $('missionEvidence').checked,
    };
    var budget = Number($('missionBudget').value);
    if (budget > 0) body.max_cost_usd = budget;

    var r = await api('/agents/dispatch', { method: 'POST', body: body });
    btn.disabled = false;
    $('missionStatus').textContent = 'HTTP ' + r.status;
    renderMissionResult(r);
    refreshMissionList();
  }

  function renderMissionResult(r) {
    var host = $('missionResult');
    clear(host);
    host.hidden = false;
    var d = r.data || {};

    if (r.status === 401 || r.status === 403) {
      var c = el('div', 'card');
      c.appendChild(el('h3', null, 'Not authorised'));
      c.appendChild(
        el(
          'div',
          'item-body',
          (d.message || 'A key with the agent scope is required.') +
            (d.required_scope ? ' Required scope: ' + d.required_scope + '.' : ''),
        ),
      );
      host.appendChild(c);
      return;
    }

    var main = el('div', 'card');
    var head = el('div', 'item-head');
    head.appendChild(el('span', 'item-title', 'Mission ' + (d.mission_id || '')));
    var tone =
      d.status === 'complete' ? 'ok' : d.status === 'partial' ? 'warn' : 'bad';
    head.appendChild(el('span', 'tag tag-' + tone, d.status || 'unknown'));
    main.appendChild(head);

    if (d.reason) main.appendChild(el('div', 'item-body', d.reason));
    if (d.synthesis) main.appendChild(el('div', 'answer', d.synthesis));

    var conf = el('div', 'item-head');
    conf.appendChild(
      el('span', 'item-title', 'Confidence: ' + (d.confidence === undefined ? '—' : d.confidence)),
    );
    conf.appendChild(el('span', 'tag tag-neutral', 'source: ' + (d.confidence_source || 'none')));
    main.appendChild(conf);
    if (d.confidence_source === 'weakest-worker') {
      main.appendChild(
        el(
          'p',
          'note',
          'No Curator verified this mission, so the confidence shown is the WEAKEST ' +
            'contributing worker\u2019s rather than an average. Averaging would let one ' +
            'confident worker mask another\u2019s uncertainty.',
        ),
      );
    }
    host.appendChild(main);

    if (d.findings && d.findings.length) {
      var fc = el('div', 'card');
      fc.appendChild(el('h3', null, 'Findings (' + d.findings.length + ')'));
      d.findings.forEach(function (f) {
        var item = el('div', 'item');
        var ih = el('div', 'item-head');
        ih.appendChild(el('span', 'item-title', 'support ' + f.support));
        var unsupported = !f.sources || f.sources.length === 0;
        ih.appendChild(
          el(
            'span',
            'tag tag-' + (unsupported ? 'bad' : 'ok'),
            unsupported ? 'UNSOURCED' : f.sources.length + ' source(s)',
          ),
        );
        item.appendChild(ih);
        item.appendChild(el('div', 'item-body', f.statement));
        if (!unsupported) {
          item.appendChild(el('div', 'item-body mono', f.sources.join(' · ')));
        }
        fc.appendChild(item);
      });
      fc.appendChild(
        el(
          'p',
          'note',
          'A finding with no sources is labelled UNSOURCED rather than omitted. Removing it ' +
            'would hide that a worker asserted something it could not attribute.',
        ),
      );
      host.appendChild(fc);
    }

    if (d.gaps && d.gaps.length) {
      var gc = el('div', 'card');
      gc.appendChild(el('h3', null, 'Declared gaps (' + d.gaps.length + ')'));
      var gul = el('ul', 'plain');
      d.gaps.forEach(function (g) {
        gul.appendChild(el('li', null, g));
      });
      gc.appendChild(gul);
      gc.appendChild(
        el('p', 'note', 'What the mission could NOT establish, stated rather than omitted.'),
      );
      host.appendChild(gc);
    }

    var plan = d.plan || {};
    var pc = el('div', 'card');
    pc.appendChild(
      el('h3', null, 'Plan · ' + (plan.fallback_used ? 'deterministic fallback' : 'model-generated')),
    );
    if (plan.planner_model) {
      pc.appendChild(el('div', 'item-body', 'Planner: ' + plan.planner_model));
    }
    if (plan.reason) pc.appendChild(el('div', 'item-body', plan.reason));
    if (plan.repairs && plan.repairs.length) {
      pc.appendChild(el('h3', null, 'Plan repairs applied'));
      var rul = el('ul', 'plain');
      plan.repairs.forEach(function (rep) {
        rul.appendChild(el('li', null, rep));
      });
      pc.appendChild(rul);
      pc.appendChild(
        el(
          'p',
          'note',
          'The planner\u2019s output is validated, not trusted: unknown agents are dropped, ' +
            'dangling dependencies removed, and cycles BROKEN rather than merely detected. ' +
            'A coordinator that waits forever on a cyclic plan cannot be recovered by an operator.',
        ),
      );
    }

    var tasks = d.tasks || [];
    if (tasks.length) {
      var wrap = el('div', 'table-wrap');
      var t = el('table');
      var th = el('thead');
      var htr = el('tr');
      ['Task', 'Agent', 'Outcome', 'Model', 'Confidence', 'Findings', 'Cost', 'Latency', 'Tools', 'Note'].forEach(
        function (h) {
          htr.appendChild(el('th', null, h));
        },
      );
      th.appendChild(htr);
      t.appendChild(th);
      var tb = el('tbody');
      tasks.forEach(function (task) {
        var tr = el('tr');
        cell(tr, task.task_id, 'mono');
        cell(tr, task.agent_id);
        tagged(tr, task.ok ? 'ok' : 'failed', task.ok ? 'ok' : 'bad');
        cell(tr, task.model_id || '—', 'mono');
        cell(tr, task.confidence, 'num');
        cell(tr, task.findings, 'num');
        cell(tr, usd(task.cost_usd), 'num');
        cell(tr, ms(task.latency_ms), 'num');
        var tools = (task.tools_used || [])
          .map(function (x) {
            return x.tool + (x.ok ? '' : ' (failed)');
          })
          .join(', ');
        cell(tr, tools || '—');
        var note = task.error || (task.structure_degraded ? 'structure degraded' : '');
        cell(tr, note || '—');
        tb.appendChild(tr);
      });
      t.appendChild(tb);
      wrap.appendChild(t);
      pc.appendChild(wrap);
    }
    host.appendChild(pc);

    var ec = el('div', 'card');
    ec.appendChild(el('h3', null, 'Mission economics'));
    var e = d.economics || {};
    var edl = el('dl', 'kv');
    function ekv(k, v) {
      edl.appendChild(el('dt', null, k));
      edl.appendChild(el('dd', null, v));
    }
    ekv('Total cost', usd(e.total_cost_usd));
    ekv('Budget', e.budget_usd === null || e.budget_usd === undefined ? 'none set' : usd(e.budget_usd));
    ekv('Budget exhausted', e.budget_exhausted ? 'YES — mission halted early' : 'no');
    ekv('Tasks executed', num(e.tasks_executed) + ' of ' + num(e.tasks_planned));
    ekv('Total latency', ms(e.total_latency_ms));
    ec.appendChild(edl);
    if (e.budget_exhausted) {
      ec.appendChild(
        el(
          'p',
          'note',
          'The ceiling was reached between tasks, so the mission halted and returned partial ' +
            'results marked as partial. Completing silently over budget would be the worse failure.',
        ),
      );
    }
    host.appendChild(ec);

    var g2 = d.governance || {};
    var gc2 = el('div', 'card');
    gc2.appendChild(el('h3', null, 'Governance'));
    var gdl = el('dl', 'kv');
    function gkv(k, v) {
      gdl.appendChild(el('dt', null, k));
      gdl.appendChild(el('dd', null, v));
    }
    gkv('Verdict', g2.verdict || '—');
    gkv('Human co-sign required', g2.human_cosign_required ? 'yes' : 'no');
    gkv('Block reason', g2.block_reason || '—');
    gkv('Audit record', g2.audit_record_id || '—');
    gkv('Chain hash', g2.audit_chain_hash ? shortHash(g2.audit_chain_hash) : '—');
    gc2.appendChild(gdl);
    host.appendChild(gc2);

    host.scrollIntoView({ behavior: 'smooth', block: 'start' });
    refreshStatus();
  }

  async function refreshMissionList() {
    if (!state.key) return;
    var r = await api('/missions?limit=25');
    var host = $('missionList');
    clear(host);
    if (!r.ok) {
      host.appendChild(el('div', 'empty', 'Unable to load missions (' + r.status + ').'));
      return;
    }
    var missions = r.data.missions || [];
    if (!missions.length) {
      host.appendChild(el('div', 'empty', 'No missions yet.'));
      return;
    }
    missions.forEach(function (m) {
      var item = el('div', 'item');
      var head = el('div', 'item-head');
      head.appendChild(el('span', 'item-title', m.title));
      var tone =
        m.status === 'complete' ? 'ok' : m.status === 'failed' ? 'bad' : 'neutral';
      head.appendChild(el('span', 'tag tag-' + tone, m.status));
      item.appendChild(head);
      item.appendChild(el('div', 'item-body', m.objective));
      item.appendChild(
        el(
          'div',
          'item-body mono',
          m.mission_id +
            ' · ' +
            num(m.requests_count) +
            ' request(s) · ' +
            usd(m.cost_usd) +
            ' · ' +
            when(m.updated_at),
        ),
      );
      var findings = (m.state && m.state.findings) || [];
      if (findings.length) {
        item.appendChild(el('div', 'item-body', findings.length + ' finding(s) accumulated'));
      }
      host.appendChild(item);
    });
  }

  // ── Tabs and refresh orchestration ───────────────────────────────────────

  function activateTab(name) {
    state.activeTab = name;
    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i += 1) {
      tabs[i].classList.toggle('active', tabs[i].getAttribute('data-tab') === name);
    }
    var panels = document.querySelectorAll('[data-panel]');
    for (var j = 0; j < panels.length; j += 1) {
      panels[j].hidden = panels[j].getAttribute('data-panel') !== name;
    }
    refreshActive();
  }

  /**
   * Refresh only the visible panel.
   *
   * Polling every endpoint on a timer would put steady load on the runtime whose
   * cost this console exists to report — the observer inflating the figure it
   * observes.
   */
  function refreshActive() {
    switch (state.activeTab) {
      case 'overview':
        refreshHealth();
        refreshStatus();
        break;
      case 'agents':
        refreshAgents();
        break;
      case 'providers':
        refreshProviders();
        break;
      case 'cost':
        refreshCost();
        break;
      case 'work':
        refreshWork();
        break;
      case 'audit':
        refreshAudit();
        break;
      case 'missions':
        refreshMissionList();
        break;
      default:
        break;
    }
  }

  function refreshAll() {
    refreshHealth();
    refreshActive();
  }

  // ── Wiring ───────────────────────────────────────────────────────────────

  function init() {
    loadKey();

    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i += 1) {
      tabs[i].addEventListener('click', function (ev) {
        activateTab(ev.currentTarget.getAttribute('data-tab'));
      });
    }

    $('saveKeyBtn').addEventListener('click', saveKey);
    $('clearKeyBtn').addEventListener('click', clearKey);
    $('apiKey').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') saveKey();
    });

    $('queryBtn').addEventListener('click', submitQuery);
    $('missionBtn').addEventListener('click', dispatchMission);
    $('verifyChainBtn').addEventListener('click', verifyChain);

    $('workPrevBtn').addEventListener('click', function () {
      state.workOffset = Math.max(0, state.workOffset - state.workLimit);
      refreshWork();
    });
    $('workNextBtn').addEventListener('click', function () {
      state.workOffset += state.workLimit;
      refreshWork();
    });

    refreshAll();

    state.timer = setInterval(function () {
      // Health only on the timer; the active panel refreshes with it so an
      // operator watching one screen sees it stay current without every other
      // endpoint being polled.
      refreshHealth();
      if (state.activeTab === 'overview') refreshStatus();
    }, REFRESH_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
