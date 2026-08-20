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

