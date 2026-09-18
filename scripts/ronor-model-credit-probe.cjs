'use strict';
// Preflight credit probe. Runs inside the model egress proxy container, uses the
// installed upstream credential and the installed gateway base URL, and asks the
// provider for a single token. It deliberately bypasses the budget ledger: no
// reservation is taken, so a refused probe cannot consume the run ceiling.
//
// Prints only a verdict, the HTTP status, the provider error code and message.
// Never prints the credential, the request body or any objective.
const fs = require('fs');

function readToken() {
  const file = process.env.RONOR_MODEL_GATEWAY_UPSTREAM_TOKEN_FILE || '/run/secrets/model_gateway_upstream_token';
  return fs.readFileSync(file, 'utf8').trim();
}

async function main() {
  const base = (process.env.RONOR_MODEL_GATEWAY_BASE_URL || '').replace(/\/+$/, '');
  const model = process.env.RONOR_MODEL_CREDIT_PROBE_MODEL || 'qwen3.8-max';
  if (!base) { console.log(JSON.stringify({ verdict: 'probe_misconfigured', detail: 'gateway_base_url_missing' })); process.exit(2); }
  const started = Date.now();
  let response;
  let body = '';
  try {
    response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${readToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ok' }] }),
      signal: AbortSignal.timeout(30000),
    });
    body = (await response.text()).slice(0, 4096);
  } catch (error) {
    console.log(JSON.stringify({ verdict: 'gateway_unreachable', detail: String(error && error.name || 'error'), elapsed_ms: Date.now() - started }));
    process.exit(3);
  }
  let parsed = null;
  try { parsed = JSON.parse(body); } catch { /* provider returned a non-JSON body */ }
  const err = parsed && (parsed.error || parsed);
  const code = err && (err.code || err.Code || null);
  const message = err && typeof err.message === 'string' ? err.message.slice(0, 400) : null;
  const usage = parsed && parsed.usage ? parsed.usage : null;
  if (response.ok && usage) {
    console.log(JSON.stringify({ verdict: 'credit_available', status: response.status, model, usage, elapsed_ms: Date.now() - started }));
    process.exit(0);
  }
  let cause = 'provider_refused';
  if (response.status === 403 && typeof code === 'string' && /FreeTierOnly/i.test(code)) cause = 'free_tier_only_switch_on';
  else if (response.status === 403 && /free quota has been exhausted/i.test(message || '')) cause = 'free_quota_exhausted_or_profile_incomplete';
  else if (response.status === 401) cause = 'credential_rejected';
  else if (response.status === 429) cause = 'rate_limited';
  console.log(JSON.stringify({ verdict: 'credit_unavailable', cause, status: response.status, code, message, elapsed_ms: Date.now() - started }));
  process.exit(4);
}

main().catch((error) => { console.log(JSON.stringify({ verdict: 'probe_failed', detail: String(error && error.name || 'error') })); process.exit(5); });
