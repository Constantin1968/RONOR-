import type { AutomationAdapters, VerificationVerdict } from './contracts';
import { createCodexVerifierAdapter, createLangGraphAdapter, createOpenHandsAdapter } from './adapters/http';

export interface AutomationAdapterStatus { enabled: boolean; ready: boolean; runner: string; adapters: Record<'langgraph' | 'openhands' | 'codex', string>; }

function endpointConfigured(urlValue: string | undefined, tokenValue: string | undefined): boolean {
  if (!urlValue) return false;
  try {
    const url = new URL(urlValue);
    const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    return loopback || Boolean(tokenValue);
  } catch { return false; }
}

export function automationAdapterStatus(env: NodeJS.ProcessEnv): AutomationAdapterStatus {
  const enabled = env.RONOR_AUTOMATION_ENABLED === 'true';
  const configured = {
    langgraph: endpointConfigured(env.RONOR_LANGGRAPH_URL, env.RONOR_LANGGRAPH_TOKEN),
    openhands: endpointConfigured(env.RONOR_OPENHANDS_URL, env.RONOR_OPENHANDS_TOKEN),
    codex: endpointConfigured(env.RONOR_CODEX_VERIFIER_URL, env.RONOR_CODEX_VERIFIER_TOKEN),
  };
  return {
    enabled,
    ready: enabled && Object.values(configured).every(Boolean),
    runner: enabled ? 'enabled' : 'implemented-disabled',
    adapters: {
      langgraph: configured.langgraph ? 'configured-not-verified' : 'not-connected',
      openhands: configured.openhands ? 'configured-not-verified' : 'not-connected',
      codex: configured.codex ? 'configured-not-verified' : 'not-connected',
    },
  };
}

export function configuredAutomationAdapters(env: NodeJS.ProcessEnv): AutomationAdapters | null {
  const status = automationAdapterStatus(env);
  if (!status.ready) return null;
  const token = (name: string) => env[name] || undefined;
  return {
    langgraph: createLangGraphAdapter({ baseUrl: env.RONOR_LANGGRAPH_URL!, token: token('RONOR_LANGGRAPH_TOKEN') }),
    openhands: createOpenHandsAdapter({ baseUrl: env.RONOR_OPENHANDS_URL!, token: token('RONOR_OPENHANDS_TOKEN') }),
    codex: createCodexVerifierAdapter({ baseUrl: env.RONOR_CODEX_VERIFIER_URL!, token: token('RONOR_CODEX_VERIFIER_TOKEN') }),
    assurance: { async accept(_missionId: string, verdict: VerificationVerdict): Promise<VerificationVerdict> {
      return verdict.verdict === 'pass'
        ? { ok: true, verdict: 'pass', summary: 'Victoria accepted independent Codex evidence.', evidence: verdict.evidence, cost_usd: 0 }
        : { ok: false, verdict: 'fail', summary: 'Victoria rejected failed verification.', evidence: verdict.evidence, cost_usd: 0 };
    } },
  };
}
