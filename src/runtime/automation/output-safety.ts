const SENSITIVE_PATTERNS: RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}/i,
  /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*['"]?[A-Za-z0-9._~+/-]{16,}/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[opusr]_[A-Za-z0-9]{30,}\b/,
  /\bsk-(?:proj-|ant-|or-)?[A-Za-z0-9_-]{20,}\b/i,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
];

/** Reject untrusted adapter output before it can reach HTTP, logs or Mission Fabric. */
export function assertAutomationOutputSafe(value: unknown): void {
  let strings = 0;
  const visit = (item: unknown, depth: number): void => {
    if (depth > 8 || strings > 500) throw new Error('automation_output_structure_refused');
    if (typeof item === 'string') {
      strings += 1;
      if (item.length > 256 * 1024 || SENSITIVE_PATTERNS.some((pattern) => pattern.test(item))) {
        throw new Error('automation_output_sensitive');
      }
      return;
    }
    if (Array.isArray(item)) { for (const child of item) visit(child, depth + 1); return; }
    if (item && typeof item === 'object') for (const child of Object.values(item as Record<string, unknown>)) visit(child, depth + 1);
  };
  visit(value, 0);
}
