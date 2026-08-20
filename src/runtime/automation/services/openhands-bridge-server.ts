import { createNativeOpenHandsClient } from '../adapters/openhands-native';
import { createOpenHandsBridgeApp } from './openhands-bridge';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name}_required`);
  return value;
}

export async function startOpenHandsBridge() {
  const native = createNativeOpenHandsClient({
    baseUrl: required('RONOR_OPENHANDS_AGENT_SERVER_URL'),
    sessionApiKey: required('RONOR_OPENHANDS_SESSION_API_KEY'),
  });
  if (!await native.health()) throw new Error('openhands_agent_server_not_ready');
  const app = createOpenHandsBridgeApp({
    capabilityKey: required('RONOR_AUTOMATION_CAPABILITY_KEY'),
    serviceToken: required('RONOR_OPENHANDS_BRIDGE_TOKEN'),
    client: native,
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
