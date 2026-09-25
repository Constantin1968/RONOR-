/**
 * R-Execution Plane
 * Plane 5 of 7 — tool calls proposed by the agent runtime.
 *
 * F07 (registrul de remediere v6, „execuție fictivă”): versiunea anterioară
 * număra fiecare `toolCall` drept invocat și scria „executed” în jurnal, deși
 * nu exista niciun executor. Planul raporta `healthy`.
 *
 * Acum planul nu mai pretinde nimic. Un apel de unealtă propus de model este o
 * propunere, nu o autoritate (F04): se înregistrează ca `refused` cu motivul
 * `executor_unavailable`, `toolsInvoked` rămâne 0, iar sănătatea planului e
 * `degraded`, pentru că execuția de unelte nu există pe această cale.
 *
 * Efectele pe gazdă au o singură cale: executorul cu mandat
 * (`src/runtime/executor`), cu mandat semnat, listă albă de acțiuni tipizate,
 * aprobare legată de hash-ul acțiunii pentru `ops.actuate` și STOP. Ieșirea
 * unui model nu ajunge acolo: executorul refuză orice cerere a cărei
 * proveniență nu e `operator`.
 */

import { createLogger } from '../../utils/logger';
import type { PlaneHealth } from '../../types';
import type { AgentRuntimeResult } from '../r-agent-runtime';

const logger = createLogger('Plane:R-Execution');

export interface ToolCallDisposition {
  name: string;
  state: 'refused';
  reason: 'executor_unavailable';
}

export interface ExecutionResult extends AgentRuntimeResult {
  executionLog: string[];
  /** Numai apelurile efectuate de un executor; pe această cale, întotdeauna 0. */
  toolsInvoked: number;
  toolCalls?: ToolCallDisposition[];
}

export class RExecutionPlane {
  private requestsTotal = 0;
  private errorsTotal = 0;

  async init(): Promise<void> {
    logger.info('R-Execution plane initialised: tool calls are refused, no executor on this path');
  }

  async process(input: AgentRuntimeResult): Promise<ExecutionResult> {
    this.requestsTotal++;
    const executionLog: string[] = [];
    const toolCalls: ToolCallDisposition[] = [];

    for (const step of input.agentSteps) {
      if (step.toolCall) {
        toolCalls.push({ name: step.toolCall.name, state: 'refused', reason: 'executor_unavailable' });
        executionLog.push(
          `[${new Date().toISOString()}] Tool: ${step.toolCall.name} — refused: executor_unavailable (not executed)`,
        );
      }
    }

    return {
      ...input,
      executionLog,
      toolsInvoked: 0,
      toolCalls,
    };
  }

  async health(): Promise<PlaneHealth> {
    return {
      planeId: 'r-execution',
      // Fără executor pe această cale, planul nu poate executa nimic: `degraded`, nu `healthy`.
      status: 'degraded',
      latencyMs: 1,
      requestsTotal: this.requestsTotal,
      errorsTotal: this.errorsTotal,
      lastChecked: new Date(),
    };
  }
}
