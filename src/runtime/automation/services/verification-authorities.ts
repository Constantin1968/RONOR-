import express from 'express';
import type { EvidenceArtifact, VerificationEvidence, VerificationVerdict } from '../contracts';
import type { WorkspaceArtifactCollector } from '../artifacts';

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
  for (const item of raw.artifacts) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const artifact = item as Record<string, unknown>;
    if (!KINDS.has(String(artifact.kind)) || typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
        typeof artifact.reference !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,499}$/.test(artifact.reference) || artifact.reference.includes('..') ||
        typeof artifact.bytes !== 'number' || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0) return null;
    artifacts.push(artifact as unknown as EvidenceArtifact);
  }
  return { claims: raw.claims as string[], artifacts };
}

function hasRequiredEvidence(evidence: VerificationEvidence): boolean {
  const kinds = new Set(evidence.artifacts.map((item) => item.kind));
  return kinds.has('git_diff') && kinds.has('git_status') && kinds.has('test_report');
}

export function createCodexVerifierApp(config: { serviceToken: string; artifacts: WorkspaceArtifactCollector; evaluator: CodexEvaluationPort }) {
  const app = express(); app.disable('x-powered-by'); app.use(express.json({ limit: '256kb' }));
  app.get('/health', (req, res) => authorised(req.header('authorization'), config.serviceToken) ? res.json({ ok: true, protocol: 'ronor-codex-verifier/v1', service_id: 'codex-verifier', capabilities: ['verify'] }) : res.status(401).json({ ok: false, error: 'unauthorized' }));
  app.post('/v1/verify', async (req, res) => {
    if (!authorised(req.header('authorization'), config.serviceToken)) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
    const missionId = req.body?.mission_id; const evidence = parseEvidence(req.body?.evidence);
    if (typeof missionId !== 'string' || !SAFE_ID.test(missionId) || !evidence) { res.status(400).json({ ok: false, error: 'invalid_verification_request' }); return; }
    if (!hasRequiredEvidence(evidence)) { res.status(422).json({ ok: false, verdict: 'fail', summary: 'Required independent evidence is incomplete.', evidence: ['required-evidence:missing'], cost_usd: 0 }); return; }
    try {
      const materials = config.artifacts.read(evidence.artifacts);
      const verdict = await config.evaluator.evaluate({ missionId, claims: evidence.claims, materials });
      if (!verdict || !['pass', 'fail'].includes(verdict.verdict) || typeof verdict.summary !== 'string' || verdict.summary.length > 4000 || !Array.isArray(verdict.evidence) || verdict.evidence.length > 50 || !verdict.evidence.every((item) => typeof item === 'string' && item.length <= 2000) || !Number.isFinite(verdict.cost_usd) || verdict.cost_usd < 0) throw new Error('invalid_evaluator_result');
      res.status(verdict.verdict === 'pass' ? 200 : 422).json({ ok: verdict.verdict === 'pass', ...verdict });
    } catch { res.status(422).json({ ok: false, verdict: 'fail', summary: 'Independent verification failed closed.', evidence: ['verification:failed-closed'], cost_usd: 0 }); }
  });
  return app;
}

export function createAssuranceAuthorityApp(config: { serviceToken: string; artifacts: WorkspaceArtifactCollector }) {
  const app = express(); app.disable('x-powered-by'); app.use(express.json({ limit: '256kb' }));
  app.get('/health', (req, res) => authorised(req.header('authorization'), config.serviceToken) ? res.json({ ok: true, protocol: 'ronor-assurance/v1', service_id: 'victoria-assurance', capabilities: ['assure'] }) : res.status(401).json({ ok: false, error: 'unauthorized' }));
  app.post('/v1/assure', (req, res) => {
    if (!authorised(req.header('authorization'), config.serviceToken)) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
    const missionId = req.body?.mission_id; const verification = req.body?.verification as Record<string, unknown> | undefined; const evidence = parseEvidence(req.body?.evidence);
    if (typeof missionId !== 'string' || !SAFE_ID.test(missionId) || !verification || !evidence) { res.status(400).json({ ok: false, error: 'invalid_assurance_request' }); return; }
    try { config.artifacts.verify(evidence.artifacts); } catch { res.status(422).json({ ok: false, verdict: 'fail', summary: 'Evidence integrity could not be independently assured.', evidence: ['assurance:integrity-failed'], cost_usd: 0 }); return; }
    const accepted = verification.verdict === 'pass' && hasRequiredEvidence(evidence) && evidence.claims.some((claim) => /test/i.test(claim));
    const verdict: VerificationVerdict = { ok: accepted, verdict: accepted ? 'pass' : 'fail', summary: accepted ? 'Victoria independently accepted the verified evidence envelope.' : 'Victoria refused an incomplete or failed evidence envelope.', evidence: [accepted ? 'assurance:policy-pass' : 'assurance:policy-fail'], cost_usd: 0 };
    res.status(accepted ? 200 : 422).json(verdict);
  });
  return app;
}
