// Local, model-free reproduction. The server does no external work.
// Default: observe Node fetch's implicit 300s wait versus the fixed adapter.
const http = require('node:http');
const { createOpenHandsAdapter } = require('../dist/runtime/automation/adapters/http');

(async () => {
  const delayMs = Number(process.env.TRANSPORT_SMOKE_DELAY_MS || 305_000);
  if (!Number.isSafeInteger(delayMs) || delayMs < 1 || delayMs > 310_000) throw new Error('invalid_delay');
  const timers = new Set();
  const server = http.createServer((req, res) => {
    req.resume();
    const timer = setTimeout(() => {
      timers.delete(timer);
      res.end(JSON.stringify({ ok: true, summary: 'Local delayed response verified.', evidence: [], cost_usd: 0 }));
    }, delayMs);
    timers.add(timer);
    res.on('close', () => { clearTimeout(timer); timers.delete(timer); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const start = Date.now();
  const record = data => console.log(JSON.stringify({ elapsed_ms: Date.now() - start, ...data }));
  record({ phase: 'start', node: process.version, delay_ms: delayMs, no_model_calls: true });
  try {
    const original = fetch(`${baseUrl}/original`, { method: 'POST', signal: AbortSignal.timeout(330_000) })
      .then(r => r.json()).then(() => record({ transport: 'original_fetch', status: 'complete' }))
      .catch(e => record({ transport: 'original_fetch', status: 'failed', name: e.name, cause_code: e.cause?.code }));
    const fixed = createOpenHandsAdapter({ baseUrl, capabilityKey: 'local-test-only-'.repeat(3), timeoutMs: 330_000 })
      .execute({ id: 'smoke', instruction: 'Transport smoke only.', actions: ['read_repo'] }, {
        mandate_id: 'transport-smoke', mission_id: 'transport-smoke', objective_hash: 'a'.repeat(64),
        expires_at: new Date(Date.now() + 320_000).toISOString(),
      })
      .then(r => { if (!r.ok || r.cost_usd !== 0) throw new Error('invalid_response'); record({ transport: 'fixed_request', status: 'complete' }); });
    await Promise.all([original, fixed]);
  } finally {
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
})().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
