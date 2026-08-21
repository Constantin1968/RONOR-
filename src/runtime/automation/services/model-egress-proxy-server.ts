import { createModelEgressProxy } from './model-egress-proxy';
import { requiredSecret } from './secret-files';

const port = Number(process.env.RONOR_MODEL_EGRESS_PORT ?? 3004);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('model_egress_port_invalid');
const host = process.env.RONOR_MODEL_EGRESS_HOST || '127.0.0.1';
createModelEgressProxy({
  gatewayBaseUrl: requiredSecret('RONOR_MODEL_GATEWAY_BASE_URL'),
  gatewayToken: requiredSecret('RONOR_MODEL_GATEWAY_TOKEN'),
  allowTailscale: process.env.RONOR_MODEL_GATEWAY_ALLOW_TAILSCALE === 'true',
}).listen(port, host, () => process.stdout.write(`RONOR model egress proxy listening on ${host}:${port}\n`));
