import { AutomationAdapterError } from './adapters/http';
import crypto from 'crypto';

type Fetcher = typeof fetch;
export type AdapterName = 'langgraph' | 'openhands' | 'codex' | 'assurance' | 'evidence';
export interface AutomationAttestation {
  verified: Record<AdapterName, 'verified'>;
  verified_at: string;
  expires_at: string;
  fingerprint: string;
}

const EXPECTED_PROTOCOL: Record<AdapterName, string> = {
  langgraph: 'ronor-langgraph/v1',
  openhands: 'ronor-openhands-bridge/v1',
  codex: 'ronor-codex-verifier/v1',
  assurance: 'ronor-assurance/v1',
  evidence: 'ronor-evidence-runner/v1',
};
const EXPECTED_IDENTITY: Record<AdapterName, { service_id: string; capabilities: string[] }> = {
  langgraph: { service_id: 'langgraph', capabilities: ['plan'] },
  openhands: { service_id: 'openhands-bridge', capabilities: ['execute', 'cancel'] },
  codex: { service_id: 'codex-verifier', capabilities: ['verify'] },
  assurance: { service_id: 'victoria-assurance', capabilities: ['assure'] },
  evidence: { service_id: 'automation-evidence-runner', capabilities: ['git-evidence', 'allowlisted-tests'] },
};
const INTERNAL_SERVICE_HOST: Record<AdapterName, string> = {
  langgraph: 'langgraph', openhands: 'openhands-bridge', codex: 'codex-verifier', assurance: 'victoria-assurance',
  evidence: 'automation-evidence-runner',
};
const cache = new Map<string, AutomationAttestation>();

function fingerprint(env: NodeJS.ProcessEnv): string {
  return crypto.createHash('sha256').update(JSON.stringify([
    env.RONOR_AUTOMATION_ENABLED,
    env.RONOR_LANGGRAPH_URL, env.RONOR_LANGGRAPH_TOKEN,
    env.RONOR_OPENHANDS_URL, env.RONOR_OPENHANDS_TOKEN,
    env.RONOR_CODEX_VERIFIER_URL, env.RONOR_CODEX_VERIFIER_TOKEN,
    env.RONOR_ASSURANCE_URL, env.RONOR_ASSURANCE_TOKEN,
    env.RONOR_EVIDENCE_RUNNER_URL, env.RONOR_EVIDENCE_RUNNER_TOKEN,
  ])).digest('hex');
}

export function currentAutomationAttestation(env: NodeJS.ProcessEnv, now = new Date()): AutomationAttestation | null {
  const item = cache.get(fingerprint(env));
  if (!item || Date.parse(item.expires_at) <= now.getTime()) return null;
  return { ...item, verified: { ...item.verified } };
}

export function clearAutomationAttestations(): void { cache.clear(); }

function endpoint(name: AdapterName, baseUrl: string): URL {
  const base = new URL(baseUrl);
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(base.hostname);
  const internal = base.hostname.toLowerCase() === INTERNAL_SERVICE_HOST[name];
  if (name === 'evidence' && !internal) throw new AutomationAdapterError('attestation_endpoint_invalid');
  if (base.username || base.password || base.search || base.hash || (base.protocol !== 'https:' && !(base.protocol === 'http:' && (loopback || internal)))) throw new AutomationAdapterError('attestation_endpoint_invalid');
  const prefix = base.pathname === '/' ? '' : base.pathname.replace(/\/$/, '');
  return new URL(`${prefix}/health`, base.origin);
}

export async function attestAutomationAdapters(env: NodeJS.ProcessEnv, fetcher: Fetcher = fetch, options: { now?: () => Date; ttlMs?: number } = {}): Promise<AutomationAttestation> {
  const configured: Record<AdapterName, { url?: string; token?: string }> = {
    langgraph: { url: env.RONOR_LANGGRAPH_URL, token: env.RONOR_LANGGRAPH_TOKEN },
    openhands: { url: env.RONOR_OPENHANDS_URL, token: env.RONOR_OPENHANDS_TOKEN },
    codex: { url: env.RONOR_CODEX_VERIFIER_URL, token: env.RONOR_CODEX_VERIFIER_TOKEN },
    assurance: { url: env.RONOR_ASSURANCE_URL, token: env.RONOR_ASSURANCE_TOKEN },
    evidence: { url: env.RONOR_EVIDENCE_RUNNER_URL, token: env.RONOR_EVIDENCE_RUNNER_TOKEN },
  };
  const key = fingerprint(env);
  cache.delete(key);
  const verified = {} as Record<AdapterName, 'verified'>;
  for (const name of Object.keys(configured) as AdapterName[]) {
    const { url, token } = configured[name];
    if (!url || !token) throw new AutomationAdapterError(`attestation_${name}_not_configured`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetcher(endpoint(name, url), { method: 'GET', redirect: 'error', signal: controller.signal, headers: { authorization: `Bearer ${token}` } });
      if (!response.ok) throw new AutomationAdapterError(`attestation_${name}_http_${response.status}`);
      const declared = Number(response.headers.get('content-length') ?? 0);
      if (declared > 8_192) throw new AutomationAdapterError(`attestation_${name}_response_too_large`);
      const raw = await response.text();
      if (new TextEncoder().encode(raw).byteLength > 8_192) throw new AutomationAdapterError(`attestation_${name}_response_too_large`);
      let body: unknown;
      try { body = JSON.parse(raw); } catch { throw new AutomationAdapterError(`attestation_${name}_invalid`); }
      const record = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
      const identity = EXPECTED_IDENTITY[name];
      const capabilities = Array.isArray(record?.capabilities) ? record.capabilities : null;
      if (!record || record.ok !== true || record.protocol !== EXPECTED_PROTOCOL[name] || record.service_id !== identity.service_id ||
          !capabilities || !identity.capabilities.every((capability) => capabilities.includes(capability))) {
        throw new AutomationAdapterError(`attestation_${name}_protocol_mismatch`);
      }
      verified[name] = 'verified';
    } catch (error) {
      if (error instanceof AutomationAdapterError) throw error;
      throw new AutomationAdapterError(`attestation_${name}_unreachable`);
    } finally { clearTimeout(timer); }
  }
  const now = options.now?.() ?? new Date();
  const ttlMs = options.ttlMs ?? 30_000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 300_000) throw new AutomationAdapterError('attestation_ttl_invalid');
  const result: AutomationAttestation = {
    verified, verified_at: now.toISOString(), expires_at: new Date(now.getTime() + ttlMs).toISOString(), fingerprint: key,
  };
  cache.set(key, result);
  return { ...result, verified: { ...verified } };
}
