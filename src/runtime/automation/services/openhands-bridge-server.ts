import { createNativeOpenHandsClient } from '../adapters/openhands-native';
import { createOpenHandsBridgeApp, FileCapabilityNonceStore } from './openhands-bridge';
import { requiredSecret } from './secret-files';
import { MODEL_RATE_CARD } from '../model-budget';

export async function startOpenHandsBridge() {
  const model = requiredSecret('RONOR_OPENHANDS_LLM_MODEL');
  if (process.env.RONOR_MODEL_RATE_CARD !== MODEL_RATE_CARD.id || model !== `openai/${MODEL_RATE_CARD.model}`) throw new Error('openhands_budget_rate_card_required');
  const native = createNativeOpenHandsClient({
    baseUrl: requiredSecret('RONOR_OPENHANDS_AGENT_SERVER_URL'),
    sessionApiKey: requiredSecret('RONOR_OPENHANDS_SESSION_API_KEY'),
    plaintextServiceHosts: ['openhands-agent'],
    catalogAccounting: true,
    llm: {
      model,
      apiKey: requiredSecret('RONOR_OPENHANDS_LLM_API_KEY'),
      baseUrl: requiredSecret('RONOR_OPENHANDS_LLM_BASE_URL'),
      apiMode: 'chat',
      inputCostPerToken: MODEL_RATE_CARD.inputMicroUsd / 1e6,
      outputCostPerToken: MODEL_RATE_CARD.outputMicroUsd / 1e6,
    },
  });
  if (!await native.health()) throw new Error('openhands_agent_server_not_ready');
  const app = createOpenHandsBridgeApp({
    capabilityKey: requiredSecret('RONOR_AUTOMATION_CAPABILITY_KEY'),
    serviceToken: requiredSecret('RONOR_OPENHANDS_BRIDGE_TOKEN'),
    client: native,
    nonces: new FileCapabilityNonceStore(requiredSecret('RONOR_OPENHANDS_NONCE_DIR')),
    requireBudget: true,
  });
  const host = process.env.RONOR_OPENHANDS_BRIDGE_HOST || '127.0.0.1';
  const port = Number(process.env.RONOR_OPENHANDS_BRIDGE_PORT || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('RONOR_OPENHANDS_BRIDGE_PORT_invalid');
  return app.listen(port, host, () => {
    process.stdout.write(`RONOR OpenHands bridge ready on ${host}:${port}\n`);
  });
}

if (require.main === module) {
  startOpenHandsBridge().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'openhands_bridge_start_failed'}\n`);
    process.exitCode = 1;
  });
}
