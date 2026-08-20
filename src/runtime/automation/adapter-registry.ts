import type { AutomationAdapters, VerificationVerdict } from './contracts';
import { createCodexVerifierAdapter, createLangGraphAdapter, createOpenHandsAdapter } from './adapters/http';

export interface AutomationAdapterStatus { enabled: boolean; ready: boolean; runner: string; adapters: Record<'langgraph' | 'openhands' | 'codex', string>; }

function endpointState(urlValue: string | undefined, tokenValue: string | undefined): string {
  if (!urlValue) return 'not-connected';
  try {
    const url = new URL(urlValue);
    const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return 'invalid-endpoint';
    if (!loopback && !tokenValue) return 'authentication-required';
    return 'configured-not-verified';
  } catch { return 'invalid-endpoint'; }
}

export function automationAdapterStatus(env: NodeJS.ProcessEnv): AutomationAdapterStatus {
  const enabled = env.RONOR_AUTOMATION_ENABLED === 'true';
  const states = {
    langgraph: endpointState(env.RONOR_LANGGRAPH_URL, env.RONOR_LANGGRAPH_TOKEN),
    openhands: endpointState(env.RONOR_OPENHANDS_URL, env.RONOR_OPENHANDS_TOKEN),
    codex: endpointState(env.RONOR_CODEX_VERIFIER_URL, env.RONOR_CODEX_VERIFIER_TOKEN),
  };
  if (states.openhands === 'configured-not-verified' && !env.RONOR_AUTOMATION_CAPABILITY_KEY) states.openhands = 'capability-key-required';
  const configured = Object.fromEntries(Object.entries(states).map(([name, state]) => [name, state === 'configured-not-verified'])) as Record<keyof typeof states, boolean>;
  return {
    enabled,
    ready: enabled && Object.values(configured).every(Boolean),
    runner: enabled ? 'enabled' : 'implemented-disabled',
    adapters: {
      langgraph: states.langgraph,
      openhands: states.openhands,
      codex: states.codex,
    },
  };
}

export function configuredAutomationAdapters(env: NodeJS.ProcessEnv): AutomationAdapters | null {
  const status = automationAdapterStatus(env);
  if (!status.ready) return null;
  const token = (name: string) => env[name] || undefined;
  return {
    langgraph: createLangGraphAdapter({ baseUrl: env.RONOR_LANGGRAPH_URL!, token: token('RONOR_LANGGRAPH_TOKEN') }),
    openhands: createOpenHandsAdapter({ baseUrl: env.RONOR_OPENHANDS_URL!, token: token('RONOR_OPENHANDS_TOKEN'), capabilityKey: env.RONOR_AUTOMATION_CAPABILITY_KEY }),
    codex: createCodexVerifierAdapter({ baseUrl: env.RONOR_CODEX_VERIFIER_URL!, token: token('RONOR_CODEX_VERIFIER_TOKEN') }),
    assurance: { async accept(_missionId: string, verdict: VerificationVerdict): Promise<VerificationVerdict> {
      return verdict.verdict === 'pass'
        ? { ok: true, verdict: 'pass', summary: 'Victoria accepted independent Codex evidence.', evidence: verdict.evidence, cost_usd: 0 }
        : { ok: false, verdict: 'fail', summary: 'Victoria rejected failed verification.', evidence: verdict.evidence, cost_usd: 0 };
    } },
  };
}
