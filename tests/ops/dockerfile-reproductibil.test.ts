/**
 * Construire reproductibilă a imaginilor Node.
 *
 * Reconstrucția primarei (25.09.2026) a arătat că `Dockerfile` copia numai
 * `package.json` și rula `npm install`: fiecare construire rezolva din nou
 * intervalele `^`, iar trei pachete au ieșit cu altă versiune decât în
 * producție și decât în lockfile. Testul fixează proprietatea, nu textul:
 * orice Dockerfile din rădăcina depozitului care instalează dependențe npm
 * trebuie să folosească `npm ci`, după ce a copiat `package-lock.json`.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');

function dockerfiles(): string[] {
  return readdirSync(ROOT).filter((name) => name === 'Dockerfile' || name.startsWith('Dockerfile.'));
}

/** Instrucțiunile Dockerfile, cu continuările de linie unite. */
function instructions(text: string): string[] {
  const out: string[] = [];
  let current = '';
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!current && (line.trim() === '' || line.trim().startsWith('#'))) continue;
    if (line.endsWith('\\')) {
      current += line.slice(0, -1) + ' ';
      continue;
    }
    current += line;
    out.push(current.trim());
    current = '';
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

describe('Dockerfile: dependențele npm vin din lockfile', () => {
  const files = dockerfiles();

  test('există cel puțin Dockerfile-ul runtime-ului', () => {
    expect(files).toContain('Dockerfile');
  });

  test.each(files)('%s nu rulează `npm install` și nici `npm i`', (name) => {
    const runs = instructions(readFileSync(join(ROOT, name), 'utf8')).filter((i) => /^RUN\s/i.test(i));
    for (const run of runs) {
      expect(run).not.toMatch(/\bnpm\s+(?:install|i|add)\b/);
    }
  });

  test.each(files)('%s: fiecare `npm ci` e precedat, în aceeași etapă, de copierea lui package-lock.json', (name) => {
    let lockCopiedInStage = false;
    for (const instruction of instructions(readFileSync(join(ROOT, name), 'utf8'))) {
      if (/^FROM\s/i.test(instruction)) {
        // O etapă `FROM <etapă anterioară>` moștenește fișierele acelei etape.
        const base = instruction.split(/\s+/)[1] ?? '';
        lockCopiedInStage = lockCopiedInStage && !base.includes(':') && !base.includes('/');
        continue;
      }
      if (/^COPY\s/i.test(instruction) && /\bpackage-lock\.json\b/.test(instruction)) lockCopiedInStage = true;
      if (/^RUN\s/i.test(instruction) && /\bnpm\s+ci\b/.test(instruction)) {
        expect({ file: name, instruction, lockCopiedInStage }).toEqual({ file: name, instruction, lockCopiedInStage: true });
      }
    }
  });

  test('Dockerfile-ul runtime-ului folosește `npm ci` în ambele etape', () => {
    const runs = instructions(readFileSync(join(ROOT, 'Dockerfile'), 'utf8')).filter((i) => /^RUN\s/i.test(i));
    const ci = runs.filter((r) => /\bnpm\s+ci\b/.test(r));
    expect(ci.length).toBe(2);
    expect(ci.some((r) => /--omit=dev/.test(r))).toBe(true);
  });
});
