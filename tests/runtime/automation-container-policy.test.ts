import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { secretValue } from '../../src/runtime/automation/services/secret-files';

type Service = Record<string, any>;

describe('isolated automation composition', () => {
  const source = readFileSync(join(process.cwd(), 'docker-compose.automation.yml'), 'utf8');
  const compose = load(source) as { services: Record<string, Service>; networks: Record<string, any> };

  it('pins external images and never grants host control surfaces', () => {
    expect(source).not.toMatch(/:\s*latest(?:\s|$)/m);
    expect(source).not.toContain('/var/run/docker.sock');
    expect(source).not.toMatch(/(?:\.ssh|tailscale|SSH_AUTH_SOCK|github_token)/i);
    expect(compose.services['openhands-agent'].image).toBe('ghcr.io/openhands/agent-server:1.42.1-python');
  });

  it('applies least privilege to every service', () => {
    for (const service of Object.values(compose.services)) {
      expect(service).toMatchObject({ read_only: true, user: '10001:10001', cap_drop: ['ALL'], restart: 'no' });
      expect(service.security_opt).toContain('no-new-privileges:true');
      expect(service.pids_limit).toBeGreaterThan(0);
      expect(service.mem_limit).toBeTruthy();
      expect(service.cpus).toBeGreaterThan(0);
    }
  });

  it('publishes control APIs on host loopback only', () => {
    for (const service of Object.values(compose.services)) {
      for (const port of service.ports ?? []) expect(String(port)).toMatch(/^127\.0\.0\.1:/);
    }
  });

  it('limits writes to the OpenHands worktree and bridge nonce ledger', () => {
    const writable: Array<[string, string]> = [];
    for (const [name, service] of Object.entries(compose.services)) {
      for (const volume of service.volumes ?? []) {
        if (typeof volume === 'object' && volume.read_only !== true) writable.push([name, volume.target]);
      }
    }
    expect(writable).toEqual([['openhands-agent', '/workspace/project'], ['openhands-bridge', '/var/lib/ronor-nonces']]);
    expect(compose.services['openhands-bridge'].volumes[0]).toMatchObject({ type: 'bind', read_only: false });
    expect(String(compose.services['openhands-bridge'].volumes[0].source)).toContain('RONOR_AUTOMATION_NONCE_DIR');
    expect(compose.services['codex-verifier'].volumes[0].read_only).toBe(true);
    expect(compose.services['victoria-assurance'].volumes[0].read_only).toBe(true);
  });

  it('uses an internal control plane and explicit model egress', () => {
    expect(compose.networks['automation-control']).toMatchObject({ external: true, name: 'ronor-automation-control' });
    expect(compose.networks['model-egress']).toMatchObject({ external: true, name: 'ronor-model-egress' });
    const egress = Object.entries(compose.services).filter(([, s]) => s.networks?.includes('model-egress')).map(([n]) => n).sort();
    expect(egress).toEqual(['codex-verifier', 'openhands-agent']);
  });

  it('attaches production only through an explicit opt-in override', () => {
    const runtimeSource = readFileSync(join(process.cwd(), 'docker-compose.automation-runtime.yml'), 'utf8');
    const runtime = load(runtimeSource) as { services: Record<string, Service>; networks: Record<string, any> };
    expect(runtime.services.ronor.networks).toEqual(['automation-control']);
    expect(runtime.services.ronor.volumes).toEqual([
      expect.objectContaining({ target: '/automation-worktrees/project', read_only: true }),
      expect.objectContaining({ target: '/automation-artifacts', read_only: false }),
    ]);
    expect(runtime.networks['automation-control']).toMatchObject({ external: true, name: 'ronor-automation-control' });
    expect(source).toContain('network reaching only');
    expect(runtimeSource).toContain('docker network create --internal ronor-automation-control');
    const dockerfile = readFileSync(join(process.cwd(), 'Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(/FROM node:20-bookworm-slim AS runtime[\s\S]*apt-get install[\s\S]*\bgit\b/);
  });
});

describe('secret file loading', () => {
  it('prefers a mounted secret file', () => {
    const path = join(tmpdir(), `ronor-secret-${process.pid}-${Date.now()}`);
    writeFileSync(path, 'mounted-value\n', { mode: 0o600 });
    try {
      expect(secretValue('TOKEN', { TOKEN: 'environment-value', TOKEN_FILE: path })).toBe('mounted-value');
    } finally {
      unlinkSync(path);
    }
  });

  it('supports a local environment fallback', () => {
    expect(secretValue('TOKEN', { TOKEN: 'local-value' })).toBe('local-value');
    expect(secretValue('TOKEN', {})).toBeUndefined();
  });
});
