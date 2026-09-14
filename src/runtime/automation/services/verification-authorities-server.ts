import { createWorkspaceArtifactCollector } from '../artifacts';
import { createOpenAIResponsesCodexEvaluator } from './codex-evaluator';
import { createAssuranceAuthorityApp, createCodexVerifierApp } from './verification-authorities';
import { requiredSecret } from './secret-files';
import { MODEL_RATE_CARD } from '../model-budget';

function price(name: string): number { const value = Number(requiredSecret(name)); if (!Number.isFinite(value) || value < 0) throw new Error(`${name}_invalid`); return value; }

const role = process.argv[2] || process.env.RONOR_AUTHORITY_ROLE;
const artifacts = createWorkspaceArtifactCollector(requiredSecret('RONOR_AUTOMATION_ARTIFACT_ROOT'));
let app; let port: number;
if (role === 'codex') {
  if (process.env.RONOR_MODEL_RATE_CARD !== MODEL_RATE_CARD.id ||
      requiredSecret('RONOR_CODEX_MODEL') !== MODEL_RATE_CARD.model ||
      price('RONOR_CODEX_INPUT_USD_PER_MTOK') !== MODEL_RATE_CARD.inputMicroUsd ||
      price('RONOR_CODEX_OUTPUT_USD_PER_MTOK') !== MODEL_RATE_CARD.outputMicroUsd) throw new Error('verifier_budget_rate_card_required');
  app = createCodexVerifierApp({ serviceToken: requiredSecret('RONOR_CODEX_VERIFIER_TOKEN'), receiptPrivateKey: requiredSecret('RONOR_CODEX_RECEIPT_PRIVATE_KEY'), artifacts, evaluator: createOpenAIResponsesCodexEvaluator({
    apiKey: requiredSecret('RONOR_CODEX_API_KEY'), model: requiredSecret('RONOR_CODEX_MODEL'),
    baseUrl: process.env.RONOR_CODEX_BASE_URL,
    inputUsdPerMillionTokens: price('RONOR_CODEX_INPUT_USD_PER_MTOK'), outputUsdPerMillionTokens: price('RONOR_CODEX_OUTPUT_USD_PER_MTOK'),
  }) });
  port = Number(process.env.RONOR_CODEX_VERIFIER_PORT ?? 3002);
} else if (role === 'assurance') {
  app = createAssuranceAuthorityApp({ serviceToken: requiredSecret('RONOR_ASSURANCE_TOKEN'), receiptPublicKey: requiredSecret('RONOR_ASSURANCE_RECEIPT_PUBLIC_KEY'), artifacts });
  port = Number(process.env.RONOR_ASSURANCE_PORT ?? 3003);
} else throw new Error('authority_role_invalid');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('authority_port_invalid');
const host = process.env.RONOR_AUTHORITY_HOST || '127.0.0.1';
app.listen(port, host, () => process.stdout.write(`RONOR ${role} authority listening on ${host}:${port}\n`));
