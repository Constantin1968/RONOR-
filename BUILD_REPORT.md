# RONOR v0.5.0 — Sovereign Deployment Build Report

**Date:** 03 August 2026  
**Author:** AMB · Principal AI/ML AgenticsAI, Mayleven Ecosystem  
**Target Branch:** `feature/sovereign-deployment` (pushed to `Constantin1968/RONOR-`)  

## Executive Summary

The sovereign deployment package for RONOR v0.5.0 has been fully architected, implemented, and pushed. The package provides a complete L0–L7 stack capable of running on a single Ubuntu 22.04 droplet with off-host durable persistence via Supabase and Cloudflare R2, plus a secure Telegram operator interface and Tailscale sovereign plane integration.

> **Minimum server specification: 4 GB RAM, 2 vCPU (DigitalOcean $24/month tier).** When all four services run simultaneously — RONOR runtime (~400 MB), Qdrant v1.18.3 (~600 MB under load), Redis 7 (~50 MB), and the Telegram bridge (~150 MB) — total RSS approaches 1.2 GB before the TypeScript build, which adds a further ~600 MB peak. A 2 GB droplet will OOM-kill during the first `docker compose build` even with a 2 GB swapfile, because swap cannot substitute for the RAM needed by the compiler and the linker simultaneously. The 4 GB tier provides a safe operating margin and is the recommended minimum for a production deployment.

All TypeScript code was written in strict mode and compiles cleanly (`tsc --noEmit` passes with zero errors).

## 1. Deployment Package & Infrastructure

The infrastructure scripts ensure a secure, reproducible host environment without relying on third-party PaaS platforms.

- **`docker-compose.production.yml`**: Configured with `ronor`, `qdrant` (v1.18.3 pinned), `redis`, `telegram`, `nginx`, and `certbot` services. All internal services are bound strictly to `127.0.0.1`.
- **`deploy/setup-server.sh`**: Idempotent host preparation script. Installs Docker Compose v2, Tailscale, configures UFW (blocking all inbound except SSH/80/443), fail2ban, unattended security upgrades, and provisions a 2 GB swapfile. Also installs a systemd timer (`ronor-certbot-renew.timer`) that fires twice daily at 04:17 and 16:17 UTC for automatic TLS certificate renewal, independent of the certbot container's own renewal loop.
- **`deploy/deploy.sh`**: Automated build and bring-up script with preflight checks, health verification (polling the runtime's own `/api/runtime/health`), and one-command rollback (`--rollback`).
- **`.env.production.template`**: Comprehensive environment template documenting all required and optional variables, including 6D router weights, persistence keys, and Telegram configuration.
- **Nginx TLS Edge (`deploy/nginx/`)**: Terminates TLS with strict AEAD suites, OCSP stapling, and rate limiting (differentiating cheap reads from expensive governed queries).

## 2. Telegram Operator Interface (L0 Side-Channel)

A complete, sovereign operator interface was built as a standalone container profile (`telegram`), ensuring that long-polling blocking I/O does not interfere with the runtime's governed API.

- **Gate 1/2 Approval Flow**: Fully implemented. When a query or mission returns `human_cosign_required: true`, the bot stores the payload in an in-memory `ApprovalStore` (backed by Redis for durability across restarts) and sends an interactive prompt with inline `Approve` / `Reject` buttons.
- **Re-submission**: Upon approval, the original payload is re-submitted to the runtime. The runtime re-evaluates governance rather than trusting a side-channel token.
- **Commands Supported**: `/start`, `/help`, `/status`, `/query`, `/mission`, `/pending`, `/approve`, `/reject`.
- **Security**: Fails closed. The bot ignores all users not explicitly listed in `TELEGRAM_ALLOWED_USER_IDS`. Only users in `TELEGRAM_APPROVER_USER_IDS` can settle Gate 1/2 requests.

## 3. Persistent Memory Layer (L2/L6)

The runtime was extended with adapters to offload durable state from the host.

- **Supabase Adapter (`src/persistence/supabase-adapter.ts`)**: Implements fire-and-forget writes via the PostgREST API using the Service Role Key. Handles `conversations`, `memory_entries`, `agent_state`, `missions`, and `audit_events`.
- **R2 Adapter (`src/persistence/r2-adapter.ts`)**: Implements an S3-compatible client with zero external dependencies, using custom AWS Signature Version 4 signing. Objects are content-addressed by SHA-256 to guarantee cryptographic equivalence with the SQLite audit chain.
- **Unified Memory Manager (`src/persistence/memory-manager.ts`)**: Provides a clean facade over Supabase and R2, handling degradation gracefully. If Supabase or R2 is unreachable, the runtime continues to answer queries and reports the degradation rather than failing.

## 4. Tailscale Integration

- **`src/interfaces/tailscale/config.ts`**: Configures the runtime to recognize the sovereign tailnet. Includes a lightweight TCP probe utility to verify reachability of the HP laptop peer (`desktop-eapcqug`, `100.108.229.28`) without requiring the heavy Tailscale SDK.
- The `setup-server.sh` script supports joining the tailnet non-interactively via `--tailscale-authkey`.

## 5. Live Provisioning & Manual Steps Required

The automated provisioning scripts (`scripts/provision-qdrant.ts` and `scripts/provision-supabase.ts`) were written and verified to compile. However, Cloudflare security policies prevent automated API execution from the current sandbox IP.

The following steps **must be executed manually** by the operator:

1. **Supabase Schema**:
   - The SQL migration file is ready at `deploy/sql/001_ronor_schema.sql`.
   - **Action**: Log into the Supabase Dashboard (project `mrmauhtdmmyaxrxfsqsn`), open the SQL Editor, and execute the contents of the file. (Alternatively, run `ts-node scripts/provision-supabase.ts` from the production server once deployed, as its IP will not be flagged as a datacenter bot).
2. **Cloudflare R2**:
   - R2 must be enabled at the account level before buckets can be created.
   - **Action**: Log into the Cloudflare Dashboard, navigate to R2, and enable the service. The `ronor-evidence` bucket will then be created automatically by the runtime on first write, or you can create it manually in the dashboard.
3. **Telegram Bot**:
   - **Action**: Obtain a bot token from `@BotFather` and add your numeric Telegram user ID (from `@userinfobot`) to both `TELEGRAM_ALLOWED_USER_IDS` and `TELEGRAM_APPROVER_USER_IDS` in `.env.production`.

## Conclusion

The repository `Constantin1968/RONOR-` now contains the `feature/sovereign-deployment` branch with all 22 new files. The codebase remains strictly typed and the existing canonical L0-L7 architecture is fully preserved.

*Signed, AMB*
