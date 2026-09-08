import http from 'node:http';
import type { AddressInfo } from 'node:net';
import undici = require('undici');
import { createOpenHandsAdapter } from '../../src/runtime/automation/adapters/http';
import type { ExecutionMandate } from '../../src/runtime/automation/contracts';

const assignment = { id: 'transport', instruction: 'Validate transport only.', actions: ['read_repo'] as const };
const result = { ok: true, summary: 'Transport verified.', evidence: [], cost_usd: 0 };
const mandate = () => ({
  mandate_id: 'transport', mission_id: 'transport', objective_hash: 'a'.repeat(64),
  expires_at: new Date(Date.now() + 900_000).toISOString(),
} as ExecutionMandate);

describe('deadline-bound OpenHands HTTP transport', () => {
  let server: http.Server;
  let baseUrl: string;
  let handler: http.RequestListener;
  const calls: string[] = [];
  beforeEach(async () => {
    calls.length = 0;
    handler = (_req, res) => res.end(JSON.stringify(result));
    server = http.createServer((req, res) => {
      calls.push(req.url!);
      req.resume();
      if (req.url === '/v1/cancel') { res.end(JSON.stringify({ ok: true })); return; }
      handler(req, res);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const execute = (baseUrl: string, timeoutMs?: number, signal?: AbortSignal) =>
    createOpenHandsAdapter({ baseUrl, capabilityKey: 'k'.repeat(32), timeoutMs })
      .execute({ ...assignment, actions: [...assignment.actions] }, mandate(), signal);

  it('sets finite header and body waits beyond five minutes, bounded by the signed deadline', async () => {
    const spy = jest.spyOn(undici, 'request');
    handler = (_req, res) => { setTimeout(() => res.end(JSON.stringify(result)), 60); };
    await expect(execute(baseUrl)).resolves.toMatchObject(result);
    const options = spy.mock.calls[0][1]!;
    expect(options.headersTimeout).toBeGreaterThan(900_000);
    expect(options.headersTimeout).toBeLessThanOrEqual(910_000);
    expect(options.bodyTimeout).toBe(options.headersTimeout);
    expect(options.maxRedirections).toBe(0);
    expect(options.headers).toHaveProperty('x-ronor-capability');
    expect(calls).toEqual(['/v1/execute']);
  });
  it('retains a shorter operator timeout and requests signed cancellation', async () => {
    handler = () => { /* deliberately no headers */ };
    await expect(execute(baseUrl, 400)).rejects.toThrow('adapter_timeout');
    expect(calls).toEqual(['/v1/execute', '/v1/cancel']);
  });
  it('distinguishes cancellation from timeout on the real transport', async () => {
    const abort = new AbortController();
    handler = () => abort.abort();
    await expect(execute(baseUrl, 5_000, abort.signal)).rejects.toThrow('adapter_cancelled');
    expect(calls).toEqual(['/v1/execute', '/v1/cancel']);
  });
  it('also enforces the wall deadline after headers arrive but the body stalls', async () => {
    handler = (_req, res) => { res.writeHead(200); res.write('{"ok":'); };
    await expect(execute(baseUrl, 400)).rejects.toThrow('adapter_timeout');
    expect(calls).toEqual(['/v1/execute', '/v1/cancel']);
  });
  it('bounds a streamed body even without a content length', async () => {
    handler = (_req, res) => { res.write('x'.repeat(256 * 1024)); res.end('x'); };
    await expect(execute(baseUrl)).rejects.toThrow('adapter_response_too_large');
  });
  it('refuses oversized advertised content before reading it', async () => {
    handler = (_req, res) => { res.writeHead(200, { 'content-length': 300_000 }); res.flushHeaders(); };
    await expect(execute(baseUrl)).rejects.toThrow('adapter_response_too_large');
  });
  it('never follows a redirect carrying execution credentials', async () => {
    handler = (_req, res) => { res.writeHead(307, { location: `${baseUrl}/unexpected` }); res.end(); };
    await expect(execute(baseUrl)).rejects.toThrow('adapter_redirect_refused');
    expect(calls).toEqual(['/v1/execute']);
  });
  it('does not contact the bridge after the signed deadline', async () => {
    const expired = { ...mandate(), expires_at: new Date(Date.now() - 1).toISOString() };
    await expect(createOpenHandsAdapter({ baseUrl, capabilityKey: 'k'.repeat(32) })
      .execute({ ...assignment, actions: [...assignment.actions] }, expired)).rejects.toThrow('openhands_deadline_expired');
    expect(calls).toHaveLength(0);
  });
});
