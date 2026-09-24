import request from 'supertest';
import { COMMIT_INSTRUCTION, createLangGraphLocalApp, planningGraph } from '../../src/runtime/automation/services/langgraph-local';

describe('RONOR local LangGraph planner', () => {
  it('uses a compiled graph and emits mandate-safe actions only', async () => {
    const result = await planningGraph.invoke({ objective: 'Verifică securitatea și testele', domains: [], assignments: [], readOnly: false });
    expect(result.assignments.length).toBeGreaterThan(1);
    const actions = result.assignments.flatMap((item) => item.actions);
    expect(actions).toEqual(expect.arrayContaining(['read_repo', 'run_tests', 'commit_local']));
    expect(actions).not.toEqual(expect.arrayContaining(['push', 'merge', 'deploy']));
  });

  it('removes every write action from an explicitly read-only objective', async () => {
    const result = await planningGraph.invoke({ objective: 'Verify runtime without editing files', domains: [], assignments: [], readOnly: false });
    const actions = result.assignments.flatMap((item) => item.actions);
    expect(actions).toEqual(expect.arrayContaining(['read_repo', 'run_tests']));
    expect(actions).not.toEqual(expect.arrayContaining(['edit_worktree', 'commit_local']));
  });

  it('understands Romanian READ-ONLY instructions with diacritics', async () => {
    const result = await planningGraph.invoke({ objective: 'Verifică infrastructura și securitatea fără modificări', domains: [], assignments: [], readOnly: false });
    expect(result.assignments.map((item) => item.id)).toEqual(expect.arrayContaining([
      expect.stringContaining('security'), expect.stringContaining('infrastructure'), expect.stringContaining('runtime'),
    ]));
    expect(result.assignments.flatMap((item) => item.actions)).not.toEqual(expect.arrayContaining(['edit_worktree', 'commit_local']));
  });

  it('routes CONTROL, knowledge and infrastructure work into distinct bounded assignments', async () => {
    const result = await planningGraph.invoke({ objective: 'Improve CONTROL dashboard, R-Knowledge memory and Docker infrastructure', domains: [], assignments: [], readOnly: false });
    const ids = result.assignments.map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining([
      expect.stringContaining('control-ui'), expect.stringContaining('infrastructure'), expect.stringContaining('knowledge'),
    ]));
    expect(result.assignments).toHaveLength(5);
    expect(result.assignments.at(-1)).toMatchObject({ id: 'langgraph-local-commit', actions: ['commit_local'] });
  });

  it('pins the commit assignment away from re-running the suite', async () => {
    // Regression: on 2026-09-09 the commit assignment said only "after all
    // declared tests pass", so the agent ran the whole suite, met pre-existing
    // failures in tests/knowledge and tests/runtime/api, and never committed.
    const result = await planningGraph.invoke({ objective: 'Documentează runtime-ul', domains: [], assignments: [], readOnly: false });
    const commit = result.assignments.at(-1);
    expect(commit).toMatchObject({ id: 'langgraph-local-commit', actions: ['commit_local'] });
    expect(commit?.instruction).toBe(COMMIT_INSTRUCTION);
    expect(commit?.instruction).toMatch(/do not run the test suite/i);
    expect(commit?.instruction).toMatch(/already executed by the runtime/i);
    expect(commit?.instruction).toMatch(/pre-existing test failures/i);
    expect(commit?.instruction).not.toMatch(/after all declared tests pass/i);
    expect(commit?.instruction.length).toBeLessThanOrEqual(8000);
  });

  it('keeps the commit assignment absent from a read-only plan', async () => {
    const result = await planningGraph.invoke({ objective: 'Verify runtime without editing files', domains: [], assignments: [], readOnly: false });
    expect(result.assignments.map((item) => item.id)).not.toContain('langgraph-local-commit');
    expect(result.assignments.every((item) => item.instruction !== COMMIT_INSTRUCTION)).toBe(true);
  });

  it('serves the adapter protocol on localhost', async () => {
    const response = await request(createLangGraphLocalApp()).post('/v1/plan').send({ objective: 'Documentează runtime-ul' });
    expect(response.status).toBe(200);
    expect(response.body.assignments[0].id).toMatch(/^langgraph-/);
  });

  it('authenticates both health attestation and planning when configured', async () => {
    const app = createLangGraphLocalApp({ serviceToken: 'graph-secret' });
    expect((await request(app).get('/health')).status).toBe(401);
    const health = await request(app).get('/health').set('Authorization', 'Bearer graph-secret');
    expect(health.body.protocol).toBe('ronor-langgraph/v1');
    expect((await request(app).post('/v1/plan').send({ objective: 'test runtime' })).status).toBe(401);
  });
});
