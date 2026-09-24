import type { EvidenceArtifact } from './contracts';
import { validCommitPins, type CommitPins } from './existing-commit-workspace';

export interface PostExecutionVerification {
  passed: boolean;
  claims: string[];
  artifacts: EvidenceArtifact[];
}

export interface PostExecutionVerifier {
  attest(): Promise<void>;
  verify(runId: string, assignmentId: string, runTests: boolean, signal?: AbortSignal): Promise<PostExecutionVerification>;
}

export interface ExistingCommitVerifier {
  attestExisting(signal?: AbortSignal): Promise<void>;
  verifyExisting(runId: string, pins: CommitPins, deadline: string, signal: AbortSignal): Promise<PostExecutionVerification>;
}

export async function readBoundedVerificationJson(response: Response, limit: number): Promise<Record<string, unknown>> {
  if (Number(response.headers.get('content-length') ?? 0) > limit) throw new Error('verification_response_too_large');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('verification_response_invalid');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new Error('verification_response_too_large');
      chunks.push(value);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('verification_response_invalid');
    return value;
  } finally { await reader.cancel().catch(() => {}); }
}

function parseArtifacts(body: Record<string, unknown>): PostExecutionVerification {
  if (typeof body.passed !== 'boolean' || !Array.isArray(body.claims) ||
      body.claims.length > 100 || !body.claims.every(item => typeof item === 'string' && item.length <= 2000) ||
      !Array.isArray(body.artifacts)) throw new Error('evidence_runner_response_invalid');
  const artifacts = body.artifacts as EvidenceArtifact[];
  if (artifacts.length < 2 || artifacts.length > 3 || !artifacts.every(item => item &&
      ['git_diff', 'git_status', 'test_report'].includes(item.kind) && /^[a-f0-9]{64}$/.test(item.sha256) &&
      Number.isSafeInteger(item.bytes) && item.bytes >= 0 &&
      /^[A-Za-z0-9][A-Za-z0-9._/-]{0,499}$/.test(item.reference) && !item.reference.includes('..')))
    throw new Error('evidence_runner_artifacts_invalid');
  return { passed: body.passed, claims: body.claims as string[], artifacts };
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

export function createHttpPostExecutionVerifier(config: {
  baseUrl: string; token: string; fetcher?: typeof fetch; timeoutMs?: number;
}): PostExecutionVerifier & ExistingCommitVerifier {
  const base = new URL(config.baseUrl);
  if (base.protocol !== 'http:' || base.hostname !== 'automation-evidence-runner' || (base.pathname !== '/' && base.pathname !== '') || base.username || base.password || base.search || base.hash) {
    throw new Error('evidence_runner_endpoint_invalid');
  }
  if (!config.token) throw new Error('evidence_runner_token_required');
  return {
    async attestExisting(signal) {
      const response = await (config.fetcher ?? fetch)(new URL('/health', base), {
        method: 'GET', redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]),
        headers: { authorization: `Bearer ${config.token}` },
      });
      if (!response.ok) throw new Error('evidence_runner_attestation_failed');
      const body = await readBoundedVerificationJson(response, 8192);
      if (body.ok !== true || body.protocol !== 'ronor-evidence-runner/v1' ||
          body.service_id !== 'automation-evidence-runner' || !Array.isArray(body.capabilities) ||
          !['git-evidence', 'allowlisted-tests', 'verify-existing'].every(c => (body.capabilities as unknown[]).includes(c)))
        throw new Error('evidence_runner_identity_mismatch');
    },
    async verifyExisting(runId, pins, deadline, signal) {
      if (!/^verify_[a-f0-9]{64}$/.test(runId) || !validCommitPins(pins) ||
          !Number.isFinite(Date.parse(deadline)) || Date.parse(deadline) <= Date.now() || signal.aborted)
        throw new Error('existing_verification_request_invalid');
      const remaining = Math.min(Date.parse(deadline) - Date.now(), config.timeoutMs ?? 60 * 60_000);
      const response = await (config.fetcher ?? fetch)(new URL('/v1/verify-existing', base), {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, remaining))]),
        headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ run_id: runId, base_commit: pins.base_commit, head_commit: pins.head_commit, deadline }),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error('existing_evidence_runner_failed'); }
      const result = parseArtifacts(await readBoundedVerificationJson(response, 128 * 1024));
      if (!result.passed || result.artifacts.length !== 3) throw new Error('existing_tests_failed');
      return result;
    },
    async attest() {
      const response = await (config.fetcher ?? fetch)(new URL('/health', base), { method: 'GET', redirect: 'error', headers: { authorization: `Bearer ${config.token}` } });
      if (!response.ok) throw new Error('evidence_runner_attestation_failed');
      const raw = await response.text(); if (Buffer.byteLength(raw) > 16 * 1024) throw new Error('evidence_runner_attestation_too_large');
      const body = JSON.parse(raw) as Record<string, unknown>;
      const capabilities = Array.isArray(body.capabilities) ? body.capabilities : [];
      if (body.protocol !== 'ronor-evidence-runner/v1' || body.service_id !== 'automation-evidence-runner' || !['git-evidence', 'allowlisted-tests'].every((item) => capabilities.includes(item))) throw new Error('evidence_runner_identity_mismatch');
    },
    async verify(runId, assignmentId, runTests, signal) {
    if (!SAFE_ID.test(runId) || !SAFE_ID.test(assignmentId)) throw new Error('evidence_runner_identifier_invalid');
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 30 * 60_000);
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await (config.fetcher ?? fetch)(new URL('/v1/verify', base), {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ run_id: runId, assignment_id: assignmentId, run_tests: runTests }),
      });
      if (!response.ok) throw new Error('evidence_runner_failed');
      const raw = await response.text();
      if (Buffer.byteLength(raw) > 128 * 1024) throw new Error('evidence_runner_response_too_large');
      const body = JSON.parse(raw) as Record<string, unknown>;
      if (typeof body.passed !== 'boolean' || !Array.isArray(body.claims) || !body.claims.every((item) => typeof item === 'string') || !Array.isArray(body.artifacts)) throw new Error('evidence_runner_response_invalid');
      const artifacts = body.artifacts as EvidenceArtifact[];
      if (artifacts.length < 2 || artifacts.length > 3 || !artifacts.every((item) => item && ['git_diff', 'git_status', 'test_report'].includes(item.kind) && /^[a-f0-9]{64}$/.test(item.sha256) && Number.isSafeInteger(item.bytes) && item.bytes >= 0 && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,499}$/.test(item.reference) && !item.reference.includes('..'))) throw new Error('evidence_runner_artifacts_invalid');
      return { passed: body.passed, claims: body.claims as string[], artifacts };
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
    },
  };
}
