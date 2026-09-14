import crypto from 'node:crypto';
import { getDb } from '../../audit/hash-chain';
import { ensureRuntimeLedgerSchema } from '../ledgers/schema';
import { AUTOMATION_ACTIONS, type ExecutionMandate, type VerificationEvidence, type VerificationReceipt } from './contracts';
import { createWorkspaceArtifactCollector } from './artifacts';
import { AutomationAdapterError, createAssuranceAdapter, createCodexVerifierAdapter, describeCodexFailure } from './adapters/http';
import { createHttpPostExecutionVerifier, readBoundedVerificationJson } from './post-execution-verifier';
import { EXISTING_ASSIGNMENT, inspectExistingCommit, validCommitPins, type CommitPins } from './existing-commit-workspace';
import { issueArchitectMandate, signMandateAuthority, verifyMandateAuthority } from './mandate-issuer';
import { verificationEvidenceDigest } from './verification-receipt';
import { createCostReconciler, type ObservedCost } from './cost-reconciliation';

type Status = 'queued' | 'evidence' | 'codex' | 'victoria' | 'verified' | 'failed' | 'cancelled' | 'interrupted';
const ACTIVE: Status[] = ['queued', 'evidence', 'codex', 'victoria'];
const active = (status: Status) => ACTIVE.includes(status);
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
export interface ExistingVerificationRequest extends CommitPins {
  approved: true; max_cost_usd: number; max_runtime_minutes: number;
}
interface RecordState {
  operation: 'verify-existing'; verification_id: string; architect_key_id: string;
  request: ExistingVerificationRequest; policy_digest: string; mandate: ExecutionMandate;
  status: Status; reason: string | null; created_at: string; updated_at: string;
  evidence: VerificationEvidence | null; evidence_digest: string | null;
  receipt: VerificationReceipt | null; victoria_accepted: boolean; cost_usd: number | null;
  /** Absent on rows written before cost reconciliation existed. */
  observed?: ObservedCost | null;
}
export class ExistingVerificationError extends Error {
  constructor(readonly code: string, readonly httpStatus = 422) { super(code); }
}
const refusal = (code: string, status = 422): never => { throw new ExistingVerificationError(code, status); };

/** This table is intentionally not a mission, author assignment, checkpoint or
 * runtime_automation_runs row. Every transition is MAC protected and CAS written.
 */
class VerificationStore {
  constructor(private readonly key: string) {
    getDb().exec(`CREATE TABLE IF NOT EXISTS runtime_existing_commit_verifications (
      id TEXT PRIMARY KEY, payload TEXT NOT NULL, mac TEXT NOT NULL
    )`);
  }
  private mac(payload: string) {
    if (Buffer.byteLength(this.key) < 32) return refusal('verification_authority_unavailable', 503);
    return crypto.createHmac('sha256', this.key).update(payload).digest('hex');
  }
  read(id: string): RecordState | null {
    const row = getDb().prepare('SELECT payload,mac FROM runtime_existing_commit_verifications WHERE id=?')
      .get(id) as { payload: string; mac: string } | undefined;
    if (!row) return null;
    if (row.payload.length > 256 * 1024 || !/^[a-f0-9]{64}$/.test(row.mac) ||
        !crypto.timingSafeEqual(Buffer.from(this.mac(row.payload), 'hex'), Buffer.from(row.mac, 'hex')))
      return refusal('verification_integrity_failed');
    const value = JSON.parse(row.payload) as RecordState;
    if (value.verification_id !== id || value.operation !== 'verify-existing' ||
        !verifyMandateAuthority(value.mandate, this.key) ||
        value.mandate.objective_hash !== hash(`verify-existing/v1:${value.request.base_commit}..${value.request.head_commit}`) ||
        value.evidence && verificationEvidenceDigest(value.evidence) !== value.evidence_digest ||
        value.status === 'verified' && (!value.victoria_accepted || !value.receipt ||
          value.receipt.evidence_digest !== value.evidence_digest || value.receipt.mission_id !== id))
      return refusal('verification_integrity_failed');
    return value;
  }
  insert(value: RecordState) {
    const payload = JSON.stringify(value);
    getDb().prepare('INSERT INTO runtime_existing_commit_verifications(id,payload,mac) VALUES(?,?,?)')
      .run(value.verification_id, payload, this.mac(payload));
  }
  write(previous: RecordState, next: RecordState) {
    const payload = JSON.stringify(next);
    const result = getDb().prepare('UPDATE runtime_existing_commit_verifications SET payload=?,mac=? WHERE id=? AND mac=?')
      .run(payload, this.mac(payload), previous.verification_id, this.mac(JSON.stringify(previous)));
    if (result.changes !== 1) refusal('verification_integrity_failed');
  }
  allIds(): string[] {
    return (getDb().prepare('SELECT id FROM runtime_existing_commit_verifications').all() as { id: string }[]).map(r => r.id);
  }
}

function publicStatus(value: RecordState) {
  return {
    operation: value.operation, full_development: false, verification_id: value.verification_id,
    base_commit: value.request.base_commit, head_commit: value.request.head_commit,
    status: value.status, reason: value.reason, evidence_digest: value.evidence_digest,
    codex_receipt_present: value.receipt !== null, victoria_accepted: value.victoria_accepted,
    cost_usd: value.cost_usd, accounting_basis: 'catalog-not-invoice',
    // What the egress ledger actually settled. Present above all when the run
    // ended without reporting a cost of its own; null when unobserved.
    observed_cost_usd: value.observed?.observed_cost_usd ?? null,
    observed_cost_basis: value.observed?.observed_cost_basis ?? null,
    observed_unresolved_dispatches: value.observed?.unresolved_dispatches ?? null,
    observed_budget_frozen: value.observed?.budget_frozen ?? null,
    max_cost_usd: value.request.max_cost_usd, deadline: value.mandate.expires_at,
    created_at: value.created_at, updated_at: value.updated_at,
  };
}

/** Server-only transport injection supports labelled offline tests; there is no
 * request-controlled adapter, workspace, command, checkout or authority override.
 */
export function createExistingCommitVerification(source: NodeJS.ProcessEnv, options: {
  fetcher?: typeof fetch; developmentAdmissionPending?: () => boolean;
} = {}) {
  const env = { ...source };
  const key = env.RONOR_AUTOMATION_MANDATE_SIGNING_KEY ?? '';
  const store = new VerificationStore(key);
  getDb().exec(`CREATE TABLE IF NOT EXISTS runtime_existing_commit_admission (
    workspace TEXT PRIMARY KEY, owner TEXT NOT NULL
  )`);
  const gateKey = hash(env.RONOR_AUTOMATION_WORKTREE ?? 'unconfigured-development-workspace');
  const release = (owner: string) => {
    getDb().prepare('DELETE FROM runtime_existing_commit_admission WHERE workspace=? AND owner=?').run(gateKey, owner);
  };
  const running = new Map<string, AbortController>();
  let stopped = false;
  const workspace = () => env.RONOR_AUTOMATION_WORKTREE!;
  const policy = () => ({
    approvedRoot: env.RONOR_AUTOMATION_WORKSPACE_ROOT!,
    branch: env.RONOR_AUTOMATION_BRANCH!, origin: env.RONOR_AUTOMATION_EXPECTED_ORIGIN!,
  });
  const policyDigest = () => hash(JSON.stringify([
    workspace(), policy(), env.RONOR_AUTOMATION_EXPECTED_HEAD, env.RONOR_AUTOMATION_ARTIFACT_ROOT,
    env.RONOR_EVIDENCE_RUNNER_URL, env.RONOR_CODEX_VERIFIER_URL, env.RONOR_ASSURANCE_URL,
    env.RONOR_AUTOMATION_CAPABILITY_KEY,
  ]));
  const collector = () => createWorkspaceArtifactCollector(env.RONOR_AUTOMATION_ARTIFACT_ROOT!);
  function change(value: RecordState, patch: Partial<RecordState>) {
    const next = { ...value, ...patch, updated_at: new Date().toISOString() };
    store.write(value, next); return next;
  }
  // Never replay an in-flight operation after restart, even with recovery enabled.
  for (const id of store.allIds()) {
    try {
      const row = store.read(id)!;
      if (active(row.status)) {
        change(row, { status: 'interrupted', reason: 'verification_restart_interrupted',
          ...(row.status === 'codex' ? { cost_usd: null } : {}) });
        // Keep the admission barrier until the old signed deadline: a lost
        // process may still have an isolated test/model request in flight.
      }
    } catch { /* Corrupt/foreign-key state remains unreadable and blocks admission. */ }
  }
  function hasActive() {
    return store.allIds().some(id => active(store.read(id)!.status));
  }
  function claim(owner: string) {
    ensureRuntimeLedgerSchema();
    getDb().transaction(() => {
      const gate = getDb().prepare('SELECT owner FROM runtime_existing_commit_admission WHERE workspace=?')
        .get(gateKey) as { owner: string } | undefined;
      if (gate?.owner.startsWith('verify_')) {
        const old = store.read(gate.owner);
        if (old && !active(old.status) && Date.now() >= Date.parse(old.mandate.expires_at)) release(gate.owner);
      }
      if (hasActive() || options.developmentAdmissionPending?.() ||
          getDb().prepare('SELECT 1 FROM runtime_existing_commit_admission WHERE workspace=?').get(gateKey) ||
          getDb().prepare("SELECT 1 FROM runtime_automation_runs WHERE status='running' LIMIT 1").get())
        refusal('verification_workspace_busy', 409);
      getDb().prepare('INSERT INTO runtime_existing_commit_admission(workspace,owner) VALUES(?,?)').run(gateKey, owner);
    }).immediate();
  }
  function assertConfig() {
    if (stopped || env.RONOR_AUTOMATION_ENABLED !== 'true') refusal('verification_disabled', 503);
    if (env.RONOR_AUTOMATION_RECOVERY_ENABLED === 'true')
      refusal('verification_requires_recovery_disabled', 503);
    for (const name of ['RONOR_AUTOMATION_WORKTREE', 'RONOR_AUTOMATION_WORKSPACE_ROOT',
      'RONOR_AUTOMATION_BRANCH', 'RONOR_AUTOMATION_EXPECTED_ORIGIN', 'RONOR_AUTOMATION_EXPECTED_HEAD',
      'RONOR_AUTOMATION_ARTIFACT_ROOT']) if (!env[name]) refusal('verification_configuration_missing', 503);
    const secrets = [key, env.RONOR_AUTOMATION_CAPABILITY_KEY, env.RONOR_EVIDENCE_RUNNER_TOKEN,
      env.RONOR_CODEX_VERIFIER_TOKEN, env.RONOR_ASSURANCE_TOKEN];
    if (secrets.some(s => !s || Buffer.byteLength(s) < 32) || new Set(secrets).size !== secrets.length)
      refusal('verification_identity_refused', 503);
    for (const [name, host] of [
      ['RONOR_EVIDENCE_RUNNER_URL', 'automation-evidence-runner'],
      ['RONOR_CODEX_VERIFIER_URL', 'codex-verifier'], ['RONOR_ASSURANCE_URL', 'victoria-assurance'],
    ]) {
      try {
        const url = new URL(env[name]!);
        if (url.protocol !== 'http:' || url.hostname !== host || url.pathname !== '/' ||
            url.username || url.password || url.search || url.hash) throw new Error();
      } catch { refusal('verification_endpoint_refused', 503); }
    }
  }
  const fetcher = options.fetcher ?? fetch;
  const reconciler = createCostReconciler({
    baseUrl: env.RONOR_MODEL_EGRESS_URL, key: env.RONOR_AUTOMATION_CAPABILITY_KEY, fetcher,
  });
  /** A run that ends without a reported cost is not a free run. Read the settled
   * ledger once, record it beside the reported figure and never in its place. */
  async function reconcile(id: string) {
    let row: RecordState | null;
    try { row = store.read(id); } catch { return; }
    if (!row || active(row.status) || row.cost_usd !== null || row.observed) return;
    const observed = await reconciler.observe(id);
    if (!observed) return;
    try {
      const current = store.read(id);
      if (current && !active(current.status) && current.cost_usd === null && !current.observed)
        change(current, { observed });
    } catch { /* Integrity loss is not repaired by an accounting note. */ }
  }
  // Runs killed with the process never reached their own accounting. Observe
  // them once at start so a restart cannot silently erase what was spent.
  setImmediate(() => {
    let ids: string[] = [];
    try { ids = store.allIds(); } catch { return; }
    for (const id of ids) void reconcile(id).catch(() => { /* Accounting is best effort. */ });
  });
  async function attestAuthority(baseUrl: string, token: string, service: string, protocol: string, capability: string, signal: AbortSignal) {
    const response = await fetcher(new URL('/health', baseUrl), {
      method: 'GET', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error('authority_http_refused');
    const body = await readBoundedVerificationJson(response, 8192);
    if (body.ok !== true || body.service_id !== service || body.protocol !== protocol ||
        !Array.isArray(body.capabilities) || !body.capabilities.includes(capability))
      throw new Error('authority_identity_refused');
  }
  function guard(id: string, signal: AbortSignal) {
    const row = store.read(id);
    if (!row || signal.aborted || !active(row.status) || Date.now() >= Date.parse(row.mandate.expires_at) ||
        row.policy_digest !== policyDigest()) throw new Error('verification_interrupted');
    return row;
  }
  async function execute(id: string, control: AbortController) {
    let phase: Status = 'queued';
    const initial = store.read(id)!;
    const timeout = setTimeout(() => {
      try {
        const row = store.read(id)!;
        if (active(row.status)) change(row, { status: 'failed', reason: 'verification_deadline_exceeded',
          ...(row.status === 'codex' ? { cost_usd: null } : {}) });
      } catch { /* A corrupt row stays closed; never throw from a timer. */ }
      finally { control.abort(); }
    }, Math.max(1, Date.parse(initial.mandate.expires_at) - Date.now()));
    try {
      guard(id, control.signal);
      const evidenceRunner = createHttpPostExecutionVerifier({
        baseUrl: env.RONOR_EVIDENCE_RUNNER_URL!, token: env.RONOR_EVIDENCE_RUNNER_TOKEN!, fetcher,
      });
      await evidenceRunner.attestExisting(control.signal);
      await attestAuthority(env.RONOR_CODEX_VERIFIER_URL!, env.RONOR_CODEX_VERIFIER_TOKEN!,
        'codex-verifier', 'ronor-codex-verifier/v1', 'verify', control.signal);
      await attestAuthority(env.RONOR_ASSURANCE_URL!, env.RONOR_ASSURANCE_TOKEN!,
        'victoria-assurance', 'ronor-assurance/v1', 'assure', control.signal);
      let row = guard(id, control.signal);
      const before = inspectExistingCommit(workspace(), row.request, policy());
      phase = 'evidence'; row = change(row, { status: phase });
      const result = await evidenceRunner.verifyExisting(id, row.request, row.mandate.expires_at, control.signal);
      row = guard(id, control.signal);
      const after = inspectExistingCommit(workspace(), row.request, policy());
      if (before.diff_sha256 !== after.diff_sha256) throw new Error('verification_workspace_changed');
      const artifacts = collector();
      const materials = artifacts.read(result.artifacts);
      const expectedNames = { git_diff: 'git.diff', git_status: 'git.status', test_report: 'test-report.json' };
      if (materials.length !== 3 || new Set(materials.map(m => m.artifact.kind)).size !== 3)
        throw new Error('verification_evidence_invalid');
      for (const material of materials) {
        const name = expectedNames[material.artifact.kind as keyof typeof expectedNames];
        if (!name || material.artifact.reference !== `${id}/${EXISTING_ASSIGNMENT}/${name}`)
          throw new Error('verification_evidence_invalid');
      }
      const diff = materials.find(m => m.artifact.kind === 'git_diff')!;
      const status = materials.find(m => m.artifact.kind === 'git_status')!;
      if (diff.artifact.sha256 !== before.diff_sha256 || status.content !== before.status.toString())
        throw new Error('verification_range_mismatch');
      const report = JSON.parse(materials.find(m => m.artifact.kind === 'test_report')!.content);
      if (report.schema !== 'ronor-test-report/v1' || report.passed !== true ||
          !Number.isInteger(report.command_count) || report.command_count < 1 || report.command_count > 20 ||
          !Array.isArray(report.results) || report.results.length !== report.command_count ||
          !report.results.every((r: Record<string, unknown>) => r && typeof r.id === 'string' &&
            /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(r.id) && r.passed === true && r.exit_code === 0 && r.signal === null))
        throw new Error('verification_tests_invalid');
      const evidence: VerificationEvidence = { claims: [
        'operation:verify-existing', `base:${row.request.base_commit}`, `head:${row.request.head_commit}`,
        `range-sha256:${before.diff_sha256}`, 'workspace:clean', 'tests:pass',
      ], artifacts: result.artifacts };
      phase = 'codex';
      row = change(row, { status: phase, evidence, evidence_digest: verificationEvidenceDigest(evidence), cost_usd: null });
      const codex = createCodexVerifierAdapter({
        baseUrl: env.RONOR_CODEX_VERIFIER_URL!, token: env.RONOR_CODEX_VERIFIER_TOKEN!,
        capabilityKey: env.RONOR_AUTOMATION_CAPABILITY_KEY, plaintextServiceHosts: ['codex-verifier'], fetcher,
        timeoutMs: Math.min(120_000, Date.parse(row.mandate.expires_at) - Date.now()),
      });
      const verdict = await codex.verify(id, evidence, control.signal, {
        mandate: row.mandate, budget: { run_id: id, accounted_cost_usd: 0 },
      });
      row = guard(id, control.signal);
      if (!verdict.ok || verdict.verdict !== 'pass' || verdict.cost_usd === null ||
          !Number.isFinite(verdict.cost_usd) || verdict.cost_usd < 0 || verdict.cost_usd > row.request.max_cost_usd ||
          !verdict.receipt || verdict.receipt.mission_id !== id || verdict.receipt.verdict !== 'pass' ||
          verdict.receipt.evidence_digest !== row.evidence_digest)
        throw new Error('verification_codex_refused');
      phase = 'victoria';
      row = change(row, { status: phase, receipt: verdict.receipt, cost_usd: verdict.cost_usd });
      // Victoria (not this controller) has the existing receipt public key and
      // must independently check the signature, freshness and artifact integrity.
      const assurance = createAssuranceAdapter({
        baseUrl: env.RONOR_ASSURANCE_URL!, token: env.RONOR_ASSURANCE_TOKEN!,
        plaintextServiceHosts: ['victoria-assurance'], fetcher,
        timeoutMs: Math.min(120_000, Date.parse(row.mandate.expires_at) - Date.now()),
      });
      const accepted = await assurance.accept(id, verdict, evidence, control.signal);
      row = guard(id, control.signal);
      if (!accepted.ok || accepted.verdict !== 'pass' || accepted.cost_usd !== 0 ||
          !accepted.evidence.includes('assurance:policy-pass')) throw new Error('verification_victoria_refused');
      artifacts.verify(evidence.artifacts);
      if (inspectExistingCommit(workspace(), row.request, policy()).diff_sha256 !== before.diff_sha256)
        throw new Error('verification_workspace_changed');
      row = guard(id, control.signal);
      change(row, { status: 'verified', victoria_accepted: true, reason: null });
    } catch (error) {
      try {
        const row = store.read(id)!;
        if (active(row.status)) {
          const reason = phase === 'codex' ? describeCodexFailure(error).code : `verification_${phase}_failed`;
          change(row, { status: 'failed', reason,
            ...(phase === 'codex' ? { cost_usd: error instanceof AutomationAdapterError ? error.cost_usd : null } : {}) });
        }
      } catch { /* Invalid persistent integrity cannot be repaired into success. */ }
    } finally {
      clearTimeout(timeout); running.delete(id);
      try {
        // Interrupted/cancelled remote calls may still be terminating. Retain
        // the workspace barrier until their signed deadline, not just until
        // fetch rejects. Only success or a health-only failure releases early.
        const row = store.read(id)!;
        if (row.status === 'verified' || row.status === 'failed' && phase === 'queued') release(id);
      } catch { /* Keep the admission barrier after integrity loss. */ }
      void reconcile(id).catch(() => { /* Accounting is best effort. */ });
    }
  }
  return {
    hasActive,
    beginDevelopmentAdmission() {
      const owner = `development_${crypto.randomUUID()}`;
      claim(owner);
      return () => release(owner);
    },
    start(body: unknown, architectKeyId: string, idempotencyKey: string) {
      assertConfig();
      if (!/^key_[a-f0-9]{12}$/.test(architectKeyId)) refusal('verification_authority_refused', 403);
      if (!/^[A-Za-z0-9_-]{8,120}$/.test(idempotencyKey)) refusal('verification_identifier_invalid', 400);
      if (!body || typeof body !== 'object' || Array.isArray(body)) refusal('verification_request_invalid', 400);
      const request = body as ExistingVerificationRequest;
      if (Object.keys(request).some(k => !['approved', 'base_commit', 'head_commit', 'max_cost_usd', 'max_runtime_minutes'].includes(k)) ||
          request.approved !== true || !validCommitPins(request) ||
          !Number.isFinite(request.max_cost_usd) || request.max_cost_usd <= 0 ||
          !Number.isInteger(request.max_runtime_minutes) || request.max_runtime_minutes < 1)
        refusal('verification_request_invalid', 400);
      const maxCost = Math.min(5, Number(env.RONOR_AUTOMATION_MAX_COST_USD ?? 5));
      const maxMinutes = Math.min(60, Number(env.RONOR_AUTOMATION_MAX_RUNTIME_MINUTES ?? 60));
      if (!Number.isFinite(maxCost) || !Number.isFinite(maxMinutes) ||
          request.max_cost_usd > maxCost || request.max_runtime_minutes > maxMinutes)
        refusal('verification_budget_refused');
      // Normalize property order before signing and idempotency comparison.
      const spec: ExistingVerificationRequest = { approved: true, base_commit: request.base_commit,
        head_commit: request.head_commit, max_cost_usd: request.max_cost_usd, max_runtime_minutes: request.max_runtime_minutes };
      const id = `verify_${hash(JSON.stringify([architectKeyId, idempotencyKey]))}`;
      const prior = store.read(id);
      if (prior) {
        if (JSON.stringify(prior.request) !== JSON.stringify(spec) || prior.policy_digest !== policyDigest())
          refusal('verification_idempotency_conflict', 409);
        return { created: false, verification: this.status(id, architectKeyId) };
      }
      if (spec.head_commit !== env.RONOR_AUTOMATION_EXPECTED_HEAD) refusal('verification_head_mismatch');
      claim(id);
      try {
      inspectExistingCommit(workspace(), spec, policy());
      collector(); // Require the configured artifact mount before dispatch.
      const mandate = issueArchitectMandate({
        architectKeyId, missionId: id, idempotencyKey, objective: `verify-existing/v1:${spec.base_commit}..${spec.head_commit}`,
        workspaceRoot: workspace(), branch: policy().branch, maxCostUsd: spec.max_cost_usd,
        maxRuntimeMinutes: spec.max_runtime_minutes, maxFixCycles: 0,
      }, { maxCostUsd: maxCost, maxRuntimeMinutes: maxMinutes, maxFixCycles: 0 }, key);
      const constrained = signMandateAuthority({ ...mandate, allowed_actions: ['read_repo', 'run_tests'],
        denied_actions: AUTOMATION_ACTIONS.filter(a => a !== 'read_repo' && a !== 'run_tests') }, key);
      const value: RecordState = {
        operation: 'verify-existing', verification_id: id, architect_key_id: architectKeyId,
        request: spec, policy_digest: policyDigest(), mandate: constrained,
        status: 'queued', reason: null, created_at: mandate.issued_at, updated_at: mandate.issued_at,
        evidence: null, evidence_digest: null, receipt: null, victoria_accepted: false, cost_usd: 0,
      };
      store.insert(value);
      const control = new AbortController(); running.set(id, control);
      setImmediate(() => { void execute(id, control).catch(() => { running.delete(id); }); });
      return { created: true, verification: publicStatus(value) };
      } catch (error) {
        release(id);
        const safe = new Set(['verification_pins_invalid', 'verification_workspace_refused',
          'verification_head_mismatch', 'verification_workspace_dirty', 'verification_workspace_timeout',
          'verification_empty_range_refused']);
        if (error instanceof Error && safe.has(error.message)) refusal(error.message);
        throw error;
      }
    },
    status(id: string, architectKeyId: string) {
      if (!/^verify_[a-f0-9]{64}$/.test(id)) return refusal('verification_not_found', 404);
      let row = store.read(id);
      if (!row || row.architect_key_id !== architectKeyId) return refusal('verification_not_found', 404);
      if (row.status === 'verified') {
        try { collector().verify(row.evidence!.artifacts); }
        catch { row = change(row, { status: 'failed', reason: 'verification_integrity_failed', victoria_accepted: false }); }
      }
      return publicStatus(row);
    },
    cancel(id: string, architectKeyId: string) {
      this.status(id, architectKeyId);
      let row = store.read(id)!;
      if (active(row.status)) row = change(row, { status: 'cancelled', reason: 'verification_cancelled' });
      running.get(id)?.abort();
      return publicStatus(row);
    },
    stop() {
      stopped = true;
      for (const [id, control] of running) {
        try {
          const row = store.read(id)!;
          if (active(row.status)) change(row, { status: 'interrupted', reason: 'verification_shutdown_interrupted' });
        } catch { /* Never continue after an integrity failure. */ }
        control.abort();
      }
    },
  };
}
