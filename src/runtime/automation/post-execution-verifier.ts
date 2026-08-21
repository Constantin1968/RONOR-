import type { EvidenceArtifact } from './contracts';

export interface PostExecutionVerification {
  passed: boolean;
  claims: string[];
  artifacts: EvidenceArtifact[];
}

export interface PostExecutionVerifier {
  attest(): Promise<void>;
  verify(runId: string, assignmentId: string, runTests: boolean, signal?: AbortSignal): Promise<PostExecutionVerification>;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

export function createHttpPostExecutionVerifier(config: {
  baseUrl: string; token: string; fetcher?: typeof fetch; timeoutMs?: number;
}): PostExecutionVerifier {
  const base = new URL(config.baseUrl);
  if (base.protocol !== 'http:' || base.hostname !== 'automation-evidence-runner' || (base.pathname !== '/' && base.pathname !== '') || base.username || base.password || base.search || base.hash) {
    throw new Error('evidence_runner_endpoint_invalid');
  }
  if (!config.token) throw new Error('evidence_runner_token_required');
  return {
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
