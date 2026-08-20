import express from 'express';
import crypto from 'crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, writeFileSync } from 'fs';
import path from 'path';
import { isAutomationAction, type AdapterResult, type OpenHandsExecutionEnvelope } from '../contracts';
import { verifyExecutionCapability } from '../capability';
import { assertAutomationOutputSafe } from '../output-safety';

export interface NativeOpenHandsPort {
  execute(envelope: OpenHandsExecutionEnvelope): Promise<AdapterResult>;
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
  consume(nonce: string, expiresAt: string): boolean {
    const expiry = Date.parse(expiresAt);
    if (!nonce || nonce.length > 512 || !Number.isFinite(expiry) || expiry <= this.now()) return false;
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
  const nonces = config.nonces ?? new MemoryCapabilityNonceStore();
  const now = config.now ?? (() => new Date());
  app.use(express.json({ limit: '32kb' }));
  app.get('/health', (_req, res) => res.json({ ok: true, protocol: 'ronor-openhands-bridge/v1' }));
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
    try {
      const result = await config.client.execute(envelope);
      assertAutomationOutputSafe(result);
      res.status(result.ok ? 200 : 422).json(result);
    } catch {
      res.status(502).json({ ok: false, error: 'openhands_execution_failed' });
    }
  });
  return app;
}
