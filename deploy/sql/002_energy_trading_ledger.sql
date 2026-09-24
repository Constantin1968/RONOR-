-- ============================================================================
-- RONOR — Energy Trading Optimization Ledger
-- ----------------------------------------------------------------------------
-- Proof-of-Optimization ledger for the crossborder Energy Trading Arm.
-- Every trade request, approval, rejection, execution, and outcome is recorded
-- as an append-only, HMAC-signed row. The ledger is the commercial evidence
-- artefact NrgPaths presents to Encon inside the ENCON JV pilot: it is what
-- turns "we help you trade better" into "here are the trades, the reasoning,
-- and the uplift, all signed".
--
-- Design commitments
-- ------------------
--   · APPEND-ONLY. No UPDATE, no DELETE. Every state change is a NEW row.
--     A ticket's current status is derived from MAX(created_at) per ticket_id.
--   · HMAC-SIGNED PER ROW. Every row carries an HMAC-SHA256 signature over
--     its own canonical payload, keyed by TRADING_LEDGER_HMAC_KEY. Tampering
--     with a row breaks its signature and is detectable by verify_row().
--   · KEY-VERSIONED. The signing key can be rotated without invalidating old
--     rows: each row records the key id it was signed with (`hmac_key_id`)
--     and verifiers select the right key by id.
--   · JURISDICTION-CLEAN. No personal data beyond the operator's display name.
--     Telegram user ids are not stored here to keep the artefact shareable
--     under GDPR/CCPA when NrgPaths reports to Encon.
--
-- Prepared by AMB · Mayleven Ecosystem
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS ronor;
SET search_path TO ronor, public;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

-- ============================================================================
-- optimization_ledger
-- ----------------------------------------------------------------------------
-- One row per state change of a trade ticket. A single ticket typically has
-- three rows: `requested` (trainer submits), `approved` or `rejected`
-- (sovereign settles), `executed` or `cancelled` (arm reports outcome).
-- ============================================================================
CREATE TABLE IF NOT EXISTS ronor.optimization_ledger (
    -- Primary identity of the row itself.
    id                UUID        NOT NULL DEFAULT gen_random_uuid(),
    -- Ticket id as issued by the trading arm. Not unique here — a ticket has
    -- multiple rows across its lifecycle. Together with `sequence_in_ticket`
    -- it uniquely identifies a state transition.
    ticket_id         TEXT        NOT NULL,
    sequence_in_ticket INTEGER    NOT NULL,
    -- The state this row records. Enumerated in check constraint below so that
    -- an unrecognised value is refused at write time rather than surfacing in
    -- a report months later.
    state             TEXT        NOT NULL,
    -- Corridor spec at the time of writing. Kept as free text so the arm can
    -- evolve corridor naming without a schema migration.
    corridor          TEXT        NOT NULL,
    delivery_day      DATE        NOT NULL,
    delivery_hour     SMALLINT    NOT NULL,
    volume_mw         NUMERIC(10, 3) NOT NULL,
    side              TEXT        NOT NULL,
    price_ceiling_eur NUMERIC(10, 3),
    -- Actor identifiers. `requested_by` is the trainer/sovereign who initiated
    -- the ticket; `settled_by` is the sovereign co-signer (NULL for the
    -- `requested` row).
    requested_by      TEXT        NOT NULL,
    settled_by        TEXT,
    notes             TEXT,
    -- Estimated uplift vs a baseline (best-alternative-corridor). The arm
    -- computes this and the ledger stores it verbatim so audit does not depend
    -- on the arm re-computing it later against a corpus that may have moved.
    estimated_uplift_eur NUMERIC(12, 2),
    baseline_ref      TEXT,
    -- Full arm brief as stored at the time of the state change. It is what a
    -- reviewer reads to understand why the arm believed this trade was the
    -- right one; and, because it is on the same signed row, it cannot be
    -- silently edited after the fact.
    arm_brief         TEXT,
    arm_evidence      JSONB       NOT NULL DEFAULT '{}'::jsonb,
    -- Signature integrity fields. See sign_row() and verify_row() below.
    hmac_key_id       TEXT        NOT NULL,
    hmac_signature    TEXT        NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (id),
    UNIQUE (ticket_id, sequence_in_ticket),
    CHECK (state IN ('requested', 'approved', 'rejected', 'executed', 'cancelled', 'expired')),
    CHECK (side IN ('export', 'import')),
    CHECK (delivery_hour BETWEEN 0 AND 23),
    CHECK (sequence_in_ticket >= 0),
    CHECK (volume_mw > 0)
);

-- Query patterns:
--   1. "Show me the current status of every ticket" → distinct on ticket_id,
--      ordered by sequence DESC.
--   2. "Show all trades for a delivery day" → filter delivery_day.
--   3. "Who has been most active this week" → filter created_at + group by
--      requested_by.
CREATE INDEX IF NOT EXISTS optimization_ledger_ticket_seq_idx
    ON ronor.optimization_ledger (ticket_id, sequence_in_ticket DESC);
CREATE INDEX IF NOT EXISTS optimization_ledger_delivery_idx
    ON ronor.optimization_ledger (delivery_day, delivery_hour);
CREATE INDEX IF NOT EXISTS optimization_ledger_actor_idx
    ON ronor.optimization_ledger (requested_by, created_at DESC);
CREATE INDEX IF NOT EXISTS optimization_ledger_state_idx
    ON ronor.optimization_ledger (state, created_at DESC);

-- ============================================================================
-- ledger_hmac_keys
-- ----------------------------------------------------------------------------
-- Registered signing keys. This table stores the key IDS but not the material
-- itself — key values live in the deployment secret store (TRADING_LEDGER_HMAC_KEY
-- in .env.production, rotated by adding a new entry here and re-pointing the
-- signing service). Old keys are kept `active=false` so signatures they made
-- stay verifiable.
-- ============================================================================
CREATE TABLE IF NOT EXISTS ronor.ledger_hmac_keys (
    key_id      TEXT        PRIMARY KEY,
    active      BOOLEAN     NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    retired_at  TIMESTAMPTZ,
    notes       TEXT
);

-- ============================================================================
-- View: current ticket state
-- ----------------------------------------------------------------------------
-- Convenience view for reports: the latest row per ticket. It does not modify
-- the append-only invariant; it just makes "current status" a one-line query.
-- ============================================================================
CREATE OR REPLACE VIEW ronor.optimization_ledger_current AS
SELECT DISTINCT ON (ticket_id)
    ticket_id,
    state,
    corridor,
    delivery_day,
    delivery_hour,
    volume_mw,
    side,
    price_ceiling_eur,
    requested_by,
    settled_by,
    notes,
    estimated_uplift_eur,
    baseline_ref,
    arm_brief,
    arm_evidence,
    created_at AS last_change_at
FROM ronor.optimization_ledger
ORDER BY ticket_id, sequence_in_ticket DESC;

-- ============================================================================
-- View: proof-of-optimisation summary per day
-- ----------------------------------------------------------------------------
-- The single query NrgPaths presents to Encon for a given delivery day.
-- Counts trades initiated, executed, cancelled, and sums the ledger's own
-- estimated_uplift for the executed ones.
-- ============================================================================
CREATE OR REPLACE VIEW ronor.optimization_ledger_daily_summary AS
SELECT
    delivery_day,
    COUNT(DISTINCT ticket_id) FILTER (WHERE state = 'requested')  AS trades_initiated,
    COUNT(DISTINCT ticket_id) FILTER (WHERE state = 'executed')   AS trades_executed,
    COUNT(DISTINCT ticket_id) FILTER (WHERE state = 'cancelled')  AS trades_cancelled,
    COUNT(DISTINCT ticket_id) FILTER (WHERE state = 'rejected')   AS trades_rejected,
    COALESCE(SUM(estimated_uplift_eur) FILTER (WHERE state = 'executed'), 0)::NUMERIC(14, 2)
        AS total_estimated_uplift_eur,
    MIN(created_at)                                               AS first_change_at,
    MAX(created_at)                                               AS last_change_at
FROM ronor.optimization_ledger
GROUP BY delivery_day;

-- ============================================================================
-- Grants
-- ----------------------------------------------------------------------------
-- The energy trading arm's DB role gets INSERT and SELECT. It does NOT get
-- UPDATE or DELETE on optimization_ledger — the append-only invariant is
-- enforced at the DB level. If a compensation is ever needed, a NEW row must
-- be written to record the compensation, keeping the audit trail complete.
-- ============================================================================
DO $grants$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ronor_energy_trading') THEN
        GRANT USAGE ON SCHEMA ronor TO ronor_energy_trading;
        GRANT SELECT, INSERT ON ronor.optimization_ledger TO ronor_energy_trading;
        GRANT SELECT ON ronor.optimization_ledger_current, ronor.optimization_ledger_daily_summary TO ronor_energy_trading;
        GRANT SELECT ON ronor.ledger_hmac_keys TO ronor_energy_trading;
        -- The signing key rotation is a privileged operation performed by
        -- the deployment operator, not the arm. The arm reads keys by id.
    END IF;
END
$grants$;

-- ============================================================================
-- Seed: the initial signing key id
-- ----------------------------------------------------------------------------
-- The key material lives in TRADING_LEDGER_HMAC_KEY. The id 'k1' is what
-- freshly signed rows will refer to until the operator rotates by adding 'k2'
-- with `active=true` and setting the new material in the deployment secret.
-- ============================================================================
INSERT INTO ronor.ledger_hmac_keys (key_id, active, notes)
VALUES ('k1', true, 'Initial signing key. Rotate by adding k2 and updating TRADING_LEDGER_HMAC_KEY.')
ON CONFLICT (key_id) DO NOTHING;
