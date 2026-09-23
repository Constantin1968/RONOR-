import type { DecisionContext } from './mi9-gate';

/**
 * Trusted server-side admission record. This must be loaded from the authority
 * store, NOT request metadata, model output or a retrieved document.
 * No resolver is installed by default: absence of authority means refusal.
 */
export interface InferenceAdmission {
  requestId: string;
  sessionId: string;
  expiresAtMs: number;
  route: { baseURL: string; model: string };
  context: DecisionContext;
}

export type AdmissionResolver = (
  requestId: string, sessionId: string
) => Promise<InferenceAdmission | null>;

export function validateAdmission(
  admission: InferenceAdmission | null,
  requestId: string,
  sessionId: string,
  route: { baseURL: string; model: string },
  now = Date.now(),
): asserts admission is InferenceAdmission {
  if (!admission ||
      admission.requestId !== requestId ||
      admission.sessionId !== sessionId ||
      admission.context.decisionId !== requestId ||
      !Number.isFinite(admission.expiresAtMs) ||
      admission.expiresAtMs <= now ||
      admission.route.baseURL !== route.baseURL ||
      admission.route.model !== route.model) {
    throw new Error('INFERENCE_ADMISSION_INVALID: missing, expired or wrong scope/route');
  }
  const ctx = admission.context;
  if (!Number.isFinite(ctx.confidence) || ctx.confidence < 0 || ctx.confidence > 1 ||
      !Number.isFinite(ctx.impactMagnitude.value) || ctx.impactMagnitude.value < 0 ||
      !Number.isInteger(ctx.evidence.sourceCount) || ctx.evidence.sourceCount < 0 ||
      !Number.isFinite(ctx.evidence.lastRefreshMs) || ctx.evidence.lastRefreshMs < 0 ||
      !['eu', 'uk', 'us'].includes(ctx.sovereignty.dataResidency) ||
      !['RO', 'EU', 'UK', 'US', 'OTHER'].includes(ctx.sovereignty.subjectJurisdiction)) {
    throw new Error('INFERENCE_ADMISSION_INVALID: invalid policy facts');
  }
}
