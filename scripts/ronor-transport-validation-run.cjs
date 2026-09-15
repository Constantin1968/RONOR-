#!/usr/bin/env node
// Transport validation driver.
//
// Starts exactly one bounded development run whose mandate is to inspect and
// execute the transport regression suite and the two audit-isolation suites,
// nothing else. The objective is fixed in this file on purpose: this is not a
// general-purpose way to dispatch arbitrary work to the author, it is the
// single procedure the transport gate is allowed to ask for.
//
// Nothing happens without an explicit approval flag and an explicit run
// identifier. `--dry-run` prints the exact request that would be submitted and
// starts no model, which is the supported way to demonstrate the script on a
// host without spending model credit.
//
// Run it inside the development controller container, where
// /app/scripts/ronor-develop.mjs and the architect key file are present.
'use strict';

const fs = require('node:fs');

const DEVELOP_CLI = process.env.RONOR_DEVELOP_CLI || '/app/scripts/ronor-develop.mjs';
const DEVELOPMENT_URL = process.env.RONOR_TRANSPORT_DEVELOPMENT_URL || 'http://127.0.0.1:3010';
const REQUEST_PATHS = (
  process.env.RONOR_TRANSPORT_REQUEST_PATHS
  || '/tmp/ronor-transport-request.json:/app/data/ronor-transport-request.json'
).split(':').filter(Boolean);

const TEST_FILES = Object.freeze([
  'tests/runtime/automation-http-transport.test.ts',
  'tests/runtime/development-controller.test.ts',
  'tests/runtime/automation-run-lease.test.ts',
]);

const CEILINGS = Object.freeze({ maxCostUsd: 100, maxRuntimeMinutes: 15, maxFixCycles: 1 });
const DEFAULTS = Object.freeze({ maxCostUsd: 100, maxRuntimeMinutes: 15 });
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{7,63}$/;

function objectiveText(files = TEST_FILES) {
  return [
    `Verify the transport regression suite in ${files[0]} and the isolation of the`,
    `persistent audit database in ${files[1]} and ${files[2]}.`,
    'These were installed by an operator-assisted local commit; do not duplicate them',
    'and do not claim to have authored them. Inspect the actual test files, then run',
    `npm test -- --runInBand ${files.join(' ')}.`,
    'Run the relevant existing tests, not an unrelated repository-wide repair.',
    'If everything is already correct and passing, make no code change and report that',
    'accurately. Only those test files may be changed if a genuine defect in them is',
    'found. Do not change implementation, dependencies, configuration, or other files.',
    'Do not read credentials. At most one local commit is allowed on the existing',
    'development branch, only if a real test correction is needed. Never push, merge,',
    'release, deploy, or rewrite history. Supply honest evidence for the independent',
    'verifier and assurance gate.',
  ].join(' ');
}

function refuse(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function parseArguments(argv) {
  const options = {
    approved: false,
    dryRun: false,
    id: null,
    maxCostUsd: DEFAULTS.maxCostUsd,
    maxRuntimeMinutes: DEFAULTS.maxRuntimeMinutes,
  };
  for (const argument of argv) {
    if (argument === '--approved-validation') { options.approved = true; continue; }
    if (argument === '--dry-run') { options.dryRun = true; continue; }
    const match = /^--([a-z-]+)=(.*)$/.exec(argument);
    if (!match) throw refuse('validation_argument_unknown');
    const [, name, value] = match;
    if (name === 'id') { options.id = value; continue; }
    if (name === 'max-cost-usd') { options.maxCostUsd = Number(value); continue; }
    if (name === 'max-runtime-minutes') { options.maxRuntimeMinutes = Number(value); continue; }
    throw refuse('validation_argument_unknown');
  }
  if (!options.approved) throw refuse('validation_not_approved');
  if (typeof options.id !== 'string' || options.id.length === 0) throw refuse('validation_id_missing');
  if (!ID_PATTERN.test(options.id)) throw refuse('validation_id_invalid');
  if (!Number.isFinite(options.maxCostUsd) || options.maxCostUsd <= 0
    || options.maxCostUsd > CEILINGS.maxCostUsd) throw refuse('validation_cost_invalid');
  if (!Number.isSafeInteger(options.maxRuntimeMinutes) || options.maxRuntimeMinutes <= 0
    || options.maxRuntimeMinutes > CEILINGS.maxRuntimeMinutes) throw refuse('validation_runtime_invalid');
  return options;
}

function buildRequest(options) {
  return {
    objective: objectiveText(),
    max_cost_usd: options.maxCostUsd,
    max_runtime_minutes: options.maxRuntimeMinutes,
    max_fix_cycles: CEILINGS.maxFixCycles,
  };
}

function writeRequest(request, paths = REQUEST_PATHS) {
  const body = JSON.stringify(request);
  for (const candidate of paths) {
    try {
      fs.writeFileSync(candidate, body, { mode: 0o600 });
      return candidate;
    } catch { /* try the next candidate */ }
  }
  throw refuse('request_path_unwritable');
}

async function run(argv, env = process.env) {
  const options = parseArguments(argv);
  const request = buildRequest(options);
  if (options.dryRun) {
    return {
      ok: true, dry_run: true, id: options.id, request,
      test_files: [...TEST_FILES], no_model_started: true, no_run_created: true,
    };
  }
  const keyFile = env.RONOR_TRANSPORT_API_KEY_FILE || env.RONOR_ARCHITECT_API_KEY_FILE;
  if (!keyFile) throw refuse('architect_key_file_missing');
  const requestPath = writeRequest(request);
  const { main } = await import(DEVELOP_CLI);
  const result = await main(['start', `--request=${requestPath}`, `--id=${options.id}`], {
    ...env,
    RONOR_DEVELOPMENT_URL: DEVELOPMENT_URL,
    RONOR_DEVELOPMENT_API_KEY_FILE: keyFile,
  });
  return { ok: true, dry_run: false, id: options.id, request_path: requestPath, result };
}

module.exports = {
  CEILINGS, DEFAULTS, TEST_FILES, buildRequest, objectiveText, parseArguments, run, writeRequest,
};

if (require.main === module) {
  run(process.argv.slice(2))
    .then(result => { console.log(JSON.stringify(result)); })
    .catch(error => {
      const code = typeof error?.code === 'string' && /^[a-z_0-9]{3,60}$/.test(error.code)
        ? error.code
        : (/^[a-z_0-9]{3,60}$/.test(String(error?.message)) ? String(error.message) : 'start_failed');
      console.error(JSON.stringify({
        ok: false, error: code, detail: String(error && error.message).slice(0, 200),
      }));
      process.exitCode = 1;
    });
}
