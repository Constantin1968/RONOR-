import { createWorkspaceArtifactCollector } from '../artifacts';
import { createAllowlistedTestExecutor, parseAllowedTestCommands } from '../test-executor';
import { requiredSecret } from './secret-files';
import { createEvidenceRunnerApp } from './evidence-runner';

const workspaceRoot = requiredSecret('RONOR_EVIDENCE_WORKSPACE');
const artifactRoot = requiredSecret('RONOR_AUTOMATION_ARTIFACT_ROOT');
const commands = parseAllowedTestCommands(requiredSecret('RONOR_AUTOMATION_TEST_COMMANDS_JSON'));
if (!commands) throw new Error('evidence_runner_test_policy_invalid');
const artifacts = createWorkspaceArtifactCollector(artifactRoot);
const tests = createAllowlistedTestExecutor({
  commands, artifacts, approvedRoot: workspaceRoot,
  // Keep the child environment allowlisted. The audit database is explicitly
  // ephemeral; no service credentials or host environment are inherited.
  baseEnv: { PATH: process.env.PATH ?? '', AUDIT_DB_PATH: requiredSecret('AUDIT_DB_PATH') },
});
const app = createEvidenceRunnerApp({ token: requiredSecret('RONOR_EVIDENCE_RUNNER_TOKEN'), workspaceRoot, artifacts, tests });
const port = Number(process.env.RONOR_EVIDENCE_RUNNER_PORT ?? 3005);
app.listen(port, '0.0.0.0', () => process.stdout.write(`RONOR evidence runner listening on 0.0.0.0:${port}\n`));
