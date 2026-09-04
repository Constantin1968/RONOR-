/**
 * RONOR Orchestrator
 * Coordinates all 7 operational planes for each inference request.
 */

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from './utils/logger';
import * as mi9 from './governance/mi9-gate';
import * as auditChain from './audit/hash-chain';
import type { DecisionContext } from './governance/mi9-gate';
import type {
  RONORRequest,
  RONORResponse,
  PlaneHealth,
  PlaneTrace,
  EMSScore,
} from './types';
import type { RGatewayPlane } from './planes/r-gateway';
import type { RContextPlane } from './planes/r-context';
import type { RModelFabricPlane } from './planes/r-model-fabric';
import type { RAgentRuntimePlane } from './planes/r-agent-runtime';
import type { RExecutionPlane } from './planes/r-execution';
import type { RAssurancePlane } from './planes/r-assurance';
import type { REconomicsPlane } from './planes/r-economics';

export interface OrchestratorPlanes {
  gateway: RGatewayPlane;
  context: RContextPlane;
  modelFabric: RModelFabricPlane;
  agentRuntime: RAgentRuntimePlane;
  execution: RExecutionPlane;
  assurance: RAssurancePlane;
  economics: REconomicsPlane;
}

export class RONOROrchestrator {
  private readonly logger = createLogger('RONOR:Orchestrator');
  private readonly planes: OrchestratorPlanes;

  constructor(planes: OrchestratorPlanes) {
    this.planes = planes;
  }

  /**
   * Process a request through all 7 operational planes.
   * Data flow: Gateway → Context → Model Fabric → Agent Runtime
   *            → Execution → Assurance → Economics → Response
   */
  async process(request: RONORRequest): Promise<RONORResponse> {
    const startTime = Date.now();
    const traces: PlaneTrace[] = [];
    this.logger.info(`Processing request ${request.id}`);

    try {
      // Plane 1: R-Gateway — auth, rate limiting, request validation
      const gatewayResult = await this.runPlane('r-gateway', async () =>
        this.planes.gateway.process(request)
      , traces);

      // Plane 2: R-Context — context enrichment & compression
      const contextResult = await this.runPlane('r-context', async () =>
        this.planes.context.process(gatewayResult)
      , traces);

      // Plane 3: R-Model Fabric — intelligent model selection via GPT-5.6 routing
      const modelResult = await this.runPlane('r-model-fabric', async () =>
        this.planes.modelFabric.process(contextResult)
      , traces);

      // Plane 4: R-Agent Runtime — multi-agent orchestration if needed
      const agentResult = await this.runPlane('r-agent-runtime', async () =>
        this.planes.agentRuntime.process(modelResult)
      , traces);

      // Plane 5: R-Execution — tool calls, code execution
      const executionResult = await this.runPlane('r-execution', async () =>
        this.planes.execution.process(agentResult)
      , traces);

      // Plane 6: R-Assurance — quality verification, evidence chain
      const assuranceResult = await this.runPlane('r-assurance', async () =>
        this.planes.assurance.process(executionResult)
      , traces);

      // Plane 7: R-Economics — EMS scoring, cost tracking
      const economicsResult = await this.runPlane('r-economics', async () =>
        this.planes.economics.process(assuranceResult)
      , traces);

      const totalLatency = Date.now() - startTime;

      const response: RONORResponse = {
        id: uuidv4(),
        requestId: request.id,
        content: economicsResult.content,
        modelUsed: economicsResult.modelUsed,
        planeTrace: traces,
        ems: economicsResult.ems,
        evidenceChain: assuranceResult.evidenceChain,
        tokensUsed: economicsResult.tokensUsed,
        latencyMs: totalLatency,
        sovereigntyVerified: assuranceResult.sovereigntyVerified,
        createdAt: new Date(),
      };
      // Poarta MI9 pe traseu, apoi depunerea actului in lantul de audit
      try {
        const evidenceCount = Array.isArray(assuranceResult.evidenceChain)
          ? assuranceResult.evidenceChain.length
          : 0;
        const costUsd = economicsResult.tokensUsed?.estimatedCostUsd ?? 0;
        const ctx: DecisionContext = {
          decisionId: request.id,
          domain:
            typeof request.metadata?.domain === 'string'
              ? (request.metadata.domain as string)
              : 'general',
          action: 'inference.respond',
          proposedBy: economicsResult.modelUsed,
          confidence:
            typeof assuranceResult.qualityScore === 'number' ? assuranceResult.qualityScore : 0,
          reversible: true,
          impactMagnitude: { unit: 'EUR', value: costUsd },
          sovereignty: { dataResidency: 'eu', subjectJurisdiction: 'RO' },
          evidence: {
            sourceCount: evidenceCount,
            lastRefreshMs: 0,
            consensusReached: Boolean(assuranceResult.sovereigntyVerified),
          },
          operator: { userId: request.sessionId, role: 'operator' },
          metadata: { surface: 'api.v1.inference', latencyMs: totalLatency },
        };
        const mi9Result = mi9.evaluate(ctx);
        const outcomeAction =
          mi9Result.verdict === 'allow'
            ? 'executed'
            : mi9Result.verdict === 'allow-with-cosign'
              ? 'held-for-cosign'
              : mi9Result.verdict === 'escalate'
                ? 'escalated'
                : 'blocked';
        const rec = auditChain.append({
          decisionId: request.id,
          decisionType: 'planes.inference',
          timestamp: new Date().toISOString(),
          context: ctx,
          mi9Result,
          aiProposal: {
            model: economicsResult.modelUsed,
            rationale: 'raspuns generat prin coloana de planuri',
            tokensUsed: economicsResult.tokensUsed?.totalTokens ?? 0,
            latencyMs: totalLatency,
          },
          outcome: { action: outcomeAction },
        });
        response.governance = {
          verdict: mi9Result.verdict,
          policyVersion: mi9Result.policyVersion,
          humanCoSignRequired: mi9Result.humanCoSignRequired,
          gatesEvaluated: mi9Result.findings.length,
          blockingGates: mi9Result.findings
            .filter((f) => f.verdict !== 'allow')
            .map((f) => `${f.gateNumber}:${f.gateName}:${f.verdict}`),
        };
        response.auditRecordId = rec.recordId;
        response.auditSeq = Number(rec.seq);
        response.auditChainHash = rec.chainHash;
      } catch (e) {
        this.logger.error(
          `Poarta MI9 sau depunerea in lantul de audit a esuat: ${(e as Error).message}`,
        );
        response.auditError = (e as Error).message;
      }


      this.logger.info(
        `Request ${request.id} completed in ${totalLatency}ms | EMS: ${response.ems.total.toFixed(3)}`
      );

      return response;
    } catch (error) {
      this.logger.error(`Request ${request.id} failed:`, error);
      throw error;
    }
  }

  private async runPlane<T>(
    planeId: string,
    fn: () => Promise<T>,
    traces: PlaneTrace[]
  ): Promise<T> {
    const enteredAt = new Date();
    try {
      const result = await fn();
      const exitedAt = new Date();
      traces.push({
        planeId: planeId as any,
        enteredAt,
        exitedAt,
        durationMs: exitedAt.getTime() - enteredAt.getTime(),
        status: 'pass',
      });
      return result;
    } catch (error) {
      const exitedAt = new Date();
      traces.push({
        planeId: planeId as any,
        enteredAt,
        exitedAt,
        durationMs: exitedAt.getTime() - enteredAt.getTime(),
        status: 'error',
        notes: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async getSystemHealth(): Promise<PlaneHealth[]> {
    return Promise.all([
      this.planes.gateway.health(),
      this.planes.context.health(),
      this.planes.modelFabric.health(),
      this.planes.agentRuntime.health(),
      this.planes.execution.health(),
      this.planes.assurance.health(),
      this.planes.economics.health(),
    ]);
  }
}
