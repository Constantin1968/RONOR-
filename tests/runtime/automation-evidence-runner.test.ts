import request from 'supertest';
import { createEvidenceRunnerApp } from '../../src/runtime/automation/services/evidence-runner';
import { createHttpPostExecutionVerifier } from '../../src/runtime/automation/post-execution-verifier';
import type { EvidenceArtifact } from '../../src/runtime/automation/contracts';

const diff: EvidenceArtifact = { kind: 'git_diff', sha256: 'a'.repeat(64), reference: 'run/task/git.diff', bytes: 10 };
const status: EvidenceArtifact = { kind: 'git_status', sha256: 'b'.repeat(64), reference: 'run/task/git.status', bytes: 5 };
const report: EvidenceArtifact = { kind: 'test_report', sha256: 'c'.repeat(64), reference: 'run/task/test-report.json', bytes: 20 };

describe('isolated automation evidence runner', () => {
  it('authenticates, collects Git evidence and runs only server-configured tests', async () => {
    const collect = jest.fn(() => [diff, status]); const run = jest.fn(() => ({ passed: true, claims: ['tests:pass'], artifact: report }));
    const app = createEvidenceRunnerApp({ token: 'runner-token', workspaceRoot: '/workspace/project', artifacts: { collect, verify: jest.fn(), read: jest.fn(), recordTestReport: jest.fn() }, tests: { run } });
    expect((await request(app).post('/v1/verify').send({ run_id: 'run-1', assignment_id: 'task-1', run_tests: true })).status).toBe(401);
    const response = await request(app).post('/v1/verify').set('Authorization', 'Bearer runner-token').send({ run_id: 'run-1', assignment_id: 'task-1', run_tests: true });
    expect(response.status).toBe(200); expect(response.body).toMatchObject({ passed: true, claims: ['tests:pass'], artifacts: [diff, status, report] });
    expect(collect).toHaveBeenCalledWith('/workspace/project', 'run-1', 'task-1');
    expect(run).toHaveBeenCalledWith('/workspace/project', 'run-1', 'task-1');
    expect(JSON.stringify(response.body)).not.toContain('/workspace/project');
  });

  it('does not execute tests for a read-only assignment', async () => {
    const run = jest.fn();
    const app = createEvidenceRunnerApp({ token: 'runner-token', workspaceRoot: '/workspace/project', artifacts: { collect: jest.fn(() => [diff, status]), verify: jest.fn(), read: jest.fn(), recordTestReport: jest.fn() }, tests: { run } });
    const response = await request(app).post('/v1/verify').set('Authorization', 'Bearer runner-token').send({ run_id: 'run-1', assignment_id: 'task-1', run_tests: false });
    expect(response.body.artifacts).toHaveLength(2); expect(run).not.toHaveBeenCalled();
  });

  it('client sends no workspace path or commands and validates the artifact envelope', async () => {
    const fetcher = jest.fn(async (_url, init) => new Response(JSON.stringify({ passed: true, claims: ['tests:pass'], artifacts: [diff, status, report] }), { status: 200 }));
    const client = createHttpPostExecutionVerifier({ baseUrl: 'http://automation-evidence-runner:3005', token: 'runner-token', fetcher });
    await expect(client.verify('run-1', 'task-1', true)).resolves.toMatchObject({ passed: true, artifacts: [diff, status, report] });
    const body = String((fetcher.mock.calls[0][1] as RequestInit).body);
    expect(body).toBe('{"run_id":"run-1","assignment_id":"task-1","run_tests":true}');
    expect(body).not.toContain('workspace'); expect(body).not.toContain('command');
  });

  it('attests the exact isolated service identity before use', async () => {
    const fetcher = jest.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      ok: true, protocol: 'ronor-evidence-runner/v1', service_id: 'automation-evidence-runner',
      capabilities: ['git-evidence', 'allowlisted-tests'],
    })));
    await expect(createHttpPostExecutionVerifier({ baseUrl: 'http://automation-evidence-runner:3005', token: 'runner-token', fetcher }).attest()).resolves.toBeUndefined();
    expect((fetcher.mock.calls[0][1] as RequestInit).headers).toEqual({ authorization: 'Bearer runner-token' });
  });
});
