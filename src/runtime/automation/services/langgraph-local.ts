import express from 'express';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { AutomationAction, PlannedAssignment } from '../contracts';

const PlanState = Annotation.Root({
  objective: Annotation<string>(),
  domains: Annotation<string[]>(),
  assignments: Annotation<PlannedAssignment[]>(),
});

function classify(state: typeof PlanState.State): Partial<typeof PlanState.State> {
  const text = state.objective.toLowerCase();
  const domains = ['security', 'test', 'documentation', 'runtime'].filter((domain) => {
    if (domain === 'security') return /security|securitate|auth|secret/.test(text);
    if (domain === 'test') return /test|verify|verific/.test(text);
    if (domain === 'documentation') return /doc|document/.test(text);
    return true;
  });
  return { domains };
}

function createPlan(state: typeof PlanState.State): Partial<typeof PlanState.State> {
  const assignments: PlannedAssignment[] = state.domains.map((domain, index) => ({
    id: `langgraph-${domain}-${index + 1}`,
    instruction: `Address the ${domain} portion of the approved objective: ${state.objective}`,
    actions: ['read_repo', 'edit_worktree', 'run_tests'] as AutomationAction[],
  }));
  assignments.push({ id: 'langgraph-local-commit', instruction: 'Create a clear local commit after all declared tests pass.', actions: ['commit_local'] });
  return { assignments };
}

export const planningGraph = new StateGraph(PlanState)
  .addNode('classify', classify)
  .addNode('plan', createPlan)
  .addEdge(START, 'classify')
  .addEdge('classify', 'plan')
  .addEdge('plan', END)
  .compile();

export function createLangGraphLocalApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));
  app.get('/health', (_req, res) => res.json({ ok: true, service: 'ronor-langgraph-local' }));
  app.post('/v1/plan', async (req, res) => {
    const objective = typeof req.body?.objective === 'string' ? req.body.objective.trim() : '';
    if (!objective || objective.length > 8000) {
      res.status(400).json({ ok: false, error: 'invalid_objective' });
      return;
    }
    const result = await planningGraph.invoke({ objective, domains: [], assignments: [] });
    res.json({ assignments: result.assignments });
  });
  return app;
}

if (require.main === module) {
  const port = Number(process.env.RONOR_LANGGRAPH_PORT ?? 2024);
  createLangGraphLocalApp().listen(port, '127.0.0.1', () => {
    process.stdout.write(`RONOR LangGraph local listening on 127.0.0.1:${port}\n`);
  });
}
