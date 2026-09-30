# Endpoints — `app.use` mount table

Source of truth: [`src/index.ts`](../src/index.ts) (`bootstrap()`). Every `app.use`
call in that file is listed below, in mount order. Nothing here is inferred from
naming conventions — each row names the module and the export actually passed to
`app.use`.

## Two generations of surface

`src/index.ts` mounts two API generations side by side. They are deliberately
isolated: the runtime plane surface carries its own middleware chain (provenance
capture and its own error handler), while the legacy surface keeps the contract
its existing test suite was written against.

| Generation | Path prefix | Middleware chain |
| --- | --- | --- |
| Runtime plane surface | `/api/runtime` | `provenanceMiddleware` → `createRuntimeRouter()` → `errorHandler as runtimeErrorHandler` |
| Legacy surface | `/api/v1` | `ingressRateLimit` → `provenanceMiddleware` → `requireAuth('read')` (finding F01), mounted ahead of the legacy routers |

## Global middleware (no path prefix)

Mounted before every route, so they apply to all requests reaching the app.

| Line | `app.use(...)` | Handler | Generation |
| --- | --- | --- | --- |
| 250 | `app.use(cors())` | `cors()` from `cors` | shared — both |
| 251 | `app.use(express.json({ limit: '10mb' }))` | `express.json` body parser | shared — both |
| 252 | `app.use(express.urlencoded({ extended: true }))` | `express.urlencoded` body parser | shared — both |

## Path-mounted handlers

| Line | Path prefix | Router / handler mounted | Defined in | Generation |
| --- | --- | --- | --- | --- |
| 263 | `/api/runtime` | `provenanceMiddleware`, `runtimeRouter` (`createRuntimeRouter()`), `runtimeErrorHandler` (`errorHandler`) | `src/runtime/api/routes.ts`, `src/runtime/api/middleware.ts` | Runtime plane surface |
| 267 | `/api/v1` | `ingressRateLimit`, `provenanceMiddleware`, `requireAuth('read')`: authentication and ingress metering for every legacy route | `src/runtime/api/middleware.ts` | Legacy surface |
| 270 | `/api/v1` | `createRouter(orchestrator)` | `src/api/router.ts` | Legacy surface |
| 271 | `/api/v1` | `createDecisionsRouter()` | `src/api/decisions-router.ts` | Legacy surface |
| 272 | `/api/v1/model-exchange` | `modelExchangeRouter` | `src/api/model-exchange-router.ts` | Legacy surface |
| 273 | `/api/v1/sentinel` | `createSentinelRouter(sentinel)` | `src/api/sentinel-router.ts` | Legacy surface |
| 277 | `/api/v1/knowledge` | `createKnowledgeRouter(knowledge)` | `src/api/knowledge-router.ts` | Legacy surface |
| 283 | `/console` | `express.static('web/console')` | `express` | neither — static UI, not an API generation |
| 284 | `/control` | `express.static('web/control')` | `express` | neither — static UI, not an API generation |
| 285 | `/` | `express.static('web')` | `express` | neither — static UI, not an API generation |

## Conditional mount

Line 277 (`/api/v1/knowledge`) is inside `if (knowledge !== null) { ... }`. When
the knowledge plane is not constructed, the mount does not happen at all and the
legacy route table is identical to the one without it. This is called out as
invariant **BE-1** in the adjacent source comment. Every other row above is
unconditional.

## Not an `app.use` mount

Line 297 registers the health probe with `app.get('/health', ...)`, not `app.use`.
It is listed here only so the table is not mistaken for a complete route
inventory: it is a single `GET` handler whose body composition is wrapped by
`compuneSauDegradat` and which returns HTTP 200 even on the degraded path.

## Related

- MI9 gate behaviour on the legacy decision path: [`src/governance/mi9-gate.ts`](../src/governance/mi9-gate.ts)
- Refusal to boot when the gate would be disarmed in production: [`src/governance/mi9-enforcement.ts`](../src/governance/mi9-enforcement.ts)
