import express from 'express';
import { createServiceRateLimit } from './rate-limit';
import crypto from 'crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'fs';
import path from 'path';
import { isAutomationAction, type AdapterResult, type OpenHandsExecutionEnvelope } from '../contracts';
import { verifyExecutionCapability } from '../capability';
import { assertAutomationOutputSafe } from '../output-safety';

export interface NativeOpenHandsPort {
  execute(envelope: OpenHandsExecutionEnvelope, signal?: AbortSignal): Promise<AdapterResult>;
  cancel?(assignmentId: string): Promise<void>;
}

export interface CapabilityNonceStore {
  consume(nonce: string, expiresAt: string): boolean;
}

export class MemoryCapabilityNonceStore implements CapabilityNonceStore {
  private readonly consumed = new Map<string, number>();
  consume(nonce: string, expiresAt: string): boolean {
    const now = Date.now();
    for (const [key, expiry] of this.consumed) if (expiry <= now) this.consumed.delete(key);
    if (this.consumed.has(nonce)) return false;
    const expiry = Date.parse(expiresAt);
    if (!Number.isFinite(expiry) || expiry <= now) return false;
    this.consumed.set(nonce, expiry);
    return true;
  }
}

/** Cross-process, restart-safe single-use store using atomic O_EXCL creation. */
export class FileCapabilityNonceStore implements CapabilityNonceStore {
  private readonly root: string;
  constructor(directory: string, private readonly now: () => number = Date.now) {
    const requested = path.resolve(directory);
    if (!existsSync(requested)) mkdirSync(requested, { recursive: true, mode: 0o700 });
    if (lstatSync(requested).isSymbolicLink()) throw new Error('nonce_store_link_refused');
    this.root = realpathSync.native(requested);
  }
  private pruneExpired(maxEntries = 256): void {
    const directory = opendirSync(this.root);
    try {
      for (let scanned = 0; scanned < maxEntries; scanned += 1) {
        const entry = directory.readSync();
        if (!entry) break;
        if (!entry.isFile() || !/^[a-f0-9]{64}\.nonce$/.test(entry.name)) continue;
        const target = path.join(this.root, entry.name);
        try {
          const metadata = lstatSync(target);
          if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 256) continue;
          const stored = JSON.parse(readFileSync(target, 'utf8')) as { expires_at?: unknown };
          if (typeof stored.expires_at === 'string' && Date.parse(stored.expires_at) <= this.now()) unlinkSync(target);
        } catch { /* malformed or concurrently removed records remain fail-closed */ }
      }
    } finally { directory.closeSync(); }
  }
  consume(nonce: string, expiresAt: string): boolean {
    const expiry = Date.parse(expiresAt);
    if (!nonce || nonce.length > 512 || !Number.isFinite(expiry) || expiry <= this.now()) return false;
    this.pruneExpired();
    const name = `${crypto.createHash('sha256').update(nonce).digest('hex')}.nonce`;
    const target = path.join(this.root, name);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(target, 'wx', 0o600);
      writeFileSync(descriptor, JSON.stringify({ expires_at: expiresAt }), { encoding: 'utf8' });
      fsyncSync(descriptor);
      return true;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') return false;
      throw error;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
}

function parseEnvelope(value: unknown): OpenHandsExecutionEnvelope | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.assignment_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(item.assignment_id) ||
      typeof item.instruction !== 'string' || item.instruction.length < 1 || item.instruction.length > 8000 ||
      typeof item.objective_hash !== 'string' || !/^[a-f0-9]{64}$/.test(item.objective_hash) ||
      typeof item.deadline !== 'string' || !Number.isFinite(Date.parse(item.deadline)) ||
      !Array.isArray(item.allowed_actions) || item.allowed_actions.length < 1 || item.allowed_actions.length > 20 ||
      !item.allowed_actions.every(isAutomationAction)) return null;
  return item as unknown as OpenHandsExecutionEnvelope;
}

function bearer(value: string | undefined): string | null {
  const match = /^Bearer ([^\s]+)$/.exec(value ?? '');
  return match?.[1] ?? null;
}

export function createOpenHandsBridgeApp(config: {
  capabilityKey: string;
  serviceToken: string;
  client: NativeOpenHandsPort;
  nonces?: CapabilityNonceStore;
  now?: () => Date;
}) {
  const app = express();
  app.use(createServiceRateLimit());
  const nonces = config.nonces ?? new MemoryCapabilityNonceStore();
  const now = config.now ?? (() => new Date());
  const active = new Map<string, AbortController>();
  const activeKey = (mandateId: string, assignmentId: string) => `${mandateId}\0${assignmentId}`;
  app.use(express.json({ limit: '32kb' }));
  app.get('/health', (req, res) => bearer(req.header('authorization')) === config.serviceToken
    ? res.json({ ok: true, protocol: 'ronor-openhands-bridge/v1', service_id: 'openhands-bridge', capabilities: ['execute', 'cancel'] })
    : res.status(401).json({ ok: false, error: 'unauthorized' }));
  app.post('/v1/cancel', (req, res) => {
    if (!config.serviceToken || bearer(req.header('authorization')) !== config.serviceToken) {
      res.status(401).json({ ok: false, error: 'unauthorized' }); return;
    }
    const token = req.header('x-ronor-capability');
    const claims = token ? verifyExecutionCapability(token, config.capabilityKey, now()) : null;
    const assignmentId = typeof (req.body as Record<string, unknown> | undefined)?.assignment_id === 'string'
      ? (req.body as Record<string, string>).assignment_id : '';
    if (!claims || claims.assignment_id !== assignmentId) {
      res.status(403).json({ ok: false, error: 'invalid_capability' }); return;
    }
    const controller = active.get(activeKey(claims.mandate_id, assignmentId));
    if (!controller) { res.status(404).json({ ok: false, error: 'execution_not_active' }); return; }
    controller.abort();
    res.status(202).json({ ok: true, status: 'cancellation_requested' });
  });
  app.post('/v1/execute', async (req, res) => {
    if (!config.serviceToken || bearer(req.header('authorization')) !== config.serviceToken) {
      res.status(401).json({ ok: false, error: 'unauthorized' }); return;
    }
    const token = req.header('x-ronor-capability');
    const claims = token ? verifyExecutionCapability(token, config.capabilityKey, now()) : null;
    const envelope = parseEnvelope((req.body as Record<string, unknown> | undefined)?.envelope);
    if (!claims || !envelope) { res.status(403).json({ ok: false, error: 'invalid_capability' }); return; }
    if (claims.assignment_id !== envelope.assignment_id || claims.objective_hash !== envelope.objective_hash ||
        claims.expires_at !== envelope.deadline || claims.allowed_actions.join('\0') !== envelope.allowed_actions.join('\0')) {
      res.status(403).json({ ok: false, error: 'capability_mismatch' }); return;
    }
    let consumed = false;
    try { consumed = nonces.consume(claims.nonce, claims.expires_at); }
    catch { res.status(503).json({ ok: false, error: 'nonce_store_unavailable' }); return; }
    if (!consumed) {
      res.status(409).json({ ok: false, error: 'capability_replayed' }); return;
    }
    const executionKey = activeKey(claims.mandate_id, envelope.assignment_id);
    if (active.has(executionKey)) {
      res.status(409).json({ ok: false, error: 'assignment_already_active' }); return;
    }
    const controller = new AbortController();
    active.set(executionKey, controller);
    const cancel = () => controller.abort();
    req.once('aborted', cancel);
    res.once('close', () => { if (!res.writableEnded) cancel(); });
    try {
      const result = await config.client.execute(envelope, controller.signal);
      assertAutomationOutputSafe(result);
      if (!res.destroyed) {
        if (controller.signal.aborted) res.status(409).json({ ok: false, error: 'openhands_execution_cancelled' });
        else res.status(result.ok ? 200 : 422).json(result);
      }
    } catch {
      if (!res.destroyed) res.status(controller.signal.aborted ? 409 : 502).json({
        ok: false, error: controller.signal.aborted ? 'openhands_execution_cancelled' : 'openhands_execution_failed',
      });
    } finally {
      if (active.get(executionKey) === controller) active.delete(executionKey);
    }
  });
  return app;
}
