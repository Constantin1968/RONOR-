/**
 * RONOR Orchestrator
 * Coordinates all 7 operational planes for each inference request.
 */

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from './utils/logger';
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
