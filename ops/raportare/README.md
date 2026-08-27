# ops/raportare — situation reporting with provenance

The three daily situation reports (opening, closing, weekly tasks) are produced
by this pipeline. It replaces a single hand-written script that lived in one
copy on one host, outside any repository, and that reported numbers without
saying where they came from.

## Contract

**No figure is reported without provenance.** Every measurement carries four
fields: the value, the exact command or request that produced it, the time it
was taken, and a confidence grade — `verificat` (measured directly),
`derivat` (computed from measurements), or `neverificat` (could not be
measured, with the reason stated). What cannot be measured is marked, never
omitted and never estimated.

## Pipeline

| Stage | File | Output |
| --- | --- | --- |
| Collect | `colector.py` | a census as JSON |
| Render | `randare.py` | the report text |
| Deliver | `trimite.py` | Telegram and e-mail |

Each stage runs standalone. `--sec` performs a dry run: it collects and renders
but delivers nothing, which is how any change to the pipeline should first be
inspected.

Delivery deliberately imports `send_telegram` and `send_email` from the
pre-existing reporter rather than reimplementing them, so there is exactly one
implementation of delivery and one place where its credentials are read.

## Probe types

`inventar.json` declares every critical service and how its health is proved.
A container being `running` is not evidence that its service works, so each
entry names a probe:

| Probe | Evidence it produces |
| --- | --- |
| `container` | the container is running (used only where nothing better exists) |
| `http` | an HTTP response, optionally requiring a named key in the JSON body |
| `antet` | an HTTP response to an authenticated request, key read from the environment by name |
| `pagina` | a web interface serves its own markup marker — asserts the interface only, not the API behind it |
| `exec` | a command inside the container returns expected text (`pg_isready`, `redis-cli ping`) |
| `lucrator` | a service with no HTTP listener: the process is alive and its last log line is recent |

`asteptat_cheie` exists because of a real failure: an application whose
catch-all route served its single-page app on every unknown path returned
`200` for eleven invented health endpoints. A status code from a catch-all
proves nothing; the probe must find a key in a JSON body.

An unknown probe type is reported as `neverificat`. There is no implicit
fallback, so a typo in the inventory cannot be silently treated as HTTP.

## Deliberately stopped containers

A stopped container is a finding only if nobody meant to stop it.
`oprite_deliberat` lists names, name prefixes, and name suffixes that are
expected to be down, and `motive` must state a reason for every one of them —
enforced by the tests. `sarcini_efemere` lists run-to-completion jobs whose
`restart: "no"` is deliberate, so they are exempt from the restart-policy check.

## Credentials

No credential appears in any file here. `cheie_din_mediu` names an environment
variable; the value is read at run time. The tests assert that no file contains
a literal of credential shape.

## Verification

`tests/ops/raportare.test.ts` runs in CI and enforces the contract above:
probe types match their implementation, every probe carries the fields it
needs, every deliberately stopped entry has a stated reason, provenance fields
exist, and no secret is embedded. The pipeline is Python, but its gate is here.
