#!/usr/bin/env node
// Transport validation status watch.
//
// Read-only. Prints one compact JSON line whenever the observed state changes,
// and stops on a terminal status or when the watch budget expires. It never
// prints objectives, transcripts, credentials or evidence bodies: only the
// identifiers, the status, the refusal code, the attempt count, the last error
// and the reported cost.
//
// Run it inside the development controller container. Identifiers are required
// arguments; there are no defaults, so a stale identifier from an earlier run
// cannot be watched by accident.
'use strict';

const DEVELOP_CLI = process.env.RONOR_DEVELOP_CLI || '/app/scripts/ronor-develop.mjs';
const DEVELOPMENT_URL = process.env.RONOR_TRANSPORT_DEVELOPMENT_URL || 'http://127.0.0.1:3010';

const RUN_PATTERN = /^run_[a-f0-9]{8,64}$/;
const MISSION_PATTERN = /^msn_[a-z0-9_]{6,64}$/;
const TERMINAL = Object.freeze(['failed', 'succeeded', 'cancelled', 'interrupted', 'complete']);
const LIMITS = Object.freeze({ watchSeconds: 900, intervalSeconds: 120 });
const DEFAULTS = Object.freeze({ watchSeconds: 240, intervalSeconds: 15 });

function refuse(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function parseArguments(argv, env = process.env) {
  const options = {
    run: null,
    mission: null,
    watchSeconds: Number(env.WATCH_SECONDS || DEFAULTS.watchSeconds),
    intervalSeconds: DEFAULTS.intervalSeconds,
  };
  for (const argument of argv) {
    const match = /^--([a-z-]+)=(.*)$/.exec(argument);
    if (!match) throw refuse('status_argument_unknown');
    const [, name, value] = match;
    if (name === 'run') { options.run = value; continue; }
    if (name === 'mission') { options.mission = value; continue; }
    if (name === 'watch-seconds') { options.watchSeconds = Number(value); continue; }
    if (name === 'interval-seconds') { options.intervalSeconds = Number(value); continue; }
    throw refuse('status_argument_unknown');
  }
  if (typeof options.run !== 'string' || options.run.length === 0) throw refuse('status_run_missing');
  if (!RUN_PATTERN.test(options.run)) throw refuse('status_run_invalid');
  if (typeof options.mission !== 'string' || options.mission.length === 0) throw refuse('status_mission_missing');
  if (!MISSION_PATTERN.test(options.mission)) throw refuse('status_mission_invalid');
  if (!Number.isSafeInteger(options.watchSeconds) || options.watchSeconds <= 0
    || options.watchSeconds > LIMITS.watchSeconds) throw refuse('status_watch_invalid');
  if (!Number.isSafeInteger(options.intervalSeconds) || options.intervalSeconds <= 0
    || options.intervalSeconds > LIMITS.intervalSeconds) throw refuse('status_interval_invalid');
  return options;
}

function redact(result) {
  const run = (result && result.run) || {};
  return {
    at: new Date().toISOString(),
    run_id: run.run_id,
    mission_id: run.mission_id,
    status: run.status,
    reason_code: run.reason_code,
    attempt_count: run.attempt_count,
    last_error: run.last_error,
    cost_usd: run.cost_usd,
    progress: (result && result.progress) || {},
  };
}

function isTerminal(observation) {
  return TERMINAL.includes(observation.status);
}

async function watch(argv, env = process.env, deps = {}) {
  const options = parseArguments(argv, env);
  const emit = deps.emit || (line => console.log(line));
  const sleep = deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const now = deps.now || (() => Date.now());
  const main = deps.main || (await import(DEVELOP_CLI)).main;
  const childEnv = {
    ...env,
    RONOR_DEVELOPMENT_URL: DEVELOPMENT_URL,
    RONOR_DEVELOPMENT_API_KEY_FILE: env.RONOR_TRANSPORT_API_KEY_FILE || env.RONOR_ARCHITECT_API_KEY_FILE,
  };
  if (!childEnv.RONOR_DEVELOPMENT_API_KEY_FILE) throw refuse('architect_key_file_missing');
  const end = now() + options.watchSeconds * 1000;
  let last = '';
  let observation = null;
  for (;;) {
    observation = redact(await main(['status', `--run=${options.run}`, `--mission=${options.mission}`], childEnv));
    const payload = JSON.stringify(observation);
    if (payload !== last) emit(payload);
    last = payload;
    if (isTerminal(observation)) return { ok: true, terminal: true, status: observation.status };
    if (now() >= end) return { ok: true, terminal: false, status: observation.status };
    await sleep(options.intervalSeconds * 1000);
  }
}

module.exports = { DEFAULTS, LIMITS, TERMINAL, isTerminal, parseArguments, redact, watch };

if (require.main === module) {
  watch(process.argv.slice(2))
    .then(() => process.exit(0))
    .catch(error => {
      const code = typeof error?.code === 'string' && /^[a-z_0-9]{3,60}$/.test(error.code)
        ? error.code
        : 'status_read_failed';
      console.error(JSON.stringify({ ok: false, error: code }));
      process.exit(1);
    });
}
