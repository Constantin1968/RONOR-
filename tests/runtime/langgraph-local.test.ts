import request from 'supertest';
import { createLangGraphLocalApp, planningGraph } from '../../src/runtime/automation/services/langgraph-local';

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
