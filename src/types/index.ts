/**
 * RONOR v1.0 — Core Type Definitions
 * Sovereign Generative Intelligence Runtime
 * Ma11AI · Mayleven Ecosystem
 */

// ============================================================
// EMS — Efficiency-Merit Score
// ============================================================

export interface EMSScore {
  quality: number;        // 0–1: output quality assessment
  cost: number;           // 0–1: normalised cost (lower = better, inverted in formula)
  latency: number;        // 0–1: normalised latency (lower = better, inverted)
  risk: number;           // 0–1: risk score (lower = better, inverted)
  sovereignty: number;    // 0–1: data sovereignty compliance
  evidence: number;       // 0–1: evidence grounding score
  total: number;          // computed: Quality − Cost − Latency − Risk + Sovereignty + Evidence
  timestamp: Date;
}

export function computeEMS(components: Omit<EMSScore, 'total' | 'timestamp'>): EMSScore {
  const total =
    components.quality
    - components.cost
    - components.latency
    - components.risk
    + components.sovereignty
    + components.evidence;
  return { ...components, total: Math.max(-1, Math.min(2, total)), timestamp: new Date() };
}

// ============================================================
// Plane Identifiers
// ============================================================

export type PlaneId =
  | 'r-gateway'
  | 'r-context'
  | 'r-model-fabric'
  | 'r-agent-runtime'
  | 'r-execution'
  | 'r-assurance'
  | 'r-economics';

export interface PlaneHealth {
  planeId: PlaneId;
  status: 'healthy' | 'degraded' | 'offline';
  latencyMs: number;
  requestsTotal: number;
  errorsTotal: number;
  lastChecked: Date;
}

// ============================================================
// Request / Response
// ============================================================

export interface RONORRequest {
  id: string;
  sessionId: string;
  userId?: string;
  prompt: string;
  context?: ConversationContext;
  modelPreferences?: ModelPreferences;
  agentConfig?: AgentConfig;
  sovereigntyRequirements?: SovereigntyRequirements;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface RONORResponse {
  id: string;
  requestId: string;
  content: string;
  modelUsed: string;
  planeTrace: PlaneTrace[];
  ems: EMSScore;
  evidenceChain: EvidenceItem[];
  tokensUsed: TokenUsage;
  latencyMs: number;
  sovereigntyVerified: boolean;
  createdAt: Date;
}

// ============================================================
// Context
// ============================================================

export interface ConversationContext {
  messages: ContextMessage[];
  systemPrompt?: string;
  maxTokens?: number;
  compressionEnabled?: boolean;
}

export interface ContextMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tokenCount?: number;
  timestamp?: Date;
}

// ============================================================
// Model Fabric
// ============================================================

export interface ModelDefinition {
  id: string;
  provider: 'openai' | 'anthropic' | 'google' | 'local';
  name: string;
  contextWindow: number;
  costPerInputToken: number;
  costPerOutputToken: number;
  avgLatencyMs: number;
  capabilities: ModelCapability[];
  sovereigntyTier: 1 | 2 | 3;  // 1=highest sovereignty
  available: boolean;
}

export type ModelCapability =
  | 'text'
  | 'vision'
  | 'code'
  | 'reasoning'
  | 'tools'
  | 'json-mode'
  | 'long-context';

export interface ModelPreferences {
  preferredModel?: string;
  strategy?: 'ems' | 'cost' | 'latency' | 'quality' | 'sovereignty';
  maxCostUsd?: number;
  maxLatencyMs?: number;
  requireCapabilities?: ModelCapability[];
}

// ============================================================
// Agent Runtime
// ============================================================

export interface AgentConfig {
  maxIterations?: number;
  tools?: AgentTool[];
  systemPrompt?: string;
  temperature?: number;
  stopConditions?: string[];
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (params: Record<string, unknown>) => Promise<unknown>;
}

export interface AgentStep {
  iteration: number;
  thought?: string;
  toolCall?: { name: string; params: Record<string, unknown> };
  toolResult?: unknown;
  response?: string;
  ems?: EMSScore;
  timestamp: Date;
}

// ============================================================
// Assurance & Evidence
// ============================================================

export interface EvidenceItem {
  id: string;
  type: 'source' | 'computation' | 'tool-call' | 'model-output' | 'human-verified';
  content: string;
  confidence: number;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface AuditRecord {
  id: string;
  requestId: string;
  planeId: PlaneId;
  action: string;
  input: unknown;
  output: unknown;
  durationMs: number;
  ems?: EMSScore;
  timestamp: Date;
}

// ============================================================
// Sovereignty
// ============================================================

export interface SovereigntyRequirements {
  dataResidency?: 'eu' | 'uk' | 'us' | 'any';
  noThirdPartyLogging?: boolean;
  encryptionRequired?: boolean;
  auditTrailRequired?: boolean;
  complianceFrameworks?: ('gdpr' | 'iso27001' | 'soc2' | 'hipaa')[];
}

// ============================================================
// Plane Tracing
// ============================================================

export interface PlaneTrace {
  planeId: PlaneId;
  enteredAt: Date;
  exitedAt: Date;
  durationMs: number;
  status: 'pass' | 'modified' | 'blocked' | 'error';
  notes?: string;
}

// ============================================================
// Token Usage
// ============================================================

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
}
