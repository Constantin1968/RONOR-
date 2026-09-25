/**
 * Dependențele gazdei primare găsite nedeclarate la reconstrucția pe probă (25.09.2026)
 * trebuie să rămână declarate în depozit. Testul verifică existența și identitatea
 * fișierelor, nu execută nimic pe gazde.
 */
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const OPS = join(ROOT, 'ops', 'ronor-sovereign');
const DOC = join(ROOT, 'docs', 'reconstructie-primara-digitalocean.md');

describe('gazda primară: dependențele declarate', () => {
  test('suprapunerea lansării e identică cu cea din producție la 1143201', () => {
    const body = readFileSync(join(OPS, 'lansare', 'docker-compose.runtime-override.yml'));
    expect(createHash('sha256').update(body).digest('hex')).toBe(
      '68565a386105c842253363b7fd2f00109e34ff1b0b7f2de23c79e49e2b8453a7',
    );
    const text = body.toString('utf8');
    expect(text).toMatch(/dockerfile:\s*Dockerfile\.runtime/);
    expect(text).toMatch(/name:\s*ronor-data/);
    expect(text).toMatch(/name:\s*app_default/);
  });

  test.each(['pregateste-lansare.sh', 'emite-pki-intern.sh'])('%s există, e executabil și are sintaxă Bash validă', (name) => {
    const path = join(OPS, name);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o111).not.toBe(0);
    expect(() => execFileSync('bash', ['-n', path])).not.toThrow();
  });

  test('emite-pki-intern.sh nu lasă cheia CA în directorul montat în containere', () => {
    const text = readFileSync(join(OPS, 'emite-pki-intern.sh'), 'utf8');
    expect(text).toMatch(/rm -f "\$PKI_DIR\/ca\.key"/);
    expect(text).toMatch(/cheia CA nu se ține în/);
    expect(text).not.toMatch(/install[^\n]*ca\.key[^\n]*\$PKI_DIR/);
  });

  test('suprapunerile Postgres nu scriu direct adresa Tailscale', () => {
    for (const name of ['docker-compose.postgres-legare.yml', 'docker-compose.postgres-local.yml']) {
      const text = readFileSync(join(OPS, name), 'utf8');
      expect(text).not.toMatch(/\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/);
    }
    expect(readFileSync(join(OPS, 'docker-compose.postgres-legare.yml'), 'utf8')).toMatch(/\$\{POSTGRES_TAILNET_ADDR:\?/);
  });

  test('documentul declară toate cele opt dependențe și trimite la fișierele existente', () => {
    const doc = readFileSync(DOC, 'utf8');
    for (let i = 1; i <= 8; i++) expect(doc).toMatch(new RegExp(`^## ${i}\\. `, 'm'));
    const referenced = Array.from(doc.matchAll(/`(ops\/ronor-sovereign\/[^`\s]+)`/g), (m) => m[1].split(' ')[0]);
    expect(referenced.length).toBeGreaterThan(0);
    for (const rel of referenced) expect(existsSync(join(ROOT, rel.replace(/\/$/, '')))).toBe(true);
  });

  test('documentul nu conține adresele gazdelor (depozitul e public)', () => {
    const doc = readFileSync(DOC, 'utf8');
    expect(doc).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b(?<!127\.0\.0\.1)/);
  });
});
