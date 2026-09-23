/**
 * R-Execution Plane
 * Plane 5 of 7 — Sandboxed tool and code execution.
 *
 * Responsibilities:
 * - Safe execution of tool calls from agent runtime
 * - Code sandbox management
 * - Retry logic with exponential backoff
 * - Execution result validation
 * - Resource usage tracking
 */

import { createLogger } from '../../utils/logger';
import type { PlaneHealth } from '../../types';
import type { AgentRuntimeResult } from '../r-agent-runtime';

const logger = createLogger('Plane:R-Execution');

export interface ExecutionResult extends AgentRuntimeResult {
  executionLog: string[];
  toolsInvoked: number;
}

export class RExecutionPlane {
  private requestsTotal = 0;
  private errorsTotal = 0;

  async init(): Promise<void> {
    logger.info('R-Execution plane initialised ✓');
  }

  async process(input: AgentRuntimeResult): Promise<ExecutionResult> {
    this.requestsTotal++;
    const executionLog: string[] = [];
    let toolsInvoked = 0;

    // No authorised executor is wired to this plane. A plan is NOT evidence
    // of execution. Fail closed rather than inventing a successful receipt.
    for (const step of input.agentSteps) {
      if (step.toolCall) {
        this.errorsTotal++;
        throw new Error('EXECUTOR_UNAVAILABLE: tool call refused before execution');
      }
    }

    return {
      ...input,
      executionLog,
      toolsInvoked,
    };
  }

  async health(): Promise<PlaneHealth> {
    return {
      planeId: 'r-execution',
      status: 'degraded',
      latencyMs: 1,
      requestsTotal: this.requestsTotal,
      errorsTotal: this.errorsTotal,
      lastChecked: new Date(),
    };
  }
}
