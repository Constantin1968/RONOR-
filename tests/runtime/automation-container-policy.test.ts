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
    expect(source).not.toMatch(/(?:\.ssh|SSH_AUTH_SOCK|github_token|tailscale\.sock|\/var\/run\/tailscale)/i);
    expect(compose.services['openhands-agent'].image).toBe('ronor-openhands-agent:${RONOR_AUTOMATION_IMAGE_TAG:-local}');
    expect(compose.services['openhands-agent'].build.args.RONOR_OPENHANDS_AGENT_IMAGE).toBe('ghcr.io/openhands/agent-server:1.42.1-python');
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

  it('health-attests every service and waits for OpenHands before starting its bridge', () => {
    for (const service of Object.values(compose.services)) {
      expect(service.healthcheck).toMatchObject({ interval: '10s', timeout: '5s' });
      expect(service.healthcheck.test).toBeTruthy();
      expect(JSON.stringify(service.healthcheck.test)).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{12,}/i);
    }
    expect(compose.services['openhands-bridge'].depends_on).toEqual({ 'openhands-agent': { condition: 'service_healthy' } });
    expect(String(compose.services.langgraph.healthcheck.test)).toContain('/run/secrets/langgraph_token');
    expect(String(compose.services['codex-verifier'].healthcheck.test)).toContain('/run/secrets/codex_verifier_token');
    expect(String(compose.services['victoria-assurance'].healthcheck.test)).toContain('/run/secrets/assurance_token');
    expect(String(compose.services['model-egress-proxy'].healthcheck.test)).toContain('/run/secrets/openhands_llm_api_key');
    expect(String(compose.services['openhands-agent'].healthcheck.test)).toContain('/run/secrets/openhands_session_key');
    expect(compose.services['openhands-agent'].depends_on).toEqual({ 'model-egress-proxy': { condition: 'service_healthy' } });
    expect(compose.services['codex-verifier'].depends_on).toEqual({ 'model-egress-proxy': { condition: 'service_healthy' } });
  });

  it('injects OpenHands credentials through mounted secrets and fails closed', () => {
    const agent = compose.services['openhands-agent'];
    expect(agent.tmpfs).toContain('/tmp:rw,exec,nosuid,nodev,size=512m');
    expect(agent.tmpfs).toContain('/workspace/conversations:rw,nosuid,nodev,size=1g');
    expect(agent.environment).toMatchObject({ HOME: '/tmp/openhands-home', XDG_CONFIG_HOME: '/tmp/openhands-config' });
    expect(agent.environment).not.toHaveProperty('SESSION_API_KEY');
    expect(agent.environment).not.toHaveProperty('LLM_API_KEY');
    expect(agent.environment).not.toHaveProperty('OH_SECRET_KEY');
    expect(agent.secrets).toEqual(['openhands_session_key', 'openhands_llm_api_key', 'openhands_secret_key']);
    expect(compose.services['openhands-bridge'].secrets).toContain('openhands_llm_api_key');
    expect(agent.environment).toMatchObject({
      RONOR_OPENHANDS_SESSION_API_KEY_FILE: '/run/secrets/openhands_session_key',
      RONOR_OPENHANDS_LLM_API_KEY_FILE: '/run/secrets/openhands_llm_api_key',
      RONOR_OPENHANDS_SECRET_KEY_FILE: '/run/secrets/openhands_secret_key',
    });
    const dockerfile = readFileSync(join(process.cwd(), 'Dockerfile.openhands-agent'), 'utf8');
    const entrypoint = readFileSync(join(process.cwd(), 'scripts/openhands-secret-entrypoint.sh'), 'utf8');
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/local/bin/ronor-openhands-entrypoint"]');
    expect(entrypoint).toContain('OpenHands startup refused');
    expect(entrypoint).toContain('export LLM_API_KEY=');
    expect(entrypoint).toContain('export OH_SECRET_KEY=');
  });

  it('limits writes to the OpenHands worktree and bridge nonce ledger', () => {
    const writable: Array<[string, string]> = [];
    for (const [name, service] of Object.entries(compose.services)) {
      for (const volume of service.volumes ?? []) {
        if (typeof volume === 'object' && volume.read_only !== true) writable.push([name, volume.target]);
      }
    }
    expect(writable).toEqual([['openhands-agent', '/workspace/project'], ['openhands-bridge', '/var/lib/ronor-nonces'], ['automation-evidence-runner', '/artifacts']]);
    expect(compose.services['openhands-bridge'].volumes[0]).toMatchObject({ type: 'bind', read_only: false });
    expect(String(compose.services['openhands-bridge'].volumes[0].source)).toContain('RONOR_AUTOMATION_NONCE_DIR');
    expect(compose.services['codex-verifier'].volumes[0].read_only).toBe(true);
    expect(compose.services['victoria-assurance'].volumes[0].read_only).toBe(true);
    expect(compose.services['automation-evidence-runner'].volumes[0]).toMatchObject({ target: '/workspace/project', read_only: true });
    expect(compose.services['automation-evidence-runner'].networks).toEqual(['automation-control']);
  });

  it('uses an internal control plane and explicit model egress', () => {
    expect(compose.networks['automation-control']).toMatchObject({ external: true, name: 'ronor-automation-control' });
    expect(compose.networks['model-egress']).toMatchObject({ external: true, name: 'ronor-model-egress' });
    const isolated = Object.entries(compose.services).filter(([, s]) => s.networks?.includes('model-egress')).map(([n]) => n).sort();
    const uplink = Object.entries(compose.services).filter(([, s]) => s.networks?.includes('model-uplink')).map(([n]) => n).sort();
    expect(isolated).toEqual(['codex-verifier', 'model-egress-proxy', 'openhands-agent']);
    expect(uplink).toEqual(['model-egress-proxy']);
    expect(compose.networks['model-uplink']).toMatchObject({ external: true, name: 'ronor-model-uplink' });
    const proxy = compose.services['model-egress-proxy'];
    expect(proxy.environment).toMatchObject({
      RONOR_MODEL_GATEWAY_OPENHANDS_TOKEN_FILE: '/run/secrets/openhands_llm_api_key',
      RONOR_MODEL_GATEWAY_CODEX_TOKEN_FILE: '/run/secrets/codex_api_key',
      RONOR_MODEL_GATEWAY_UPSTREAM_TOKEN_FILE: '/run/secrets/model_gateway_upstream_token',
    });
    expect(proxy.secrets).toEqual(expect.arrayContaining(['openhands_llm_api_key', 'codex_api_key', 'model_gateway_upstream_token']));
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
    const dockerfile = readFileSync(join(process.cwd(), 'Dockerfile.automation-runtime'), 'utf8');
    expect(dockerfile).toMatch(/ARG RONOR_AUTOMATION_RUNTIME_BASE_IMAGE[\s\S]*FROM \$\{RONOR_AUTOMATION_RUNTIME_BASE_IMAGE\}[\s\S]*\bgit\b/);
    expect(runtime.services.ronor.build.args.RONOR_AUTOMATION_RUNTIME_BASE_IMAGE).toContain('RONOR_AUTOMATION_RUNTIME_BASE_IMAGE');
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
