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
  const text = state.objective.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  const rules: Array<[string, RegExp]> = [
    ['security', /\b(?:security|securitate(?:a)?|auth(?:entication|orization)?|credential|secret|risk|risc)\b/],
    ['test', /\b(?:test(?:s|ing)?|verify|verification|verific(?:a|are|ari)|ci|conformance)\b/],
    ['documentation', /\b(?:doc(?:s|ument|umentation)?|document(?:eaza|are)|readme|runbook)\b/],
    ['control-ui', /\b(?:control|dashboard|front[ -]?end|ui|ux|interfata|website|web)\b/],
    ['infrastructure', /\b(?:infra(?:structure)?|infrastructur(?:a|e)?|docker|compose|tailscale|server|hetzner|contabo|digital ocean|cloudflare|r2|deployment)\b/],
    ['knowledge', /\b(?:knowledge|cunostinte|memorie|memory|retrieval|rag|continuumpedia|cida)\b/],
  ];
  const domains = rules.filter(([, pattern]) => pattern.test(text)).map(([domain]) => domain);
  if (!domains.includes('runtime')) domains.push('runtime');
  const readOnly = /\b(?:read[ -]?only|fara (?:modificari|editare)|nu modifica|doar (?:inspecteaza|verifica)|no (?:file )?(?:edit|change)s?|without (?:file )?(?:editing|changes))\b/.test(text);
  return { domains, readOnly };
}

/**
 * The commit assignment must never re-derive its own test scope. The runtime
 * already runs the declared allow-listed commands for the preceding
 * assignments and records their reports; an agent that reruns the whole suite
 * meets pre-existing failures outside the approved objective and spends the
 * mandate repairing them instead of committing.
 */
export const COMMIT_INSTRUCTION = [
  'Create exactly one local commit for the changes already present in the worktree.',
  'Do not run the test suite and do not invoke any test command: the declared allow-listed tests were already executed by the runtime for the preceding assignments, and their reports are the recorded evidence for this run.',
  'Do not investigate, repair or modify anything outside the changes already present in the worktree, including pre-existing test failures.',
  'If the worktree has no changes, make no commit and report that instead.',
].join(' ');

function createPlan(state: typeof PlanState.State): Partial<typeof PlanState.State> {
  const actions = state.readOnly
    ? ['read_repo', 'run_tests'] as AutomationAction[]
    : ['read_repo', 'edit_worktree', 'run_tests'] as AutomationAction[];
  const assignments: PlannedAssignment[] = state.domains.map((domain, index) => ({
    id: `langgraph-${domain}-${index + 1}`,
    instruction: `Address the ${domain} portion of the approved objective. Stay inside the declared actions and produce bounded evidence: ${state.objective}`,
    actions,
  }));
  if (!state.readOnly) assignments.push({ id: 'langgraph-local-commit', instruction: COMMIT_INSTRUCTION, actions: ['commit_local'] });
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
