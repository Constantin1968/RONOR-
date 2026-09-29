# Endpoint Mounts (`src/index.ts`)

Every `app.use` registration in the bootstrap path of `src/index.ts`, read from
the code. Nothing here is inferred: each row carries the source line it was
taken from, and the two surfaces are separated exactly as the file separates
them.

Two generations coexist by design:

- **Runtime plane surface — `/api/runtime`.** Mounted first, with its own
  middleware chain (`provenanceMiddleware` → `runtimeRouter` →
  `runtimeErrorHandler`). The isolation is deliberate, per the comment above the
  mount: provenance capture, per-key rate limiting and the runtime error handler
  apply to `/api/runtime` only, so the legacy contracts are untouched.
- **Legacy surface — `/api/v1`.** The pre-existing Core Active routers, mounted
  after the runtime surface. `/api/v1/knowledge` is registered only when the
  R-Knowledge plane exists; in disabled mode that mount does not occur at all.

Path-less registrations (`cors()`, body parsers) and the `/health` `app.get`
handler are not route mounts; they are listed separately at the end for
completeness.

## Route mounts

| # | Line | Path prefix | Mounted router / handler | Source module | Generation | Registered when |
|---|------|-------------|--------------------------|---------------|------------|-----------------|
| 1 | 255 | `/api/runtime` | `provenanceMiddleware`, `runtimeRouter`, `runtimeErrorHandler` | `createRuntimeRouter()` ← `./runtime/api/routes`; middleware ← `./runtime/api/middleware` | Runtime plane surface (`/api/runtime`) | Always |
| 2 | 258 | `/api/v1` | `createRouter(orchestrator)` | `./api/router` | Legacy surface (`/api/v1`) | Always |
| 3 | 259 | `/api/v1` | `createDecisionsRouter()` | `./api/decisions-router` | Legacy surface (`/api/v1`) | Always |
| 4 | 260 | `/api/v1/model-exchange` | `modelExchangeRouter` | `./api/model-exchange-router` | Legacy surface (`/api/v1`) | Always |
| 5 | 261 | `/api/v1/sentinel` | `createSentinelRouter(sentinel)` | `./api/sentinel-router` | Legacy surface (`/api/v1`) | Always |
| 6 | 265 | `/api/v1/knowledge` | `createKnowledgeRouter(knowledge)` | `./api/knowledge-router` | Legacy surface (`/api/v1`) | Only if `knowledge !== null` |
| 7 | 271 | `/console` | `express.static('web/console')` | `express` (static) | Neither — Operator Console static UI | Always |
| 8 | 272 | `/control` | `express.static('web/control')` | `express` (static) | Neither — control static UI | Always |
| 9 | 273 | `/` | `express.static('web')` | `express` (static) | Neither — baseline root-served web UI | Always |

Notes on ordering, taken from the same file:

- The runtime surface is mounted **ahead of** the Core Active routers, so a
  request under `/api/runtime` never reaches the legacy chain.
- Rows 2 and 3 share the `/api/v1` prefix and are chained in that order.
- Row 6 is inside the `if (knowledge !== null)` block; the comment there states
  that when the plane is disabled the route table is identical to the baseline's.

## Non-mount registrations

| Line | Registration | Purpose |
|------|--------------|---------|
| 242 | `app.use(cors())` | Global CORS, no path prefix |
| 243 | `app.use(express.json({ limit: '10mb' }))` | Global JSON body parser, no path prefix |
| 244 | `app.use(express.urlencoded({ extended: true }))` | Global form body parser, no path prefix |
| 285 | `app.get('/health', …)` | Health handler — `app.get`, not `app.use`; wrapped so a failure to *compose* health degrades the body instead of taking the process down |
| 360 | `app.listen(PORT, …)` | Server start |
