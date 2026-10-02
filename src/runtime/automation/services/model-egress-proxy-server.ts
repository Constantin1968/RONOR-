import { createModelEgressProxy } from './model-egress-proxy';
import { requiredSecret } from './secret-files';
import { MODEL_RATE_CARD_SET, ModelBudgetLedger } from '../model-budget';

const port = Number(process.env.RONOR_MODEL_EGRESS_PORT ?? 3004);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('model_egress_port_invalid');
const host = process.env.RONOR_MODEL_EGRESS_HOST || '127.0.0.1';
if (process.env.RONOR_MODEL_RATE_CARD !== MODEL_RATE_CARD_SET) throw new Error('model_budget_rate_card_required');
// Provider hosts are checked against each role's rate card inside the proxy.
createModelEgressProxy({
  upstreams: {
    author: { baseUrl: requiredSecret('RONOR_MODEL_AUTHOR_BASE_URL'), token: requiredSecret('RONOR_MODEL_AUTHOR_UPSTREAM_TOKEN') },
    verifier: { baseUrl: requiredSecret('RONOR_MODEL_VERIFIER_BASE_URL'), token: requiredSecret('RONOR_MODEL_VERIFIER_UPSTREAM_TOKEN') },
  },
  clientTokens: [
    requiredSecret('RONOR_MODEL_GATEWAY_OPENHANDS_TOKEN'),
    requiredSecret('RONOR_MODEL_GATEWAY_CODEX_TOKEN'),
  ],
  allowTailscale: process.env.RONOR_MODEL_GATEWAY_ALLOW_TAILSCALE === 'true',
  budget: {key:requiredSecret('RONOR_AUTOMATION_CAPABILITY_KEY'),
    ledger:new ModelBudgetLedger(requiredSecret('RONOR_MODEL_BUDGET_DB'))},
}).listen(port, host, () => process.stdout.write(`RONOR model egress proxy listening on ${host}:${port}\n`));
