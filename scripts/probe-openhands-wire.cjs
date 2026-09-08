// Operator-only diagnostic: the receiver has NO forwarding implementation.
// Never log headers, credentials, prompts, tool arguments or raw error detail.
const http = require('node:http');
const mode = process.argv[2];
if (mode === 'receiver') {
  const { reserveModelRequest } = require('/app/dist/runtime/automation/model-budget.js');
  http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404).end(); return;
    }
    const chunks = []; let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 256 * 1024) { res.writeHead(413).end(); return; }
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    try {
      const p = JSON.parse(body);
      let validation;
      try {
        const result = reserveModelRequest(req.url, body);
        validation = { accepted: true, input_bound: result.inputBound,
          reserve_micro_usd: result.reserveMicroUsd };
      } catch (e) {
        validation = { accepted: false, code: /^budget_[a-z_]+$/.test(e.message) ? e.message : 'unknown' };
      }
      console.log(JSON.stringify({ checked_at: new Date().toISOString(), bytes,
        path: req.url, root_keys: Object.keys(p), model: p.model,
        tools: p.tools?.length ?? 0, validation,
        messages: (p.messages ?? []).map((m, i) => ({
          index: i, role: m.role, keys: Object.keys(m),
          content_type: m.content === undefined ? 'missing' : m.content === null ? 'null'
            : Array.isArray(m.content) ? 'array' : typeof m.content,
          content_blocks: Array.isArray(m.content) ? m.content.map(c => ({ type: c.type, keys: Object.keys(c) })) : [],
          tool_calls: m.tool_calls?.map(t => ({ keys: Object.keys(t), type: t.type,
            function_keys: Object.keys(t.function ?? {}) })) ?? [],
        })), upstream_requests: 0 }));
    } catch { console.log('{"error":"wire_shape_invalid","upstream_requests":0}'); }
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'budget_native_preflight_only',
      type: 'invalid_request_error', code: 'budget_native_preflight_only' } }));
  }).listen(3004, '0.0.0.0', () => console.log('wire_receiver_ready_no_forwarding'));
} else if (mode === 'capture' && process.argv.includes('--approved-no-inference')) {
  const { requiredSecret: r } = require('/app/dist/runtime/automation/services/secret-files.js');
  const id = 'e9b2ae3e-8bfc-4fcc-9d10-1ac8c1e11b6c';
  const base = r('RONOR_OPENHANDS_AGENT_SERVER_URL');
  const prefix = `/api/conversations/${id}`;
  const call = async (p, body) => {
    const res = await fetch(base + p, { method: body ? 'POST' : 'GET',
      headers: { 'X-Session-API-Key': r('RONOR_OPENHANDS_SESSION_API_KEY'),
        ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error', signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw Error(`native_http_${res.status}`);
    return res.json();
  };
  const usage = s => Object.values(s.stats?.usage_to_metrics ?? {}).reduce(
    (a, m) => [a[0] + m.accumulated_token_usage.prompt_tokens,
      a[1] + m.accumulated_token_usage.completion_tokens], [0, 0]);
  (async () => {
    const before = await call(prefix);
    if (!['paused', 'error'].includes(before.execution_status)
        || before.agent?.llm?.model !== 'openai/qwen3.8-max'
        || before.confirmation_policy?.kind !== 'AlwaysConfirm'
        || before.agent.llm.base_url !== r('RONOR_OPENHANDS_LLM_BASE_URL')) throw Error('identity_refused');
    const oldEvents = new Set((await call(prefix + '/events/search?limit=100')).items.map(e => e.id));
    const original = { ...before.agent.llm, api_key: r('RONOR_OPENHANDS_LLM_API_KEY') };
    let switched = false, captured = false;
    try {
      await call(prefix + '/switch_llm', { llm: { ...original,
        base_url: 'http://ronor-wire-probe:3004/v1', api_key: 'non-secret-offline-probe',
        extra_headers: {}, num_retries: 0, timeout: 15 } });
      switched = true;
      const configured = await call(prefix);
      if (configured.agent.llm.base_url !== 'http://ronor-wire-probe:3004/v1'
          || configured.agent.llm.num_retries !== 0) throw Error('probe_configuration_unverified');
      await call(prefix + '/run', {});
      for (let n = 0; n < 45; n++) {
        const events = await call(prefix + '/events/search?limit=100');
        captured = events.items.some(e => !oldEvents.has(e.id) && e.kind === 'ConversationErrorEvent'
          && JSON.stringify(e).includes('budget_native_preflight_only'));
        if (captured) break;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      if (!captured) throw Error('wire_capture_not_observed');
    } finally {
      if (switched) {
        await call(prefix + '/pause', {});
        const stopped = await call(prefix);
        if (!['paused', 'error', 'finished'].includes(stopped.execution_status))
          throw Error('pause_unconfirmed_receiver_retained');
        await call(prefix + '/switch_llm', { llm: original });
        const restored = await call(prefix);
        if (restored.agent.llm.base_url !== before.agent.llm.base_url
            || restored.agent.llm.model !== before.agent.llm.model
            || JSON.stringify(restored.agent.llm.extra_headers) !== JSON.stringify(before.agent.llm.extra_headers)
            || JSON.stringify(usage(restored)) !== JSON.stringify(usage(before)))
          throw Error('restoration_unverified');
        console.log(JSON.stringify({ captured, original_endpoint_restored: true,
          model_unchanged: true, usage_unchanged: true, status: restored.execution_status,
          input_tokens: usage(restored)[0], output_tokens: usage(restored)[1] }));
      }
    }
  })().catch(e => {
    console.error(JSON.stringify({ error: /^[a-z_0-9]+$/.test(e.message) ? e.message : 'wire_probe_failed' }));
    process.exitCode = 1;
  });
} else { console.error('wire_probe_mode_refused'); process.exitCode = 2; }
