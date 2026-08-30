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

/**
 * The register's state as OBSERVED, not as hoped.
 *
 * Four values, because three distinct faults were previously collapsed into the
 * single word `available`:
 *
 *   · `accesibil`            — the register answered with a 2xx. The only state
 *                              in which a caller may treat it as usable.
 *   · `refuzat_autorizare`   — 401 or 403. The register is alive and REFUSING:
 *                              an expired service-role key, a revoked grant, a
 *                              row-level-security policy denying the write. Rows
 *                              are being lost, and no retry will land until a
 *                              human fixes the credential.
 *   · `refuzat`              — any other 4xx (a 404 on a missing table, a 400
 *                              from the constrained event-type vocabulary), and
 *                              any 3xx, which PostgREST does not issue on these
 *                              paths and therefore signals something other than
 *                              the register in front of us.
 *   · `inaccesibil`          — 5xx, a transport error, or a timeout. Nobody
 *                              answered.
 *   · `necunoscut`           — no contact attempted yet. Not a verdict.
 *
 * The distinction is the whole point. The retired rule `available = status < 500`
 * reported a register that answers `401 Unauthorized` to every write as
 * AVAILABLE, so a runtime losing every audit row looked healthy. Reachability is
 * not usability, and a refusal is not an outage: it is a louder fault, because
 * it will not heal on its own.
 */
export type StareRegistru =
  | 'necunoscut'
  | 'accesibil'
  | 'refuzat_autorizare'
  | 'refuzat'
  | 'inaccesibil';

export class SupabaseAdapter {
  private readonly config: SupabaseConfig;
  private stare: StareRegistru = 'necunoscut';
  private motivStare: string | null = null;

  constructor(config: SupabaseConfig) {
    this.config = config;
    logger.info(`Supabase adapter initialised → ${config.url} (schema: ${config.schema}, required: ${config.required})`);
  }

  /**
   * True ONLY for an observed 2xx. A refusal (401/403/404/400) and an outage
   * both return false, because in all of them a write does not land.
   *
   * `necunoscut` returns false as well: before the first contact there is no
   * evidence of availability, and the previous optimistic initial value `true`
   * meant the very first health report could claim a register nobody had spoken
   * to yet.
   */
  get isAvailable(): boolean {
    return this.stare === 'accesibil';
  }

  /** The observed state, for callers that must tell a refusal from an outage. */
  get stareRegistru(): StareRegistru {
    return this.stare;
  }

  /** Human-readable reason for the current state; null when accessible. */
  get motivulStarii(): string | null {
    return this.stare === 'accesibil' ? null : this.motivStare;
  }

  /**
   * Record the state implied by one observed HTTP status.
   *
   * Returns whether the status is a CONFIRMATION (2xx), so callers never have to
   * restate the boundary. Restating it is how `>= 400` came to mean "confirmed"
   * for every 3xx.
   */
  private noteazaStatus(status: number, context: string): boolean {
    if (status >= 200 && status < 300) {
      this.stare = 'accesibil';
      this.motivStare = null;
      return true;
    }
    if (status === 401 || status === 403) {
      this.stare = 'refuzat_autorizare';
      this.motivStare = `registrul a refuzat autorizarea (HTTP ${status}) la ${context}`;
      return false;
    }
    if (status >= 500) {
      this.stare = 'inaccesibil';
      this.motivStare = `registrul a răspuns cu eroare de server (HTTP ${status}) la ${context}`;
      return false;
    }
    this.stare = 'refuzat';
    this.motivStare = `registrul a respins cererea (HTTP ${status}) la ${context}`;
    return false;
  }

  /** Record a transport-level fault: nobody answered. */
  private noteazaEroare(err: unknown, context: string): void {
    this.stare = 'inaccesibil';
    this.motivStare = `${context}: ${err instanceof Error ? err.message : String(err)}`;
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

  /**
   * Insert one audit event and report whether the register CONFIRMED the write.
   *
   * Returns true only for a 2xx. A rejection — 400 from a CHECK constraint, 401
   * from an expired token, 403 from a missing grant, and equally a 3xx redirect —
   * returns false, because a row that was not confirmed is a lost row.
   *
   * `isAvailable` follows the same 2xx boundary, so a refusal can no longer be
   * read as proof that writes are landing. What the two still say separately is
   * WHICH fault occurred: `stareRegistru` distinguishes a refusal that will not
   * heal without a human from an outage that may.
   */
  async insertAuditEvent(row: AuditEventRow): Promise<boolean> {
    return this.writeConfirmed('/rest/v1/audit_events', 'POST', row, { Prefer: 'return=minimal' });
  }

  /**
   * Like `write`, but the return value is the confirmation of the write itself
   * rather than the response body. Kept separate so no existing caller changes
   * meaning.
   */
  private async writeConfirmed(
    path: string,
    method: 'POST' | 'PATCH' | 'DELETE',
    body: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<boolean> {
    try {
      const { status, data } = await supabaseRequest<unknown>(this.config, method, path, body, extraHeaders);
      // A write is confirmed by a 2xx and by nothing else. The retired test
      // `status >= 400` counted every 3xx as a confirmed insertion: a redirect —
      // from a proxy in front of the register, or a URL that moved — would have
      // been recorded as a mirrored link, and the row would exist nowhere.
      const confirmat = this.noteazaStatus(status, `${method} ${path}`);
      if (!confirmat) {
        logger.warn(`Supabase write ${method} ${path} → HTTP ${status} (neconfirmat, rândul e pierdut)`, data);
        return false;
      }
      return true;
    } catch (err) {
      logger.error(`Supabase write error on ${path}:`, err);
      this.noteazaEroare(err, `scriere ${method} ${path}`);
      if (this.config.required) throw err;
      return false;
    }
  }

  async listAuditEvents(limit = 100): Promise<AuditEventRow[]> {
    const { data } = await this.read<AuditEventRow[]>(
      `/rest/v1/audit_events?order=occurred_at.desc&limit=${limit}`,
    );
    return data ?? [];
  }

  // ---- Health check --------------------------------------------------------

  /**
   * Reachability probe. True only on a 2xx.
   *
   * The retired rule was `status < 500`, which answered TRUE to a register that
   * replies 401 to every request. Health then reported green while every audit
   * row was being dropped — the exact false green this module exists to remove.
   * A refusal is now false, and `stareRegistru` says which refusal it was.
   */
  async ping(): Promise<boolean> {
    try {
      const { status } = await supabaseRequest<unknown>(this.config, 'GET', '/rest/v1/', undefined);
      return this.noteazaStatus(status, 'GET /rest/v1/ (sondă)');
    } catch (err) {
      this.noteazaEroare(err, 'sondă GET /rest/v1/');
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
      if (!this.noteazaStatus(status, `${method} ${path}`)) {
        logger.warn(`Supabase write ${method} ${path} → HTTP ${status}`, data);
        return null;
      }
      return data;
    } catch (err) {
      logger.error(`Supabase write error on ${path}:`, err);
      this.noteazaEroare(err, `scriere ${method} ${path}`);
      if (this.config.required) throw err;
      return null;
    }
  }

  private async read<T>(path: string): Promise<{ data: T | null }> {
    try {
      const { status, data } = await supabaseRequest<T>(this.config, 'GET', path);
      if (!this.noteazaStatus(status, `GET ${path}`)) {
        logger.warn(`Supabase read GET ${path} → HTTP ${status}`);
        return { data: null };
      }
      return { data };
    } catch (err) {
      logger.error(`Supabase read error on ${path}:`, err);
      this.noteazaEroare(err, `citire GET ${path}`);
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
