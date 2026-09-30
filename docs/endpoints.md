# Endpoints — `app.use` mounts in `src/index.ts`

Every `app.use(...)` call registered on the Express application in `src/index.ts`, in
registration order. Line numbers refer to `src/index.ts`.

Two generations of API surface exist:

- **Runtime plane** — the newer surface, mounted under `/api/runtime`. It is isolated on
  purpose: provenance capture, per-key rate limiting and the runtime error handler apply
  to `/api/runtime` only, so the legacy contracts are untouched (see the comment block at
  `src/index.ts:245`).
- **Legacy surface** — the original Core Active routers, mounted under `/api/v1`.

Everything else in the table is global middleware (no path prefix) or a static UI mount
(not an API generation).

| # | Line | Path prefix | Router / handler mounted | Generation |
|---|------|-------------|--------------------------|------------|
| 1 | 241 | *(none — global)* | `cors()` | Middleware (cross-origin policy) |
| 2 | 242 | *(none — global)* | `express.json({ limit: '10mb' })` | Middleware (JSON body parsing) |
| 3 | 243 | *(none — global)* | `express.urlencoded({ extended: true })` | Middleware (form body parsing) |
| 4 | 254 | `/api/runtime` | `provenanceMiddleware`, `createRuntimeRouter()` (from `src/runtime/api/routes`), then `errorHandler` (imported as `runtimeErrorHandler`, from `src/runtime/api/middleware`) | Runtime plane |
| 5 | 257 | `/api/v1` | `createRouter(orchestrator)` (from `src/api/router`) | Legacy surface |
| 6 | 258 | `/api/v1` | `createDecisionsRouter()` (from `src/api/decisions-router`) | Legacy surface |
| 7 | 259 | `/api/v1/model-exchange` | `modelExchangeRouter` (from `src/api/model-exchange-router`) | Legacy surface |
| 8 | 260 | `/api/v1/sentinel` | `createSentinelRouter(sentinel)` (from `src/api/sentinel-router`) | Legacy surface |
| 9 | 264 | `/api/v1/knowledge` | `createKnowledgeRouter(knowledge)` (from `src/api/knowledge-router`) — registered only when `knowledge !== null`; in disabled mode this mount does not occur | Legacy surface |
| 10 | 270 | `/console` | `express.static('web/console')` — Operator Console | Static UI (not an API generation) |
| 11 | 271 | `/control` | `express.static('web/control')` — CONTROL UI | Static UI (not an API generation) |
| 12 | 272 | `/` | `express.static('web')` — existing root-served web UI | Static UI (not an API generation) |

## Not an `app.use` mount

- `GET /health` (`src/index.ts:284`) is registered with `app.get`, not `app.use`. The whole
  handler is wrapped in `compuneSauDegradat`: a failure to compose health is reported as
  `degraded` with the reason over HTTP 200, rather than thrown.
- `app.listen(PORT, ...)` (`src/index.ts:359`) starts the server. Governance is checked
  before this point: `assertMi9EnforcementAllowed(process.env)`
  (`src/governance/mi9-enforcement.ts`) runs at `src/index.ts:83` and throws with code
  `mi9_enforce_off_refused_in_production` when `NODE_ENV=production` and `MI9_ENFORCE=off`.

## Notes

- Middleware mounts 1–3 have no path prefix, so they apply to both generations.
- Mount 4 is the only mount with its own middleware chain; mounts 5–9 share the global chain.
- This document describes the mount table only, not the individual routes declared inside
  each router. For those, read the router sources listed in the table.
