/**
 * Ronor SIS brand spelling guard (approved 3 October 2026).
 *
 * Live brand text uses "Ronor". Technical identifiers that are contracts
 * between services, hosts and rebuild recipes keep their original form:
 * RONOR_* environment variables, X-RONOR-* headers, RONOR-DATA delimiters,
 * RONOR: logger namespaces. Archives, evidence and dated reports are
 * preserved as historical records and are not scanned.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const SCANNED_DIRS = ['src', 'web', 'tests', 'docs', 'documente', 'scripts', 'ops', 'deploy', 'services'];
const ROOT_FILES = ['README.md', 'package.json', 'docker-compose.production.yml'];
// Dockerfile is pinned against an approved baseline and is deliberately not scanned.
const EXCLUDED_PREFIXES = [
  'documente/rapoarte/',
  'documente/scripturi/',
  'docs/reference/',
  'docs/consolidation/RONOR-document-comprehensiv-export.md',
  'documente/jurnal-decizii.md',
  'tests/brand/',
  // Governance-pinned files: changing them requires a separately approved
  // hash amendment (governance/approved-spine-hashes.json, Dockerfile baseline).
  'src/orchestrator.ts',
  'src/audit/hash-chain.ts',
  'src/governance/mi9-gate.ts',
];
const TEXT_EXT = new Set(['.ts', '.js', '.mjs', '.cjs', '.md', '.html', '.css', '.json', '.yml', '.yaml', '.sh', '.py', '.txt', '.service', '.timer', '']);
const DATED = /(\d{4}-\d{2}-\d{2})|(\d{1,2}(jan|feb|mar|apr|may|mai|jun|iun|jul|iul|aug|sep|oct|nov|dec)\d{4})/i;
// Brand-form RONOR: not part of an identifier, header, delimiter, namespace, path,
// filename, or a quoted title of a historical document (opening „ quote).
const BRAND_FORM = /(?<![-_/.$\w„])RONOR(?![-_:/\w]|\.\w)/g;

function walk(rel: string, out: string[]): void {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return;
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    for (const entry of fs.readdirSync(abs)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      walk(path.posix.join(rel, entry), out);
    }
    return;
  }
  if (EXCLUDED_PREFIXES.some((p) => rel.startsWith(p))) return;
  if (DATED.test(path.basename(rel))) return;
  if (!TEXT_EXT.has(path.extname(rel))) return;
  out.push(rel);
}

function liveFiles(): string[] {
  const out: string[] = [];
  for (const d of SCANNED_DIRS) walk(d, out);
  for (const f of ROOT_FILES) if (fs.existsSync(path.join(ROOT, f))) out.push(f);
  return out;
}

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('Ronor SIS brand spelling', () => {
  const files = liveFiles();

  it('scans a meaningful set of live files', () => {
    expect(files.length).toBeGreaterThan(300);
  });

  it('uses "Ronor", not "RONOR", in live brand text', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const lines = read(f).split('\n');
      lines.forEach((line, i) => {
        // Git commit identity of the development worker is an audit identifier.
        if (line.includes('RONOR Development Worker')) return;
        if (line.match(BRAND_FORM)) offenders.push(`${f}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('no longer names the product RSIOR in source code or web interfaces', () => {
    const offenders = files
      .filter((f) => f.startsWith('src/') || f.startsWith('web/'))
      .filter((f) => /RSIOR|Sovereign Intelligence Operating Runtime/.test(read(f)));
    expect(offenders).toEqual([]);
  });

  it('keeps technical identifiers unchanged', () => {
    expect(read('src/interfaces/telegram/energy-trading/trading-client.ts')).toContain("'X-RONOR-Token'");
    expect(read('services/r-powertrade/api.py')).toContain('X-RONOR-Token');
    expect(read('src/knowledge/rag.ts')).toContain('RONOR-DATA');
    expect(read('src/runtime/api/middleware.ts')).toMatch(/X-RONOR-API/);
    const envVars = files.reduce((n, f) => n + (read(f).match(/\bRONOR_[A-Z0-9_]+/g)?.length ?? 0), 0);
    expect(envVars).toBeGreaterThan(800);
  });
});
