// Explicitly authorized single controlled validation run, maximum 100 USD, 15 minutes.
const fs = require('node:fs');
const candidates = ['/tmp/ronor-transport-request.json', '/app/data/ronor-transport-request.json'];
let path = null;
(async () => {
  const { main } = await import('/app/scripts/ronor-develop.mjs');
  const env = {
    ...process.env,
    RONOR_DEVELOPMENT_URL: 'http://127.0.0.1:3010',
    RONOR_DEVELOPMENT_API_KEY_FILE: process.env.RONOR_ARCHITECT_API_KEY_FILE,
  };
  const request = JSON.stringify({
    objective: 'Verify the transport regression suite in tests/runtime/automation-http-transport.test.ts and the isolation of the persistent audit database in tests/runtime/development-controller.test.ts and tests/runtime/automation-run-lease.test.ts. These were installed by an operator-assisted local commit; do not duplicate them and do not claim to have authored them. Inspect the actual test files, then run npm test -- --runInBand tests/runtime/automation-http-transport.test.ts tests/runtime/development-controller.test.ts tests/runtime/automation-run-lease.test.ts. Run the relevant existing tests, not an unrelated repository-wide repair. If everything is already correct and passing, make no code change and report that accurately. Only those three test files may be changed if a genuine defect in them is found. Do not change implementation, dependencies, configuration, or other files. Do not read credentials. At most one local commit is allowed on the existing development branch, only if a real test correction is needed. Never push, merge, release, deploy, or rewrite history. Supply honest evidence for the independent verifier and assurance gate.',
    max_cost_usd: 100,
    max_runtime_minutes: 15,
    max_fix_cycles: 1,
  });
  for (const candidate of candidates) {
    try { fs.writeFileSync(candidate, request, { mode: 0o600 }); path = candidate; break; } catch { /* next */ }
  }
  if (!path) throw new Error('request_path_unwritable');
  console.log(JSON.stringify(await main([
    'start', `--request=${path}`, '--id=ronor-transport-validation-20260909',
  ], env)));
})().catch(error => {
  console.error(JSON.stringify({
    ok: false, error: /^[a-z_0-9]{3,60}$/.test(error.message) ? error.message : 'start_failed',
    detail: String(error && error.message).slice(0, 200),
  }));
  process.exitCode = 1;
});
