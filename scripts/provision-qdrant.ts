/**
 * RONOR — Qdrant Collection Provisioning
 * ───────────────────────────────────────
 * Creates the three collections required by RONOR v0.5.0 if they do not already
 * exist. Safe to re-run; existing collections are left untouched.
 *
 * Collections
 * ───────────
 *   ronor_memory    — operator memory entries (text-embedding-3-small, 1536d)
 *   ronor_knowledge — ingested documents for RAG (text-embedding-3-small, 1536d)
 *   ronor_missions  — mission objective embeddings (text-embedding-3-small, 1536d)
 *
 * All three use Cosine distance. The embedding model is text-embedding-3-small
 * (OpenAI), which produces 1536-dimensional vectors. The dimension and the
 * model must agree: a collection created at one width cannot accept vectors of
 * another, and the mismatch surfaces as a write failure long after ingestion
 * began.
 *
 * Usage
 * ─────
 *   ts-node scripts/provision-qdrant.ts
 *   node dist/scripts/provision-qdrant.js
 *
 * Prepared by AMB · Mayleven Ecosystem
 */

import 'dotenv/config';
import { QdrantClient } from '@qdrant/js-client-rest';
import { createLogger } from '../src/utils/logger';

const logger = createLogger('RONOR:Provision:Qdrant');

const EMBEDDING_DIM = 1536;  // text-embedding-3-small
const DISTANCE = 'Cosine' as const;

interface CollectionSpec {
  name: string;
  description: string;
}

const COLLECTIONS: CollectionSpec[] = [
  { name: 'ronor_memory',    description: 'Operator memory entries — recalled across sessions' },
  { name: 'ronor_knowledge', description: 'Ingested documents for RAG grounding' },
  { name: 'ronor_missions',  description: 'Mission objective embeddings for similarity search' },
];

async function provisionCollections(): Promise<void> {
  const endpoint = (
    process.env.KNOWLEDGE_QDRANT_ENDPOINT ??
    process.env.QDRANT_URL ??
    'http://127.0.0.1:6333'
  ).replace(/\/+$/, '');

  const apiKey = process.env.KNOWLEDGE_QDRANT_API_KEY ?? process.env.QDRANT_API_KEY ?? undefined;

  logger.info(`Connecting to Qdrant at ${endpoint} (key present: ${apiKey ? 'yes' : 'no'})`);

  const client = new QdrantClient({ url: endpoint, apiKey });

  // Verify connectivity before attempting any writes.
  try {
    const info = await client.api('cluster').clusterStatus();
    logger.info(`Qdrant reachable — status: ${JSON.stringify(info.data?.status ?? 'unknown')}`);
  } catch (err) {
    logger.error('Cannot reach Qdrant:', err);
    logger.error(
      'Ensure Qdrant is running and KNOWLEDGE_QDRANT_ENDPOINT is set correctly. ' +
        'In the compose deployment: docker compose -f docker-compose.production.yml up -d qdrant',
    );
    process.exit(1);
  }

  // List existing collections once to avoid per-collection round trips.
  const existing = new Set<string>();
  try {
    const list = await client.getCollections();
    for (const c of list.collections) existing.add(c.name);
    logger.info(`Existing collections: ${existing.size > 0 ? [...existing].join(', ') : '(none)'}`);
  } catch (err) {
    logger.error('Failed to list collections:', err);
    process.exit(1);
  }

  let created = 0;
  let skipped = 0;

  for (const spec of COLLECTIONS) {
    if (existing.has(spec.name)) {
      logger.info(`  ✓ ${spec.name} — already exists, skipping`);
      skipped++;
      continue;
    }

    logger.info(`  → creating ${spec.name} (${EMBEDDING_DIM}d, ${DISTANCE})`);
    try {
      await client.createCollection(spec.name, {
        vectors: {
          size: EMBEDDING_DIM,
          distance: DISTANCE,
          // HNSW index: ef_construct=128 balances index quality against build
          // time. A lower value builds faster but produces a sparser graph that
          // misses neighbours the query would have found.
          hnsw_config: {
            m: 16,
            ef_construct: 128,
          },
          // Quantisation disabled. The corpus is small and the latency budget
          // generous; quantisation trades recall for speed, and neither trade
          // is worth making here.
          quantization_config: null,
        },
        optimizers_config: {
          // Indexing threshold: 20 000 vectors. Below this the flat index is
          // faster than HNSW for a corpus this size.
          indexing_threshold: 20_000,
          // Memmap threshold: 50 000 vectors. Below this the collection lives
          // in RAM, which is appropriate for a corpus that fits in 2 GB.
          memmap_threshold: 50_000,
        },
        replication_factor: 1,  // single-node deployment
        write_consistency_factor: 1,
      });

      // Create a payload index on the fields the runtime filters by.
      await client.createPayloadIndex(spec.name, {
        field_name: 'source_uri',
        field_schema: 'keyword',
        wait: true,
      });
      await client.createPayloadIndex(spec.name, {
        field_name: 'classification',
        field_schema: 'keyword',
        wait: true,
      });
      await client.createPayloadIndex(spec.name, {
        field_name: 'created_at',
        field_schema: 'datetime',
        wait: true,
      });

      logger.info(`  ✓ ${spec.name} created with payload indexes`);
      created++;
    } catch (err) {
      logger.error(`  ✗ Failed to create ${spec.name}:`, err);
      process.exit(1);
    }
  }

  logger.info(
    `Qdrant provisioning complete: ${created} created, ${skipped} already existed, ` +
      `${COLLECTIONS.length} total`,
  );
}

void provisionCollections().catch((err) => {
  logger.error('Unhandled error:', err);
  process.exit(1);
});
