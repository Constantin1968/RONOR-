/**
 * RONOR Runtime — L0 · Request Classification
 * ───────────────────────────────────────────
 * Turns a free-text request into the structured constraints the router needs:
 * task type, complexity, whether live retrieval is required, and whether the
 * work should be decomposed across multiple agents.
 *
 * Deliberately DETERMINISTIC AND LOCAL. Classification runs on every request, so
 * an LLM call here would add latency and cost to work that has not yet been
 * authorised, and would make the routing decision depend on a model whose own
 * routing has not yet happened — a circularity that is awkward to audit and
 * impossible to reproduce offline.
 *
 * An explicit `task_type` from the caller always wins. The classifier is a
 * convenience for callers who do not know or do not care, not an authority that
 * overrides an operator who has stated their intent.
 *
 * Prepared by AMB.
 */

import type { RuntimeCapability } from '../router/catalogue';
import type { ConfidentialityLevel } from '../router/policy';

export type Complexity = 'trivial' | 'simple' | 'moderate' | 'complex';

export interface Classification {
  task_type: RuntimeCapability;
  complexity: Complexity;
  /** True when answering well requires information the model cannot hold. */
  requires_search: boolean;
  /** True when the request contains several separable questions. */
  requires_decomposition: boolean;
  /** Suggested reasoning budget for the chosen engine. */
  reasoning_effort: 'none' | 'low' | 'medium' | 'high';
  /** Suggested visible-output ceiling. */
  suggested_max_output_tokens: number;
  /** Named signals that produced this classification, for the provenance record. */
  signals: string[];
  /** True when the caller stated the task type and the classifier deferred. */
  explicit: boolean;
}

const CALCULATION = /\b(?:calculate|compute|what is|how much is|sum of|product of)\b|[0-9]\s*[+\-*/^%]\s*[0-9]/i;
const SEARCH = /\b(?:latest|current|today|yesterday|this week|recent|news|as of|price of|who is currently|what happened)\b|\b20[2-9][0-9]\b/i;
const SUMMARY = /\b(?:summar(?:ise|ize|y)|tl;?dr|condense|abstract|key points)\b/i;
const EXTRACTION = /\b(?:extract|list all|pull out|identify all|enumerate|tabulate)\b/i;
const VERIFICATION = /\b(?:verify|fact.?check|confirm whether|is it true|corroborate|substantiate)\b/i;
const ANALYSIS = /\b(?:analyse|analyze|assess|evaluate|compare|implications|why does|explain how|trade.?offs?)\b/i;
const SYNTHESIS = /\b(?:synthesis|synthesise|synthesize|write a report|draft a|memo|brief|recommendation)\b/i;
const VALIDATION = /\b(?:validate|check whether|does this comply|conforms? to|is this correct)\b/i;
const LOOKUP = /\b(?:who is|what is the capital|when was|where is|define|definition of)\b/i;
const DECOMPOSE = /\b(?:and then|first.*then|step by step|multi.?step|for each|across (?:all|several)|end.to.end)\b/i;

export function classifyRequest(params: {
  query: string;
  declaredTaskType?: string | null;
  confidentiality?: ConfidentialityLevel;
}): Classification {
  const q = params.query;
  const signals: string[] = [];

  // The caller's declaration is authoritative.
  if (params.declaredTaskType && isCapability(params.declaredTaskType)) {
    const complexity = assessComplexity(q, signals);
    return {
      task_type: params.declaredTaskType,
      complexity,
      requires_search: SEARCH.test(q),
      requires_decomposition: DECOMPOSE.test(q) || complexity === 'complex',
      reasoning_effort: effortFor(complexity),
      suggested_max_output_tokens: tokensFor(complexity),
      signals: ['C0_CALLER_DECLARED', ...signals],
      explicit: true,
    };
  }

  // Ordered from most specific to least. `calculation` is tested first because
  // an arithmetic request is the only class with a zero-cost sovereign engine,
  // and misclassifying it as reasoning silently spends money on a sum.
  let task_type: RuntimeCapability = 'reasoning';
  if (CALCULATION.test(q)) {
    task_type = 'calculation';
    signals.push('C1_ARITHMETIC_SIGNAL');
  } else if (VERIFICATION.test(q)) {
    task_type = 'verification';
    signals.push('C2_VERIFICATION_SIGNAL');
  } else if (EXTRACTION.test(q)) {
    task_type = 'extraction';
    signals.push('C3_EXTRACTION_SIGNAL');
  } else if (SUMMARY.test(q)) {
    task_type = 'summarization';
    signals.push('C4_SUMMARY_SIGNAL');
  } else if (SYNTHESIS.test(q)) {
    task_type = 'synthesis';
    signals.push('C5_SYNTHESIS_SIGNAL');
  } else if (VALIDATION.test(q)) {
    task_type = 'validation';
    signals.push('C6_VALIDATION_SIGNAL');
  } else if (ANALYSIS.test(q)) {
    task_type = 'analysis';
    signals.push('C7_ANALYSIS_SIGNAL');
  } else if (SEARCH.test(q)) {
    task_type = 'search';
    signals.push('C8_RECENCY_SIGNAL');
  } else if (LOOKUP.test(q) && q.length < 160) {
    task_type = 'lookup';
    signals.push('C9_LOOKUP_SIGNAL');
  } else {
    signals.push('C10_DEFAULT_REASONING');
  }

  const requires_search = SEARCH.test(q);
  if (requires_search && task_type !== 'search') signals.push('C8_RECENCY_SIGNAL');

  const complexity = assessComplexity(q, signals);
  const requires_decomposition = DECOMPOSE.test(q) || complexity === 'complex';
  if (requires_decomposition) signals.push('C11_DECOMPOSITION_SIGNAL');

  return {
    task_type,
    complexity,
    requires_search,
    requires_decomposition,
    reasoning_effort: effortFor(complexity),
    suggested_max_output_tokens: tokensFor(complexity),
    signals,
    explicit: false,
  };
}

function assessComplexity(q: string, signals: string[]): Complexity {
  const words = q.trim().split(/\s+/).length;
  const questionMarks = (q.match(/\?/g) ?? []).length;
  const conjunctions = (q.match(/\b(?:and|also|additionally|furthermore|as well as)\b/gi) ?? []).length;

  // A short arithmetic query is trivial regardless of the other signals; routing
  // it as complex would spend a premium engine on a sum.
  if (words <= 8 && CALCULATION.test(q)) {
    signals.push('X0_TRIVIAL_ARITHMETIC');
    return 'trivial';
  }
  const score = words / 30 + questionMarks + conjunctions * 0.5 + (DECOMPOSE.test(q) ? 2 : 0);
  if (score >= 4) {
    signals.push('X3_COMPLEX');
    return 'complex';
  }
  if (score >= 2) {
    signals.push('X2_MODERATE');
    return 'moderate';
  }
  if (words <= 12) {
    signals.push('X1_SIMPLE');
    return 'simple';
  }
  signals.push('X2_MODERATE');
  return 'moderate';
}

function effortFor(c: Complexity): Classification['reasoning_effort'] {
  switch (c) {
    case 'trivial':
      return 'none';
    case 'simple':
      return 'low';
    case 'moderate':
      return 'medium';
    case 'complex':
      return 'high';
  }
}

function tokensFor(c: Complexity): number {
  switch (c) {
    case 'trivial':
      return 1024;
    case 'simple':
      return 2048;
    case 'moderate':
      return 4096;
    case 'complex':
      return 8192;
  }
}

const CAPABILITIES: ReadonlySet<string> = new Set<RuntimeCapability>([
  'reasoning',
  'generation',
  'analysis',
  'summarization',
  'extraction',
  'calculation',
  'validation',
  'lookup',
  'search',
  'synthesis',
  'verification',
  'decomposition',
]);

export function isCapability(v: string): v is RuntimeCapability {
  return CAPABILITIES.has(v);
}
