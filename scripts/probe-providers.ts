/**
 * RONOR Runtime — L1 Live Provider Probe
 * ──────────────────────────────────────
 * Exercises every adapter against whatever credentials the environment actually
 * holds and prints one line per provider. This is the script an operator runs
 * after editing `.env` to answer "is my exchange live?" without submitting a
 * governed request or spending a meaningful number of tokens.
 *
 *   npx ts-node scripts/probe-providers.ts
 *
 * Prepared by AMB.
 */

import 'dotenv/config';
import { listAdapters, providerStatuses } from '../src/runtime/providers/registry';
import { entriesForProvider } from '../src/runtime/router/catalogue';

async function main(): Promise<void> {
  console.log('RONOR L1 Model Exchange — live provider probe\n');

  const statuses = providerStatuses();
  for (const s of statuses) {
    console.log(
      `${s.provider.padEnd(14)} ${s.credentialState.padEnd(13)} transport=${s.transport.padEnd(8)} models=${s.models.length}`,
    );
  }

  console.log('\nInvoking one minimal call per invocable provider…\n');

  for (const adapter of listAdapters()) {
    const state = adapter.credentialState();
    if (state === 'key-absent') {
      console.log(`- ${adapter.descriptor.id}: SKIPPED (key-absent, no simulation)`);
      continue;
    }
    // Cheapest catalogue entry for the provider: a probe should cost as little
    // as possible while still proving the wire works end to end.
    const entries = entriesForProvider(adapter.descriptor.id).sort(
      (a, b) => a.output_cost_per_1m - b.output_cost_per_1m,
    );
    const entry = entries[0];
    if (!entry) {
      console.log(`- ${adapter.descriptor.id}: no catalogue entry`);
      continue;
    }

    const res = await adapter.invoke({
      model: entry.vendorModel,
      system: 'You are a terse diagnostic responder.',
      prompt: 'Reply with the single word: OPERATIONAL',
      maxOutputTokens: 4096,
    });

    if (res.ok) {
      console.log(
        `+ ${adapter.descriptor.id.padEnd(14)} ${entry.vendorModel.padEnd(24)} ${String(
          res.latency_ms,
        ).padStart(6)}ms  in=${res.usage.input_tokens} out=${res.usage.output_tokens} via=${res.transport}  "${res.content.trim().slice(0, 40)}"`,
      );
    } else {
      console.log(
        `! ${adapter.descriptor.id.padEnd(14)} ${entry.vendorModel.padEnd(24)} FAILED ${res.failure?.kind}: ${res.failure?.message}`,
      );
    }
  }
}

main().catch((err) => {
  console.error('probe failed:', err);
  process.exit(1);
});
