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

  it('serves the adapter protocol on localhost', async () => {
    const response = await request(createLangGraphLocalApp()).post('/v1/plan').send({ objective: 'Documentează runtime-ul' });
    expect(response.status).toBe(200);
    expect(response.body.assignments[0].id).toMatch(/^langgraph-/);
  });
});
