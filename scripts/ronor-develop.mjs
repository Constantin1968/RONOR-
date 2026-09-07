#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export function controllerUrl(value = 'http://127.0.0.1:3010') {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('controller_requires_loopback');
  }
  return url.origin;
}

export async function developmentRequest(base, key, route, method = 'GET', body, idempotencyKey) {
  const response = await fetch(`${base}${route}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json',
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`controller_http_${response.status}`);
  return response.json();
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const [command, ...rest] = args;
  if (!['start', 'status', 'cancel', 'readiness'].includes(command)) throw new Error('invalid_command');
  const options = Object.fromEntries(rest.map(item => {
    const separator = item.indexOf('=');
    if (separator < 3 || !item.startsWith('--')) throw new Error('invalid_option');
    return [item.slice(2, separator), item.slice(separator + 1)];
  }));
  if (Object.keys(options).some(key => !['request', 'id', 'mission', 'run'].includes(key))) throw new Error('invalid_option');
  const base = controllerUrl(env.RONOR_DEVELOPMENT_URL);
  const file = env.RONOR_DEVELOPMENT_API_KEY_FILE;
  if (!file) throw new Error('credential_file_required');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.size > 4096) {
    throw new Error('credential_file_permissions_refused');
  }
  const key = fs.readFileSync(file, 'utf8').trim();
  if (Buffer.byteLength(key) < 32) throw new Error('credential_too_short');
  const request = (route, method, body, id) => developmentRequest(base, key, route, method, body, id);
  if (command === 'readiness') {
    const result = await request('/api/runtime/control/automation/readiness');
    return { ready: result.ok === true && result.automation?.ready === true };
  }
  if (command === 'start') {
    if (!/^[A-Za-z0-9_-]{8,120}$/.test(options.id || '') || !options.request) throw new Error('stable_id_and_request_required');
    const stat = fs.lstatSync(options.request);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16000) throw new Error('request_file_refused');
    const spec = JSON.parse(fs.readFileSync(options.request, 'utf8'));
    if (Object.keys(spec).some(key => !['objective', 'max_cost_usd', 'max_runtime_minutes', 'max_fix_cycles'].includes(key)) ||
        typeof spec.objective !== 'string' || spec.objective.length < 1 || spec.objective.length > 8000 ||
        !Number.isFinite(spec.max_cost_usd) || spec.max_cost_usd <= 0 ||
        !Number.isInteger(spec.max_runtime_minutes) || spec.max_runtime_minutes <= 0 ||
        !Number.isInteger(spec.max_fix_cycles) || spec.max_fix_cycles < 0) throw new Error('request_contract_refused');
    const readiness = await request('/api/runtime/control/automation/readiness');
    if (readiness.ok !== true || readiness.automation?.ready !== true) throw new Error('automation_not_ready');
    const prepared = await request('/api/development/jobs', 'POST', { objective: spec.objective }, options.id);
    const result = await request('/api/runtime/control/automation/run', 'POST', {
      approved: true, mission_id: prepared.job.mission_id,
      max_cost_usd: spec.max_cost_usd, max_runtime_minutes: spec.max_runtime_minutes,
      max_fix_cycles: spec.max_fix_cycles,
    }, options.id);
    return { job_id: prepared.job.job_id, mission_id: prepared.job.mission_id,
      run_id: result.run.run_id, status: result.run.status };
  }
  if (![options.run, options.mission].every(id => /^[A-Za-z0-9_-]{1,120}$/.test(id || ''))) {
    throw new Error('run_and_mission_required');
  }
  const route = `/api/runtime/control/automation/runs/${options.run}`;
  if (command === 'cancel') {
    const result = await request(`${route}/cancel`, 'POST', { mission_id: options.mission });
    return { status: result.status, rollback: false };
  }
  const result = await request(`${route}?mission_id=${options.mission}`);
  return { run: result.run, progress: result.fabric_run };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(value => console.log(JSON.stringify(value))).catch(() => {
    // Keys, objectives, paths and arbitrary server messages must never reach stderr.
    console.error('Comanda nu a reușit. Nu a fost retrimisă automat; păstrează același identificator pentru verificare.');
    process.exitCode = 1;
  });
}
