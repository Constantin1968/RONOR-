import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('automation activation preflight', () => {
  const source = readFileSync(join(process.cwd(), 'scripts/automation-preflight.sh'), 'utf8');
  const workflow = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');

  it('is read-only and never starts, creates or removes infrastructure', () => {
    expect(source).toContain('READ-ONLY automation activation audit');
    expect(source).toContain('docker compose');
    expect(source).toContain('config --quiet');
    expect(source).not.toMatch(/docker\s+(?:compose\s+)?(?:up|start|run|exec|create|rm|down)\b/);
    expect(source).not.toMatch(/docker\s+network\s+create\b/);
    expect(source).not.toMatch(/\bgit\s+(?:checkout|switch|reset|merge|rebase|pull|push|commit)\b/);
  });

  it('validates every secret identity and never prints or sources secret values', () => {
    for (const name of ['langgraph_token', 'openhands_session_key', 'openhands_llm_api_key', 'openhands_secret_key', 'openhands_bridge_token', 'automation_capability_key', 'codex_verifier_token', 'codex_api_key', 'model_gateway_upstream_token', 'assurance_token', 'evidence_runner_token', 'codex_receipt_private_key', 'assurance_receipt_public_key']) {
      expect(source).toContain(name);
    }
    expect(source).toContain("stat -c '%a'");
    expect(source).toContain('sha256sum');
    expect(source).toContain('cmp -s');
    expect(source).not.toMatch(/\b(?:cat|head|tail|less|more)\s+[^\n]*secret/i);
    expect(source).not.toMatch(/source\s+[^\n]*secret/i);
  });

  it('checks exact networks, repository identity, clean state and pinned HEAD', () => {
    expect(source).toContain('ronor-automation-control:true');
    expect(source).toContain('ronor-model-egress:true');
    expect(source).toContain('ronor-model-uplink:false');
    expect(source).toContain('remote get-url origin');
    expect(source).toContain('rev-parse HEAD');
    expect(source).toContain('status --porcelain=v1');
  });

  it('is syntax-checked and exercised fail-closed by Linux CI', () => {
    expect(workflow).toContain('name: Automation Activation Preflight Contract');
    expect(workflow).toContain('bash -n scripts/automation-preflight.sh');
    expect(workflow).toContain('env -i PATH="$PATH" HOME="$HOME" bash scripts/automation-preflight.sh');
    expect(workflow).not.toMatch(/automation-preflight\.sh[^\n]*(?:up|start|run|exec|create|deploy)/);
  });
});
