/**
 * Contained relative imports in file content (decision of 28 September 2026).
 *
 * The effect policy refuses every relative traversal (`../`). Inside file
 * content this also refused the ordinary import of a test file, for example
 * `import { x } from '../../src/x'`, so the development loop could not write any
 * test with a relative import (runs of 16.09 and 28.09.2026).
 *
 * The containment argument for the one allowance made here:
 *  - it applies only to content written into one named file of the workspace,
 *    never to a command, an argument list or an unclassified field;
 *  - the traversal must be the start of a quoted module specifier in an import,
 *    export-from, require, dynamic import or jest module call;
 *  - the specifier is a plain path: only leading `../` steps, then ordinary
 *    segments, no `..` further on, no backslash, no absolute form, no template;
 *  - the number of `../` steps is at most the depth of the file's directory
 *    below the workspace root, so the resolved module stays inside the workspace.
 * Every other rule of the policy still applies to the same content.
 */

export const AGENT_WORKSPACE_ROOT = '/workspace/project';

const SEGMENT = /^[A-Za-z0-9_@][A-Za-z0-9_.@-]*$/;

/** Directory depth of a target file below the workspace root, or null if it is not provably inside. */
export function workspaceFileDepth(target: unknown): number | null {
  if (typeof target !== 'string' || target.length === 0 || target.length > 500) return null;
  let relative = target;
  if (relative.startsWith('/')) {
    if (!relative.startsWith(`${AGENT_WORKSPACE_ROOT}/`)) return null;
    relative = relative.slice(AGENT_WORKSPACE_ROOT.length + 1);
  }
  const parts = relative.split('/');
  if (parts.length < 1 || !parts.every(part => SEGMENT.test(part))) return null;
  return parts.length - 1;
}

const IMPORT_PREFIX = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|^\s*import\s+|\bexport\s+\*\s+from\s*|\bjest\.(?:mock|doMock|unmock|requireActual|requireMock)\s*\(\s*)$/;
const SPECIFIER = /^((?:\.\.\/)+)((?:[A-Za-z0-9_@][A-Za-z0-9_.@-]*\/)*[A-Za-z0-9_@][A-Za-z0-9_.@-]*)$/;

/**
 * True only when the traversal at `offset` is the start of a contained module
 * specifier, as defined above. `offset` points at the first `.` of `../`.
 */
export function relativeEscapeIsContainedImport(text: string, offset: number, fileDepth: number | null): boolean {
  if (fileDepth === null || offset < 1 || offset >= text.length) return false;
  const quote = text[offset - 1];
  if (quote !== '\'' && quote !== '"') return false;
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const lineEndRaw = text.indexOf('\n', offset);
  const lineEnd = lineEndRaw === -1 ? text.length : lineEndRaw;
  const close = text.indexOf(quote, offset);
  if (close === -1 || close > lineEnd) return false;
  if (!IMPORT_PREFIX.test(text.slice(lineStart, offset - 1))) return false;
  if (!/^\s*(?:\)|;|,|$)/.test(text.slice(close + 1, lineEnd))) return false;
  const match = SPECIFIER.exec(text.slice(offset, close));
  if (!match) return false;
  const steps = match[1].length / 3;
  return steps <= fileDepth;
}
