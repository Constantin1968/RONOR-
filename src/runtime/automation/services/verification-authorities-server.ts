import { createWorkspaceArtifactCollector } from '../artifacts';
import { createOpenAIResponsesCodexEvaluator } from './codex-evaluator';
import { createAssuranceAuthorityApp, createCodexVerifierApp } from './verification-authorities';

function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name}_required`); return value; }
function price(name: string): number { const value = Number(required(name)); if (!Number.isFinite(value) || value < 0) throw new Error(`${name}_invalid`); return value; }

const role = process.argv[2] || process.env.RONOR_AUTHORITY_ROLE;
const artifacts = createWorkspaceArtifactCollector(required('RONOR_AUTOMATION_ARTIFACT_ROOT'));
let app; let port: number;
if (role === 'codex') {
  app = createCodexVerifierApp({ serviceToken: required('RONOR_CODEX_VERIFIER_TOKEN'), artifacts, evaluator: createOpenAIResponsesCodexEvaluator({
    apiKey: required('RONOR_CODEX_API_KEY'), model: required('RONOR_CODEX_MODEL'),
    inputUsdPerMillionTokens: price('RONOR_CODEX_INPUT_USD_PER_MTOK'), outputUsdPerMillionTokens: price('RONOR_CODEX_OUTPUT_USD_PER_MTOK'),
  }) });
  port = Number(process.env.RONOR_CODEX_VERIFIER_PORT ?? 3002);
} else if (role === 'assurance') {
  app = createAssuranceAuthorityApp({ serviceToken: required('RONOR_ASSURANCE_TOKEN'), artifacts });
  port = Number(process.env.RONOR_ASSURANCE_PORT ?? 3003);
} else throw new Error('authority_role_invalid');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('authority_port_invalid');
app.listen(port, '127.0.0.1', () => process.stdout.write(`RONOR ${role} authority listening on loopback:${port}\n`));
