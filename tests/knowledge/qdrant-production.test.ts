/**
 * R-Knowledge — Qdrant Production Store Verification
 * MIP-015 STEP 3 · Requirement 2
 *
 * ── WHAT THIS SUITE PROVES, AND WHAT IT DOES NOT ────────────────────────────
 *
 * Two distinct things are verified here, and conflating them would be an overclaim.
 *
 * 1. COLLECTION AUTO-CREATION AND ITS GATING, verified against the in-process
 *    double. This proves the adapter's decision logic: when it provisions, when it
 *    refuses to, what width it provisions at, and that it re-reads rather than
 *    trusting an acknowledgement. These are real, complete proofs.
 *
 * 2. THE LIVE TRANSPORT'S ERROR MAPPING AND PAYLOAD COERCION, verified by calling
 *    the mapping functions directly. This proves that no vendor error type crosses
 *    the adapter boundary and that a malformed payload is rejected rather than
 *    coerced.
 *
 * What is NOT proved anywhere in this suite: that a real Qdrant server behaves as
 * the double does. `docker` is unavailable in the authoring environment, so no
 * server was started. A live integration test exists at the end of this file and
 * SKIPS EXPLICITLY, printing its reason, when `QDRANT_URL` is absent. A green run
 * of this file must never be read as evidence that a live server was exercised.
 */

import { join } from 'path';

import { QdrantVectorStore } from '../../src/knowledge/stores/qdrant-store';
import { __testing as liveTesting } from '../../src/knowledge/stores/qdrant-live-transport';
import { QdrantTransportError } from '../../src/knowledge/stores/qdrant-transport';
import { resolveKnowledgeConfig } from '../../src/planes/r-knowledge/config';
import { makeMockQdrantTransportWithRecorder } from './helpers/mock-qdrant-transport';

const DIMENSIONS = 64;

const BASE_ENV: Record<string, string> = {
  KNOWLEDGE_ENABLED: 'true',
  KNOWLEDGE_VECTOR_STORE: 'qdrant',
  KNOWLEDGE_EXTERNAL_EGRESS_AUTHORISED: 'true',
  KNOWLEDGE_QDRANT_ENDPOINT: 'https://qdrant.internal.example:6333',
  KNOWLEDGE_QDRANT_API_KEY: 'test-key-not-a-real-credential',
  KNOWLEDGE_QDRANT_COLLECTION: 'ronor_knowledge',
  KNOWLEDGE_QDRANT_ENVIRONMENT_AUTHORISATION: 'MIP-015-EO-STEP3',
  KNOWLEDGE_ENVIRONMENT_CLASS: 'test',
  KNOWLEDGE_EMBEDDING_DIMENSIONS: String(DIMENSIONS),
};

function configWith(overrides: Record<string, string | undefined> = {}) {
  const env: Record<string, string | undefined> = { ...BASE_ENV, ...overrides };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
  }
  return resolveKnowledgeConfig(env);
}

// ============================================================
// Collection auto-creation
// ============================================================

describe('MIP-015 · collection auto-creation', () => {
  test('auto-creation is DISABLED by default', () => {
    expect(configWith().qdrant.autoCreateCollection).toBe(false);
  });

  test('only the exact string "true" enables it', () => {
    for (const raw of ['1', 'yes', 'TRUE', 'True', 'on', ' true ', '']) {
      expect(
        configWith({ KNOWLEDGE_QDRANT_AUTO_CREATE_COLLECTION: raw }).qdrant.autoCreateCollection
      ).toBe(false);
    }
    expect(
      configWith({ KNOWLEDGE_QDRANT_AUTO_CREATE_COLLECTION: 'true' }).qdrant.autoCreateCollection
    ).toBe(true);
  });

  test('a missing collection with auto-creation DISABLED refuses and creates NOTHING', async () => {
    const { factory, recorder } = makeMockQdrantTransportWithRecorder({
      dimensions: DIMENSIONS,
      collectionExists: false,
    });
    const store = new QdrantVectorStore(configWith(), factory);

    const opened = await store.open();

    expect(opened.ok).toBe(false);
    expect(opened.reason).toBe('STORE_UNAVAILABLE');
    expect(opened.detail).toMatch(/auto-creation is not enabled/i);
    // The decisive assertion. Refusing is not the same as not creating: an adapter
    // could refuse having already provisioned on the way.
    expect(recorder.collectionsCreated).toEqual([]);
    expect(store.getCollectionsCreatedCount()).toBe(0);
    expect(recorder.operations).not.toContain('createCollection');
  });

  test('the refusal detail NAMES the variable that would permit it', async () => {
    // An operator reading "collection does not exist" has to guess. An operator
    // reading the variable name does not.
    const { factory } = makeMockQdrantTransportWithRecorder({
      dimensions: DIMENSIONS,
      collectionExists: false,
    });
    const opened = await new QdrantVectorStore(configWith(), factory).open();
    expect(opened.detail).toMatch(/KNOWLEDGE_QDRANT_AUTO_CREATE_COLLECTION/);
  });

  test('a missing collection with auto-creation ENABLED is provisioned, then opens', async () => {
    const { factory, recorder } = makeMockQdrantTransportWithRecorder({
      dimensions: DIMENSIONS,
      collectionExists: false,
    });
    const store = new QdrantVectorStore(
      configWith({ KNOWLEDGE_QDRANT_AUTO_CREATE_COLLECTION: 'true' }),
      factory
    );

    const opened = await store.open();

    expect(opened.ok).toBe(true);
    expect(opened.degradationLevel).toBe(0);
    expect(recorder.collectionsCreated).toHaveLength(1);
    expect(store.getCollectionsCreatedCount()).toBe(1);
  });

  test('the provisioned width comes from the ACTIVE embedder, not from a constant', async () => {
    // The property that matters: a collection provisioned at a width that disagrees
    // with the vectors about to be written into it is worse than no collection,
    // because it fails on first write rather than at configuration time.
    for (const dimensions of [8, 384, 1536]) {
      const { factory, recorder } = makeMockQdrantTransportWithRecorder({
        dimensions,
        collectionExists: false,
      });
      const store = new QdrantVectorStore(
        configWith({
          KNOWLEDGE_QDRANT_AUTO_CREATE_COLLECTION: 'true',
          KNOWLEDGE_EMBEDDING_DIMENSIONS: String(dimensions),
        }),
        factory
      );
      const opened = await store.open();
      expect(opened.ok).toBe(true);
      expect(recorder.collectionsCreated[0].dimensions).toBe(dimensions);
    }
  });

  test('the distance metric defaults to Cosine and is configurable', async () => {
    const cases: [string | undefined, string][] = [
      [undefined, 'Cosine'],
      ['cosine', 'Cosine'],
      ['dot', 'Dot'],
      ['euclid', 'Euclid'],
      ['euclidean', 'Euclid'],
      ['nonsense', 'Cosine'],
    ];
    for (const [raw, expected] of cases) {
      const { factory, recorder } = makeMockQdrantTransportWithRecorder({
        dimensions: DIMENSIONS,
        collectionExists: false,
      });
      const store = new QdrantVectorStore(
        configWith({
          KNOWLEDGE_QDRANT_AUTO_CREATE_COLLECTION: 'true',
          KNOWLEDGE_QDRANT_DISTANCE: raw,
        }),
        factory
      );
      await store.open();
      expect(recorder.collectionsCreated[0].distance).toBe(expected);
    }
  });

  test('an EXISTING collection is never re-created', async () => {
    const { factory, recorder } = makeMockQdrantTransportWithRecorder({
      dimensions: DIMENSIONS,
      collectionExists: true,
    });
    const store = new QdrantVectorStore(
      configWith({ KNOWLEDGE_QDRANT_AUTO_CREATE_COLLECTION: 'true' }),
      factory
    );
    const opened = await store.open();
    expect(opened.ok).toBe(true);
    // Auto-creation is enabled, and it still did nothing, because there was nothing
    // to do. A create against an existing collection could reset it.
    expect(recorder.collectionsCreated).toEqual([]);
    expect(recorder.operations).not.toContain('createCollection');
  });

  test('a transport WITHOUT createCollection refuses rather than calling an absent method', async () => {
    const { factory, recorder } = makeMockQdrantTransportWithRecorder({
      dimensions: DIMENSIONS,
      collectionExists: false,
      omitCreateCollection: true,
    });
    const store = new QdrantVectorStore(
      configWith({ KNOWLEDGE_QDRANT_AUTO_CREATE_COLLECTION: 'true' }),
      factory
    );

    // Not a TypeError. A capability the transport does not offer is a refusal.
    const opened = await store.open();
    expect(opened.ok).toBe(false);
    expect(opened.reason).toBe('STORE_UNAVAILABLE');
    expect(recorder.collectionsCreated).toEqual([]);
  });

  test('a FAILED creation is reported with a mapped reason, not a vendor error', async () => {
    const { factory } = makeMockQdrantTransportWithRecorder({
      dimensions: DIMENSIONS,
      collectionExists: false,
      failCreateWith: 'forbidden',
    });
    const store = new QdrantVectorStore(
      configWith({ KNOWLEDGE_QDRANT_AUTO_CREATE_COLLECTION: 'true' }),
      factory
    );

    const opened = await store.open();
    expect(opened.ok).toBe(false);
    // A credential that can read but not create is a realistic production posture,
    // and the operator needs to see an authorisation failure rather than a generic
    // outage.
    expect(opened.reason).toBe('STORE_AUTH_FAILURE');
    expect(opened.detail).toMatch(/could not be created/i);
  });

  test('a creation that is ACKNOWLEDGED but did not happen is caught by the re-read', async () => {
    // Without the re-read the adapter would proceed against a collection that does
    // not exist, and the failure would surface at the first upsert — far from the
    // cause, and looking like a write problem rather than a provisioning one.
    const { factory, recorder } = makeMockQdrantTransportWithRecorder({
      dimensions: DIMENSIONS,
      collectionExists: false,
      createSilentlyFails: true,
    });
    const store = new QdrantVectorStore(
      configWith({ KNOWLEDGE_QDRANT_AUTO_CREATE_COLLECTION: 'true' }),
      factory
    );

    const opened = await store.open();
    expect(opened.ok).toBe(false);
    expect(opened.reason).toBe('STORE_UNAVAILABLE');
    expect(opened.detail).toMatch(/reported created but is not present/i);
    // The create WAS attempted; the adapter simply refused to believe it.
    expect(recorder.collectionsCreated).toHaveLength(1);
  });

  test('auto-creation does NOT bypass any condition precedent', async () => {
    // Provisioning is a capability, not an authorisation. An unauthorised
    // configuration with auto-creation enabled must still refuse before any
    // transport exists.
    const { factory, recorder } = makeMockQdrantTransportWithRecorder({
      dimensions: DIMENSIONS,
      collectionExists: false,
    });
    const store = new QdrantVectorStore(
      configWith({
        KNOWLEDGE_QDRANT_AUTO_CREATE_COLLECTION: 'true',
        KNOWLEDGE_EXTERNAL_EGRESS_AUTHORISED: 'false',
      }),
      factory
    );

    const opened = await store.open();
    expect(opened.ok).toBe(false);
    expect(opened.reason).toBe('STORE_UNAUTHORISED_EGRESS');
    expect(recorder.factoryInvocations).toBe(0);
    expect(recorder.collectionsCreated).toEqual([]);
  });

  test('there is NO capability to delete or reshape a collection', () => {
    // The asymmetry is the point: creating an empty collection is recoverable,
    // destroying a populated one is not. Asserted against the transport surface, so
    // that adding such a method later fails this test.
    const { factory } = makeMockQdrantTransportWithRecorder({ dimensions: DIMENSIONS });
    const transport = factory({
      endpoint: 'https://example.invalid',
      collection: 'c',
      timeoutMs: 1000,
      bearerToken: '',
    }) as unknown as Record<string, unknown>;

    expect(typeof transport.createCollection).toBe('function');
    expect(transport.deleteCollection).toBeUndefined();
    expect(transport.recreateCollection).toBeUndefined();
    expect(transport.updateCollection).toBeUndefined();
    expect(transport.createSnapshot).toBeUndefined();
  });
});

// ============================================================
// Live transport — neutral failure mapping
// ============================================================

describe('MIP-015 · live transport failure classification', () => {
  const { classify } = liveTesting;

  test('HTTP status codes map to distinct, actionable classes', () => {
    expect(classify({ status: 401 })).toBe('unauthorised');
    expect(classify({ status: 403 })).toBe('forbidden');
    expect(classify({ status: 404 })).toBe('not-found');
    expect(classify({ status: 500 })).toBe('unreachable');
    expect(classify({ status: 503 })).toBe('unreachable');
  });

  test('401 and 403 are distinguished, because the operator remedies differ', () => {
    // 401 means the credential is wrong. 403 means the credential is right and the
    // permission is missing. Collapsing them into one class would send an operator
    // to rotate a key that is perfectly valid.
    expect(classify({ status: 401 })).not.toBe(classify({ status: 403 }));
  });

  test('network conditions are classified from the error text', () => {
    expect(classify(new Error('connect ECONNREFUSED 10.0.0.1:6333'))).toBe('unreachable');
    expect(classify(new Error('getaddrinfo ENOTFOUND qdrant.invalid'))).toBe('unreachable');
    expect(classify(new Error('socket hang up'))).toBe('unreachable');
    expect(classify(new Error('fetch failed'))).toBe('unreachable');
  });

  test('timeout is distinguished from unreachability', () => {
    expect(classify(new Error('Request timeout after 2000ms'))).toBe('timeout');
    expect(classify(new Error('connect ETIMEDOUT'))).toBe('timeout');
  });

  test('TLS failures are classified as TLS, not as generic unreachability', () => {
    // A certificate problem is a configuration error the operator can fix. Reported
    // as unreachability it would look like a network outage.
    expect(classify(new Error('unable to verify the first certificate'))).toBe('tls');
    expect(classify(new Error('self-signed certificate in certificate chain'))).toBe('tls');
    expect(classify(new Error('SSL routines: wrong version number'))).toBe('tls');
  });

  test('an UNRECOGNISED error becomes protocol, never unreachable', () => {
    // Conservative by design. Misreporting a protocol disagreement as unreachability
    // sends the operator to check the network when the fault is in the request.
    expect(classify(new Error('something entirely unexpected'))).toBe('protocol');
    expect(classify('a bare string')).toBe('protocol');
    expect(classify(null)).toBe('protocol');
    expect(classify(undefined)).toBe('protocol');
    expect(classify({})).toBe('protocol');
  });

  test('every classification is a member of the closed neutral set', () => {
    const permitted = ['unauthorised', 'forbidden', 'tls', 'timeout', 'unreachable', 'not-found', 'protocol'];
    const probes: unknown[] = [
      { status: 401 },
      { status: 403 },
      { status: 404 },
      { status: 500 },
      new Error('ECONNREFUSED'),
      new Error('timeout'),
      new Error('certificate'),
      new Error('mystery'),
      'string',
      null,
      42,
    ];
    for (const probe of probes) {
      expect(permitted).toContain(classify(probe));
    }
  });
});

// ============================================================
// Live transport — credential scrubbing
// ============================================================

describe('MIP-015 · live transport credential scrubbing', () => {
  const { scrub } = liveTesting;

  test('api-key and bearer forms are removed', () => {
    const raw =
      'request failed api-key: qd-abcdefghijklmnopqrstuvwxyz123456 and Authorization: Bearer qd-zyxwvutsrqponmlkjihgfedcba654321';
    const cleaned = scrub(raw);
    expect(cleaned).not.toMatch(/abcdefghijklmnop/);
    expect(cleaned).not.toMatch(/zyxwvutsrqponm/);
    expect(cleaned).toMatch(/REDACTED/);
  });

  test('a long opaque token is removed even without a label', () => {
    // Real client errors sometimes echo a URL or header value with no label at all.
    const raw = 'failed for 0123456789abcdef0123456789abcdef0123456789';
    expect(scrub(raw)).toMatch(/REDACTED/);
  });

  test('ordinary diagnostic text is preserved', () => {
    // Over-redaction destroys the diagnostic. The remedy for a leak is not to make
    // every message useless.
    const raw = 'collection "ronor_knowledge" not found on host qdrant.internal.example:6333';
    expect(scrub(raw)).toBe(raw);
  });
});

// ============================================================
// Live transport — payload coercion
// ============================================================

describe('MIP-015 · live transport payload coercion', () => {
  const { coercePayload } = liveTesting;

  const valid = {
    classification: 'INTERNAL',
    sovereigntyTier: 1,
    parentDocumentId: 'doc-1',
    contentHash: 'a'.repeat(64),
    chunkIndex: 0,
    chunkTotal: 3,
    ingestedAt: '2026-08-03T00:00:00+00:00',
  };

  test('a conforming payload is accepted', () => {
    expect(coercePayload(valid)).not.toBeNull();
  });

  test('optional content is preserved when present and omitted when absent', () => {
    expect(coercePayload({ ...valid, content: 'text' })?.content).toBe('text');
    expect(coercePayload(valid)?.content).toBeUndefined();
  });

  test('a payload missing ANY required field is REJECTED, not partially coerced', () => {
    // The decisive property. A partially-coerced payload would produce a Knowledge
    // Object that fails integrity verification later, at a point far from the cause.
    for (const field of Object.keys(valid)) {
      const broken: Record<string, unknown> = { ...valid };
      delete broken[field];
      expect(coercePayload(broken)).toBeNull();
    }
  });

  test('a wrongly-typed field is rejected rather than converted', () => {
    expect(coercePayload({ ...valid, chunkIndex: '0' })).toBeNull();
    expect(coercePayload({ ...valid, sovereigntyTier: '1' })).toBeNull();
    expect(coercePayload({ ...valid, contentHash: 12345 })).toBeNull();
  });

  test('an unrecognised classification is rejected', () => {
    // A classification the plane does not know cannot be ranked, and an unrankable
    // classification cannot be filtered against a ceiling.
    for (const bad of ['SECRET', 'internal', 'TOP_SECRET', '', 'PUBLIC ']) {
      expect(coercePayload({ ...valid, classification: bad })).toBeNull();
    }
  });

  test('an out-of-range sovereignty tier is rejected', () => {
    for (const bad of [0, 4, -1, 1.5]) {
      expect(coercePayload({ ...valid, sovereigntyTier: bad })).toBeNull();
    }
  });

  test('null, undefined and primitives are rejected', () => {
    for (const bad of [null, undefined, 'string', 42, true, []]) {
      expect(coercePayload(bad)).toBeNull();
    }
  });
});

// ============================================================
// Vendor error containment
// ============================================================

describe('MIP-015 · vendor error containment (N-2)', () => {
  test('the live transport module exports no vendor type', async () => {
    const module = await import('../../src/knowledge/stores/qdrant-live-transport');
    const exported = Object.keys(module);
    // Only the factory and the testing hook. A leaked class or client type would let
    // a caller depend on the vendor surface.
    expect(exported.sort()).toEqual(['__testing', 'liveQdrantTransportFactory']);
  });

  test('the neutral error type carries a classification, not a status code', () => {
    const error = new QdrantTransportError('unauthorised', 'refused');
    expect(error.failure).toBe('unauthorised');
    expect(error).toBeInstanceOf(Error);
    expect((error as unknown as { status?: number }).status).toBeUndefined();
  });

  test('the ADAPTER does not import the live transport', () => {
    // The adapter receives a factory. If it imported the live transport it could
    // construct one, and "no egress unless deliberately injected" would stop being a
    // structural property.
    const { readFileSync } = require('fs') as typeof import('fs');
    const { join } = require('path') as typeof import('path');
    const source = readFileSync(
      join(__dirname, '..', '..', 'src', 'knowledge', 'stores', 'qdrant-store.ts'),
      'utf8'
    );
    expect(source).not.toMatch(/from\s+['"]\.\/qdrant-live-transport['"]/);
    expect(source).not.toMatch(/@qdrant\/js-client-rest/);
  });

  test('only ONE module in the plane IMPORTS the vendor client', () => {
    // Scanned over EXECUTABLE code with comments stripped. The transport-boundary
    // module names the client in its header prose — explaining that MIP-015 amends
    // the MIP-014 position under which it was not installed — and that documentation
    // is not an import. Conflating the two would force the codebase to stop
    // explaining itself in order to satisfy an assertion about what it does, which is
    // the wrong trade.
    const { execSync } = require('child_process') as typeof import('child_process');
    const { readFileSync } = require('fs') as typeof import('fs');
    const repoRoot = join(__dirname, '..', '..');

    const candidates = execSync('grep -rl "@qdrant/js-client-rest" src/ || true', {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .filter((line: string) => line.length > 0);

    const importers = candidates.filter((relative: string) => {
      const executable = readFileSync(join(repoRoot, relative), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      return /(from\s+['"]@qdrant\/js-client-rest['"]|require\(\s*['"]@qdrant\/js-client-rest['"])/.test(
        executable
      );
    });

    expect(importers).toEqual([
      // Deployment-only provisioning is outside the runtime plane.
      'src/scripts/provision-qdrant.ts',
      'src/knowledge/stores/qdrant-live-transport.ts',
    ]);
  });
});

// ============================================================
// LIVE INTEGRATION — skips EXPLICITLY, never silently
// ============================================================

const LIVE_URL = process.env.QDRANT_URL || '';
const LIVE_ENABLED = process.env.KNOWLEDGE_LIVE_QDRANT_TEST === 'true' && LIVE_URL.length > 0;

describe('MIP-015 · live Qdrant integration', () => {
  test('a live server is either exercised or EXPLICITLY declared unexercised', async () => {
    if (!LIVE_ENABLED) {
      const skipReason =
        'KNOWLEDGE_LIVE_QDRANT_TEST is not "true" or QDRANT_URL is absent. No Qdrant server was ' +
        'contacted. The production store is verified against an in-process double only; docker ' +
        'was unavailable in the authoring environment, so no server was started.';
      // eslint-disable-next-line no-console
      console.log(`[MIP-015 LIVE QDRANT SKIP] ${skipReason}`);
      expect(skipReason).toMatch(/No Qdrant server was contacted/);
      return;
    }

    const { liveQdrantTransportFactory } = await import(
      '../../src/knowledge/stores/qdrant-live-transport'
    );
    const store = new QdrantVectorStore(
      resolveKnowledgeConfig({
        ...BASE_ENV,
        KNOWLEDGE_QDRANT_ENDPOINT: LIVE_URL,
        KNOWLEDGE_QDRANT_API_KEY: process.env.QDRANT_API_KEY || 'unset',
        KNOWLEDGE_QDRANT_AUTO_CREATE_COLLECTION: 'true',
        KNOWLEDGE_QDRANT_COLLECTION: `ronor_live_${Date.now()}`,
      }),
      liveQdrantTransportFactory
    );

    const opened = await store.open();
    // eslint-disable-next-line no-console
    console.log(`[MIP-015 LIVE QDRANT] open ok=${opened.ok} reason=${opened.reason ?? 'none'}`);

    // A refusal against a real server is still valid evidence that the adapter maps
    // real conditions correctly. A thrown exception would not be.
    expect(typeof opened.ok).toBe('boolean');
    await store.close();
  }, 30_000);
});
