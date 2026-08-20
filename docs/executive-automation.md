# Executive Mission Runner v1

The runner converts one Merlin-issued, bounded and expiring mandate into an
automated development sequence:

```text
Richard delegation → LangGraph plan → OpenHands sandbox work
                   → Codex independent verification → Victoria assurance
```

One mandate covers read-only repository work, an isolated branch/worktree,
edits in that worktree, tests, local commits and preparation of a draft PR. It
does not ask for approval between those in-scope steps.

The runner denies before adapter invocation: external email, secret access,
main writes, push, merge, release, deployment, financial activity and destructive
actions. Objective digest, workspace, branch prefix, expiry, cost, duration and
fix-cycle ceilings bind the mandate. A new approval is required to expand any of
those boundaries.

The implementation is adapter-driven. Tests use in-process doubles and perform
no external calls. Live LangGraph and OpenHands adapters remain disabled until a
dedicated sandbox and service identities are configured. Codex and Victoria are
separate verifier roles and cannot be replaced by the implementing OpenHands
worker.
## Live adapter boundary

The runner connects through three small HTTP contracts: LangGraph `POST /v1/plan`,
OpenHands `POST /v1/execute`, and the independent Codex verifier `POST /v1/verify`.
Remote endpoints require HTTPS; plaintext HTTP is accepted only on loopback.
Credentials are read from environment variables and are never returned by the
status API. The registry fails closed unless automation is explicitly enabled
and all three endpoints are configured.

```text
RONOR_AUTOMATION_ENABLED=false
RONOR_LANGGRAPH_URL=
RONOR_LANGGRAPH_TOKEN=
RONOR_OPENHANDS_URL=
RONOR_OPENHANDS_TOKEN=
RONOR_AUTOMATION_CAPABILITY_KEY=
RONOR_AUTOMATION_WORKSPACE_ROOT=
RONOR_AUTOMATION_ARTIFACT_ROOT=
RONOR_AUTOMATION_EXPECTED_ORIGIN=https://github.com/Constantin1968/RONOR-.git
RONOR_AUTOMATION_EXPECTED_HEAD=
RONOR_CODEX_VERIFIER_URL=
RONOR_CODEX_VERIFIER_TOKEN=
```

## Native OpenHands bridge

RONOR never sends a host workspace path or the full mandate to OpenHands. The
runner sends a minimal execution envelope to a dedicated bridge, accompanied by
a short-lived HMAC capability bound to the objective digest, assignment,
allowed actions, deadline and one-time nonce. The bridge requires a distinct
service token, rejects replay and mismatched claims, and then uses the native
OpenHands Agent Server conversation/event API with `X-Session-API-Key`.

The bridge uses `POST /api/conversations`, native conversation events and
pause-on-timeout. It never deletes a conversation automatically. A completed
conversation yields a SHA-256 event-log reference; diff and test artifacts must
also be supplied before Codex can issue a production-grade verification verdict.

The service is not started by the normal runtime and fails closed unless every
required value is provided. It binds to loopback by default:

```text
RONOR_OPENHANDS_AGENT_SERVER_URL=http://127.0.0.1:8000
RONOR_OPENHANDS_SESSION_API_KEY=
RONOR_OPENHANDS_BRIDGE_TOKEN=
RONOR_AUTOMATION_CAPABILITY_KEY=
RONOR_OPENHANDS_BRIDGE_HOST=127.0.0.1
RONOR_OPENHANDS_BRIDGE_PORT=3001
```

`npm run automation:openhands-bridge` starts only this bridge after the Agent
Server readiness probe passes. Container isolation, credential-free worktrees
and default-deny egress remain mandatory before enabling live execution.

Before calling the bridge, the runtime resolves the worktree and approved root
to canonical paths, refuses links and path escapes, verifies that the directory
is the Git toplevel, rejects `main` and `master`, enforces the branch namespace,
origin and optional base commit, and requires a clean starting tree. The actual
branch must equal the branch declared by the request. Inspection failures return
a bounded reason code without filesystem or remote details.

An active run can be cancelled only through the architect route
`POST /control/automation/runs/:runId/cancel`. The request is bound to its
mission and produces an `AbortSignal` that propagates to LangGraph, OpenHands
and Codex HTTP calls. Cancellation is distinct from adapter timeout and never
claims to roll back local effects that completed before the signal arrived.

After every completed OpenHands assignment, RONOR independently invokes Git in
the validated worktree and captures the binary diff and porcelain status. The
files are written atomically beneath the pre-existing artifact root, bounded to
2 MiB each, and represented in Mission Fabric and the Codex request only by
relative reference, byte count and SHA-256 digest. Existing evidence is reused
only when its digest matches; collisions, symlinks, path escapes and oversized
outputs fail the run before verification.

## Local model cabinet

Ollama is a first-class, fail-closed local provider. Set `OLLAMA_ENABLED=true`
only after `http://127.0.0.1:11434/api/tags` passes its health check. The default
local endpoint can be overridden with `OLLAMA_BASE_URL`.

- `qwen3:4b-instruct`: private general analysis and drafting;
- `qwen2.5-coder:3b`: bounded coding assistance;
- `deepseek-r1:1.5b`: lightweight reasoning;
- `qwen3-embedding:0.6b`: embeddings for persistent memory (not chat routing).

Local generation has zero vendor-token cost and maximum sovereignty, but lower
quality scores than frontier cloud models. Claude, Kimi, Grok, OpenAI, Gemini and
Perplexity remain credential-gated escalation routes. The router records which
provider and transport produced every answer.

Grok uses the current xAI `grok-4.5` model through the OpenAI-compatible API and
remains disabled until `XAI_API_KEY` is supplied at runtime. Its catalogue entry
does not claim live web or X search: those require separately governed tool
integration. No xAI credential is committed, cached, or returned by CONTROL.

The cabinet can split sovereign work between the workstation and a larger
Tailscale-connected inference host. Endpoints remain environment configuration,
are restricted to loopback, Tailscale addresses, or HTTPS, and are never exposed
by the CONTROL status API.

```text
OLLAMA_ENABLED=false
OLLAMA_LOCAL_BASE_URL=http://127.0.0.1:11434
OLLAMA_CONTABO_BASE_URL=http://<tailscale-host>:11434
```

The measured routing policy keeps Qwen 4B and Qwen Coder interactive on the
workstation, assigns Qwen 72B to private batch analysis, Llama 70B to an
independent local-verification role, and BGE-M3 to 1024-dimensional memory.
DeepSeek 70B is opt-in for deep reasoning rather than rapid work because its
short-output benchmark exhausted the response budget before producing a final
answer. Cloud models remain explicit escalation routes, never automatic
defaults.

Gemini uses stable `gemini-3.7-flash` and `gemini-3.6-flash` routes, with
`gemini-3.1-pro-preview` retained for complex work. It remains disabled until
an explicit Gemini credential or allow-listed gateway is configured.

The Qwen portfolio is surfaced as a governed cabinet rather than treated as one
interchangeable model. Selection filters by modality, sovereignty, interactive
latency and budget class. Installed Ollama models are zero-token-cost routes;
Qwen 3.8 Max, Coder Plus, Omni and Image remain credential-gated cloud routes.
Uninstalled self-hosted candidates are visible but ineligible until their exact
model is installed and declared. Manus remains deferred until after 26 August
2026; no Manus credential or execution path is enabled.
