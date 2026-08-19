/**
 * RONOR — L2 · Persistence · Supabase Adapter
 * ─────────────────────────────────────────────
 * Durable relational persistence for conversations, memory entries, agent state,
 * missions and audit events, backed by the Supabase project
 * mrmauhtdmmyaxrxfsqsn.
 *
 * Design commitments
 * ──────────────────
 *   · FAIL-OPEN BY DEFAULT. A Supabase outage degrades RONOR to local SQLite and
 *     says so in every response. `PERSISTENCE_REQUIRED=true` in the environment
 *     inverts this: a request that cannot be persisted is refused rather than
 *     answered silently. The default is fail-open because a governed runtime that
 *     refuses all work during a Postgres outage is less useful than one that
 *     continues with degraded durability and reports it.
 *
 *   · THE SERVICE ROLE KEY IS NEVER LOGGED. It is present/absent in the log,
 *     never its value. A log is not a place a credential should be recoverable
 *     from.
 *
 *   · SCHEMA IS IDEMPOTENT. The SQL migration uses `CREATE TABLE IF NOT EXISTS`
 *     and `CREATE INDEX IF NOT EXISTS` throughout, so it is safe to re-run
 *     against an already-migrated database.
 *
 *   · EVERY WRITE IS FIRE-AND-FORGET BY DEFAULT. The runtime does not wait for
 *     Supabase to confirm a write before returning an answer to the caller. A
 *     persistence layer that adds 200ms to every governed query is a persistence
 *     layer that gets disabled. Callers that need confirmation can await the
 *     returned promise explicitly.
 *
 * Prepared by AMB · Mayleven Ecosystem
 */

import https from 'https';
import http from 'http';
import { createLogger } from '../utils/logger';

const logger = createLogger('RONOR:Persistence:Supabase');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface SupabaseConfig {
  url: string;
  serviceRoleKey: string;
  schema: string;
  required: boolean;
}

export function loadSupabaseConfig(env: NodeJS.ProcessEnv = process.env): SupabaseConfig | null {
  const url = (env.SUPABASE_URL ?? '').trim();
  const key = (env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
  if (!url || !key) {
    logger.warn('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — Supabase persistence disabled');
    return null;
  }
  return {
    url: url.replace(/\/+$/, ''),
    serviceRoleKey: key,
    schema: (env.SUPABASE_SCHEMA ?? 'ronor').trim(),
    required: env.PERSISTENCE_REQUIRED === 'true',
  };
}

// ---------------------------------------------------------------------------
// HTTP helper (no external deps — the adapter ships in the same image as the
// runtime, which already has no HTTP client dependency for internal calls)
// ---------------------------------------------------------------------------

function supabaseRequest<T>(
  config: SupabaseConfig,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; data: T }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, config.url);
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        'Accept-Profile': config.schema,
        'Content-Profile': config.schema,
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...extraHeaders,
      },
      timeout: 10_000,
    };

    const req = lib.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data: T;
        try {
          data = raw.length > 0 ? (JSON.parse(raw) as T) : ([] as unknown as T);
        } catch {
          reject(new Error(`Supabase non-JSON response on ${path}: ${raw.slice(0, 200)}`));
          return;
        }
        resolve({ status: res.statusCode ?? 0, data });
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`Supabase request timed out: ${path}`)); });
    req.on('error', (e: Error) => reject(e));
    if (payload) req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface ConversationRow {
  id?: string;
  session_id: string;
  user_id: string | null;
  channel: string;
  started_at: string;
  last_active_at: string;
  message_count: number;
  metadata: Record<string, unknown>;
}

export interface MemoryEntryRow {
  id?: string;
  session_id: string | null;
  user_id: string | null;
  kind: 'fact' | 'preference' | 'context' | 'instruction' | 'event';
  content: string;
  source: string;
  confidence: number;
  embedding_id: string | null;
  created_at?: string;
  expires_at: string | null;
  metadata: Record<string, unknown>;
}

export interface AgentStateRow {
  agent_id: string;
  mission_id: string | null;
  status: string;
  last_task_id: string | null;
  cost_usd_accumulated: number;
  updated_at?: string;
  state_json: Record<string, unknown>;
}

export interface MissionRow {
  mission_id: string;
  title: string;
  objective: string;
  status: string;
  operator_id: string | null;
  cost_usd: number;
  requests_count: number;
  created_at?: string;
  updated_at?: string;
  state_json: Record<string, unknown>;
}

export interface AuditEventRow {
  id?: string;
  event_type: string;
  request_id: string | null;
  mission_id: string | null;
  user_id: string | null;
  channel: string | null;
  verdict: string | null;
  human_cosign_required: boolean;
  cost_usd: number | null;
  latency_ms: number | null;
  model_id: string | null;
  audit_chain_hash: string | null;
  occurred_at?: string;
  payload_json: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class SupabaseAdapter {
  private readonly config: SupabaseConfig;
  private available = true;

  constructor(config: SupabaseConfig) {
    this.config = config;
    logger.info(`Supabase adapter initialised → ${config.url} (schema: ${config.schema}, required: ${config.required})`);
  }

  get isAvailable(): boolean {
    return this.available;
  }

  // ---- Conversations -------------------------------------------------------

  async upsertConversation(row: ConversationRow): Promise<void> {
    await this.write('/rest/v1/conversations', 'POST', row, { Prefer: 'resolution=merge-duplicates,return=minimal' });
  }

  async getConversation(sessionId: string): Promise<ConversationRow | null> {
    const { data } = await this.read<ConversationRow[]>(
      `/rest/v1/conversations?session_id=eq.${encodeURIComponent(sessionId)}&limit=1`,
    );
    return data?.[0] ?? null;
  }

  // ---- Memory entries ------------------------------------------------------

  async insertMemoryEntry(row: MemoryEntryRow): Promise<string | null> {
    const result = await this.write<MemoryEntryRow[]>('/rest/v1/memory_entries', 'POST', row);
    return result?.[0]?.id ?? null;
  }

  async queryMemoryEntries(params: {
    userId?: string;
    sessionId?: string;
    kind?: MemoryEntryRow['kind'];
    limit?: number;
  }): Promise<MemoryEntryRow[]> {
    const qs: string[] = ['order=created_at.desc'];
    if (params.userId) qs.push(`user_id=eq.${encodeURIComponent(params.userId)}`);
    if (params.sessionId) qs.push(`session_id=eq.${encodeURIComponent(params.sessionId)}`);
    if (params.kind) qs.push(`kind=eq.${encodeURIComponent(params.kind)}`);
    qs.push(`limit=${params.limit ?? 50}`);
    const { data } = await this.read<MemoryEntryRow[]>(`/rest/v1/memory_entries?${qs.join('&')}`);
    return data ?? [];
  }

  // ---- Agent state ---------------------------------------------------------

  async upsertAgentState(row: AgentStateRow): Promise<void> {
    await this.write('/rest/v1/agent_state', 'POST', row, { Prefer: 'resolution=merge-duplicates,return=minimal' });
  }

  async getAgentState(agentId: string): Promise<AgentStateRow | null> {
    const { data } = await this.read<AgentStateRow[]>(
      `/rest/v1/agent_state?agent_id=eq.${encodeURIComponent(agentId)}&limit=1`,
    );
    return data?.[0] ?? null;
  }

  // ---- Missions ------------------------------------------------------------

  async upsertMission(row: MissionRow): Promise<void> {
    await this.write('/rest/v1/missions', 'POST', row, { Prefer: 'resolution=merge-duplicates,return=minimal' });
  }

  async getMission(missionId: string): Promise<MissionRow | null> {
    const { data } = await this.read<MissionRow[]>(
      `/rest/v1/missions?mission_id=eq.${encodeURIComponent(missionId)}&limit=1`,
    );
    return data?.[0] ?? null;
  }

  async listMissions(limit = 50): Promise<MissionRow[]> {
    const { data } = await this.read<MissionRow[]>(
      `/rest/v1/missions?order=created_at.desc&limit=${limit}`,
    );
    return data ?? [];
  }

  // ---- Audit events --------------------------------------------------------

  async insertAuditEvent(row: AuditEventRow): Promise<void> {
    await this.write('/rest/v1/audit_events', 'POST', row, { Prefer: 'return=minimal' });
  }

  async listAuditEvents(limit = 100): Promise<AuditEventRow[]> {
    const { data } = await this.read<AuditEventRow[]>(
      `/rest/v1/audit_events?order=occurred_at.desc&limit=${limit}`,
    );
    return data ?? [];
  }

  // ---- Health check --------------------------------------------------------

  async ping(): Promise<boolean> {
    try {
      const { status } = await supabaseRequest<unknown>(this.config, 'GET', '/rest/v1/', undefined);
      this.available = status < 500;
      return this.available;
    } catch {
      this.available = false;
      return false;
    }
  }

  // ---- Internal helpers ----------------------------------------------------

  private async write<T = unknown>(
    path: string,
    method: 'POST' | 'PATCH' | 'DELETE',
    body: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T | null> {
    try {
      const { status, data } = await supabaseRequest<T>(this.config, method, path, body, extraHeaders);
      if (status >= 400) {
        logger.warn(`Supabase write ${method} ${path} → HTTP ${status}`, data);
        this.available = status < 500;
        return null;
      }
      this.available = true;
      return data;
    } catch (err) {
      logger.error(`Supabase write error on ${path}:`, err);
      this.available = false;
      if (this.config.required) throw err;
      return null;
    }
  }

  private async read<T>(path: string): Promise<{ data: T | null }> {
    try {
      const { status, data } = await supabaseRequest<T>(this.config, 'GET', path);
      if (status >= 400) {
        logger.warn(`Supabase read GET ${path} → HTTP ${status}`);
        this.available = status < 500;
        return { data: null };
      }
      this.available = true;
      return { data };
    } catch (err) {
      logger.error(`Supabase read error on ${path}:`, err);
      this.available = false;
      if (this.config.required) throw err;
      return { data: null };
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance: SupabaseAdapter | null = null;

export function getSupabaseAdapter(env: NodeJS.ProcessEnv = process.env): SupabaseAdapter | null {
  if (_instance) return _instance;
  const config = loadSupabaseConfig(env);
  if (!config) return null;
  _instance = new SupabaseAdapter(config);
  return _instance;
}
