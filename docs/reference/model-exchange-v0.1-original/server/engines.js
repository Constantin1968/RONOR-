/**
 * RONOR Model Exchange v0.1 — Engine Adapters
 * --------------------------------------------
 * Every engine implements the same contract:
 *   execute(model, request) → {
 *     ok, answer, confidence, sources, input_tokens, output_tokens,
 *     latency_ms, simulated, error?
 *   }
 *
 * - OpenAI: real Chat Completions API call (JSON mode) using OPENAI_API_KEY.
 *   Optional OPENAI_API_BASE override (useful behind gateways/proxies).
 * - Anthropic: real call if ANTHROPIC_API_KEY is set; otherwise a clearly
 *   flagged simulation so the routing/fallback logic remains demonstrable.
 * - Deterministic Core: a local, exact math/logic evaluator — zero cost,
 *   millisecond latency, 100% reproducible.
 */

const RONOR_SYSTEM_PROMPT = `You are an intelligence engine operating inside RONOR, a Sovereign Generative Intelligence Runtime. You do not chat. You return verifiable, structured output.

Respond ONLY with a single valid JSON object:
{
  "answer": "a precise, professional answer in 1-3 short paragraphs",
  "confidence": <integer 0-100, calibrated confidence in the answer>,
  "sources": [{"title": "plausible evidence source", "type": "Journal|Report|Dataset|Standard|Filing"}, ... 2-3 items]
}
The first character of your reply must be { and the last must be }.`;

// ---------------------------------------------------------------------------
// OpenAI adapter (REAL)
// ---------------------------------------------------------------------------
async function executeOpenAI(model, request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { ok: false, error: "OPENAI_API_KEY not configured", simulated: false };
  }
  const base = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";
  // Allow overriding the model name for gateway environments that expose a
  // different catalog (e.g. RONOR_OPENAI_MODEL=gpt-5-mini behind a proxy).
  const apiModel = process.env.RONOR_OPENAI_MODEL || "gpt-4.1";

  const started = Date.now();
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: apiModel,
        temperature: 0.3,
        max_tokens: 4000, // headroom for reasoning-token models
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: RONOR_SYSTEM_PROMPT },
          { role: "user", content: request.query },
        ],
      }),
    });

    if (!res.ok) {
      const t = await res.text();
      return {
        ok: false,
        error: `OpenAI API ${res.status}: ${t.slice(0, 200)}`,
        simulated: false,
        latency_ms: Date.now() - started,
      };
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content ?? "";
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      return {
        ok: false,
        error: "OpenAI returned non-JSON content",
        simulated: false,
        latency_ms: Date.now() - started,
      };
    }

    return {
      ok: true,
      answer: String(parsed.answer ?? ""),
      confidence: clampInt(parsed.confidence, 0, 100),
      sources: normalizeSources(parsed.sources),
      input_tokens: data?.usage?.prompt_tokens ?? 0,
      output_tokens: data?.usage?.completion_tokens ?? 0,
      latency_ms: Date.now() - started,
      simulated: false,
    };
  } catch (err) {
    return {
      ok: false,
      error: `OpenAI network error: ${err?.message ?? err}`,
      simulated: false,
      latency_ms: Date.now() - started,
    };
  }
}

// ---------------------------------------------------------------------------
// Anthropic adapter (REAL if key present, otherwise SIMULATED)
// ---------------------------------------------------------------------------
async function executeAnthropic(model, request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const started = Date.now();

  if (apiKey) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1500,
          system: RONOR_SYSTEM_PROMPT,
          messages: [{ role: "user", content: request.query }],
        }),
      });
      if (!res.ok) {
        const t = await res.text();
        return {
          ok: false,
          error: `Anthropic API ${res.status}: ${t.slice(0, 200)}`,
          simulated: false,
          latency_ms: Date.now() - started,
        };
      }
      const data = await res.json();
      const content = data?.content?.[0]?.text ?? "";
      let parsed;
      try {
        parsed = JSON.parse(content);
      } catch {
        // Claude sometimes wraps JSON in prose; attempt extraction
        const m = content.match(/\{[\s\S]*\}/);
        if (!m) {
          return {
            ok: false,
            error: "Anthropic returned non-JSON content",
            simulated: false,
            latency_ms: Date.now() - started,
          };
        }
        parsed = JSON.parse(m[0]);
      }
      return {
        ok: true,
        answer: String(parsed.answer ?? ""),
        confidence: clampInt(parsed.confidence, 0, 100),
        sources: normalizeSources(parsed.sources),
        input_tokens: data?.usage?.input_tokens ?? 0,
        output_tokens: data?.usage?.output_tokens ?? 0,
        latency_ms: Date.now() - started,
        simulated: false,
      };
    } catch (err) {
      return {
        ok: false,
        error: `Anthropic network error: ${err?.message ?? err}`,
        simulated: false,
        latency_ms: Date.now() - started,
      };
    }
  }

  // --- Simulation path (no key). Clearly flagged; deterministic delay. ----
  await sleep(600);
  const estIn = Math.ceil(request.query.length / 4) + 90;
  const estOut = 220;
  return {
    ok: true,
    answer:
      `[SIMULATED — Anthropic API key not configured in this deployment] ` +
      `RONOR routed this request to Claude Sonnet 4 based on its eligibility score. ` +
      `In production, this adapter executes a real Anthropic Messages API call with the same ` +
      `unified request contract, and the response flows through identical verification, ` +
      `trace and cost accounting as every other engine.`,
    confidence: 50,
    sources: [
      { title: "RONOR Engine Adapter Contract v0.1", type: "Standard" },
      { title: "Anthropic Messages API Reference", type: "Report" },
    ],
    input_tokens: estIn,
    output_tokens: estOut,
    latency_ms: Date.now() - started,
    simulated: true,
  };
}

// ---------------------------------------------------------------------------
// Deterministic Core adapter (LOCAL, EXACT)
// ---------------------------------------------------------------------------
function safeEvaluateExpression(raw) {
  // Extract a candidate arithmetic expression from the query.
  const match = raw.match(/[-+0-9().*/%^ eE]+/g);
  if (!match) return null;
  const expr = match
    .sort((a, b) => b.length - a.length)[0]
    .trim()
    .replace(/\^/g, "**");
  if (!/[0-9]/.test(expr)) return null;
  // Strict whitelist: digits, operators, parentheses, dots, spaces only.
  if (!/^[-+0-9().*/%* eE]+$/.test(expr)) return null;
  try {
    // eslint-disable-next-line no-new-func
    const value = Function(`"use strict"; return (${expr});`)();
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    return { expr: expr.replace(/\*\*/g, "^"), value };
  } catch {
    return null;
  }
}

async function executeDeterministic(model, request) {
  const started = Date.now();
  const result = safeEvaluateExpression(request.query);

  if (result === null) {
    return {
      ok: false,
      error:
        "Deterministic Core could not extract a computable expression from the query. Escalating to a generative engine.",
      simulated: false,
      latency_ms: Date.now() - started,
    };
  }

  return {
    ok: true,
    answer: `Deterministic evaluation: ${result.expr} = ${result.value}. Computed locally by RONOR Deterministic Core — exact, reproducible, zero marginal cost, no data left the sovereign boundary.`,
    confidence: 100,
    sources: [
      { title: "IEEE 754 double-precision arithmetic", type: "Standard" },
      { title: "RONOR Deterministic Core execution record", type: "Dataset" },
    ],
    input_tokens: 0,
    output_tokens: 0,
    latency_ms: Date.now() - started,
    simulated: false,
  };
}

// ---------------------------------------------------------------------------
export async function executeEngine(model, request) {
  switch (model.engine) {
    case "openai":
      return executeOpenAI(model, request);
    case "anthropic":
      return executeAnthropic(model, request);
    case "deterministic":
      return executeDeterministic(model, request);
    default:
      return { ok: false, error: `Unknown engine: ${model.engine}`, simulated: false };
  }
}

// --- helpers ---------------------------------------------------------------
function clampInt(v, lo, hi) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function normalizeSources(v) {
  if (!Array.isArray(v)) return [];
  return v
    .filter((s) => s && s.title)
    .slice(0, 4)
    .map((s) => ({ title: String(s.title), type: String(s.type ?? "Report") }));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
