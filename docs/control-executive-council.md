# CONTROL · Ma11AI Executive Intelligence Council

CONTROL recognises `Merlin` as the constitutional `architect` identity. The
Architect role is distinct from technical administration: an `admin` credential
cannot access CONTROL management surfaces or delegate executive missions.

Richard Fairchild, the AI Chief Executive Adviser, translates an Architect
objective into a governed mission, RACI allocation and internal communication
draft. The other named identities are synthetic AI agents. They are not people,
employees, statutory directors or regulated professionals.

## Authority boundary

Every management passport declares:

- `statutory_authority: false`;
- `external_send_authority: false`;
- `email_status: proposed`.

The `@ma11ai.com` addresses are design identifiers until the mail domain,
mailboxes, SPF, DKIM, DMARC and Communications Gateway are separately verified.
No code in this slice sends email.

Risk (William), Compliance (Catherine) and Independent Assurance (Victoria)
report directly to Merlin rather than to the executive implementer. A generated
communication remains `draft`, and consequential operations remain outside the
delegation contract: external send, contracts, financial commitments, merge,
release, deployment and destructive actions.

## API

All endpoints require the dedicated `architect` scope:

```text
GET  /api/runtime/management
GET  /api/runtime/management/:id
POST /api/runtime/management/executive/delegate
```

Example delegation body:

```json
{
  "objective": "Rezolvă situația de securitate și fiabilitate a runtime-ului RONOR."
}
```

The authenticated principal supplies authorship. A request body cannot claim to
be Merlin or another agent. The response contains the mission id, accountable,
responsible, consulted and informed identities, the independent verifier, the
consequential gates and an unsent `To/CC` draft. The complete allocation is
recorded in the Mission State Fabric.

## Runtime configuration

`RONOR_ARCHITECT_API_KEY` is loaded only from the deployment secret boundary.
Its hashed identity is labelled `merlin`. It must never be stored in Git, a URL,
browser local storage, an email or mission state.
## CONTROL v1

The Architect surface is served locally at `/control`. Its dedicated API lives
under `/api/runtime/control` and requires both the `architect` role and the
verified `merlin` identity. Operator, administrator, and differently labelled
architect credentials are denied.

The interface provides a sovereign overview, keyboard-first Agent Switchboard,
Executive Intelligence Council, and recent Mission State Fabric activity. The
browser keeps the temporary credential in `sessionStorage` only. Adapter states
are reported honestly: configuration is not presented as a verified connection,
and unavailable agents never return simulated execution.

Richard delegation creates a governed mission and draft communication. It does
not send email, invoke an external adapter, push, merge, release, or deploy.

