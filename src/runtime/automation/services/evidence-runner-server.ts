import { createWorkspaceArtifactCollector } from '../artifacts';
import { createAllowlistedTestExecutor, parseAllowedTestCommands } from '../test-executor';
import { requiredSecret } from './secret-files';
import { createEvidenceRunnerApp } from './evidence-runner';
import { createBoundedTestExecutor } from '../bounded-test-executor';
import { evaluateAcceptanceGate, parseProtectedPaths } from '../acceptance-gate';

// The only writable path in this container is the ephemeral scratch mount.
const TEST_SCRATCH_DIR = '/tmp';

const workspaceRoot = requiredSecret('RONOR_EVIDENCE_WORKSPACE');
const artifactRoot = requiredSecret('RONOR_AUTOMATION_ARTIFACT_ROOT');
const commands = parseAllowedTestCommands(requiredSecret('RONOR_AUTOMATION_TEST_COMMANDS_JSON'));
if (!commands) throw new Error('evidence_runner_test_policy_invalid');
const artifacts = createWorkspaceArtifactCollector(artifactRoot, { baseCommit: process.env.RONOR_AUTOMATION_EXPECTED_HEAD });
const testConfig = {
  commands, artifacts, approvedRoot: workspaceRoot,
  // Keep the child environment allowlisted. The audit database is explicitly
  // ephemeral; no service credentials or host environment are inherited.
  // HOME and the npm cache are pinned to the ephemeral scratch directory: the
  // Node toolchain resolves a home directory before it reads any configuration,
  // and the container image has no writable home for the unprivileged user.
  baseEnv: {
    PATH: process.env.PATH ?? '',
    HOME: TEST_SCRATCH_DIR,
    npm_config_cache: `${TEST_SCRATCH_DIR}/.npm`,
    npm_config_update_notifier: 'false',
    AUDIT_DB_PATH: requiredSecret('AUDIT_DB_PATH'),
  },
};
const tests = createAllowlistedTestExecutor(testConfig);
const boundedTests = createBoundedTestExecutor(testConfig);
// External acceptance gate (M1). Enabled by pointing RONOR_ACCEPTANCE_RECEIPT_ROOT at a
// directory outside the workspace. When enabled it is fail-closed: the base commit must be
// pinned and the host test allowlist must contain the acceptance suite under the id "acceptance".
const receiptRoot = process.env.RONOR_ACCEPTANCE_RECEIPT_ROOT;
let acceptance: Parameters<typeof createEvidenceRunnerApp>[0]['acceptance'];
if (receiptRoot) {
  const pinnedBase = process.env.RONOR_AUTOMATION_EXPECTED_HEAD ?? '';
  if (!/^[a-f0-9]{40}$/.test(pinnedBase)) throw new Error('acceptance_requires_pinned_base_commit');
  if (!commands.some(c => c.id === 'acceptance')) throw new Error('acceptance_suite_not_in_test_allowlist');
  if (receiptRoot === workspaceRoot || receiptRoot.startsWith(`${workspaceRoot}/`)) throw new Error('acceptance_receipts_inside_workspace');
  const protectedPaths = parseProtectedPaths(process.env.RONOR_ACCEPTANCE_PROTECTED_PATHS_JSON);
  acceptance = { evaluate: (root, runId, assignmentId, baseCommit) => evaluateAcceptanceGate(root, runId, assignmentId,
    { baseCommit: baseCommit ?? pinnedBase, protectedPaths, receiptRoot, suitePath: 'tests/acceptance' }) };
}
const app = createEvidenceRunnerApp({ token: requiredSecret('RONOR_EVIDENCE_RUNNER_TOKEN'), workspaceRoot, artifacts, tests, boundedTests, acceptance });
const port = Number(process.env.RONOR_EVIDENCE_RUNNER_PORT ?? 3005);
app.listen(port, '0.0.0.0', () => process.stdout.write(`RONOR evidence runner listening on 0.0.0.0:${port}\n`));
