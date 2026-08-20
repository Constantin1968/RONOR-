import { AutomationAdapterError } from './adapters/http';

type Fetcher = typeof fetch;
type AdapterName = 'langgraph' | 'openhands' | 'codex' | 'assurance';

const EXPECTED_PROTOCOL: Record<AdapterName, string> = {
  langgraph: 'ronor-langgraph/v1',
  openhands: 'ronor-openhands-bridge/v1',
  codex: 'ronor-codex-verifier/v1',
  assurance: 'ronor-assurance/v1',
};

function endpoint(baseUrl: string): URL {
  const base = new URL(baseUrl);
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(base.hostname);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) throw new AutomationAdapterError('attestation_endpoint_invalid');
  const prefix = base.pathname === '/' ? '' : base.pathname.replace(/\/$/, '');
  return new URL(`${prefix}/health`, base.origin);
}

export async function attestAutomationAdapters(env: NodeJS.ProcessEnv, fetcher: Fetcher = fetch): Promise<Record<AdapterName, 'verified'>> {
  const configured: Record<AdapterName, { url?: string; token?: string }> = {
    langgraph: { url: env.RONOR_LANGGRAPH_URL, token: env.RONOR_LANGGRAPH_TOKEN },
    openhands: { url: env.RONOR_OPENHANDS_URL, token: env.RONOR_OPENHANDS_TOKEN },
    codex: { url: env.RONOR_CODEX_VERIFIER_URL, token: env.RONOR_CODEX_VERIFIER_TOKEN },
    assurance: { url: env.RONOR_ASSURANCE_URL, token: env.RONOR_ASSURANCE_TOKEN },
  };
  const verified = {} as Record<AdapterName, 'verified'>;
  for (const name of Object.keys(configured) as AdapterName[]) {
    const { url, token } = configured[name];
    if (!url || !token) throw new AutomationAdapterError(`attestation_${name}_not_configured`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetcher(endpoint(url), { method: 'GET', redirect: 'error', signal: controller.signal, headers: { authorization: `Bearer ${token}` } });
      if (!response.ok) throw new AutomationAdapterError(`attestation_${name}_http_${response.status}`);
      const declared = Number(response.headers.get('content-length') ?? 0);
      if (declared > 8_192) throw new AutomationAdapterError(`attestation_${name}_response_too_large`);
      const raw = await response.text();
      if (new TextEncoder().encode(raw).byteLength > 8_192) throw new AutomationAdapterError(`attestation_${name}_response_too_large`);
      let body: unknown;
      try { body = JSON.parse(raw); } catch { throw new AutomationAdapterError(`attestation_${name}_invalid`); }
      if (!body || typeof body !== 'object' || Array.isArray(body) || (body as Record<string, unknown>).ok !== true || (body as Record<string, unknown>).protocol !== EXPECTED_PROTOCOL[name]) {
        throw new AutomationAdapterError(`attestation_${name}_protocol_mismatch`);
      }
      verified[name] = 'verified';
    } catch (error) {
      if (error instanceof AutomationAdapterError) throw error;
      throw new AutomationAdapterError(`attestation_${name}_unreachable`);
    } finally { clearTimeout(timer); }
  }
  return verified;
}
