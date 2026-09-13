// Read-only, bounded status watch. Prints no objectives, secrets or transcripts.
(async () => {
  const { main } = await import('/app/scripts/ronor-develop.mjs');
  const env = { ...process.env, RONOR_DEVELOPMENT_URL: 'http://127.0.0.1:3010',
    RONOR_DEVELOPMENT_API_KEY_FILE: process.env.RONOR_ARCHITECT_API_KEY_FILE };
  const budget = Number(process.env.WATCH_SECONDS || 240) * 1000;
  const end = Date.now() + budget;
  let last = '';
  for (;;) {
    const result = await main(['status', '--run=run_006cc7aa5f89f370b94b',
      '--mission=msn_mtt6t4q8_1304ee6c'], env);
    const run = result.run || {};
    const progress = result.progress || {};
    const safe = { at: new Date().toISOString(), run_id: run.run_id, status: run.status,
      reason_code: run.reason_code, attempt_count: run.attempt_count,
      last_error: run.last_error, cost_usd: run.cost_usd, progress };
    const payload = JSON.stringify(safe);
    if (payload !== last) console.log(payload);
    last = payload;
    if (['failed', 'succeeded', 'cancelled', 'interrupted', 'complete'].includes(run.status)) break;
    if (Date.now() >= end) break;
    await new Promise(r => setTimeout(r, 15000));
  }
})().then(() => process.exit(0)).catch(() => { console.error('status_read_failed'); process.exit(1); });
