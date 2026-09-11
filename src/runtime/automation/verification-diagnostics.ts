import { assertAutomationOutputSafe } from './output-safety';

export type VerificationFailureCategory = 'rejection' | 'service' | 'http' | 'transport' | 'protocol' | 'unknown';

/** Diagnostic only: never a verification receipt or accepted evidence. */
export interface VerificationFailureDiagnostic {
  category: VerificationFailureCategory;
  code: string;
  http_status?: number;
  verdict?: 'fail';
  summary?: string;
  evidence?: string[];
  details_omitted?: true;
}

const CODE_CATEGORIES: Record<string, VerificationFailureCategory> = {
  codex_evidence_missing: 'rejection',
  codex_test_evidence_invalid: 'rejection',
  codex_verdict_rejected: 'rejection',
  codex_request_invalid: 'protocol',
  codex_artifact_read_failed: 'service',
  codex_evaluator_failed: 'service',
  codex_evaluator_result_invalid: 'service',
  codex_receipt_signing_failed: 'service',
  codex_verification_failed_closed: 'service',
  codex_api_response_too_large: 'service',
  codex_api_usage_missing: 'service',
  codex_api_usage_invalid: 'service',
  codex_api_output_missing: 'service',
  codex_api_output_not_json: 'service',
  codex_api_output_invalid: 'service',
  codex_api_timeout: 'service',
  codex_api_unavailable: 'service',
  adapter_timeout: 'transport',
  adapter_cancelled: 'transport',
  adapter_unreachable: 'transport',
  adapter_invalid_json: 'protocol',
  adapter_result_invalid: 'protocol',
  adapter_artifacts_invalid: 'protocol',
  adapter_sensitive_output_refused: 'protocol',
  adapter_response_too_large: 'protocol',
  adapter_redirect_refused: 'protocol',
  adapter_url_invalid: 'protocol',
  adapter_url_requires_https_or_loopback: 'protocol',
  adapter_auth_required: 'protocol',
  codex_verdict_invalid: 'protocol',
  codex_receipt_invalid: 'protocol',
  budget_authority_required: 'protocol',
  codex_failure_response_invalid: 'protocol',
  codex_failure_unclassified: 'unknown',
  codex_adapter_failed: 'unknown',
};

export function verificationFailureCategory(code: unknown): VerificationFailureCategory | null {
  if (typeof code !== 'string') return null;
  if (Object.prototype.hasOwnProperty.call(CODE_CATEGORIES, code)) return CODE_CATEGORIES[code];
  if (/^codex_api_http_[1-5][0-9]{2}$/.exec(code)?.[0] === code) return 'service';
  if (/^adapter_http_[1-5][0-9]{2}$/.exec(code)?.[0] === code) return 'http';
  return null;
}

/** Revalidate at the persistence boundary, including test/custom adapters. */
export function readVerificationFailureDiagnostic(value: unknown): VerificationFailureDiagnostic | null {
  try { return readDiagnostic(value); } catch { return null; }
}

function readDiagnostic(value: unknown): VerificationFailureDiagnostic | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  // Read each field once. Custom adapters can supply getters or shadowed methods.
  const { code, category: claimedCategory, http_status: httpStatus, verdict,
    details_omitted: omitted, summary, evidence: rawEvidence } = value as Record<string, unknown>;
  const category = verificationFailureCategory(code);
  if (!category || claimedCategory !== category) return null;
  if (httpStatus !== undefined && (typeof httpStatus !== 'number' || !Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599)) return null;
  if (verdict !== undefined && verdict !== 'fail') return null;
  if (omitted !== undefined && omitted !== true) return null;
  if (summary !== undefined && (typeof summary !== 'string' || summary.length > 4000)) return null;
  let evidence: string[] | undefined;
  if (rawEvidence !== undefined) {
    if (!Array.isArray(rawEvidence)) return null;
    const count = rawEvidence.length;
    if (!Number.isInteger(count) || count < 0 || count > 50) return null;
    evidence = [];
    for (let index = 0; index < count; index++) {
      const item: unknown = rawEvidence[index];
      if (typeof item !== 'string' || item.length > 2000) return null;
      evidence.push(item);
    }
  }
  const result: VerificationFailureDiagnostic = {
    category, code: code as string,
    ...(httpStatus === undefined ? {} : { http_status: httpStatus }),
    ...(verdict === undefined ? {} : { verdict: 'fail' as const }),
    ...(summary === undefined ? {} : { summary: summary as string }),
    ...(evidence === undefined ? {} : { evidence }),
    ...(omitted === true ? { details_omitted: true as const } : {}),
  };
  assertAutomationOutputSafe(result);
  // Reject any nonempty Bearer token, including short fixtures. Check raw strings
  // before JSON escaping can hide tabs/newlines; serialized scan is defense in depth.
  const sensitive = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]+|\b(?:ghp_|sk-)[A-Za-z0-9_-]{16,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/i;
  if ([result.summary ?? '', ...(result.evidence ?? [])].some(item => sensitive.test(item))) return null;
  const json = JSON.stringify(result);
  if (sensitive.test(json)) return null;
  // Leave room for run/event metadata inside the 16 KiB event limit.
  if (Buffer.byteLength(json, 'utf8') > 12_000) {
    delete result.summary;
    delete result.evidence;
    result.details_omitted = true;
  }
  return result;
}
