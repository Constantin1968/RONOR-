/**
 * R-Knowledge Plane
 * Plane 9 — Governed knowledge retrieval (MIP-014)
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THE ABSOLUTE GATE
 *
 * When `KNOWLEDGE_ENABLED` is not exactly the string `"true"`, this module's
 * factory returns `null` and NO PLANE INSTANCE COMES INTO EXISTENCE. That is the
 * mechanism by which the nine disabled-mode prohibitions of STEP 1 § 4.2 are
 * satisfied structurally rather than by discipline:
 *
 *   1. No route is registered          — the router is never constructed
 *   2. No plane appears in health      — no instance to enumerate
 *   3. No database file is created     — no store is constructed
 *   4. No directory is created         — no path is resolved
 *   5. No timer is scheduled           — the constructor creates none, ever
 *   6. No network connection is opened — no adapter exists
 *   7. No credential is read           — no configuration consumer runs
 *   8. No log line is emitted          — beyond the single gate decision
 *   9. No process handler is installed — none is installed even when enabled
 *
 * A conditional inside a constructed object would satisfy none of these, because
 * the object's construction is itself an observable event: it allocates, it may
 * resolve a path, it may open a handle, and it appears in a plane list. The gate
 * is therefore placed BEFORE construction, in a factory.
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Isolation (STEP 1 § 13.2). This plane holds no handle on the audit database,
 * imports nothing from `src/audit/`, participates in no orchestrator pipeline and
 * installs no process-level handler. A failure inside it degrades it alone: the
 * eight pre-existing planes are unaffected, `GET /health` continues to report
 * `status: "ok"`, and `verifyChain().ok` remains true.
 */

import { createLogger } from '../../utils/logger';
import type { PlaneHealth } from '../../types';

import { computeDegradation, initialDegradation } from '../../knowledge/degradation';
import type { DependencyHealth } from '../../knowledge/degradation';
import { createEmbeddingAdapter } from '../../knowledge/embedding/embedding-adapter';
import { ingest } from '../../knowledge/ingestion';
import type { IngestionResult } from '../../knowledge/ingestion';
import { composeRag } from '../../knowledge/rag';
import type { RagComposition, RagRequest } from '../../knowledge/rag';
import { ingestCorpus } from '../../knowledge/corpus';
import type {
  CorpusDocument,
  CorpusIngestionOptions,
  CorpusIngestionReport,
} from '../../knowledge/corpus';
import { retrieve } from '../../knowledge/retrieval';
import { selectVectorStore } from '../../knowledge/stores/vector-store';
import { isKnowledgeEnabled, resolveKnowledgeConfig } from './config';
import type {
  DegradationState,
  EmbeddingAdapter,
  KnowledgeConfig,
  KnowledgeDiagnostics,
  KnowledgeRetrievalResponse,
  QuarantineRecord,
  StoreHealth,
  VectorStore,
} from './types';

const logger = createLogger('Plane:R-Knowledge');

/**
 * The activation predicate is IMPORTED, not redefined here.
 *
 * It previously existed twice — once in `config.ts` and once in this file. Both said
 * `=== 'true'`, so the duplication was harmless on the day it was written, and that is
 * exactly the hazard. Two copies of a security-relevant predicate drift silently,
 * because the copy someone later relaxes to accept `'1'` is not necessarily the copy
 * the conformance suite asserts against. The G8 rollback drill found this by counting
 * definitions rather than by reading them, which is the kind of defect a drill exists
 * to catch.
 *
 * `=== 'true'` exactly: lowercase, untrimmed, string-compared. `1`, `yes`, `TRUE`,
 * `True`, `on` and `' true '` all evaluate false. A permissive predicate on a
 * fail-closed flag is how a plane ends up enabled in an environment nobody intended,
 * so the strictness is a feature rather than an inconvenience.
 */
export { isKnowledgeEnabled } from './config';

export class RKnowledgePlane {
  private readonly config: KnowledgeConfig;
  private readonly store: VectorStore;
  private readonly embedder: EmbeddingAdapter;
  private degradation: DegradationState;

  private requestsTotal = 0;
  private errorsTotal = 0;
  private objectsIngested = 0;
  private objectsRefused = 0;
  private queriesServed = 0;
  private quarantineEvents = 0;
  /** The plane's own accounting of egress attempts. Expected to remain zero. */
  private egressEvents = 0;
  private lastStoreHealth: StoreHealth | null = null;
  private readonly quarantineRecords: QuarantineRecord[] = [];

  /**
   * Private by intent: construction is reachable only through `create()`, so the
   * gate cannot be bypassed by a caller who instantiates the class directly.
   */
  private constructor(config: KnowledgeConfig) {
    this.config = config;

    const selection = selectVectorStore(config);
    this.store = selection.store;

    // The factory evaluates its egress gate before any adapter exists, and returns
    // a refusing null-object adapter rather than throwing when a provider is not
    // authorised. The plane therefore degrades to level 1 without a null check at
    // every call site.
    this.embedder = createEmbeddingAdapter(config).adapter;

    this.degradation = selection.ok
      ? initialDegradation()
      : initialDegradation(selection.reason ?? 'STORE_UNCONFIGURED');

    // NO TIMER IS CREATED HERE, and none is created anywhere in this class.
    // R-Sentinel legitimately polls on an interval because its subject is a
    // changing host. This plane's subject is a corpus that changes only when
    // something ingests into it, so a background poller would add a process-level
    // side effect for no informational gain — and prohibition 5 forbids it in
    // disabled mode, which is easiest to guarantee by never having one at all.
  }

  /**
   * THE GATE. Returns `null` when the plane is not enabled.
   *
   * The order is decisive: the predicate is evaluated before `new`, before
   * configuration is resolved, and before any module with a side effect is
   * touched. A disabled plane therefore performs exactly one observable action —
   * a single debug line recording the gate decision — and nothing else.
   */
  static create(env: NodeJS.ProcessEnv = process.env): RKnowledgePlane | null {
    if (!isKnowledgeEnabled(env)) {
      // The single permitted log line. It records the DECISION and reads no
      // credential, resolves no path and touches no store configuration.
      logger.debug('R-Knowledge disabled (KNOWLEDGE_ENABLED is not "true") — plane not constructed');
      return null;
    }
    const config = resolveKnowledgeConfig(env as Record<string, string | undefined>);
    return new RKnowledgePlane(config);
  }

  async init(): Promise<void> {
    const opened = await this.store.open();
    const embedderInit = await this.embedder.init();

    this.degradation = computeDegradation({
      storeAvailable: opened.ok,
      storeWritable: opened.ok,
      storeCircuitOpen: false,
      embedderAvailable: embedderInit.ok,
      lastStoreErrorCode: opened.reason,
      lastEmbedderErrorCode: embedderInit.reason,
    });

    logger.info(
      `R-Knowledge initialised — store=${this.store.id} embedder=${this.embedder.provider} ` +
        `degradation=${this.degradation.level} (${this.degradation.name})`
    );
  }

  /** Idempotent. Releases the store handle; installs and removes no handler. */
  async shutdown(): Promise<void> {
    await this.store.close();
  }

  // ----------------------------------------------------------
  // Operations
  // ----------------------------------------------------------

  async ingestDocument(raw: unknown): Promise<IngestionResult> {
    this.requestsTotal += 1;
    await this.refreshDegradation();

    const result = await ingest(raw, {
      config: this.config,
      store: this.store,
      embedder: this.embedder,
      degradation: this.degradation,
      now: () => new Date(),
      onQuarantine: (record) => {
        this.quarantineEvents += 1;
        // Bounded retention: the quarantine list holds digests, and a cap prevents
        // it from becoming an unbounded in-memory accumulation under attack.
        if (this.quarantineRecords.length >= 1000) this.quarantineRecords.shift();
        this.quarantineRecords.push(record);
      },
    });

    if (result.ok && !result.duplicate) this.objectsIngested += result.objectIds.length;
    if (!result.ok) {
      this.objectsRefused += 1;
      this.errorsTotal += 1;
    }
    return result;
  }

  /**
   * Batch corpus ingestion (Stage D).
   *
   * Delegates to the corpus service, which loops over the SAME governed pipeline
   * used for a single document. No stage is skipped for batch input, because a
   * second ingestion law is how a corpus acquires documents that could never have
   * been admitted individually.
   */
  async ingestCorpusBatch(
    documents: CorpusDocument[],
    options: CorpusIngestionOptions = {}
  ): Promise<CorpusIngestionReport> {
    this.requestsTotal += 1;
    await this.refreshDegradation();

    const report = await ingestCorpus(
      documents,
      {
        config: this.config,
        store: this.store,
        embedder: this.embedder,
        degradation: this.degradation,
        now: () => new Date(),
        onQuarantine: (record) => {
          this.quarantineEvents += 1;
          if (this.quarantineRecords.length >= 1000) this.quarantineRecords.shift();
          this.quarantineRecords.push(record);
        },
      },
      options
    );

    this.objectsIngested += report.objectsWritten;
    this.objectsRefused += report.documentsRefused + report.documentsQuarantined;
    if (!report.ok) this.errorsTotal += 1;
    return report;
  }

  async query(raw: unknown): Promise<KnowledgeRetrievalResponse> {
    this.requestsTotal += 1;
    await this.refreshDegradation();

    const response = await retrieve(raw, {
      config: this.config,
      store: this.store,
      embedder: this.embedder,
      degradation: this.degradation,
      now: () => new Date(),
    });

    if (response.ok) this.queriesServed += 1;
    else this.errorsTotal += 1;
    return response;
  }

  async compose(request: RagRequest): Promise<RagComposition> {
    this.requestsTotal += 1;
    await this.refreshDegradation();

    const composition = await composeRag(request, {
      config: this.config,
      store: this.store,
      embedder: this.embedder,
      degradation: this.degradation,
      now: () => new Date(),
    });

    if (!composition.ok) this.errorsTotal += 1;
    return composition;
  }

  /**
   * Recompute degradation from current dependency health.
   *
   * Called at the start of each operation rather than on a timer, so recovery is
   * observed on the next request and no background work exists. This is what makes
   * every level reversible without a restart: there is no cached state to
   * invalidate.
   */
  private async refreshDegradation(): Promise<void> {
    const storeHealth = await this.store.health();
    const embedderHealth = await this.embedder.health();
    this.lastStoreHealth = storeHealth;

    const dependency: DependencyHealth = {
      storeAvailable: storeHealth.reachable,
      storeWritable: storeHealth.lastErrorCode !== 'STORE_WRITE_REFUSED',
      storeCircuitOpen: storeHealth.lastErrorCode === 'STORE_CIRCUIT_OPEN',
      embedderAvailable: embedderHealth.available,
      lastStoreErrorCode: storeHealth.lastErrorCode,
      lastEmbedderErrorCode: embedderHealth.lastErrorCode,
    };
    this.degradation = computeDegradation(dependency, this.degradation.since);
  }

  // ----------------------------------------------------------
  // Health and diagnostics
  // ----------------------------------------------------------

  /**
   * Plane health.
   *
   * Reports `degraded` rather than `offline` at levels 1 and 2, and `offline` at
   * level 3. The distinction matters to an operator: a degraded plane is serving
   * something, an offline one is serving nothing, and collapsing the two would
   * make the difference invisible on a dashboard.
   */
  async health(): Promise<PlaneHealth> {
    const started = Date.now();
    await this.refreshDegradation();
    return {
      planeId: 'r-knowledge',
      status:
        this.degradation.level === 0
          ? 'healthy'
          : this.degradation.level === 3
            ? 'offline'
            : 'degraded',
      latencyMs: Date.now() - started,
      requestsTotal: this.requestsTotal,
      errorsTotal: this.errorsTotal,
      lastChecked: new Date(),
    };
  }

  getDiagnostics(): KnowledgeDiagnostics {
    return {
      enabled: this.config.enabled,
      degradation: this.degradation,
      storeId: this.store.id,
      storeHealth: this.lastStoreHealth,
      embeddingProvider: this.embedder.id,
      embeddingHealth: null,
      objectsIngested: this.objectsIngested,
      objectsRefused: this.objectsRefused,
      queriesServed: this.queriesServed,
      quarantineEvents: this.quarantineEvents,
      egressEvents: this.egressEvents,
      requestsTotal: this.requestsTotal,
      errorsTotal: this.errorsTotal,
    };
  }

  getConfig(): KnowledgeConfig {
    return this.config;
  }

  getDegradation(): DegradationState {
    return this.degradation;
  }

  getStore(): VectorStore {
    return this.store;
  }

  /** Quarantine records held in memory. Digests only, never payloads. */
  getQuarantineRecords(): readonly QuarantineRecord[] {
    return this.quarantineRecords;
  }
}
