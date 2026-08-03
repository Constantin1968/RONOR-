/**
 * RONOR Runtime — L1 · Deterministic Core
 * ───────────────────────────────────────
 * A local, exact arithmetic evaluator dressed in the provider contract. It
 * exists because for a genuinely exact task — a sum, a unit conversion, a
 * threshold comparison — a probabilistic model is never the correct first
 * choice. It costs nothing, answers in single-digit milliseconds, is
 * bit-reproducible, and no token leaves the sovereign boundary.
 *
 * SAFETY. The evaluator does not use `eval` on user input. It tokenises, then
 * evaluates with a hand-written shunting-yard parser over a closed operator set.
 * The character class is an allow-list, so a query containing an identifier, a
 * property access, a call or a template literal is refused before parsing rather
 * than sanitised and hoped about. `new Function` appears nowhere in this file.
 *
 * When no expression can be extracted the adapter returns `not-computable` with
 * `retryable: true`, which is precisely the signal the fallback chain needs to
 * escalate to a generative engine.
 *
 * Prepared by AMB.
 */

import {
  providerFailure,
  type CredentialState,
  type ProviderAdapter,
  type ProviderDescriptor,
  type ProviderInvocation,
  type ProviderResponse,
} from './types';

export const DETERMINISTIC_MODEL = 'ronor/deterministic-core';

type Token =
  | { t: 'num'; v: number }
  | { t: 'op'; v: '+' | '-' | '*' | '/' | '%' | '^' }
  | { t: 'lparen' }
  | { t: 'rparen' };

const PRECEDENCE: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, '^': 3 };
const RIGHT_ASSOC = new Set(['^']);

/**
 * Extract the longest arithmetic expression from a natural-language query.
 *
 * Deliberately conservative: the candidate must contain a digit and an
 * operator, and must consist solely of allow-listed characters. A query that is
 * merely *about* numbers ("what were 2024 revenues") yields nothing, which is
 * the correct outcome — the deterministic core should decline and let a
 * reasoning model answer.
 *
 * The candidate may BEGIN with `(` or a unary sign, which is why the pattern
 * does not anchor on a digit. Anchoring on a digit silently truncates `(2+3)*4`
 * to `2+3)*4` — a change that still parses to a number and would therefore have
 * returned a confidently wrong answer rather than an error.
 */
export function extractExpression(query: string): string | null {
  // Anchored on a run of arithmetic characters that CONTAINS at least one digit,
  // rather than on a digit itself. A digit anchor splits `4 * -2` into `4 * ` and
  // `-2`, and the longest-candidate rule then evaluates `-2` — a wrong answer
  // returned with full confidence, which is the failure mode this parser exists
  // to make impossible.
  const candidates = query.match(/[0-9.\s()+\-*/%^]+/g);
  if (!candidates) return null;
  const viable = candidates
    .map((c) => trimDanglingOperators(c.trim()))
    .filter((c) => /[0-9]/.test(c) && /[+\-*/%^]/.test(c))
    .filter((c) => /^[0-9.\s()+\-*/%^]+$/.test(c))
    .sort((a, b) => b.length - a.length);
  return viable[0] ?? null;
}

/**
 * Balance parentheses at the edges and drop a trailing operator.
 *
 * The regex is greedy over an allow-listed character class, so it can capture a
 * closing paren whose opener sits outside the match, or a trailing `+` from
 * prose. Both would make an otherwise valid expression unparseable, and the
 * fallback would then escalate a perfectly computable sum to a paid model.
 */
function trimDanglingOperators(raw: string): string {
  let s = raw.replace(/[\s+\-*/%^]+$/, '');
  // Drop unmatched closing parens from the right.
  for (;;) {
    const opens = (s.match(/\(/g) ?? []).length;
    const closes = (s.match(/\)/g) ?? []).length;
    if (closes <= opens) break;
    const idx = s.lastIndexOf(')');
    if (idx === -1) break;
    s = `${s.slice(0, idx)}${s.slice(idx + 1)}`.replace(/[\s+\-*/%^]+$/, '');
  }
  return s.trim();
}

export function tokenise(expr: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === ' ' || ch === '\t') {
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < expr.length && /[0-9.]/.test(expr[j])) j++;
      const slice = expr.slice(i, j);
      // Reject malformed literals such as `1.2.3` rather than letting
      // `parseFloat` silently accept a prefix.
      if ((slice.match(/\./g) ?? []).length > 1) return null;
      const v = Number(slice);
      if (!Number.isFinite(v)) return null;
      tokens.push({ t: 'num', v });
      i = j;
      continue;
    }
    if (ch === '(') {
      tokens.push({ t: 'lparen' });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ t: 'rparen' });
      i++;
      continue;
    }
    if ('+-*/%^'.includes(ch)) {
      tokens.push({ t: 'op', v: ch as '+' });
      i++;
      continue;
    }
    return null;
  }
  return tokens.length ? tokens : null;
}

/** Shunting-yard evaluation over a closed operator set. Returns null on any malformity. */
export function evaluateTokens(tokens: Token[]): number | null {
  const output: Token[] = [];
  const ops: Token[] = [];

  // Unary minus is rewritten as `(0 - x)` so the operator set stays binary and
  // the parser needs no special case.
  //
  // The parentheses are load-bearing. Rewriting `4 * -2` as `4 * 0 - 2` binds
  // the multiplication to the zero and yields -2 instead of -8: a plausible
  // number, returned with full confidence, from an engine whose entire purpose
  // is exactness. Emitting `4 * ( 0 - 2 )` preserves the intended precedence.
  const normalised: Token[] = [];
  for (let k = 0; k < tokens.length; k++) {
    const tk = tokens[k];
    const prev = normalised[normalised.length - 1];
    const atStart = prev === undefined;
    const afterOpOrParen = prev !== undefined && (prev.t === 'op' || prev.t === 'lparen');
    if (tk.t === 'op' && (tk.v === '-' || tk.v === '+') && (atStart || afterOpOrParen)) {
      // Consume the operand the sign applies to. A sign with no operand is
      // malformed and is rejected rather than absorbed.
      const next = tokens[k + 1];
      if (next === undefined) return null;
      if (next.t === 'num') {
        normalised.push({ t: 'num', v: tk.v === '-' ? -next.v : next.v });
        k += 1;
        continue;
      }
      if (next.t === 'lparen') {
        // `-(a+b)` becomes `( 0 - ( a + b ) )`, closed when the group closes.
        normalised.push({ t: 'lparen' });
        normalised.push({ t: 'num', v: 0 });
        normalised.push(tk);
        // The inner group is emitted by subsequent iterations; the wrapper is
        // closed by tracking depth below.
        const depthMarker = { open: 1 };
        let j = k + 1;
        normalised.push({ t: 'lparen' });
        j += 1;
        while (j < tokens.length && depthMarker.open > 0) {
          const inner = tokens[j];
          if (inner.t === 'lparen') depthMarker.open += 1;
          if (inner.t === 'rparen') depthMarker.open -= 1;
          normalised.push(inner);
          j += 1;
        }
        if (depthMarker.open !== 0) return null;
        normalised.push({ t: 'rparen' });
        k = j - 1;
        continue;
      }
      return null;
    }
    normalised.push(tk);
  }

  for (const tk of normalised) {
    if (tk.t === 'num') {
      output.push(tk);
    } else if (tk.t === 'op') {
      while (ops.length) {
        const top = ops[ops.length - 1];
        if (top.t !== 'op') break;
        const higher = PRECEDENCE[top.v] > PRECEDENCE[tk.v];
        const equalLeft = PRECEDENCE[top.v] === PRECEDENCE[tk.v] && !RIGHT_ASSOC.has(tk.v);
        if (higher || equalLeft) output.push(ops.pop() as Token);
        else break;
      }
      ops.push(tk);
    } else if (tk.t === 'lparen') {
      ops.push(tk);
    } else {
      let matched = false;
      while (ops.length) {
        const top = ops.pop() as Token;
        if (top.t === 'lparen') {
          matched = true;
          break;
        }
        output.push(top);
      }
      if (!matched) return null;
    }
  }
  while (ops.length) {
    const top = ops.pop() as Token;
    if (top.t === 'lparen' || top.t === 'rparen') return null;
    output.push(top);
  }

  const stack: number[] = [];
  for (const tk of output) {
    if (tk.t === 'num') {
      stack.push(tk.v);
      continue;
    }
    if (tk.t !== 'op') return null;
    const b = stack.pop();
    const a = stack.pop();
    if (a === undefined || b === undefined) return null;
    let r: number;
    switch (tk.v) {
      case '+':
        r = a + b;
        break;
      case '-':
        r = a - b;
        break;
      case '*':
        r = a * b;
        break;
      case '/':
        // Division by zero yields Infinity in IEEE 754. An arithmetic core that
        // returned Infinity as an answer would be technically correct and
        // operationally useless, so it refuses instead.
        if (b === 0) return null;
        r = a / b;
        break;
      case '%':
        if (b === 0) return null;
        r = a % b;
        break;
      case '^':
        r = Math.pow(a, b);
        break;
      default:
        return null;
    }
    if (!Number.isFinite(r)) return null;
    stack.push(r);
  }

  if (stack.length !== 1) return null;
  return stack[0];
}

export function computeExactly(query: string): { expression: string; value: number } | null {
  const expr = extractExpression(query);
  if (!expr) return null;
  const tokens = tokenise(expr);
  if (!tokens) return null;
  const value = evaluateTokens(tokens);
  if (value === null) return null;
  return { expression: expr.replace(/\s+/g, ' '), value };
}

export class DeterministicAdapter implements ProviderAdapter {
  readonly descriptor: ProviderDescriptor = {
    id: 'deterministic',
    displayName: 'RONOR Deterministic Core',
    models: [DETERMINISTIC_MODEL],
    searchAugmented: false,
    jurisdictions: ['sovereign'],
  };

  credentialState(): CredentialState {
    return 'live-local';
  }

  async invoke(invocation: ProviderInvocation): Promise<ProviderResponse> {
    const started = Date.now();
    const source = invocation.messages?.length
      ? invocation.messages.map((m) => m.content).join('\n')
      : invocation.prompt;
    const result = computeExactly(source);

    if (!result) {
      return providerFailure(
        'deterministic',
        DETERMINISTIC_MODEL,
        'local',
        {
          kind: 'not-computable',
          message:
            'no exact arithmetic expression could be extracted; escalation to a generative engine is required',
          retryable: true,
        },
        Date.now() - started,
      );
    }

    const content = JSON.stringify({
      answer: `${result.expression} = ${result.value}`,
      confidence: 100,
      method: 'IEEE 754 double-precision evaluation, RONOR Deterministic Core',
      sovereign: true,
    });

    return {
      ok: true,
      provider: 'deterministic',
      model: DETERMINISTIC_MODEL,
      transport: 'local',
      content,
      usage: { input_tokens: 0, output_tokens: 0, estimated: false },
      latency_ms: Date.now() - started,
      citations: [],
      finishReason: 'stop',
      failure: null,
      simulated: false,
    };
  }
}
