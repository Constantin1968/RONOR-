import express from 'express';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { AutomationAction, PlannedAssignment } from '../contracts';
import { requiredSecret } from './secret-files';

const PlanState = Annotation.Root({
  objective: Annotation<string>(),
  domains: Annotation<string[]>(),
  assignments: Annotation<PlannedAssignment[]>(),
  readOnly: Annotation<boolean>(),
});

function classify(state: typeof PlanState.State): Partial<typeof PlanState.State> {
  const text = state.objective.toLowerCase();
  const domains = ['security', 'test', 'documentation', 'runtime'].filter((domain) => {
    if (domain === 'security') return /security|securitate|auth|secret/.test(text);
    if (domain === 'test') return /test|verify|verific/.test(text);
    if (domain === 'documentation') return /doc|document/.test(text);
    return true;
  });
  const readOnly = /read[ -]?only|f[aă]r[aă] modific|f[aă]r[aă] edit|no (?:file )?(?:edit|change)|without (?:file )?(?:editing|changes)/.test(text);
  return { domains, readOnly };
}

function createPlan(state: typeof PlanState.State): Partial<typeof PlanState.State> {
  const actions = state.readOnly
    ? ['read_repo', 'run_tests'] as AutomationAction[]
    : ['read_repo', 'edit_worktree', 'run_tests'] as AutomationAction[];
  const assignments: PlannedAssignment[] = state.domains.map((domain, index) => ({
    id: `langgraph-${domain}-${index + 1}`,
    instruction: `Address the ${domain} portion of the approved objective: ${state.objective}`,
    actions,
  }));
  if (!state.readOnly) assignments.push({ id: 'langgraph-local-commit', instruction: 'Create a clear local commit after all declared tests pass.', actions: ['commit_local'] });
  return { assignments };
}

export const planningGraph = new StateGraph(PlanState)
  .addNode('classify', classify)
  .addNode('plan', createPlan)
  .addEdge(START, 'classify')
  .addEdge('classify', 'plan')
  .addEdge('plan', END)
  .compile();

export function createLangGraphLocalApp(config: { serviceToken?: string } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));
  if (config.serviceToken) app.use((req, res, next) => {
    if (req.header('authorization') !== `Bearer ${config.serviceToken}`) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
    next();
  });
  app.get('/health', (_req, res) => res.json({ ok: true, protocol: 'ronor-langgraph/v1', service_id: 'langgraph', capabilities: ['plan'] }));
  app.post('/v1/plan', async (req, res) => {
    const objective = typeof req.body?.objective === 'string' ? req.body.objective.trim() : '';
    if (!objective || objective.length > 8000) {
      res.status(400).json({ ok: false, error: 'invalid_objective' });
      return;
    }
    const result = await planningGraph.invoke({ objective, domains: [], assignments: [], readOnly: false });
    res.json({ assignments: result.assignments });
  });
  return app;
}

if (require.main === module) {
  const port = Number(process.env.RONOR_LANGGRAPH_PORT ?? 2024);
  const serviceToken = requiredSecret('RONOR_LANGGRAPH_TOKEN');
  const host = process.env.RONOR_LANGGRAPH_HOST || '127.0.0.1';
  createLangGraphLocalApp({ serviceToken }).listen(port, host, () => {
    process.stdout.write(`RONOR LangGraph local listening on ${host}:${port}\n`);
  });
}
