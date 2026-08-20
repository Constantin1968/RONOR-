# RONOR Mission State Fabric v1

The Mission State Fabric is the vendor-neutral, persistent collaboration contract
for RONOR agents. Conversation history is not authoritative state. Codex,
LangGraph, OpenHands, RONOR-native agents and human operators all publish bounded
events to the same mission stream.

## Guarantees

- append-only events with a SHA-256 integrity chain;
- optimistic concurrency through `expected_version`;
- deterministic projections for tasks, evidence, coverage, failures,
  checkpoints, approvals and messages;
- actor attribution across human and machine surfaces;
- 16 KiB event limit and rejection of secret-like fields;
- backward-compatible upgrade of existing mission records;
- an integrity result on every read and successful append.

## HTTP contract

Read current state:

```http
GET /api/runtime/missions/:id/fabric
Authorization: Bearer <operator credential>
```

Append one event:

```http
POST /api/runtime/missions/:id/fabric/events
Authorization: Bearer <operator credential>
Content-Type: application/json

{
  "expected_version": 0,
  "actor": { "kind": "langgraph", "id": "control-plane" },
  "type": "task.upserted",
  "payload": {
    "id": "task-1",
    "title": "Implement the OpenHands adapter",
    "status": "ready"
  }
}
```

Supported actor kinds are `human`, `ronor`, `codex`, `langgraph`, `openhands`
and `agent`. Supported event types are:

- `task.upserted`
- `task.status_changed`
- `evidence.added`
- `coverage.updated`
- `failure.recorded`
- `checkpoint.created`
- `approval.required`
- `approval.resolved`
- `message.recorded`

A stale writer receives HTTP `409 version_conflict`; it must read the current
projection, reconcile its proposed event and retry with the new version. Agents
must never retry blindly.

## Adapter boundary

LangGraph owns workflow transitions but records them as fabric events. OpenHands
owns code execution inside its sandbox but records tasks, checkpoints, failures
and messages here. Codex independently records verification evidence and review
decisions. RONOR remains the authority: external frameworks can be replaced
without losing institutional state.

Event payloads must contain a bounded string `id`. Credentials, tokens,
passwords, private keys and API keys are forbidden. Evidence payloads should
store references and digests; large or sensitive artefacts belong in the
evidence store/R2 and are never embedded in mission state.
