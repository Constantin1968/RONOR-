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

The CONTROL client approves a mission, workspace, exact branch and bounded
cost/time/fix-cycle request; it never submits an `ExecutionMandate`. After
`requireArchitect` authenticates the dedicated Merlin credential, RONOR creates
the mandate server-side, binds it to that credential's non-secret key id and
the stored mission objective, assigns a random identifier, derives the action
sets and timestamps, and caps every requested limit by server policy. Client
authority fields are refused. Exact branches do not use lexical-prefix matching;
namespace authorization is possible only when policy explicitly ends in `/`.

Every start request also carries a non-secret `Idempotency-Key`. RONOR derives a
stable mandate handle from that key, the stored mission and the authenticated
architect identity. The first claimant atomically persists the complete mandate
and obtains a short lease in `runtime_automation_runs`; concurrent claimants are
refused. A heartbeat renews ownership while work is active. After a crash, only
an expired lease may be reclaimed, the original stored mandate is restored
rather than regenerated, and the configured fix-cycle ceiling is enforced by
the same transaction. A stale worker cannot complete a lease after ownership
has moved. Fabric remains the append-only audit view; the run registry supplies
cross-process mutual exclusion and recovery state.

The implementation is adapter-driven. Tests use in-process doubles and perform
no external calls. Live LangGraph and OpenHands adapters remain disabled until a
dedicated sandbox and service identities are configured. Codex and Victoria are
independent service identities and cannot be replaced by the implementing
OpenHands worker or by one another. Victoria receives the verified evidence
manifest and issues its own assurance verdict; a Codex PASS is never converted
automatically into a Victoria PASS.
## Live adapter boundary

The runner connects through four small HTTP contracts: LangGraph `POST /v1/plan`,
OpenHands `POST /v1/execute`, the independent Codex verifier `POST /v1/verify`,
and Victoria assurance `POST /v1/assure`.
Remote endpoints require HTTPS; plaintext HTTP is accepted only on loopback.
The sole production exception is an exact service identity on the pre-created
internal Docker network: `langgraph`, `openhands-bridge`, `codex-verifier` and
`victoria-assurance`. Each adapter accepts only its own hostname; arbitrary
container names and private-network addresses remain invalid.
Credentials are read from environment variables and are never returned by the
status API. The registry fails closed unless automation is explicitly enabled
and all four endpoints are configured. OpenHands, Codex and Assurance must use
distinct endpoint and credential identities; aliasing any of them fails closed.
Immediately before execution, the runtime performs authenticated `GET /health`
attestation against every service and requires its pinned `ronor-*/v1` protocol.
A configured URL is therefore never treated as proof of readiness, redirects are
refused, and any unavailable or incompatible authority stops the run.

The repository also provides independently mountable Codex and Victoria
authority applications in `verification-authorities.ts`. Codex must receive an
explicit evaluator port and independently reopens the diff, status and test
report from the read-only artifact store before evaluation. Victoria uses a
separate service credential, re-hashes the same artifacts itself and applies a
distinct evidence policy. Both fail closed on missing test evidence, digest
mismatch, malformed evaluator output or inaccessible storage; provider errors
are never returned to the caller. The Codex evaluator's live provider binding is
intentionally not implicit: it must be configured as a separate, least-privilege
service before activation.

```text
RONOR_AUTOMATION_ENABLED=false
RONOR_LANGGRAPH_URL=
RONOR_LANGGRAPH_TOKEN=
RONOR_OPENHANDS_URL=
RONOR_OPENHANDS_TOKEN=
RONOR_AUTOMATION_CAPABILITY_KEY=
RONOR_AUTOMATION_WORKSPACE_ROOT=
RONOR_AUTOMATION_ARTIFACT_ROOT=
RONOR_AUTOMATION_TEST_COMMANDS_JSON=
RONOR_AUTOMATION_EXPECTED_ORIGIN=https://github.com/Constantin1968/RONOR-.git
RONOR_AUTOMATION_EXPECTED_HEAD=
RONOR_CODEX_VERIFIER_URL=
RONOR_CODEX_VERIFIER_TOKEN=
RONOR_ASSURANCE_URL=
RONOR_ASSURANCE_TOKEN=
RONOR_EVIDENCE_RUNNER_URL=http://automation-evidence-runner:3005
RONOR_EVIDENCE_RUNNER_TOKEN=
RONOR_CODEX_API_KEY=
RONOR_CODEX_MODEL=
RONOR_CODEX_INPUT_USD_PER_MTOK=
RONOR_CODEX_OUTPUT_USD_PER_MTOK=
```

`npm run automation:codex-verifier` and `npm run automation:assurance` start
the two authorities on loopback ports 3002 and 3003. The Codex process uses the
OpenAI Responses API with `store:false`, no tools and a strict JSON-schema
verdict. The model and current per-million-token prices are mandatory operator
configuration so cost accounting cannot silently assume a free or guessed
price. Evidence above the bounded context is refused rather than truncated.

`RONOR_AUTOMATION_TEST_COMMANDS_JSON` is a server-side allowlist, never mission
input. It contains bounded objects such as
`[{"id":"jest","executable":"npm","args":["test","--","--runInBand"],"timeout_ms":900000}]`.
RONOR invokes each executable directly with `shell:false`, a secretless minimal
environment, output limits and a per-command timeout. Shell interpreters are
refused. A SHA-256 `ronor-test-report/v1` artifact is written atomically; a
non-zero exit, timeout, cancellation, secret-like output or missing executor
stops the run before Codex. The executor must still run inside the dedicated
automation container/worktree—the allowlist does not replace OS isolation.

## Native OpenHands bridge

RONOR never sends a host workspace path or the full mandate to OpenHands. The
runner sends a minimal execution envelope to a dedicated bridge, accompanied by
a short-lived HMAC capability bound to the objective digest, assignment,
allowed actions, deadline and one-time nonce. The bridge requires a distinct
service token, rejects replay and mismatched claims, and then uses the native
OpenHands Agent Server `/api/conversations` event API with the documented
`X-Session-API-Key` header. The host path is never transmitted: every
conversation is bound to the fixed container path `/workspace/project`.

The bridge creates every conversation with `AlwaysConfirm`. Before accepting a
pending `ActionEvent`, a deterministic deny-by-default effect policy rejects Git
push/remote mutation, network clients, cloud metadata or private addresses,
workspace escape, privilege escalation and destructive commands. Rejection is
followed by a pause; unknown actions fail closed. This policy complements the
container boundary and does not replace it. The bridge uses native conversation
events and pause-on-timeout, and never deletes a conversation automatically. A
completed conversation yields a SHA-256 event-log reference; diff and test
artifacts must also be supplied before Codex can issue a production-grade
verification verdict.

The service is not started by the normal runtime and fails closed unless every
required value is provided. It binds to loopback by default:

```text
RONOR_OPENHANDS_AGENT_SERVER_URL=http://127.0.0.1:8000
RONOR_OPENHANDS_SESSION_API_KEY=
RONOR_OPENHANDS_LLM_MODEL=
RONOR_OPENHANDS_LLM_BASE_URL=
RONOR_OPENHANDS_BRIDGE_TOKEN=
RONOR_AUTOMATION_CAPABILITY_KEY=
RONOR_OPENHANDS_NONCE_DIR=/var/lib/ronor-nonces
RONOR_AUTOMATION_NONCE_DIR=/absolute/host/path/owned-by-10001
RONOR_OPENHANDS_BRIDGE_HOST=127.0.0.1
RONOR_OPENHANDS_BRIDGE_PORT=3001
```

The Agent Server receives its session credential, model-gateway credential and
persistence-encryption key only from Docker secret files named
`openhands_session_key`, `openhands_llm_api_key` and `openhands_secret_key`.
The wrapper refuses startup when any file is missing or empty, exports the
official `SESSION_API_KEY`, `LLM_API_KEY` and `OH_SECRET_KEY` variables only
inside the container process, and then starts the pinned Agent Server. Secret
values are never placed in Compose environment declarations or committed env
files. `LLM_MODEL` and the restricted gateway URL are non-secret routing data.

The native client permits plaintext only for loopback and the exact
`openhands-agent` service name on the internal Compose network. Every other
endpoint requires HTTPS; URL credentials, query strings, fragments and base
paths are rejected, and redirects remain disabled.

`npm run automation:openhands-bridge` starts only this bridge after the Agent
Server readiness probe passes. Container isolation, credential-free worktrees
and default-deny egress remain mandatory before enabling live execution.

`GET /api/runtime/control/automation/readiness` performs an architect-only,
authenticated probe of LangGraph, OpenHands, Codex and Victoria. Readiness is
true only when each endpoint declares its exact protocol, service identity and
required capability. The proof is cached for at most 30 seconds, is keyed to the
complete private configuration fingerprint, is invalidated on probe failure or
configuration change, and exposes only timestamps and bounded state labels.
Every execution request performs a fresh attestation before claiming its lease.

The bridge consumes every capability nonce with atomic exclusive file creation
in a dedicated persistent host directory mounted only into the bridge. The
operator pre-creates that directory for uid/gid 10001; the container receives
no permission to change host ownership. Replay therefore remains blocked across
process and container restarts; an unavailable nonce store fails closed before
OpenHands is called. Adapter summaries and evidence are screened for secret-like
material at both the bridge and runtime ingress boundaries.

Before calling the bridge, the runtime resolves the worktree and approved root
to canonical paths, refuses links and path escapes, verifies that the directory
is the Git toplevel, rejects `main` and `master`, enforces the branch namespace,
origin and optional base commit, and requires a clean starting tree. The actual
branch must equal the branch declared by the request. Inspection failures return
a bounded reason code without filesystem or remote details.

An active run can be cancelled only through the architect route
`POST /control/automation/runs/:runId/cancel`. The request is bound to its
mission and produces an `AbortSignal` that propagates to LangGraph, OpenHands
and Codex HTTP calls. The OpenHands adapter also sends an authenticated,
capability-bound `POST /v1/cancel`; the bridge aborts the matching active
assignment and pauses its already-created Agent Server conversation. A broken
HTTP connection remains an additional best-effort cancellation signal. Cancellation is
distinct from adapter timeout and never
claims to roll back local effects that completed before the signal arrived.
The propagated signal also includes the mandate deadline, so an in-flight
adapter or allowlisted test is interrupted when approved runtime expires. A zero
or exhausted cost envelope stops OpenHands or Codex before invocation; reported
spend is checked again after every paid stage.

`POST /control/automation/run` acknowledges an admitted mandate with HTTP `202`
and its deterministic `run_id` after the durable lease and initial `queued`
Fabric event exist. Execution then continues under that lease independently of
the browser request. CONTROL follows the mission Fabric, allowing Merlin to
observe or cancel a live run without keeping one long HTTP connection open.
`GET /control/automation/runs/:runId?mission_id=...` returns a safe durable
projection without mandate JSON, lease tokens or owner identity. Cancellation
is committed to the run ledger before the in-memory `AbortSignal` is fired;
the active lease is revoked and the same mandate can never resurrect that run
after a process restart.

Codex signs every verification verdict with a short-lived Ed25519 receipt bound to
the mission id, verdict and SHA-256 digest of the exact evidence envelope.
Victoria has a separate service identity and token and accepts a verdict only
after independently validating that receipt and re-reading the artifact hashes.
Only Codex receives `codex_receipt_private_key`; Victoria receives the matching
`assurance_receipt_public_key`, so Victoria can verify but cannot forge a Codex
verdict. Neither key is exposed to CONTROL, LangGraph, OpenHands or the runtime.

Post-OpenHands Git inspection and allowlisted tests execute in the dedicated
`automation-evidence-runner`, not in the production runtime. Its worktree mount
is read-only, its root filesystem is read-only, it has no model, GitHub, SSH,
cloud or runtime credential, and it joins only the internal automation-control
network. The runtime sends only opaque run/assignment ids and a `run_tests`
boolean; workspace paths and command definitions remain server-side. The
sidecar returns bounded artifact references and SHA-256 digests, which the
runtime independently re-reads from the artifact volume before Codex receives
them.

After every completed OpenHands assignment, RONOR independently invokes Git in
the validated worktree and captures the binary diff and porcelain status. The
files are written atomically beneath the pre-existing artifact root, bounded to
2 MiB each, and represented in Mission Fabric and the Codex request only by
relative reference, byte count and SHA-256 digest. Existing evidence is reused
only when its digest matches; collisions, symlinks, path escapes and oversized
outputs fail the run before verification.

The first accepted LangGraph plan is stored as a Fabric checkpoint. On restart,
the same mandate and deterministic run id reuse that plan, skip tasks already
marked complete, re-hash their authoritative artifacts and continue from the
next assignment. A Victoria PASS is returned idempotently without invoking any
adapter. Failed attempts are counted against `max_fix_cycles`; exceeding the
ceiling blocks further resume attempts.

Immediately before Codex verification, every artifact is reopened from the
authoritative artifact root. RONOR rechecks reference containment, symlink
status, byte count, SHA-256 and DLP policy. Codex receives a typed manifest with
separate worker claims and verified artifact descriptors; concatenated evidence
strings and unverified worker paths are not accepted by the live route. Any
post-capture modification terminates the run with `artifact_integrity_failed`.

Mission Fabric projects bounded `run.status_changed`, `run.cancel_requested`
and `evidence.added` events. CONTROL polls only the selected mission, displays
the accumulated LangGraph, OpenHands, Codex and Assurance stage states,
approvals, artifact references and failures, and stops polling on a terminal
state. Rendering uses `textContent`; artifact bodies and credentials are never
placed in the browser response.

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

## Isolated automation composition

`docker-compose.automation.yml` is an opt-in plane, separate from production
and never started by normal RONOR deployment. It pins OpenHands Agent Server to
`1.42.1-python`, publishes control ports on loopback only, drops every Linux
capability, and uses non-root identities, read-only filesystems, bounded
resources and `no-new-privileges`.

Only OpenHands receives a writable mount: a dedicated Git worktree on the
approved branch. Codex and Victoria see artifacts read-only. No service mounts
the Docker socket, SSH agent, home directory, Tailscale socket, GitHub
credential store or production environment. Host credentials therefore cannot
be used to push, merge or deploy.

Secrets live outside Git under `RONOR_AUTOMATION_SECRET_DIR`; RONOR services
consume Docker secret files through `*_FILE`. The upstream Agent Server's
session key is supplied from ignored, permission-restricted `.env.automation`,
never Compose or Mission Fabric. Each service identity must be distinct.

The `automation-control` and `ronor-model-egress` networks are internal.
OpenHands and Codex join only `ronor-model-egress`; neither receives a general
Internet route. A small RONOR reverse proxy is the sole dual-homed component:
it joins the internal network and `ronor-model-uplink`, validates one configured
HTTPS hostname, authenticates the gateway credential and permits only
`/v1/responses`, `/v1/chat/completions` and `/v1/models`. It rejects query
strings, redirects, arbitrary paths, plaintext upstreams, IP-literal targets
and oversized responses. A generic Internet-connected agent bridge does not
meet this policy.

An operator may explicitly set `RONOR_MODEL_GATEWAY_ALLOW_TAILSCALE=true` only
when the configured upstream is an IPv4 address inside Tailscale's
`100.64.0.0/10` range and the peer identity has been verified. This exception
admits HTTP because the transport is already protected by Tailscale/WireGuard;
it does not admit RFC1918, link-local, metadata or arbitrary plaintext hosts.

Every automation service has an authenticated in-container healthcheck. The
OpenHands bridge starts only after Agent Server is healthy, eliminating the
one-shot startup race without enabling automatic restart loops. Health probes
read their identities from mounted secret files or the Agent Server process
environment and never embed credential values in the Compose definition.

The runtime and automation projects share only the externally declared
`ronor-automation-control` network. It must be created explicitly with Docker's
`--internal` flag; Compose never creates a broadly routed substitute. Production
joins it only when the separate `docker-compose.automation-runtime.yml` override
is supplied. That override mounts the dedicated repository clone read-only for
policy inspection/diff capture and the artifact directory read-write; it never
mounts credentials or the Docker socket. Use a self-contained clone rather than
a linked Git worktree whose `.git` file points outside the mounted boundary.
`Dockerfile.automation-runtime` derives from an explicitly pinned, already
verified RONOR image and adds the Git CLI only for fixed-argument workspace
inspection and artifact capture. The constitutional production Dockerfile is
unchanged, and the opt-in derivative receives no Git credentials.
Use service DNS inside the runtime:

```text
RONOR_LANGGRAPH_URL=http://langgraph:2024
RONOR_OPENHANDS_URL=http://openhands-bridge:3001
RONOR_CODEX_VERIFIER_URL=http://codex-verifier:3002
RONOR_ASSURANCE_URL=http://victoria-assurance:3003
```

Safe static validation (nothing is started):

```text
docker compose --env-file .env.automation -f docker-compose.automation.yml config
npm run typecheck
npm test -- --runInBand tests/runtime/automation-container-policy.test.ts
```

Activation is separately human-approved. Record the base commit/worktree,
verify network policy and secret-file permissions, then require authenticated
health attestation. On failure, stop the composition, rotate its identities and
retain artifacts for audit. Production, `main`, releases and deployments remain
outside this composition.

### Direct contact in CONTROL

The Architect uses **CONTROL → Switchboard** rather than service ports or SSH:

- **LangGraph + PLANIFICĂ/EXPLICĂ** calls the authenticated planning adapter,
  creates an auditable Mission Fabric record and returns the exact assignments
  and action classes. It never grants execution authority.
- **OpenHands + DELEGĂ** creates the mission and one bounded execution mandate,
  then runs the isolated implementer, allowlisted tests, independent Codex
  verification and Victoria assurance. Submitting the form is the architect
  approval for that envelope; there are no repeated prompts for actions already
  inside it.
- **Codex** remains evidence-driven and independent. CONTROL deliberately does
  not turn the verifier into an implementation chatbot.

Workspace path and branch come from server policy
(`RONOR_AUTOMATION_WORKTREE` and `RONOR_AUTOMATION_BRANCH`), not browser input.
The UI never receives service tokens, model keys, host credentials or raw
artifact contents. Push, merge, release, deployment, production access,
external send, secret reads and destructive actions remain outside the mandate.
