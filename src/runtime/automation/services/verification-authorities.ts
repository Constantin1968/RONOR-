import express from 'express';
import type { EvidenceArtifact, VerificationEvidence, VerificationVerdict } from '../contracts';
import type { WorkspaceArtifactCollector } from '../artifacts';
import { signVerificationReceipt, verifyVerificationReceipt } from '../verification-receipt';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const KINDS = new Set(['git_diff', 'git_status', 'test_report', 'event_log']);

export interface VerifiedMaterial { artifact: EvidenceArtifact; content: string; }
export interface CodexEvaluationPort {
  evaluate(input: { missionId: string; claims: string[]; materials: VerifiedMaterial[] }): Promise<{ verdict: 'pass' | 'fail'; summary: string; evidence: string[]; cost_usd: number }>;
}

function authorised(header: string | undefined, token: string): boolean { return header === `Bearer ${token}`; }

function parseEvidence(value: unknown): VerificationEvidence | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.claims) || raw.claims.length > 100 || !raw.claims.every((claim) => typeof claim === 'string' && claim.length > 0 && claim.length <= 2000) ||
      !Array.isArray(raw.artifacts) || raw.artifacts.length < 1 || raw.artifacts.length > 100) return null;
  const artifacts: EvidenceArtifact[] = [];
  const references = new Set<string>();
  for (const item of raw.artifacts) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const artifact = item as Record<string, unknown>;
    if (!KINDS.has(String(artifact.kind)) || typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
        typeof artifact.reference !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,499}$/.test(artifact.reference) || artifact.reference.includes('..') ||
        typeof artifact.bytes !== 'number' || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0) return null;
    if (references.has(artifact.reference as string)) return null;
    references.add(artifact.reference as string);
    artifacts.push(artifact as unknown as EvidenceArtifact);
  }
  return { claims: raw.claims as string[], artifacts };
}

function hasRequiredEvidence(evidence: VerificationEvidence): boolean {
  const kinds = new Set(evidence.artifacts.map((item) => item.kind));
  return kinds.has('git_diff') && kinds.has('git_status') && kinds.has('test_report');
}

function testMaterialsProvePass(evidence: VerificationEvidence, materials: VerifiedMaterial[]): boolean {
  if (!evidence.claims.includes('tests:pass') || evidence.claims.some((claim) => /(?:tests?|test:[^:]+):fail/i.test(claim))) return false;
  const reports = materials.filter((item) => item.artifact.kind === 'test_report');
  if (reports.length < 1) return false;
  return reports.every(({ content }) => {
    try {
      const report = JSON.parse(content) as Record<string, unknown>;
      if (report.schema !== 'ronor-test-report/v1' || report.passed !== true ||
          !Number.isInteger(report.command_count) || Number(report.command_count) < 1 ||
          !Array.isArray(report.results) || report.results.length !== report.command_count) return false;
      return report.results.every((raw) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
        const result = raw as Record<string, unknown>;
        return typeof result.id === 'string' && SAFE_ID.test(result.id) && result.passed === true &&
          result.exit_code === 0 && result.signal === null;
      });
    } catch { return false; }
  });
}

export function createCodexVerifierApp(config: { serviceToken: string; receiptPrivateKey: string; artifacts: WorkspaceArtifactCollector; evaluator: CodexEvaluationPort; now?: () => Date }) {
  const app = express(); app.disable('x-powered-by'); app.use(express.json({ limit: '256kb' }));
  app.get('/health', (req, res) => authorised(req.header('authorization'), config.serviceToken) ? res.json({ ok: true, protocol: 'ronor-codex-verifier/v1', service_id: 'codex-verifier', capabilities: ['verify'] }) : res.status(401).json({ ok: false, error: 'unauthorized' }));
  app.post('/v1/verify', async (req, res) => {
    if (!authorised(req.header('authorization'), config.serviceToken)) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
    const missionId = req.body?.mission_id; const evidence = parseEvidence(req.body?.evidence);
    if (typeof missionId !== 'string' || !SAFE_ID.test(missionId) || !evidence) { res.status(400).json({ ok: false, error: 'invalid_verification_request' }); return; }
    if (!hasRequiredEvidence(evidence)) { res.status(422).json({ ok: false, verdict: 'fail', summary: 'Required independent evidence is incomplete.', evidence: ['required-evidence:missing'], cost_usd: 0 }); return; }
    try {
      const materials = config.artifacts.read(evidence.artifacts);
      if (!testMaterialsProvePass(evidence, materials)) {
        res.status(422).json({ ok: false, verdict: 'fail', summary: 'Test evidence does not deterministically prove a passing run.', evidence: ['test-evidence:invalid'], cost_usd: 0 });
        return;
      }
      const verdict = await config.evaluator.evaluate({ missionId, claims: evidence.claims, materials });
      if (!verdict || !['pass', 'fail'].includes(verdict.verdict) || typeof verdict.summary !== 'string' || verdict.summary.length > 4000 || !Array.isArray(verdict.evidence) || verdict.evidence.length > 50 || !verdict.evidence.every((item) => typeof item === 'string' && item.length <= 2000) || !Number.isFinite(verdict.cost_usd) || verdict.cost_usd < 0) throw new Error('invalid_evaluator_result');
      const receipt = signVerificationReceipt({ privateKeyPem: config.receiptPrivateKey, missionId, verdict: verdict.verdict, evidence, now: config.now?.() });
      res.status(verdict.verdict === 'pass' ? 200 : 422).json({ ok: verdict.verdict === 'pass', ...verdict, receipt });
    } catch { res.status(422).json({ ok: false, verdict: 'fail', summary: 'Independent verification failed closed.', evidence: ['verification:failed-closed'], cost_usd: 0 }); }
  });
  return app;
}

export function createAssuranceAuthorityApp(config: { serviceToken: string; receiptPublicKey: string; artifacts: WorkspaceArtifactCollector; now?: () => Date }) {
  const app = express(); app.disable('x-powered-by'); app.use(express.json({ limit: '256kb' }));
  app.get('/health', (req, res) => authorised(req.header('authorization'), config.serviceToken) ? res.json({ ok: true, protocol: 'ronor-assurance/v1', service_id: 'victoria-assurance', capabilities: ['assure'] }) : res.status(401).json({ ok: false, error: 'unauthorized' }));
  app.post('/v1/assure', (req, res) => {
    if (!authorised(req.header('authorization'), config.serviceToken)) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
    const missionId = req.body?.mission_id; const verification = req.body?.verification as Record<string, unknown> | undefined; const evidence = parseEvidence(req.body?.evidence);
    if (typeof missionId !== 'string' || !SAFE_ID.test(missionId) || !verification || !evidence) { res.status(400).json({ ok: false, error: 'invalid_assurance_request' }); return; }
    let materials: VerifiedMaterial[];
    try { materials = config.artifacts.read(evidence.artifacts); } catch { res.status(422).json({ ok: false, verdict: 'fail', summary: 'Evidence integrity could not be independently assured.', evidence: ['assurance:integrity-failed'], cost_usd: 0 }); return; }
    const receipt = verification.receipt as VerificationVerdict['receipt'];
    const receiptValid = Boolean(receipt && verifyVerificationReceipt({
      publicKeyPem: config.receiptPublicKey, receipt, missionId, verdict: verification.verdict as 'pass' | 'fail', evidence, now: config.now?.(),
    }));
    const accepted = verification.verdict === 'pass' && receiptValid && hasRequiredEvidence(evidence) && testMaterialsProvePass(evidence, materials);
    const verdict: VerificationVerdict = { ok: accepted, verdict: accepted ? 'pass' : 'fail', summary: accepted ? 'Victoria independently accepted the verified evidence envelope.' : 'Victoria refused an incomplete or failed evidence envelope.', evidence: [accepted ? 'assurance:policy-pass' : 'assurance:policy-fail'], cost_usd: 0 };
    res.status(accepted ? 200 : 422).json(verdict);
  });
  return app;
}
