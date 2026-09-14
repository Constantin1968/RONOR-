import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type express from 'express';
import { createWorkspaceArtifactCollector } from '../../src/runtime/automation/artifacts';
import { createBoundedTestExecutor } from '../../src/runtime/automation/bounded-test-executor';
import { createAllowlistedTestExecutor } from '../../src/runtime/automation/test-executor';
import { createEvidenceRunnerApp } from '../../src/runtime/automation/services/evidence-runner';
import { createAssuranceAuthorityApp, createCodexVerifierApp } from '../../src/runtime/automation/services/verification-authorities';
import { createOpenAIResponsesCodexEvaluator } from '../../src/runtime/automation/services/codex-evaluator';
import { createModelEgressProxy } from '../../src/runtime/automation/services/model-egress-proxy';
import { MODEL_RATE_CARD, ModelBudgetLedger } from '../../src/runtime/automation/model-budget';

/**
 * PROTOCOL-FAITHFUL STACK. Nothing here stands in for a RONOR component: the
 * evidence runner, the Codex verifier with its real OpenAI-Responses evaluator,
 * the Victoria assurance authority, the model egress proxy and its SQLite budget
 * ledger are the production implementations, each bound to a real loopback
 * socket and reached over real HTTP with the real `fetch`.
 *
 * Exactly two things are supplied by the test, and both are deliberate:
 *
 *  1. `resolve` maps the internal service hostnames and the tailnet gateway
 *     address to the loopback ports the stack is actually listening on. This is
 *     name resolution only. Method, path, headers, body bytes, status codes,
 *     `content-length`, abort propagation and socket teardown are untouched, so
 *     a request that would be refused in production is refused here too.
 *  2. `provider` is the only genuine outside party — the paid model endpoint.
 *     It answers on the wire in the OpenAI Responses protocol the evaluator
 *     parses and the proxy meters, including `usage` token counters, and can be
 *     told to fail, stall or answer unfaithfully so that the accounting and the
 *     admission barrier are exercised against real settlement, not a stub.
 */

export interface ProviderScript {
  /** Verdict object the model returns as its single `output_text` item. */
  verdict?: { verdict: 'pass' | 'fail'; summary: string; evidence: string[] };
  /** Token counters the provider reports. Both accounting paths read these. */
  inputTokens?: number;
  outputTokens?: number;
  /** Provider-side HTTP refusal, e.g. 503. */
  status?: number;
  /** Hold the connection open until the caller aborts it. */
  stall?: boolean;
  /** Replace the whole response body, to test unfaithful providers. */
  body?: unknown;
}

/** A service that answers unfaithfully or not at all. Applied on the wire, after
 * the real service produced its answer, so the client performs a complete HTTP
 * round trip and its own parsing and signature checks decide the outcome. */
export type ServiceTamper = (host: string, path: string, body: any) => { status?: number; body?: unknown } | undefined;

export interface ProtocolFaithfulStack {
  /** Real `fetch`, with internal hostnames resolved to the live loopback ports. */
  fetcher: typeof fetch;
  /** Every request the stack received, as `host/path`, in order. */
  calls: string[];
  /** What the provider answers next. Mutate between assertions. */
  provider: ProviderScript;
  /** Requests the model provider actually received. */
  providerRequests: Record<string, unknown>[];
  /** The live budget ledger the proxy settles into. */
  ledger: ModelBudgetLedger;
  /** Make one service answer unfaithfully. Set to `() => undefined` to stop. */
  setTamper(tamper: ServiceTamper): void;
  /** Make one route stop answering, so the client aborts a real connection. */
  setHold(hold: (host: string, path: string) => boolean): void;
  /** Environment values the controller needs to reach this stack. */
  env: Record<string, string>;
  /** Tokens, exposed for negative authorisation tests. */
  tokens: { evidenceRunner: string; codexVerifier: string; assurance: string; author: string; verifier: string };
  stop(): Promise<void>;
}

const PROVIDER_HOST = '100.64.0.1';

/** One well-formed OpenAI Responses answer carrying the verifier's JSON object. */
function responsesEnvelope(script: ProviderScript) {
  const verdict = script.verdict ?? { verdict: 'pass' as const, summary: 'Diff is coherent and the supplied test report passes.', evidence: ['faithful-evaluation:pass'] };
  return {
    id: `resp_${crypto.randomBytes(12).toString('hex')}`, object: 'response', model: MODEL_RATE_CARD.model,
    status: 'completed',
    output: [{ id: `msg_${crypto.randomBytes(12).toString('hex')}`, type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: JSON.stringify(verdict), annotations: [] }] }],
    usage: { input_tokens: script.inputTokens ?? 1800, output_tokens: script.outputTokens ?? 120,
      total_tokens: (script.inputTokens ?? 1800) + (script.outputTokens ?? 120) },
  };
}

async function listen(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

export async function startProtocolFaithfulStack(config: {
  /** Git worktree the evidence runner reads and tests inside. */
  worktree: string;
  artifactRoot: string;
  /** Where the proxy's SQLite budget ledger is created. Defaults to the artifact root. */
  ledgerDir?: string;
  /** Capability key the controller signs budget tokens and budget queries with. */
  capabilityKey: string;
  /** Test commands the bounded executor is allowed to run. */
  commands?: { id: string; executable: string; args: string[]; timeout_ms: number }[];
}): Promise<ProtocolFaithfulStack> {
  const tokens = {
    evidenceRunner: crypto.randomBytes(32).toString('hex'),
    codexVerifier: crypto.randomBytes(32).toString('hex'),
    assurance: crypto.randomBytes(32).toString('hex'),
    author: crypto.randomBytes(32).toString('hex'),
    verifier: crypto.randomBytes(32).toString('hex'),
    upstream: crypto.randomBytes(32).toString('hex'),
  };
  const calls: string[] = [];
  const provider: ProviderScript = {};
  const providerRequests: Record<string, unknown>[] = [];
  const ports: Record<string, number> = {};
  let tamper: ServiceTamper = () => undefined;
  let hold: (host: string, path: string) => boolean = () => false;

  // Name resolution only: the request itself is carried by the real fetch over
  // a real socket to the port the target is listening on.
  const fetcher: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    const port = ports[url.hostname];
    if (!port) return Promise.reject(new Error(`unresolvable_service_host:${url.hostname}`));
    const target = new URL(url.toString());
    target.hostname = '127.0.0.1'; target.port = String(port);
    return fetch(target, init);
  };

  const modelProvider = await listen((req, res) => {
    calls.push(`model-provider${req.url}`);
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk as Buffer));
    req.on('end', () => {
      try { providerRequests.push(JSON.parse(Buffer.concat(chunks).toString())); } catch { providerRequests.push({}); }
      if (provider.stall) return; // Held open until the client gives up.
      const payload = Buffer.from(JSON.stringify(provider.body ?? responsesEnvelope(provider)));
      res.writeHead(provider.status ?? 200, { 'content-type': 'application/json', 'content-length': String(payload.byteLength) });
      res.end(payload);
    });
  });
  ports[PROVIDER_HOST] = modelProvider.port;

  const ledgerDb = `${config.ledgerDir ?? config.artifactRoot}/faithful-ledger.db`;
  const ledger = new ModelBudgetLedger(ledgerDb);
  const proxy = createModelEgressProxy({
    gatewayBaseUrl: `http://${PROVIDER_HOST}/v1`, allowTailscale: true, fetcher,
    clientTokens: [tokens.author, tokens.verifier], upstreamToken: tokens.upstream,
    budget: { key: config.capabilityKey, ledger },
  });

  const artifacts = createWorkspaceArtifactCollector(config.artifactRoot);
  const testConfig = { artifacts, approvedRoot: config.worktree, baseEnv: {},
    commands: config.commands ?? [{ id: 'faithful-node-test', executable: process.execPath, args: ['-e', 'process.exit(0)'], timeout_ms: 5000 }] };
  const runner = createEvidenceRunnerApp({ token: tokens.evidenceRunner, workspaceRoot: config.worktree, artifacts,
    tests: createAllowlistedTestExecutor(testConfig), boundedTests: createBoundedTestExecutor(testConfig) });

  const keys = crypto.generateKeyPairSync('ed25519');
  const codex = createCodexVerifierApp({
    serviceToken: tokens.codexVerifier, artifacts,
    receiptPrivateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    // The production evaluator, speaking to the production proxy. Rates equal
    // the rate card, so the evaluator's arithmetic and the ledger's settlement
    // are two independent computations over the same provider counters.
    evaluator: createOpenAIResponsesCodexEvaluator({
      apiKey: tokens.verifier, model: MODEL_RATE_CARD.model, baseUrl: 'http://model-egress-proxy/v1',
      inputUsdPerMillionTokens: MODEL_RATE_CARD.inputMicroUsd, outputUsdPerMillionTokens: MODEL_RATE_CARD.outputMicroUsd,
      fetcher, timeoutMs: 20_000,
    }),
  });
  const victoria = createAssuranceAuthorityApp({ serviceToken: tokens.assurance, artifacts,
    receiptPublicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() });

  const mounted: { host: string; app: express.Express }[] = [
    { host: 'automation-evidence-runner', app: runner },
    { host: 'codex-verifier', app: codex },
    { host: 'victoria-assurance', app: victoria },
    { host: 'model-egress-proxy', app: proxy },
  ];
  const servers = [modelProvider.server];
  for (const { host, app } of mounted) {
    const started = await listen((req, res) => {
      const path = req.url!.split('?')[0];
      calls.push(`${host}${path}`);
      if (hold(host, path)) { req.resume(); return; }
      // Capture the real answer and hand it to `tamper` before it reaches the
      // socket. Headers are still unsent at this point, so a replaced body gets
      // a correct `content-length` and the client sees an ordinary response.
      const chunks: Buffer[] = [];
      const write = res.write.bind(res); const end = res.end.bind(res);
      res.write = ((chunk: any, ...rest: any[]) => { if (chunk) chunks.push(Buffer.from(chunk)); return true; }) as typeof res.write;
      res.end = ((chunk?: any, ...rest: any[]) => {
        if (chunk && typeof chunk !== 'function') chunks.push(Buffer.from(chunk));
        res.write = write; res.end = end;
        const original = Buffer.concat(chunks);
        let parsed: any = null;
        try { parsed = JSON.parse(original.toString()); } catch { /* not JSON */ }
        const replacement = tamper(host, path, parsed);
        if (!replacement) return end(original);
        const payload = replacement.body === undefined ? original : Buffer.from(JSON.stringify(replacement.body));
        res.statusCode = replacement.status ?? res.statusCode;
        res.removeHeader('etag');
        res.setHeader('content-type', 'application/json');
        res.setHeader('content-length', String(payload.byteLength));
        return end(payload);
      }) as typeof res.end;
      app(req, res);
    });
    ports[host] = started.port; servers.push(started.server);
  }

  return {
    fetcher, calls, provider, providerRequests, ledger,
    tokens: { evidenceRunner: tokens.evidenceRunner, codexVerifier: tokens.codexVerifier,
      assurance: tokens.assurance, author: tokens.author, verifier: tokens.verifier },
    env: {
      RONOR_EVIDENCE_RUNNER_TOKEN: tokens.evidenceRunner, RONOR_CODEX_VERIFIER_TOKEN: tokens.codexVerifier,
      RONOR_ASSURANCE_TOKEN: tokens.assurance,
      RONOR_EVIDENCE_RUNNER_URL: 'http://automation-evidence-runner:3005',
      RONOR_CODEX_VERIFIER_URL: 'http://codex-verifier:3002',
      RONOR_ASSURANCE_URL: 'http://victoria-assurance:3003',
      RONOR_MODEL_EGRESS_URL: 'http://model-egress-proxy:3004',
    },
    setTamper(next) { tamper = next; },
    setHold(next) { hold = next; },
    async stop() {
      for (const server of servers) {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    },
  };
}
