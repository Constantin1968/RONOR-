import type { AutomationAdapters } from './contracts';
import { createAssuranceAdapter, createCodexVerifierAdapter, createLangGraphAdapter, createOpenHandsAdapter } from './adapters/http';
import { currentAutomationAttestation } from './attestation';

type AdapterStatusName = 'langgraph' | 'openhands' | 'codex' | 'assurance' | 'evidence';
export interface AutomationAdapterStatus { enabled: boolean; configured: boolean; ready: boolean; runner: string; attested_at: string | null; attestation_expires_at: string | null; adapters: Record<AdapterStatusName, string>; }

function sameIdentity(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  // Different URL paths behind one origin are still one failure/trust domain.
  try { const a = new URL(left); const b = new URL(right); return a.origin === b.origin; }
  catch { return false; }
}

const INTERNAL_SERVICE_HOST: Record<AdapterStatusName, string> = {
  langgraph: 'langgraph', openhands: 'openhands-bridge', codex: 'codex-verifier', assurance: 'victoria-assurance',
  evidence: 'automation-evidence-runner',
};

function endpointState(name: keyof typeof INTERNAL_SERVICE_HOST, urlValue: string | undefined, tokenValue: string | undefined): string {
  if (!urlValue) return 'not-connected';
  try {
    const url = new URL(urlValue);
    const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    const internal = url.hostname.toLowerCase() === INTERNAL_SERVICE_HOST[name];
    if (name === 'evidence' && !internal) return 'invalid-endpoint';
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && (loopback || internal)))) return 'invalid-endpoint';
    if (!tokenValue) return 'authentication-required';
    return 'configured-not-verified';
  } catch { return 'invalid-endpoint'; }
}

export function automationAdapterStatus(env: NodeJS.ProcessEnv): AutomationAdapterStatus {
  const enabled = env.RONOR_AUTOMATION_ENABLED === 'true';
  const states = {
    langgraph: endpointState('langgraph', env.RONOR_LANGGRAPH_URL, env.RONOR_LANGGRAPH_TOKEN),
    openhands: endpointState('openhands', env.RONOR_OPENHANDS_URL, env.RONOR_OPENHANDS_TOKEN),
    codex: endpointState('codex', env.RONOR_CODEX_VERIFIER_URL, env.RONOR_CODEX_VERIFIER_TOKEN),
    assurance: endpointState('assurance', env.RONOR_ASSURANCE_URL, env.RONOR_ASSURANCE_TOKEN),
    evidence: endpointState('evidence', env.RONOR_EVIDENCE_RUNNER_URL, env.RONOR_EVIDENCE_RUNNER_TOKEN),
  };
  if (states.openhands === 'configured-not-verified' && !env.RONOR_AUTOMATION_CAPABILITY_KEY) states.openhands = 'capability-key-required';
  const criticalUrls = [env.RONOR_OPENHANDS_URL, env.RONOR_CODEX_VERIFIER_URL, env.RONOR_ASSURANCE_URL, env.RONOR_EVIDENCE_RUNNER_URL];
  const criticalTokens = [env.RONOR_OPENHANDS_TOKEN, env.RONOR_CODEX_VERIFIER_TOKEN, env.RONOR_ASSURANCE_TOKEN, env.RONOR_EVIDENCE_RUNNER_TOKEN];
  const identityConflict = criticalUrls.some((left, index) => criticalUrls.slice(index + 1).some((right) => sameIdentity(left, right))) ||
    criticalTokens.some((left, index) => Boolean(left && criticalTokens.slice(index + 1).includes(left)));
  if (identityConflict) { states.openhands = 'identity-conflict'; states.codex = 'identity-conflict'; states.assurance = 'identity-conflict'; states.evidence = 'identity-conflict'; }
  const configuredParts = Object.fromEntries(Object.entries(states).map(([name, state]) => [name, state === 'configured-not-verified'])) as Record<keyof typeof states, boolean>;
  const configured = enabled && Object.values(configuredParts).every(Boolean);
  const attestation = configured ? currentAutomationAttestation(env) : null;
  return {
    enabled,
    configured,
    ready: configured && Boolean(attestation),
    runner: enabled ? 'enabled' : 'implemented-disabled',
    attested_at: attestation?.verified_at ?? null,
    attestation_expires_at: attestation?.expires_at ?? null,
    adapters: attestation ? { langgraph: 'verified', openhands: 'verified', codex: 'verified', assurance: 'verified', evidence: 'verified' } : states,
  };
}

export function configuredAutomationAdapters(env: NodeJS.ProcessEnv): AutomationAdapters | null {
  const status = automationAdapterStatus(env);
  if (!status.ready) return null;
  const token = (name: string) => env[name] || undefined;
  return {
    langgraph: createLangGraphAdapter({ baseUrl: env.RONOR_LANGGRAPH_URL!, token: token('RONOR_LANGGRAPH_TOKEN'), plaintextServiceHosts: [INTERNAL_SERVICE_HOST.langgraph] }),
    openhands: createOpenHandsAdapter({ baseUrl: env.RONOR_OPENHANDS_URL!, token: token('RONOR_OPENHANDS_TOKEN'), capabilityKey: env.RONOR_AUTOMATION_CAPABILITY_KEY, plaintextServiceHosts: [INTERNAL_SERVICE_HOST.openhands] }),
    codex: createCodexVerifierAdapter({ baseUrl: env.RONOR_CODEX_VERIFIER_URL!, token: token('RONOR_CODEX_VERIFIER_TOKEN'), plaintextServiceHosts: [INTERNAL_SERVICE_HOST.codex] }),
    assurance: createAssuranceAdapter({ baseUrl: env.RONOR_ASSURANCE_URL!, token: token('RONOR_ASSURANCE_TOKEN'), plaintextServiceHosts: [INTERNAL_SERVICE_HOST.assurance] }),
  };
}
