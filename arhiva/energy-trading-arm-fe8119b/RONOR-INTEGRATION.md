# Energy Trading Arm — RONOR integration

This directory contains the Muse-authored `energy_trading` Python package
(v0.2.0 handover, 336 files, 127 pytest passing, SHA256
`865e63f82f6853afbbb5a557dfa9e26b6b2001d489d07f2ecf47c6298a47d78f`), placed
here so RONOR can build and run it as a compose service on Hetzner without
depending on any external URL.

Nothing under `src/`, `data/`, `tests/`, `ronor/`, `docs/`, `static/`,
`templates/` or `deploy/` has been modified. This document is the RONOR-side
integration surface; the arm itself is untouched.

## What runs where

* **Arm container** — this directory, built by `docker-compose.production.yml`
  under service name `energy-trading-arm`, exposed only on the internal
  compose network at `http://energy-trading-arm:8000`. Reached from the bot
  container, never from the public internet.

* **Bot** — the TypeScript Telegram bridge, extended in this PR to:
  * accept a role map (`TELEGRAM_ROLE_MAP`) and enforce it per command,
  * expose new commands `/energy_status`, `/energy_report`, `/day`, `/pl`,
    `/brief`, `/trade_request`, `/upload_case`, `/feedback`, `/correct`,
  * proxy the read/contribute ones straight to the arm,
  * raise a `trade` co-sign gate for every `/trade_request`, settled by the
    sovereign via the existing `/approve` / `/reject` flow.

* **Ledger** — Postgres tables `ronor.optimization_ledger` and
  `ronor.ledger_hmac_keys`, created by `deploy/sql/002_energy_trading_ledger.sql`.
  Rows are HMAC-signed with `TRADING_LEDGER_HMAC_KEY`. Append-only at the DB
  level: no UPDATE, no DELETE on ledger rows.

## Environment

Set in `.env.production`:

```
TRADING_ARM_BASE_URL=http://energy-trading-arm:8000
ET_API_TOKEN=<openssl rand -hex 32>
TELEGRAM_ROLE_MAP=7200344419:ma11ai:sovereign,532895049:nrgpaths:trading_trainer
TELEGRAM_TRADING_APPROVERS=        # empty → all base approvers may co-sign trades
TRADING_LEDGER_DSN=                # optional; empty → arm uses local sqlite
TRADING_LEDGER_HMAC_KEY=<openssl rand -hex 32>
```

## Deploy on Hetzner

```bash
cd /opt/ronor/current
git pull
# Generate token if not already present in .env.production:
grep -q '^ET_API_TOKEN=' .env.production || \
  echo "ET_API_TOKEN=$(openssl rand -hex 32)" >> .env.production
grep -q '^TRADING_LEDGER_HMAC_KEY=' .env.production || \
  echo "TRADING_LEDGER_HMAC_KEY=$(openssl rand -hex 32)" >> .env.production
./deploy/deploy.sh --with-telegram --with-energy-trading
```

`deploy.sh` refuses to start if `ET_API_TOKEN` or `TELEGRAM_ROLE_MAP` are
missing when `--with-energy-trading` is requested. That is deliberate: a
trading arm without a token would answer nobody, and a bot without a role
map would either lock every user out of trading (best case) or expose the
sovereign surface to whoever is on the allowlist (worst case, if the fail
were relaxed).

## Rollback

```bash
./deploy/deploy.sh --rollback
```

Rolls back the bot image only. The arm container is versioned separately
(`RONOR_ENERGY_TRADING_VERSION`), so a rollback of the RONOR bot does not
touch the arm. To roll the arm back, redeploy the previous git tag of this
subdirectory or pin the container to the previous image tag.

## Role model

| Role                        | Who    | Commands            | Trade initiation | Trade settlement |
|-----------------------------|--------|---------------------|------------------|------------------|
| `ma11ai:sovereign`          | Liviu  | all                 | yes              | yes (co-signs)   |
| `nrgpaths:trading_trainer`  | Natalia| trading only        | yes (no cap)     | never (must be co-signed) |
| `encon:trading_observer`    | (TBD)  | read-only trading   | no               | no               |

Adding a user to `TELEGRAM_ALLOWED_USER_IDS` alone gives them the general
RONOR commands (`/query`, `/mission`, `/status`, `/pending`, `/approve`,
`/reject`) but **not** trading commands. To grant trading, add them to
`TELEGRAM_ROLE_MAP` too.

## Parity with Muse's sandbox

Muse retains a copy of v0.2.0 on his own VM. The sandbox has no inbound (no
public URL, no `ET_API_TOKEN`), so parity is checked out-of-band:

1. Same day, same three questions are posed to both instances.
2. Muse runs them on his sandbox (offline) and shares the JSON briefs.
3. RONOR runs them via `/energy_report` and stores the briefs.
4. Field-by-field comparison per `PARITY.md` (in this directory).

Parity does **not** require Muse's sandbox to be reachable from Hetzner.
The arm running on Hetzner is the production instance; Muse's sandbox is
the reference oracle.
