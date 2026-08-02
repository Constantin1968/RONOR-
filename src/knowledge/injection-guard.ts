/**
 * Prompt-Injection Guard
 * MIP-014 STEP 2 · Phase 4 (Pipelines)
 *
 * Screening occurs at ingestion stage I-4, BEFORE normalisation, chunking and
 * hashing (STEP 1 § 8.1). The ordering is the whole point: screening after
 * normalisation would screen text that normalisation has already altered, and an
 * attacker who knows the normalisation rules could construct input whose
 * malicious form appears only after the screen has passed. Screening the raw
 * bytes is the only position at which the screen sees what the author wrote.
 *
 * A refused payload is quarantined and NOT stored in the corpus. The quarantine
 * record holds a DIGEST of the payload, never the payload itself, so the
 * quarantine cannot become a second uncontrolled copy of hostile content.
 *
 * On the limits of this control, stated plainly rather than overclaimed:
 * pattern-based injection screening is a bounded control, not a solution. It
 * catches the known corpus of directive-injection forms and it will not catch a
 * novel phrasing that no rule anticipates. The architectural control that does
 * not depend on enumeration is the nonce-delimited data region of the RAG
 * composer (stage G-3), which marks retrieved content as data rather than as
 * instruction irrespective of its content. The screen reduces exposure; the
 * delimiter is what bounds it.
 */

import { createHash } from 'crypto';

import type {
  KnowledgeClassification,
  KnowledgeReasonCode,
  QuarantineRecord,
} from '../planes/r-knowledge/types';

export interface InjectionRule {
  id: string;
  description: string;
  pattern: RegExp;
}

/**
 * The rule corpus.
 *
 * Rules are expressed over a case-folded, whitespace-collapsed view of the input
 * so that trivial evasion by casing or spacing does not defeat them, while the
 * ORIGINAL bytes are what get hashed and quarantined.
 */
export const INJECTION_RULES: readonly InjectionRule[] = Object.freeze([
  {
    id: 'IG-01',
    description: 'Instruction override directed at a system or prior prompt',
    pattern:
      /\b(ignore|disregard|forget|override|discard)\b[^.]{0,40}\b(previous|prior|above|earlier|all|any)\b[^.]{0,20}\b(instruction|instructions|prompt|prompts|direction|directions|rule|rules|context)\b/i,
  },
  {
    id: 'IG-02',
    description: 'Role or persona reassignment',
    pattern:
      /\b(you\s+are\s+now|from\s+now\s+on\s+you|act\s+as|pretend\s+to\s+be|assume\s+the\s+role|roleplay\s+as|you\s+must\s+now\s+be)\b/i,
  },
  {
    id: 'IG-03',
    description: 'System-prompt or instruction exfiltration',
    pattern:
      /\b(reveal|show|print|output|repeat|disclose|dump|display)\b[^.]{0,40}\b(system\s*prompt|initial\s*instruction|your\s*instruction|hidden\s*prompt|configuration|training\s*data)\b/i,
  },
  {
    id: 'IG-04',
    description: 'Guardrail or safety-constraint removal',
    pattern:
      /\b(bypass|disable|circumvent|remove|turn\s+off|switch\s+off|deactivate|jailbreak)\b[^.]{0,40}\b(safety|guardrail|guardrails|filter|filters|restriction|restrictions|constraint|constraints|policy|policies|moderation)\b/i,
  },
  {
    id: 'IG-05',
    description: 'Injected conversational turn markers or role delimiters',
    pattern:
      /(^|\s)(\[\/?(?:system|assistant|user|inst)\]|<\|(?:im_start|im_end|system|assistant|user|endoftext)\|>|<\/?s>|###\s*(?:system|assistant|instruction)\s*:)/i,
  },
  {
    id: 'IG-06',
    description: 'Elevated-authority impersonation',
    pattern:
      /\b(as\s+(?:the\s+)?(?:system|administrator|admin|root|developer|operator)|system\s*(?:message|override|instruction)|developer\s+mode|admin\s+mode|sudo\s+mode)\b/i,
  },
  {
    id: 'IG-07',
    description: 'Directive to disregard retrieved context or provenance',
    pattern:
      /\b(ignore|do\s+not\s+use|disregard|skip|omit)\b[^.]{0,30}\b(retrieved|context|source|sources|citation|citations|document|documents|provenance|evidence)\b/i,
  },
  {
    id: 'IG-08',
    description: 'Instruction to fabricate, invent or assert without evidence',
    pattern:
      /\b(make\s+up|fabricate|invent|hallucinate|guess|pretend\s+you\s+know)\b[^.]{0,30}\b(answer|citation|citations|source|sources|reference|references|fact|facts|data)\b/i,
  },
  {
    id: 'IG-09',
    description: 'Encoded or obfuscated instruction delivery',
    pattern:
      /\b(base64|rot13|hex\s*decode|urldecode|atob)\b[^.]{0,40}\b(then|and)\b[^.]{0,20}\b(execute|run|follow|obey|comply|do)\b/i,
  },
  {
    id: 'IG-10',
    description: 'Tool, command or code execution directive',
    pattern:
      /\b(execute|run|eval|invoke|call)\b[^.]{0,25}\b(command|shell|bash|script|code|tool|function|payload)\b/i,
  },
  {
    id: 'IG-11',
    description: 'Credential or secret extraction directive',
    pattern:
      /\b(what\s+is|tell\s+me|give\s+me|reveal|print|show)\b[^.]{0,30}\b(api\s*key|apikey|secret|token|password|credential|credentials|private\s+key)\b/i,
  },
  {
    id: 'IG-12',
    description: 'Zero-width or bidirectional control characters used to conceal text',
    // Screened on the RAW input, because normalisation removes these characters
    // and a screen positioned after normalisation would never see them. This is
    // the concrete reason stage I-4 precedes stage I-5.
    pattern: /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/,
  },
]);

export interface ScreeningVerdict {
  clean: boolean;
  /** Identifier of the first rule that matched, or null. */
  ruleId: string | null;
  ruleDescription: string | null;
  reason: KnowledgeReasonCode | null;
  /** Every rule that matched, so a report can state the full basis. */
  allMatches: string[];
}

/**
 * Screen raw input for injection attempts.
 *
 * Applied to the raw payload. Rules 1 through 11 are evaluated against a
 * case-folded, whitespace-collapsed projection so that casing and spacing tricks
 * do not defeat them; rule 12 is evaluated against the raw text because the
 * characters it detects are exactly those the projection would preserve but
 * normalisation would remove.
 */
export function screenForInjection(raw: string): ScreeningVerdict {
  const collapsed = raw.replace(/\s+/g, ' ');
  const matches: string[] = [];

  for (const rule of INJECTION_RULES) {
    const target = rule.id === 'IG-12' ? raw : collapsed;
    if (rule.pattern.test(target)) matches.push(rule.id);
  }

  if (matches.length === 0) {
    return { clean: true, ruleId: null, ruleDescription: null, reason: null, allMatches: [] };
  }

  const first = INJECTION_RULES.find((r) => r.id === matches[0])!;
  return {
    clean: false,
    ruleId: first.id,
    ruleDescription: first.description,
    reason: 'INJECTION_DETECTED',
    allMatches: matches,
  };
}

/**
 * Build a quarantine record.
 *
 * The record holds a digest of the refused payload and never the payload. A
 * quarantine that stored the content would be a second uncontrolled copy of
 * hostile material with weaker governance than the corpus it was excluded from.
 */
export function buildQuarantineRecord(input: {
  raw: string;
  sourceUri: string;
  declaredClassification: KnowledgeClassification;
  ingestedBy: string;
  reason: KnowledgeReasonCode;
  detectionRule: string | null;
  quarantinedAt: string;
}): QuarantineRecord {
  return {
    quarantinedAt: input.quarantinedAt,
    reason: input.reason,
    detectionRule: input.detectionRule,
    sourceUri: input.sourceUri,
    declaredClassification: input.declaredClassification,
    payloadDigest: createHash('sha256').update(input.raw, 'utf8').digest('hex'),
    ingestedBy: input.ingestedBy,
  };
}

/**
 * Generate a nonce for the RAG data region (stage G-3).
 *
 * The nonce is unpredictable per request, which is what prevents an attacker from
 * embedding a matching closing delimiter in ingested content in order to escape
 * the data region. A fixed delimiter, however exotic, is discoverable and
 * therefore forgeable; a per-request random one is not.
 */
export function generateDataRegionNonce(randomBytes: () => Buffer): string {
  return randomBytes().toString('hex');
}
