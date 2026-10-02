/**
 * The production Compose file must load on a host that does not run the trading
 * profile. Compose interpolates every service, including those in disabled
 * profiles, so a required-variable marker (`:?`) on a profile-only service makes
 * `docker compose ... up ronor` fail on hosts without the trading secrets.
 */
import { readFileSync } from 'fs';
import path from 'path';

const compose = readFileSync(path.join(__dirname, '..', '..', 'docker-compose.production.yml'), 'utf8');

function serviceBlock(name: string): string {
  const start = compose.indexOf(`\n  ${name}:\n`);
  expect(start).toBeGreaterThan(-1);
  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z0-9-]+:\n|\n[a-z]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe('docker-compose.production.yml interpolation', () => {
  it('r-powertrade (profile energy-trading) has no required-variable markers', () => {
    const block = serviceBlock('r-powertrade');
    expect(block).toContain('profiles: ["energy-trading"]');
    expect(block).not.toMatch(/\$\{[A-Z0-9_]+:\?/);
    expect(block).toContain('POWERTRADE_TOKEN: ${ET_API_TOKEN:-}');
  });
});
