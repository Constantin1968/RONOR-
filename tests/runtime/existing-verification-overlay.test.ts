import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

describe('opt-in existing-commit verification install overlay', () => {
  const overlay = yaml.load(fs.readFileSync(path.join(
    __dirname, '../../docker-compose.development-existing-verification.yml',
  ), 'utf8')) as { services: Record<string, {
    build: { context: string; dockerfile: string; target: string };
    image: string; environment?: Record<string, string>;
  }> };

  it('touches only the three development services and no isolation or identity settings', () => {
    expect(Object.keys(overlay)).toEqual(['services']);
    expect(Object.keys(overlay.services).sort()).toEqual(
      ['automation-evidence-runner', 'controller', 'openhands-bridge'],
    );
    for (const service of Object.values(overlay.services)) {
      expect(Object.keys(service).every(key => ['build', 'image', 'environment'].includes(key))).toBe(true);
      expect(service.build.context).toBe('${RONOR_EXISTING_VERIFY_SOURCE:?absolute reviewed source directory}');
      expect(service.build.dockerfile).toBe('Dockerfile.development-tools');
      expect(service.image).toContain('${RONOR_EXISTING_VERIFY_TAG:?reviewed source commit}');
    }
  });

  it('pins the candidate independently of the executable version', () => {
    expect(overlay.services.controller.build.target).toBe('development-controller');
    expect(overlay.services['openhands-bridge'].build.target).toBe('runtime');
    expect(overlay.services['automation-evidence-runner'].build.target).toBe('evidence');
    const environment = {
      RONOR_AUTOMATION_EXPECTED_HEAD: '${RONOR_EXISTING_VERIFY_HEAD:?exact approved candidate commit}',
    };
    expect(overlay.services.controller.environment).toEqual(environment);
    expect(overlay.services['automation-evidence-runner'].environment).toEqual(environment);
    expect(overlay.services['openhands-bridge'].environment).toBeUndefined();
  });
});
