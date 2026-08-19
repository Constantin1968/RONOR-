-- ============================================================================
-- RONOR v0.5.0 — Supabase schema migration
-- Project: mrmauhtdmmyaxrxfsqsn
-- Schema: ronor
-- ----------------------------------------------------------------------------
-- Idempotent: safe to re-run against an already-migrated database.
-- Every table uses CREATE TABLE IF NOT EXISTS; every index uses
-- CREATE INDEX IF NOT EXISTS.
--
-- Prepared by AMB · Mayleven Ecosystem
-- ============================================================================

-- Create the schema if it does not exist.
CREATE SCHEMA IF NOT EXISTS ronor;

-- Set the search path for this session so unqualified names resolve correctly.
SET search_path TO ronor, public;

-- Enable the pgcrypto extension for gen_random_uuid() if not already present.
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

-- ============================================================================
-- conversations
-- ----------------------------------------------------------------------------
-- One row per operator session. A session is a coherent exchange with a single
-- user over a single channel (Telegram, API, console). It is the unit of
-- context for memory retrieval: entries scoped to a session are preferred over
-- entries scoped only to a user.
-- ============================================================================
CREATE TABLE IF NOT EXISTS ronor.conversations (
    id              UUID        PRIMARY KEY DEFAULT public.gen_random_uuid(),
    session_id      TEXT        NOT NULL UNIQUE,
    user_id         TEXT,
    channel         TEXT        NOT NULL DEFAULT 'api',
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_active_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    message_count   INTEGER     NOT NULL DEFAULT 0,
    metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT conversations_channel_check CHECK (channel IN ('telegram', 'api', 'console', 'webhook'))
);

CREATE INDEX IF NOT EXISTS conversations_user_id_idx   ON ronor.conversations (user_id);
CREATE INDEX IF NOT EXISTS conversations_channel_idx   ON ronor.conversations (channel);
CREATE INDEX IF NOT EXISTS conversations_last_active_idx ON ronor.conversations (last_active_at DESC);

COMMENT ON TABLE ronor.conversations IS
    'One row per operator session. The unit of context for memory retrieval.';

-- ============================================================================
-- memory_entries
-- ----------------------------------------------------------------------------
-- Durable facts, preferences, instructions and events that the runtime should
-- recall across sessions. Entries are retrieved by user id, session id, kind
-- or embedding similarity (the embedding_id references a Qdrant point).
-- ============================================================================
CREATE TABLE IF NOT EXISTS ronor.memory_entries (
    id              UUID        PRIMARY KEY DEFAULT public.gen_random_uuid(),
    session_id      TEXT        REFERENCES ronor.conversations (session_id) ON DELETE SET NULL,
    user_id         TEXT,
    kind            TEXT        NOT NULL DEFAULT 'fact',
    content         TEXT        NOT NULL,
    source          TEXT        NOT NULL DEFAULT 'operator',
    confidence      FLOAT       NOT NULL DEFAULT 1.0
                                CHECK (confidence >= 0.0 AND confidence <= 1.0),
    embedding_id    TEXT,       -- Qdrant point id in the ronor_memory collection
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ,
    metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT memory_entries_kind_check CHECK (
        kind IN ('fact', 'preference', 'context', 'instruction', 'event')
    )
);

CREATE INDEX IF NOT EXISTS memory_entries_user_id_idx    ON ronor.memory_entries (user_id);
CREATE INDEX IF NOT EXISTS memory_entries_session_id_idx ON ronor.memory_entries (session_id);
CREATE INDEX IF NOT EXISTS memory_entries_kind_idx       ON ronor.memory_entries (kind);
CREATE INDEX IF NOT EXISTS memory_entries_created_at_idx ON ronor.memory_entries (created_at DESC);
CREATE INDEX IF NOT EXISTS memory_entries_expires_at_idx ON ronor.memory_entries (expires_at)
    WHERE expires_at IS NOT NULL;

COMMENT ON TABLE ronor.memory_entries IS
    'Durable facts, preferences and instructions recalled across sessions.';
COMMENT ON COLUMN ronor.memory_entries.embedding_id IS
    'Qdrant point id in the ronor_memory collection. NULL until the entry is embedded.';

-- ============================================================================
-- agent_state
-- ----------------------------------------------------------------------------
-- Per-agent persistent state. One row per agent_id; upserted on every state
-- change. The state_json column holds the agent's working memory between tasks
-- in a multi-step mission.
-- ============================================================================
CREATE TABLE IF NOT EXISTS ronor.agent_state (
    agent_id                TEXT        PRIMARY KEY,
    mission_id              TEXT,
    status                  TEXT        NOT NULL DEFAULT 'idle',
    last_task_id            TEXT,
    cost_usd_accumulated    FLOAT       NOT NULL DEFAULT 0.0,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    state_json              JSONB       NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT agent_state_status_check CHECK (
        status IN ('idle', 'planning', 'executing', 'waiting', 'complete', 'failed')
    )
);

CREATE INDEX IF NOT EXISTS agent_state_mission_id_idx ON ronor.agent_state (mission_id)
    WHERE mission_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_state_status_idx     ON ronor.agent_state (status);

COMMENT ON TABLE ronor.agent_state IS
    'Per-agent persistent working state. One row per agent; upserted on every change.';

-- ============================================================================
-- missions
-- ----------------------------------------------------------------------------
-- Durable mission records. The runtime's in-process SQLite store is the
-- authoritative live state; this table is the durable replica that survives
-- a container restart. Upserted on every status transition.
-- ============================================================================
CREATE TABLE IF NOT EXISTS ronor.missions (
    mission_id      TEXT        PRIMARY KEY,
    title           TEXT        NOT NULL,
    objective       TEXT        NOT NULL,
    status          TEXT        NOT NULL DEFAULT 'open',
    operator_id     TEXT,
    cost_usd        FLOAT       NOT NULL DEFAULT 0.0,
    requests_count  INTEGER     NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    state_json      JSONB       NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT missions_status_check CHECK (
        status IN ('open', 'executing', 'complete', 'failed', 'abandoned')
    )
);

CREATE INDEX IF NOT EXISTS missions_operator_id_idx ON ronor.missions (operator_id)
    WHERE operator_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS missions_status_idx      ON ronor.missions (status);
CREATE INDEX IF NOT EXISTS missions_created_at_idx  ON ronor.missions (created_at DESC);

COMMENT ON TABLE ronor.missions IS
    'Durable mission records. Upserted on every status transition.';

-- ============================================================================
-- audit_events
-- ----------------------------------------------------------------------------
-- Structured audit log for every governed request, mission dispatch and
-- co-sign decision. This is the Supabase-side complement to the SQLite audit
-- chain: the chain provides tamper-evidence; this table provides queryability.
--
-- The two are reconciled by audit_chain_hash: a row here whose hash does not
-- appear in the chain is an event that was recorded but not chained, which is
-- a finding worth investigating.
-- ============================================================================
CREATE TABLE IF NOT EXISTS ronor.audit_events (
    id                      UUID        PRIMARY KEY DEFAULT public.gen_random_uuid(),
    event_type              TEXT        NOT NULL,
    request_id              TEXT,
    mission_id              TEXT,
    user_id                 TEXT,
    channel                 TEXT,
    verdict                 TEXT,
    human_cosign_required   BOOLEAN     NOT NULL DEFAULT false,
    cost_usd                FLOAT,
    latency_ms              INTEGER,
    model_id                TEXT,
    audit_chain_hash        TEXT,       -- SHA-256 from the SQLite chain
    occurred_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    payload_json            JSONB       NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT audit_events_event_type_check CHECK (
        event_type IN (
            'query', 'mission_dispatch', 'cosign_requested', 'cosign_approved',
            'cosign_rejected', 'cosign_expired', 'governance_block',
            'knowledge_ingest', 'agent_dispatch', 'system_boot', 'system_shutdown'
        )
    )
);

CREATE INDEX IF NOT EXISTS audit_events_request_id_idx   ON ronor.audit_events (request_id)
    WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_events_mission_id_idx   ON ronor.audit_events (mission_id)
    WHERE mission_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_events_user_id_idx      ON ronor.audit_events (user_id)
    WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_events_event_type_idx   ON ronor.audit_events (event_type);
CREATE INDEX IF NOT EXISTS audit_events_occurred_at_idx  ON ronor.audit_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_chain_hash_idx   ON ronor.audit_events (audit_chain_hash)
    WHERE audit_chain_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_events_cosign_idx       ON ronor.audit_events (human_cosign_required)
    WHERE human_cosign_required = true;

COMMENT ON TABLE ronor.audit_events IS
    'Structured audit log. Complements the SQLite chain with queryability.';
COMMENT ON COLUMN ronor.audit_events.audit_chain_hash IS
    'SHA-256 from the runtime SQLite audit chain. Reconciliation key.';

-- ============================================================================
-- Row-level security
-- ----------------------------------------------------------------------------
-- The service role key bypasses RLS, so these policies apply only to
-- authenticated (anon/user) roles. The runtime uses the service role key and
-- is therefore unrestricted. The policies prevent a future anon-key leak from
-- exposing the entire audit log.
-- ============================================================================
ALTER TABLE ronor.conversations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ronor.memory_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE ronor.agent_state    ENABLE ROW LEVEL SECURITY;
ALTER TABLE ronor.missions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE ronor.audit_events   ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS by default in Supabase; no explicit policy needed.
-- The following policies ensure that no other role can read or write these tables
-- without an explicit grant.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'ronor' AND tablename = 'conversations' AND policyname = 'service_role_all'
  ) THEN
    CREATE POLICY service_role_all ON ronor.conversations TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

-- ============================================================================
-- Schema version marker
-- ============================================================================
CREATE TABLE IF NOT EXISTS ronor.schema_migrations (
    version     TEXT        PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    description TEXT
);

INSERT INTO ronor.schema_migrations (version, description)
VALUES ('001', 'Initial RONOR v0.5.0 schema: conversations, memory_entries, agent_state, missions, audit_events')
ON CONFLICT (version) DO NOTHING;

-- ============================================================================
-- Summary
-- ============================================================================
DO $$
DECLARE
  tbl TEXT;
  cnt INTEGER;
BEGIN
  RAISE NOTICE '=== RONOR schema migration 001 complete ===';
  FOR tbl IN SELECT tablename FROM pg_tables WHERE schemaname = 'ronor' ORDER BY tablename LOOP
    EXECUTE format('SELECT count(*) FROM ronor.%I', tbl) INTO cnt;
    RAISE NOTICE '  table ronor.% — % rows', tbl, cnt;
  END LOOP;
END $$;
