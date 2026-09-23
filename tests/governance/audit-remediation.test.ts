import { RExecutionPlane } from '../../src/planes/r-execution';
import { RONOROrchestrator } from '../../src/orchestrator';
import { InferenceAdmission, validateAdmission } from '../../src/governance/inference-admission';
import * as mi9 from '../../src/governance/mi9-gate';
import * as audit from '../../src/audit/hash-chain';

jest.mock('../../src/audit/hash-chain', () => ({ append: jest.fn(() => ({})) }));
jest.mock('../../src/governance/cosign-store', () => ({ hold: jest.fn() }));

const route = { baseURL: 'http://127.0.0.1:8000/v1', model: 'local-fixture' };
const request = { id: 'request-1', sessionId: 'session-1', prompt: 'fixture', createdAt: new Date() };
function admission(): InferenceAdmission {
  return {
    requestId: request.id, sessionId: request.sessionId, expiresAtMs: Date.now() + 60000,
    route: { ...route },
    context: {
      decisionId: request.id, domain: 'energy.reporting.generate', action: 'inference.start',
      taskClass: 'conversational', proposedBy: 'server-authority', confidence: 0.99,
      reversible: true, impactMagnitude: { unit: 'EUR', value: 0 },
      sovereignty: { dataResidency: 'eu', subjectJurisdiction: 'RO' },
      evidence: { sourceCount: 2, lastRefreshMs: 0, consensusReached: true },
      operator: { role: 'operator' }, metadata: { fallbackAvailable: true },
    },
  };
}
function planes() {
  return {
    gateway: { process: jest.fn(async () => request) },
    context: { process: jest.fn(async (x: unknown) => x) },
    modelFabric: {
      getRouteIdentity: () => route,
      process: jest.fn(async () => { throw new Error('MODEL_REACHED'); }),
    },
    agentRuntime: { process: jest.fn() }, execution: { process: jest.fn() },
    assurance: { process: jest.fn() }, economics: { process: jest.fn() },
  };
}
beforeEach(() => { mi9.loadPolicy(); mi9.resetRateLimits(); jest.clearAllMocks(); });

describe('F02 pre-effect governance', () => {
  test('missing authority refuses without context, inference or tools', async () => {
    const p = planes();
    await expect(new RONOROrchestrator(p as any).process(request)).rejects.toThrow('ADMISSION_INVALID');
    expect(p.context.process).not.toHaveBeenCalled();
    expect(p.modelFabric.process).not.toHaveBeenCalled();
    expect(p.execution.process).not.toHaveBeenCalled();
  });
  test('client metadata cannot supply its own admission, even with enforcement disabled', async () => {
    const old = process.env.MI9_ENFORCE;
    process.env.MI9_ENFORCE = 'off';
    try {
      const p = planes();
      await expect(new RONOROrchestrator(p as any).process({
        ...request, metadata: { admission: admission(), authorised: true },
      })).rejects.toThrow('ADMISSION_INVALID');
      expect(p.modelFabric.process).not.toHaveBeenCalled();
    } finally {
      if (old === undefined) delete process.env.MI9_ENFORCE; else process.env.MI9_ENFORCE = old;
    }
  });
  test('policy blocks disallowed actual-route residency before inference', async () => {
    const p = planes(), a = admission();
    a.context.sovereignty.dataResidency = 'us';
    await expect(new RONOROrchestrator(p as any, async () => a).process(request))
      .rejects.toThrow('INFERENCE_REFUSED');
    expect(p.modelFabric.process).not.toHaveBeenCalled();
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({
      outcome: { action: 'blocked' },
    }));
  });
  test('cosign is not autonomous permission', async () => {
    const p = planes(), a = admission();
    a.context.taskClass = 'operational';
    a.context.domain = 'energy.bess.dispatch';
    await expect(new RONOROrchestrator(p as any, async () => a).process(request))
      .rejects.toThrow('INFERENCE_REFUSED');
    expect(p.modelFabric.process).not.toHaveBeenCalled();
  });
  test('allow records admission, not execution, before reaching model', async () => {
    const p = planes();
    await expect(new RONOROrchestrator(p as any, async () => admission()).process(request))
      .rejects.toThrow('MODEL_REACHED');
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({
      outcome: { action: 'admitted' },
    }));
    expect(p.modelFabric.process).toHaveBeenCalledTimes(1);
  });
  test('audit storage failure prevents a model call', async () => {
    const p = planes();
    (audit.append as jest.Mock).mockImplementationOnce(() => { throw new Error('disk failure'); });
    await expect(new RONOROrchestrator(p as any, async () => admission()).process(request))
      .rejects.toThrow('disk failure');
    expect(p.modelFabric.process).not.toHaveBeenCalled();
  });
  test.each(['request', 'session', 'route', 'expiry', 'nan'])('%s mismatch fails closed', (kind) => {
    const a = admission();
    if (kind === 'request') a.requestId = 'wrong';
    if (kind === 'session') a.sessionId = 'wrong';
    if (kind === 'route') a.route.model = 'unapproved-fallback';
    if (kind === 'expiry') a.expiresAtMs = Date.now() - 1;
    if (kind === 'nan') a.context.impactMagnitude.value = NaN;
    expect(() => validateAdmission(a, request.id, request.sessionId, route)).toThrow('ADMISSION_INVALID');
  });
});

describe('F07 truthful execution', () => {
  test('tool plan without executor fails, never fabricates success', async () => {
    const p = new RExecutionPlane();
    await expect(p.process({ agentSteps: [{ toolCall: { name: 'shell', params: {} } }] } as any))
      .rejects.toThrow('EXECUTOR_UNAVAILABLE');
    expect((await p.health()).status).toBe('degraded');
    expect((await p.health()).errorsTotal).toBe(1);
  });
  test('no-tool request has zero invocations and no execution receipts', async () => {
    const result = await new RExecutionPlane().process({ agentSteps: [] } as any);
    expect(result.toolsInvoked).toBe(0);
    expect(result.executionLog).toEqual([]);
  });
});
