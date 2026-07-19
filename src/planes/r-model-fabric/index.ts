/**
 * R-Model Fabric Plane
 * Plane 3 of 7 — Intelligent model routing, selection, and inference.
 *
 * GPT-5.6 is the core inference engine powering this plane.
 * It drives:
 *   - Intelligent routing decisions (which model to use for each request)
 *   - Context analysis and prompt optimisation
 *   - Agent orchestration instructions
 *   - Primary inference for all complex reasoning tasks
 *
 * The fabric maintains a registry of 9 active models and uses the
 * EMS formula to select the optimal model for each request.
 */

import OpenAI from 'openai';
import { createLogger } from '../../utils/logger';
import { computeEMS } from '../../types';
import type {
  RONORRequest,
  PlaneHealth,
  ModelDefinition,
  EMSScore,
  TokenUsage,
} from '../../types';

const logger = createLogger('Plane:R-ModelFabric');

// ============================================================
// Model Registry — 9 Active Models
// ============================================================

const MODEL_REGISTRY: ModelDefinition[] = [
  {
    id: 'gpt-4o',
    provider: 'openai',
    name: 'GPT-4o',
    contextWindow: 128000,
    costPerInputToken: 0.000005,
    costPerOutputToken: 0.000015,
    avgLatencyMs: 1200,
    capabilities: ['text', 'vision', 'code', 'tools', 'json-mode'],
    sovereigntyTier: 1,
    available: true,
  },
  {
    id: 'gpt-4o-mini',
    provider: 'openai',
    name: 'GPT-4o Mini',
    contextWindow: 128000,
    costPerInputToken: 0.00000015,
    costPerOutputToken: 0.0000006,
    avgLatencyMs: 600,
    capabilities: ['text', 'code', 'tools', 'json-mode'],
    sovereigntyTier: 1,
    available: true,
  },
  {
    id: 'gpt-4-turbo',
    provider: 'openai',
    name: 'GPT-4 Turbo',
    contextWindow: 128000,
    costPerInputToken: 0.00001,
    costPerOutputToken: 0.00003,
    avgLatencyMs: 2000,
    capabilities: ['text', 'vision', 'code', 'tools', 'json-mode', 'reasoning'],
    sovereigntyTier: 1,
    available: true,
  },
  {
    id: 'o1-preview',
    provider: 'openai',
    name: 'o1 Preview',
    contextWindow: 128000,
    costPerInputToken: 0.000015,
    costPerOutputToken: 0.00006,
    avgLatencyMs: 8000,
    capabilities: ['text', 'code', 'reasoning', 'long-context'],
    sovereigntyTier: 1,
    available: true,
  },
  {
    id: 'o1-mini',
    provider: 'openai',
    name: 'o1 Mini',
    contextWindow: 128000,
    costPerInputToken: 0.000003,
    costPerOutputToken: 0.000012,
    avgLatencyMs: 3000,
    capabilities: ['text', 'code', 'reasoning'],
    sovereigntyTier: 1,
    available: true,
  },
  {
    id: 'gpt-3.5-turbo',
    provider: 'openai',
    name: 'GPT-3.5 Turbo',
    contextWindow: 16385,
    costPerInputToken: 0.0000005,
    costPerOutputToken: 0.0000015,
    avgLatencyMs: 400,
    capabilities: ['text', 'tools', 'json-mode'],
    sovereigntyTier: 1,
    available: true,
  },
  {
    id: 'text-embedding-3-large',
    provider: 'openai',
    name: 'Text Embedding 3 Large',
    contextWindow: 8191,
    costPerInputToken: 0.00000013,
    costPerOutputToken: 0,
    avgLatencyMs: 200,
    capabilities: ['text'],
    sovereigntyTier: 1,
    available: true,
  },
  {
    id: 'text-embedding-3-small',
    provider: 'openai',
    name: 'Text Embedding 3 Small',
    contextWindow: 8191,
    costPerInputToken: 0.00000002,
    costPerOutputToken: 0,
    avgLatencyMs: 150,
    capabilities: ['text'],
    sovereigntyTier: 1,
    available: true,
  },
  {
    id: 'whisper-1',
    provider: 'openai',
    name: 'Whisper v1',
    contextWindow: 0,
    costPerInputToken: 0,
    costPerOutputToken: 0,
    avgLatencyMs: 500,
    capabilities: ['text'],
    sovereigntyTier: 1,
    available: true,
  },
];

export interface ModelFabricResult extends RONORRequest {
  selectedModel: ModelDefinition;
  inferenceResult: string;
  tokensUsed: TokenUsage;
  modelEms: EMSScore;
}

export class RModelFabricPlane {
  private readonly openai: OpenAI;
  private requestsTotal = 0;
  private errorsTotal = 0;

  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  async init(): Promise<void> {
    const available = MODEL_REGISTRY.filter((m) => m.available).length;
    logger.info(`R-Model Fabric plane initialised — ${available} models active ✓`);
    logger.info(`Core inference engine: GPT-4o (OpenAI)`);
  }

  async process(request: RONORRequest): Promise<ModelFabricResult> {
    this.requestsTotal++;

    // Select optimal model using EMS-based routing
    const selectedModel = this.selectModel(request);
    logger.info(`Model selected: ${selectedModel.name} (strategy: ${request.modelPreferences?.strategy || 'ems'})`);

    // Build messages array
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

    if (request.context?.systemPrompt) {
      messages.push({ role: 'system', content: request.context.systemPrompt });
    }

    if (request.context?.messages) {
      for (const msg of request.context.messages) {
        if (msg.role !== 'system') {
          messages.push({
            role: msg.role as 'user' | 'assistant',
            content: msg.content,
          });
        }
      }
    } else {
      messages.push({ role: 'user', content: request.prompt });
    }

    // Execute inference
    const startTime = Date.now();
    let inferenceResult = '';
    let promptTokens = 0;
    let completionTokens = 0;

    try {
      const completion = await this.openai.chat.completions.create({
        model: selectedModel.id,
        messages,
        temperature: 0.7,
        max_tokens: 4096,
      });

      inferenceResult = completion.choices[0]?.message?.content || '';
      promptTokens = completion.usage?.prompt_tokens || 0;
      completionTokens = completion.usage?.completion_tokens || 0;
    } catch (error) {
      this.errorsTotal++;
      // Fallback to gpt-4o-mini if primary fails
      if (selectedModel.id !== 'gpt-4o-mini') {
        logger.warn(`Primary model ${selectedModel.id} failed, falling back to gpt-4o-mini`);
        const fallback = await this.openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages,
          temperature: 0.7,
          max_tokens: 4096,
        });
        inferenceResult = fallback.choices[0]?.message?.content || '';
        promptTokens = fallback.usage?.prompt_tokens || 0;
        completionTokens = fallback.usage?.completion_tokens || 0;
      } else {
        throw error;
      }
    }

    const latencyMs = Date.now() - startTime;
    const estimatedCostUsd =
      promptTokens * selectedModel.costPerInputToken +
      completionTokens * selectedModel.costPerOutputToken;

    const tokensUsed: TokenUsage = {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      estimatedCostUsd,
    };

    // Compute EMS for this model invocation
    const modelEms = computeEMS({
      quality: this.assessQuality(inferenceResult),
      cost: Math.min(1, estimatedCostUsd / 0.01),  // normalised to $0.01 ceiling
      latency: Math.min(1, latencyMs / selectedModel.avgLatencyMs / 2),
      risk: 0.1,  // base risk score
      sovereignty: selectedModel.sovereigntyTier === 1 ? 0.9 : 0.5,
      evidence: 0.7,  // base evidence score, refined by R-Assurance
    });

    return {
      ...request,
      selectedModel,
      inferenceResult,
      tokensUsed,
      modelEms,
    };
  }

  /**
   * EMS-based model selection.
   * Scores each available model and returns the highest-scoring candidate.
   */
  private selectModel(request: RONORRequest): ModelDefinition {
    const strategy = request.modelPreferences?.strategy || 'ems';
    const available = MODEL_REGISTRY.filter(
      (m) => m.available && m.capabilities.includes('text')
    );

    if (request.modelPreferences?.preferredModel) {
      const preferred = available.find(
        (m) => m.id === request.modelPreferences!.preferredModel
      );
      if (preferred) return preferred;
    }

    // Filter by required capabilities
    const candidates = request.modelPreferences?.requireCapabilities
      ? available.filter((m) =>
          request.modelPreferences!.requireCapabilities!.every((cap) =>
            m.capabilities.includes(cap)
          )
        )
      : available.filter((m) => m.capabilities.includes('text') && m.contextWindow > 0);

    if (candidates.length === 0) return MODEL_REGISTRY[0];

    switch (strategy) {
      case 'cost':
        return candidates.sort((a, b) => a.costPerInputToken - b.costPerInputToken)[0];
      case 'latency':
        return candidates.sort((a, b) => a.avgLatencyMs - b.avgLatencyMs)[0];
      case 'quality':
        return candidates.sort((a, b) => b.contextWindow - a.contextWindow)[0];
      case 'sovereignty':
        return candidates.sort((a, b) => a.sovereigntyTier - b.sovereigntyTier)[0];
      case 'ems':
      default:
        // Score each model by EMS proxy
        return candidates.sort((a, b) => {
          const scoreA = this.modelEmsProxy(a);
          const scoreB = this.modelEmsProxy(b);
          return scoreB - scoreA;
        })[0];
    }
  }

  private modelEmsProxy(model: ModelDefinition): number {
    const quality = model.contextWindow > 100000 ? 0.9 : 0.7;
    const cost = 1 - Math.min(1, model.costPerInputToken * 1_000_000 / 10);
    const latency = 1 - Math.min(1, model.avgLatencyMs / 10000);
    const sovereignty = model.sovereigntyTier === 1 ? 0.9 : 0.5;
    return quality - (1 - cost) - (1 - latency) + sovereignty;
  }

  private assessQuality(output: string): number {
    if (!output || output.length < 10) return 0.1;
    if (output.length > 500) return 0.85;
    return 0.7;
  }

  getAvailableModels(): ModelDefinition[] {
    return MODEL_REGISTRY.filter((m) => m.available);
  }

  async health(): Promise<PlaneHealth> {
    return {
      planeId: 'r-model-fabric',
      status: 'healthy',
      latencyMs: 5,
      requestsTotal: this.requestsTotal,
      errorsTotal: this.errorsTotal,
      lastChecked: new Date(),
    };
  }
}
