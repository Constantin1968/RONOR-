/**
 * R-Knowledge Conformance Runner
 * MIP-014 STEP 2 · Phase 7 · Gate G7
 *
 * Aggregates every gate verdict into a single machine-readable conformance report,
 * and exits non-zero if any determinative check fails.
 *
 * The runner RE-VERIFIES rather than re-reading. Where a previous phase produced an
 * evidence file, this runner recomputes the underlying fact wherever recomputation is
 * cheap — because an evidence file that is merely read back proves only that the file
 * exists, not that the property still holds. A conformance report assembled from
 * stale evidence is the failure mode this design avoids.
 *
 * Run:  npx ts-node scripts/verify-knowledge-conformance.ts
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = join(__dirname, '..');
const EVIDENCE_DIR = join(REPO_ROOT, 'evidence', 'knowledge');
const BASELINE = 'd058544d1c579611cce99cdf2b87a78d7534e75b';

interface Check {
  id: string;
  description: string;
  determinative: boolean;
  result: 'PASS' | 'FAIL' | 'INFO';
  observed: unknown;
}

const checks: Check[] = [];

function record(
  id: string,
  description: string,
  determinative: boolean,
  passed: boolean | null,
  observed: unknown
): void {
  checks.push({
    id,
    description,
    determinative,
    result: passed === null ? 'INFO' : passed ? 'PASS' : 'FAIL',
    observed,
  });
}

function sh(command: string): string {
  return execSync(command, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

function main(): number {
  mkdirSync(EVIDENCE_DIR, { recursive: true });

  // ── Baseline integrity ──────────────────────────────────────────────
  const spine = [
    'src/orchestrator.ts',
    'src/audit/hash-chain.ts',
    'src/governance/mi9-gate.ts',
  ];
  const spineDetail: Record<string, { baseline: string; current: string; identical: boolean }> = {};
  let spineOk = true;
  for (const path of spine) {
    const baselineHash = sh(`git rev-parse ${BASELINE}:${path}`);
    const currentHash = sh(`git hash-object ${path}`);
    const identical = baselineHash === currentHash;
    spineDetail[path] = { baseline: baselineHash, current: currentHash, identical };
    if (!identical) spineOk = false;
  }
  record(
    'CONF-1',
    'Governance and audit spine byte-identical to baseline',
    true,
    spineOk,
    spineDetail
  );

  // ── Dependency surface ──────────────────────────────────────────────
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  const depCount = Object.keys(pkg.dependencies).length;
  const devCount = Object.keys(pkg.devDependencies).length;
  record(
    'CONF-2',
    'Dependency surface unchanged: 9 production, 15 development',
    true,
    depCount === 9 && devCount === 15,
    { production: depCount, development: devCount }
  );

  const lockUnchanged =
    sh(`git diff --name-only ${BASELINE} -- package-lock.json`).length === 0;
  record('CONF-3', 'package-lock.json unchanged from baseline', true, lockUnchanged, {
    changed: !lockUnchanged,
  });

  // ── Test corpus ─────────────────────────────────────────────────────
  // Run BOTH the baseline corpus in isolation and the whole suite. The isolated run
  // is the one that discharges BE-4: a combined count of 455 could conceal a
  // pre-existing test that was quietly deleted while new tests raised the total.
  let baselineTests = { suites: 0, tests: 0, failures: 0 };
  let allTests = { suites: 0, tests: 0, failures: 0 };

  const parseJest = (output: string): { suites: number; tests: number; failures: number } => {
    const suiteMatch = output.match(/Test Suites:.*?(\d+) passed, (\d+) total/);
    const testMatch = output.match(/Tests:.*?(\d+) passed, (\d+) total/);
    const failMatch = output.match(/(\d+) failed/);
    return {
      suites: suiteMatch ? Number(suiteMatch[2]) : 0,
      tests: testMatch ? Number(testMatch[2]) : 0,
      failures: failMatch ? Number(failMatch[1]) : 0,
    };
  };

  try {
    const output = execSync(
      'npx jest --testPathIgnorePatterns="tests/knowledge" 2>&1 || true',
      { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
    );
    baselineTests = parseJest(output);
  } catch {
    baselineTests = { suites: 0, tests: 0, failures: -1 };
  }

  record(
    'CONF-4',
    'Pre-existing corpus intact: 8 suites, 137 tests, isolated from knowledge tests',
    true,
    baselineTests.suites === 8 && baselineTests.tests === 137 && baselineTests.failures === 0,
    baselineTests
  );

  try {
    const output = execSync('npx jest 2>&1 || true', {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    allTests = parseJest(output);
  } catch {
    allTests = { suites: 0, tests: 0, failures: -1 };
  }

  record('CONF-5', 'Whole suite green', true, allTests.failures === 0, allTests);

  // ── Build, typecheck, audit ─────────────────────────────────────────
  let typecheckOk = true;
  try {
    execSync('npx tsc --noEmit', { cwd: REPO_ROOT, stdio: 'pipe' });
  } catch {
    typecheckOk = false;
  }
  record('CONF-6', 'tsc --noEmit clean under strict mode', true, typecheckOk, {
    clean: typecheckOk,
  });

  let buildOk = true;
  try {
    execSync('npm run build', { cwd: REPO_ROOT, stdio: 'pipe' });
  } catch {
    buildOk = false;
  }
  record('CONF-7', 'npm run build succeeds', true, buildOk, { ok: buildOk });

  let auditOk = true;
  try {
    execSync('npm audit --audit-level=critical', { cwd: REPO_ROOT, stdio: 'pipe' });
  } catch {
    auditOk = false;
  }
  record('CONF-8', 'npm audit --audit-level=critical clean', true, auditOk, { ok: auditOk });

  // ── Disabled-mode equivalence (G5, absolute) ────────────────────────
  const equivalencePath = join(EVIDENCE_DIR, 'equivalence-report.json');
  if (existsSync(equivalencePath)) {
    const equivalence = JSON.parse(readFileSync(equivalencePath, 'utf8'));
    record(
      'CONF-9',
      'G5 disabled-mode equivalence (ABSOLUTE gate)',
      true,
      equivalence.verdict === 'PASS',
      { verdict: equivalence.verdict, checks: equivalence.checks?.length ?? 0 }
    );
  } else {
    record('CONF-9', 'G5 disabled-mode equivalence report present', true, false, {
      missing: 'evidence/knowledge/equivalence-report.json',
    });
  }

  // ── Benchmark release gate (G7) ─────────────────────────────────────
  const benchmarkPath = join(EVIDENCE_DIR, 'benchmark-report.json');
  if (existsSync(benchmarkPath)) {
    const benchmark = JSON.parse(readFileSync(benchmarkPath, 'utf8'));
    record(
      'CONF-10',
      'Benchmark RELEASE GATE: citation accuracy and provenance completeness both 1.000',
      true,
      benchmark.releaseGate?.verdict === 'PASS',
      benchmark.releaseGate?.metrics
    );
    // Qualification is recorded but is NOT determinative: a refusal blocks
    // operational-retrieval qualification, not release.
    record(
      'CONF-11',
      'Benchmark OPERATIONAL QUALIFICATION (recorded, not determinative)',
      false,
      null,
      {
        verdict: benchmark.operationalQualification?.verdict,
        metrics: benchmark.operationalQualification?.metrics,
        caveat: benchmark.qualificationCaveat,
      }
    );
  } else {
    record('CONF-10', 'Benchmark report present', true, false, {
      missing: 'evidence/knowledge/benchmark-report.json',
    });
  }

  // ── Qdrant negative attestation (G6) ────────────────────────────────
  const qdrantPackages = Object.keys({
    ...pkg.dependencies,
    ...pkg.devDependencies,
  }).filter((name) => /qdrant/i.test(name));
  record(
    'CONF-12',
    'No Qdrant client dependency installed; MT-1..MT-8 held',
    true,
    qdrantPackages.length === 0,
    { qdrantPackages }
  );

  let qdrantProcesses: string[] = [];
  try {
    qdrantProcesses = sh('ps aux | grep -i qdrant | grep -v grep || true')
      .split('\n')
      .filter((line) => line.length > 0);
  } catch {
    qdrantProcesses = [];
  }
  record('CONF-13', 'No Qdrant process running', true, qdrantProcesses.length === 0, {
    processes: qdrantProcesses.length,
  });

  // ── Evidence completeness ───────────────────────────────────────────
  const requiredEvidence = [
    'branch-attestation.txt',
    'G5-equivalence-attestation.md',
    'equivalence-report.json',
    'health-disabled.json',
    'health-enabled.json',
    'routes-disabled.txt',
    'routes-enabled.txt',
    'fs-diff-disabled.txt',
    'qdrant-adapter-report.md',
    'qdrant-dependency-assessment.md',
    'mocked-transport-attestation.txt',
    'benchmark-report.json',
  ];
  const missing = requiredEvidence.filter((file) => !existsSync(join(EVIDENCE_DIR, file)));
  record('CONF-14', 'All required evidence artefacts present', true, missing.length === 0, {
    required: requiredEvidence.length,
    missing,
  });

  // ── Verdict ─────────────────────────────────────────────────────────
  const determinative = checks.filter((c) => c.determinative);
  const verdict = determinative.every((c) => c.result === 'PASS') ? 'PASS' : 'FAIL';

  const report = {
    gate: 'G7',
    name: 'R-Knowledge conformance',
    baselineCommit: BASELINE,
    branch: sh('git rev-parse --abbrev-ref HEAD'),
    head: sh('git rev-parse HEAD'),
    verdict,
    determinativeChecks: determinative.length,
    informationalChecks: checks.length - determinative.length,
    checks,
  };

  writeFileSync(
    join(EVIDENCE_DIR, 'conformance-report.json'),
    JSON.stringify(report, null, 2) + '\n'
  );

  console.log('\n=========================================================');
  console.log('R-KNOWLEDGE CONFORMANCE · Gate G7');
  console.log('=========================================================');
  console.log(`${'ID'.padEnd(10)} ${'RESULT'.padEnd(7)} ${'DET'.padEnd(4)} DESCRIPTION`);
  console.log('-'.repeat(100));
  for (const check of checks) {
    console.log(
      `${check.id.padEnd(10)} ${check.result.padEnd(7)} ${(check.determinative ? 'yes' : 'no').padEnd(4)} ${check.description}`
    );
  }
  console.log('-'.repeat(100));
  console.log(`VERDICT: ${verdict}  (${determinative.length} determinative checks)`);
  console.log('wrote evidence/knowledge/conformance-report.json');
  console.log('=========================================================\n');

  return verdict === 'PASS' ? 0 : 1;
}

process.exit(main());
