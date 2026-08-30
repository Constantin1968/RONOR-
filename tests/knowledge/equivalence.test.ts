/**
 * R-Knowledge — Disabled-Mode Baseline Equivalence
 * MIP-014 STEP 2 · Phase 5 · GATE G5 (ABSOLUTE)
 *
 * This is the gate that cannot be waived. It asserts that with `KNOWLEDGE_ENABLED`
 * absent or not exactly `"true"`, the runtime is observationally indistinguishable
 * from the baseline commit d058544d.
 *
 * The nine prohibitions of STEP 1 § 4.2 are asserted individually, and the five
 * BE invariants of § 4.1 follow from them.
 *
 * On method: these tests exercise the REAL composition root by importing the same
 * modules `src/index.ts` imports and reproducing its gating logic, and by static
 * analysis of `src/index.ts` itself to prove every touch point is null-guarded. A
 * test that only asserted the factory returns null would prove the gate works and
 * say nothing about whether the composition root respects it.
 */

import { execFileSync } from 'child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

import { RKnowledgePlane, isKnowledgeEnabled } from '../../src/planes/r-knowledge';

const REPO_ROOT = join(__dirname, '..', '..');
const INDEX_SOURCE = readFileSync(join(REPO_ROOT, 'src', 'index.ts'), 'utf8');

/** Environment variants that must ALL leave the plane unconstructed. */
const DISABLED_VARIANTS: { label: string; env: NodeJS.ProcessEnv }[] = [
  { label: 'unset', env: {} },
  { label: 'empty string', env: { KNOWLEDGE_ENABLED: '' } },
  { label: '"false"', env: { KNOWLEDGE_ENABLED: 'false' } },
  { label: '"1"', env: { KNOWLEDGE_ENABLED: '1' } },
  { label: '"yes"', env: { KNOWLEDGE_ENABLED: 'yes' } },
  { label: '"TRUE" (uppercase)', env: { KNOWLEDGE_ENABLED: 'TRUE' } },
  { label: '"True" (capitalised)', env: { KNOWLEDGE_ENABLED: 'True' } },
  { label: '"on"', env: { KNOWLEDGE_ENABLED: 'on' } },
  { label: '" true " (padded)', env: { KNOWLEDGE_ENABLED: ' true ' } },
  { label: '"true\\n" (trailing newline)', env: { KNOWLEDGE_ENABLED: 'true\n' } },
];

describe('G5 · The activation predicate', () => {
  test.each(DISABLED_VARIANTS)('KNOWLEDGE_ENABLED = %s leaves the plane unconstructed', ({ env }) => {
    expect(isKnowledgeEnabled(env)).toBe(false);
    expect(RKnowledgePlane.create(env)).toBeNull();
  });

  test('only the exact string "true" constructs the plane', () => {
    const plane = RKnowledgePlane.create({
      KNOWLEDGE_ENABLED: 'true',
      KNOWLEDGE_VECTOR_STORE: 'null',
      KNOWLEDGE_EMBEDDING_DIMENSIONS: '64',
    });
    expect(plane).not.toBeNull();
  });
});

describe('G5 · The nine disabled-mode prohibitions', () => {
  // ── Prohibition 3 and 4: no file and no directory is created ──
  //
  // Asserted by snapshotting the ENTIRE repository tree before and after
  // repeated factory calls across every disabled variant, and comparing. This is
  // stronger than checking for a specific database path, because it would also
  // catch a file created somewhere nobody thought to look.
  test('3+4 · no file or directory is created anywhere in the repository', () => {
    const snapshot = (): string[] => {
      const entries: string[] = [];
      const walk = (dir: string): void => {
        for (const name of readdirSync(dir)) {
          if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
          const full = join(dir, name);
          const stats = statSync(full);
          entries.push(`${full}:${stats.isDirectory() ? 'dir' : stats.size}`);
          if (stats.isDirectory()) walk(full);
        }
      };
      walk(REPO_ROOT);
      return entries.sort();
    };

    const before = snapshot();
    for (const { env } of DISABLED_VARIANTS) {
      // Called repeatedly, because a side effect might occur only on first call.
      expect(RKnowledgePlane.create(env)).toBeNull();
      expect(RKnowledgePlane.create(env)).toBeNull();
    }
    const after = snapshot();

    // An EMPTY diff, not a small one (invariant BE-5).
    expect(after).toEqual(before);
  });

  // ── Prohibition 5: no timer is scheduled ──
  //
  // Asserted by counting live handles, and additionally by static proof that the
  // class contains no timer call at all — so the property holds in ENABLED mode
  // too, not merely while the gate happens to be closed.
  test('5 · no timer is scheduled, and none exists in the class at all', () => {
    const activeTimersBefore = (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles().length;
    for (const { env } of DISABLED_VARIANTS) RKnowledgePlane.create(env);
    const activeTimersAfter = (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles().length;
    expect(activeTimersAfter).toBe(activeTimersBefore);

    const planeSource = readFileSync(
      join(REPO_ROOT, 'src', 'planes', 'r-knowledge', 'index.ts'),
      'utf8'
    );
    const executable = stripComments(planeSource);
    expect(executable).not.toMatch(/setInterval|setTimeout|setImmediate/);
  });

  // ── Prohibition 6: no network connection is opened ──
  test('6 · no socket is opened', () => {
    const socketsBefore = countHandles('Socket');
    for (const { env } of DISABLED_VARIANTS) RKnowledgePlane.create(env);
    expect(countHandles('Socket')).toBe(socketsBefore);
  });

  // ── Prohibition 7: no credential is read ──
  //
  // Asserted by placing sentinel credentials in the environment and proving the
  // gate returns before anything could consume them. A getter-based trap is used
  // so that a mere READ is detectable, not only a use.
  test('7 · no credential is read', () => {
    const reads: string[] = [];
    const trap = new Proxy(
      { KNOWLEDGE_ENABLED: 'false' } as Record<string, string | undefined>,
      {
        get(target, property: string) {
          reads.push(property);
          if (property === 'KNOWLEDGE_QDRANT_API_KEY') return 'SENTINEL-SHOULD-NEVER-BE-READ';
          return target[property];
        },
      }
    ) as NodeJS.ProcessEnv;

    expect(RKnowledgePlane.create(trap)).toBeNull();

    // Exactly one property was read: the flag. No credential, no endpoint, no path.
    expect(reads).toEqual(['KNOWLEDGE_ENABLED']);
    expect(reads).not.toContain('KNOWLEDGE_QDRANT_API_KEY');
    expect(reads).not.toContain('KNOWLEDGE_QDRANT_URL');
    expect(reads).not.toContain('KNOWLEDGE_SQLITE_PATH');
  });

  // ── Prohibition 9: no process-level handler is installed ──
  //
  // Asserted in BOTH modes. The plane must never install one, because a handler
  // installed by a subordinate plane could intercept a signal the runtime owns.
  test('9 · no process handler is installed, in either mode', async () => {
    const signals = ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection'] as const;
    const before = signals.map((s) => process.listenerCount(s));

    for (const { env } of DISABLED_VARIANTS) RKnowledgePlane.create(env);
    expect(signals.map((s) => process.listenerCount(s))).toEqual(before);

    // And with the plane ENABLED and initialised.
    const enabled = RKnowledgePlane.create({
      KNOWLEDGE_ENABLED: 'true',
      KNOWLEDGE_VECTOR_STORE: 'null',
      KNOWLEDGE_EMBEDDING_DIMENSIONS: '64',
    });
    expect(enabled).not.toBeNull();
    await enabled!.init();
    expect(signals.map((s) => process.listenerCount(s))).toEqual(before);
    await enabled!.shutdown();
  });
});

describe('G5 · Composition-root gating, proved by static analysis', () => {
  // A factory that returns null is worthless if the composition root ignores it.
  // These assertions read the real `src/index.ts`.

  test('1 · the knowledge route is mounted only inside a null guard', () => {
    const executable = stripComments(INDEX_SOURCE);

    // The mount exists.
    expect(executable).toMatch(/app\.use\(\s*'\/api\/v1\/knowledge'/);

    // And every line that mounts it, initialises the plane, or reads from it is
    // inside a `knowledge !== null` guard. Verified by removing all guarded
    // blocks and asserting no reference survives in the unguarded remainder.
    const unguarded = removeGuardedBlocks(executable, 'knowledge !== null');
    expect(unguarded).not.toMatch(/\/api\/v1\/knowledge/);
    expect(unguarded).not.toMatch(/knowledge\.init\(\)/);
    expect(unguarded).not.toMatch(/knowledge\.getDegradation\(\)/);

    // The static IMPORT of `createKnowledgeRouter` legitimately survives guard
    // removal, and must: an ES import is hoisted and cannot be placed inside a
    // conditional. Importing the symbol is inert — the module registers no route
    // and touches nothing until the factory is invoked — so what matters is that
    // the INVOCATION is guarded, not the import. Asserting on the invocation is the
    // precise claim; asserting on the import would have been a claim that cannot be
    // satisfied by any correct implementation, which is a broken test rather than a
    // detected defect.
    expect(unguarded).not.toMatch(/createKnowledgeRouter\(/);
    expect(executable).toMatch(/import \{ createKnowledgeRouter \}/);

    // The single invocation in the file is the guarded one.
    const invocations = executable.match(/createKnowledgeRouter\(/g) ?? [];
    expect(invocations).toHaveLength(1);
  });

  test('2+BE-3 · the plane is NOT added to the eight-plane array or the orchestrator', () => {
    const executable = stripComments(INDEX_SOURCE);

    // The `planes` array literal must contain exactly the eight baseline planes.
    const arrayMatch = executable.match(/const planes = \[([\s\S]*?)\];/);
    expect(arrayMatch).not.toBeNull();
    const members = arrayMatch![1]
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    expect(members).toEqual([
      'gateway',
      'context',
      'modelFabric',
      'agentRuntime',
      'execution',
      'assurance',
      'economics',
      'sentinel',
    ]);
    expect(members).not.toContain('knowledge');
    expect(members).toHaveLength(8);

    // And the orchestrator constructor does not receive it.
    const orchestratorMatch = executable.match(/new RONOROrchestrator\(\{([\s\S]*?)\}\)/);
    expect(orchestratorMatch).not.toBeNull();
    expect(orchestratorMatch![1]).not.toMatch(/knowledge/);
  });

  test('BE-1 · the baseline route mounts are unchanged and unconditional', () => {
    const executable = stripComments(INDEX_SOURCE);
    // Each baseline mount must still be present and must NOT have become
    // conditional as a side effect of this work.
    for (const mount of [
      /app\.use\('\/api\/v1', createRouter\(orchestrator\)\)/,
      /app\.use\('\/api\/v1', createDecisionsRouter\(\)\)/,
      /app\.use\('\/api\/v1\/model-exchange', modelExchangeRouter\)/,
      /app\.use\('\/api\/v1\/sentinel', createSentinelRouter\(sentinel\)\)/,
      /app\.use\('\/', express\.static\('web'\)\)/,
    ]) {
      expect(executable).toMatch(mount);
    }
    const unguarded = removeGuardedBlocks(executable, 'knowledge !== null');
    // The baseline mounts survive removal of the guarded blocks, proving they are
    // not inside them.
    expect(unguarded).toMatch(/app\.use\('\/api\/v1\/sentinel'/);
    expect(unguarded).toMatch(/app\.use\('\/', express\.static\('web'\)\)/);
  });

  test('8 · the health payload gains no key in disabled mode', () => {
    const executable = stripComments(INDEX_SOURCE);
    // A conditional SPREAD, not a nullable field. `knowledge: null` would still be
    // a structural diff in the response body; an absent key is not.
    expect(executable).toMatch(/\.\.\.\(knowledge !== null[\s\S]{0,160}?\{ knowledge:/);
    // And no unconditional knowledge key exists in the payload.
    // Ancorat pe CONȚINUTUL corpului de sănătate, nu pe forma lui sintactică.
    // Corpul este acum compus într-o funcție și trimis de gestionar, fiindcă
    // gestionarul trebuie să prindă orice excepție din compunere; o ancoră pe
    // `res.json({` ar fi verificat plasarea codului, nu proprietatea cerută.
    // `persistence: persistenta` distinge corpul real de corpul de rezervă al
    // căii degradate, care conține și el `uptime`.
    const healthBlock = executable.match(
      /\{[\s\S]*?persistence: persistenta,[\s\S]*?uptime: process\.uptime\(\),/,
    );
    expect(healthBlock).not.toBeNull();
    expect(healthBlock![0]).not.toMatch(/^\s*knowledge:/m);
  });
});

describe('G5 · Isolation from the governance and audit spine', () => {
  // § 13.2. Asserted over EXECUTABLE code, so a mention in prose cannot satisfy
  // or fail the check.
  const knowledgeFiles = [
    'src/planes/r-knowledge/index.ts',
    'src/planes/r-knowledge/config.ts',
    'src/planes/r-knowledge/types.ts',
    'src/api/knowledge-router.ts',
    'src/knowledge/ingestion.ts',
    'src/knowledge/retrieval.ts',
    'src/knowledge/rag.ts',
    'src/knowledge/schema.ts',
    'src/knowledge/provenance.ts',
    'src/knowledge/chunker.ts',
    'src/knowledge/degradation.ts',
    'src/knowledge/injection-guard.ts',
    'src/knowledge/stores/vector-store.ts',
    'src/knowledge/stores/sqlite-store.ts',
    'src/knowledge/stores/qdrant-store.ts',
    'src/knowledge/stores/qdrant-transport.ts',
    'src/knowledge/embedding/embedding-adapter.ts',
    'src/knowledge/embedding/deterministic-adapter.ts',
  ];

  test.each(knowledgeFiles)('%s imports nothing from the audit spine', (relativePath) => {
    const source = stripComments(readFileSync(join(REPO_ROOT, relativePath), 'utf8'));
    // No import of the audit chain, the MI9 gate or the orchestrator. R-Knowledge
    // must not hold a handle on the programme's integrity root: a plane that could
    // write to the audit chain could corrupt the evidence of its own failure.
    expect(source).not.toMatch(/from\s+['"][^'"]*audit\/hash-chain/);
    expect(source).not.toMatch(/from\s+['"][^'"]*governance\/mi9-gate/);
    expect(source).not.toMatch(/from\s+['"][^'"]*\/orchestrator/);
    expect(source).not.toMatch(/AuditHashChain|verifyChain/);
  });

  test('the orchestrator is untouched by this work', () => {
    const orchestrator = readFileSync(join(REPO_ROOT, 'src', 'orchestrator.ts'), 'utf8');
    expect(orchestrator).not.toMatch(/knowledge|Knowledge/);
  });

  test('the orchestrator, audit chain and repaired MI9 gate match approved hashes', () => {
    // The strongest available form of this assertion: compare the blob hashes
    // against the canonical tree rather than grepping for a keyword.
    const baseline = 'd058544d1c579611cce99cdf2b87a78d7534e75b';
    const expectedHashes: Record<string, string> = {
      'src/orchestrator.ts': execFileSync('git', ['rev-parse', `${baseline}:src/orchestrator.ts`], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      }).trim(),
      // Approved audit-mirror hook: a single fire-and-forget call inside
      // append(), placed after the local insert and before the return, so the
      // local chain remains authoritative and the sovereign relational register
      // receives a copy it can be reconciled against. Hashing, ordering,
      // verification and export are untouched.
      'src/audit/hash-chain.ts': '3c2b9e848684c1e6953516a6c8f4f0f794ffc50f',
      // Approved repair for D-1: pure evaluation plus post-execution accounting.
      'src/governance/mi9-gate.ts': '31ef9f2562254bdca7f871b71e1b7d7be11b90dd',
    };

    for (const [path, expectedHash] of Object.entries(expectedHashes)) {
      const currentHash = execFileSync('git', ['hash-object', path], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      }).trim();
      expect(currentHash).toBe(expectedHash);
    }
  });
});

describe('G5 · The disabled plane performs no work', () => {
  test('the factory is cheap and has no observable effect beyond returning null', () => {
    // 10,000 calls. If any performed a filesystem probe, resolved a path or read
    // configuration, this would be measurably slow and would have shown up in the
    // filesystem snapshot above.
    const started = Date.now();
    for (let i = 0; i < 10_000; i++) {
      expect(RKnowledgePlane.create({ KNOWLEDGE_ENABLED: 'false' })).toBeNull();
    }
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test('no knowledge database file exists after disabled-mode operation', () => {
    for (const candidate of ['data/knowledge.db', 'knowledge.db', 'data/knowledge']) {
      expect(existsSync(join(REPO_ROOT, candidate))).toBe(false);
    }
  });
});

// ============================================================
// Helpers
// ============================================================

/**
 * Remove comments so that assertions run against EXECUTABLE code.
 *
 * Without this, a prohibition could be "satisfied" by a comment mentioning the
 * forbidden construct, or falsely failed by prose describing what the code avoids.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/**
 * Remove every `if (<guard>) { ... }` block, so the remaining text is exactly the
 * code that executes when the guard is false. Brace-counted rather than
 * regex-matched, because nested braces defeat a regex.
 */
function removeGuardedBlocks(source: string, guard: string): string {
  let result = source;
  for (;;) {
    const start = result.indexOf(`if (${guard})`);
    if (start === -1) break;
    const braceStart = result.indexOf('{', start);
    if (braceStart === -1) break;
    let depth = 0;
    let end = braceStart;
    for (let i = braceStart; i < result.length; i++) {
      if (result[i] === '{') depth += 1;
      else if (result[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    result = result.slice(0, start) + result.slice(end + 1);
  }
  // Also remove conditional-spread expressions of the same guard.
  return result.replace(/\.\.\.\(knowledge !== null[\s\S]*?\}\),/g, '');
}

/** Count live handles of a given constructor name. */
function countHandles(constructorName: string): number {
  const handles = (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles();
  return handles.filter((handle) => handle?.constructor?.name === constructorName).length;
}
