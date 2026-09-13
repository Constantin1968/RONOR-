#!/usr/bin/env python3
"""
R-Knowledge Disabled-Mode Equivalence Report
MIP-014 STEP 2 · Phase 5 · Gate G5 (ABSOLUTE)

Compares the disabled-mode and enabled-mode observations captured by
scripts/knowledge-equivalence.sh and emits a machine-readable verdict.

The enabled-mode run is not decoration. It is the control that proves the harness
can DETECT a difference: a comparison that reports "no difference" is worthless
unless it is shown to report a difference when one exists.

F01 (approved): /api/v1 requires requireAuth('read'). Authenticated probes establish
route registration; anonymous probes must see 401 on /api/v1 while /health stays public.
"""

import json
import pathlib
import subprocess
import sys

OUT = pathlib.Path("evidence/knowledge")
BASELINE = "d058544d1c579611cce99cdf2b87a78d7534e75b"
APPROVED_SPINE_HASHES = {
    # Approved gateway/MI9 convergence: the MI9 gate is evaluated on every
    # inference request and the resulting act is deposited in the audit chain,
    # so reported sovereignty is derived from gate 1 instead of asserted.
    "src/orchestrator.ts": "2630262353157928b165facbfdf63c44fb7a9c00",
    # Approved D-1 repair: pure MI9 evaluation plus post-execution accounting.
    "src/governance/mi9-gate.ts": "31ef9f2562254bdca7f871b71e1b7d7be11b90dd",
    # Approved audit-mirror hook: a single fire-and-forget call inside append(),
    # placed after the local insert and before the return. The local chain stays
    # authoritative — hashing, ordering, verification and export are untouched —
    # and the mirror can neither block nor throw into this path.
    "src/audit/hash-chain.ts": "3c2b9e848684c1e6953516a6c8f4f0f794ffc50f",
}

# The baseline plane roster, in order. Recorded as a literal so that a reordering
# or an addition is caught, not merely a count change.
BASELINE_PLANES = [
    "r-gateway",
    "r-context",
    "r-model-fabric",
    "r-agent-runtime",
    "r-execution",
    "r-assurance",
    "r-economics",
    "r-sentinel",
]


def read_json(path):
    return json.loads((OUT / path).read_text())


def read_routes(path):
    result = {}
    for line in (OUT / path).read_text().splitlines():
        if not line.strip():
            continue
        route, code = line.rsplit(" ", 1)
        result[route] = code
    return result


def main():
    disabled = read_json("health-disabled.json")
    enabled = read_json("health-enabled.json")
    routes_disabled = read_routes("routes-disabled.txt")
    routes_enabled = read_routes("routes-enabled.txt")
    routes_anon = read_routes("routes-disabled-anon.txt")
    fs_diff = (OUT / "fs-diff-disabled.txt").read_text().strip()

    checks = []

    def check(ident, description, passed, observed):
        checks.append(
            {
                "id": ident,
                "description": description,
                "result": "PASS" if passed else "FAIL",
                "observed": observed,
            }
        )

    # ── BE-1 · Route set identical to baseline (authenticated probe) ──
    knowledge_routes_disabled = {
        r: c for r, c in routes_disabled.items() if "/knowledge/" in r
    }
    # Every knowledge route must be 404 in disabled mode once past requireAuth.
    # 404 is what an unmounted path returns; any other code would mean a handler exists.
    all_404 = all(code == "404" for code in knowledge_routes_disabled.values())
    check(
        "BE-1",
        "No knowledge route is registered in disabled mode (authenticated probes all return 404)",
        all_404 and len(knowledge_routes_disabled) > 0,
        knowledge_routes_disabled,
    )

    # And EVERY one of the same routes must respond when enabled, or the probe
    # proves nothing. `any` was the weaker form and would have passed while some
    # routes were silently unmounted or mis-probed; `all` is the claim that
    # actually establishes the probe's power to detect a mount.
    knowledge_routes_enabled = {
        r: c for r, c in routes_enabled.items() if "/knowledge/" in r
    }
    all_respond = all(code != "404" for code in knowledge_routes_enabled.values())
    check(
        "BE-1-CONTROL",
        "EVERY knowledge route responds when enabled (authenticated), proving the probe detects a mount",
        all_respond and len(knowledge_routes_enabled) > 0,
        knowledge_routes_enabled,
    )

    # ── BE-2 · Baseline routes unaffected (authenticated where required) ──
    baseline_routes = {
        r: c for r, c in routes_disabled.items() if "/knowledge/" not in r
    }
    baseline_ok = all(
        code in ("200", "204", "304") for code in baseline_routes.values()
    )
    check(
        "BE-2",
        "Every baseline route still responds successfully (auth where /api/v1 requires it; /health public)",
        baseline_ok and len(baseline_routes) > 0,
        baseline_routes,
    )

    # ── BE-F01 · Approved auth hardening on /api/v1 ──
    api_v1_anon = {r: c for r, c in routes_anon.items() if r.startswith("/api/v1")}
    health_anon = routes_anon.get("/health")
    all_401 = all(code == "401" for code in api_v1_anon.values()) and len(api_v1_anon) > 0
    health_public = health_anon == "200"
    check(
        "BE-F01",
        "F01 approved: unauthenticated /api/v1 returns 401; GET /health stays public",
        all_401 and health_public,
        {"api_v1_anonymous": api_v1_anon, "health_anonymous": health_anon},
    )

    # ── BE-3 · Exactly eight planes, in baseline order ──
    disabled_planes = [p["planeId"] for p in disabled["planes"]]
    check(
        "BE-3",
        "GET /health reports exactly the eight baseline planes in order",
        disabled_planes == BASELINE_PLANES,
        {"observed": disabled_planes, "expected": BASELINE_PLANES},
    )

    # The health payload must gain NO key. An absent key, not a null field.
    check(
        "BE-3b",
        "The health payload contains no 'knowledge' key in disabled mode",
        "knowledge" not in disabled,
        {"top_level_keys": sorted(disabled.keys())},
    )
    check(
        "BE-3b-CONTROL",
        "The health payload DOES contain 'knowledge' when enabled",
        "knowledge" in enabled,
        {"top_level_keys": sorted(enabled.keys())},
    )
    # And the plane roster must be unchanged even when ENABLED: R-Knowledge is not
    # in the orchestrator pipeline, so it must not appear in the eight-plane list.
    enabled_planes = [p["planeId"] for p in enabled["planes"]]
    check(
        "BE-3c",
        "The eight-plane roster is unchanged even when R-Knowledge is ENABLED",
        enabled_planes == BASELINE_PLANES,
        {"observed": enabled_planes},
    )

    # ── BE-4 · Status is unaffected by R-Knowledge ──
    #
    # Originally asserted literally as status == "ok". That form conflated two
    # different claims once honest persistence reporting landed: the runtime now
    # reports `degraded` when the sovereign relational register is unconfigured or
    # unreachable, which is true in this harness and has nothing to do with
    # R-Knowledge. The claim the gate actually owns is that the disabled and
    # enabled modes report the SAME status and that no degradation reason is
    # attributable to R-Knowledge — which is strictly stronger on the mode
    # comparison than the old literal check, and silent where it has no standing.
    disabled_reasons = disabled.get("degradation_reasons", [])
    enabled_reasons = enabled.get("degradation_reasons", [])
    knowledge_blamed = any("knowledge" in str(r).lower() for r in disabled_reasons)
    check(
        "BE-4",
        "Runtime status is identical in both modes and no degradation is blamed on R-Knowledge",
        disabled.get("status") == enabled.get("status") and not knowledge_blamed,
        {
            "status_disabled": disabled.get("status"),
            "status_enabled": enabled.get("status"),
            "degradation_reasons_disabled": disabled_reasons,
            "degradation_reasons_enabled": enabled_reasons,
        },
    )

    # ── BE-5 · Empty filesystem diff ──
    check(
        "BE-5",
        "The filesystem is byte-identical before and after a disabled-mode boot",
        fs_diff == "",
        {"diff": fs_diff if fs_diff else "(empty)"},
    )

    # ── Governance spine byte-identity ──
    spine_ok = True
    spine_detail = {}
    for path in [
        "src/orchestrator.ts",
        "src/audit/hash-chain.ts",
        "src/governance/mi9-gate.ts",
    ]:
        baseline_hash = subprocess.run(
            ["git", "rev-parse", f"{BASELINE}:{path}"],
            capture_output=True,
            text=True,
        ).stdout.strip()
        expected_hash = APPROVED_SPINE_HASHES.get(path, baseline_hash)
        current_hash = subprocess.run(
            ["git", "hash-object", path], capture_output=True, text=True
        ).stdout.strip()
        spine_detail[path] = {
            "baseline": baseline_hash,
            "expected": expected_hash,
            "current": current_hash,
            "identical": expected_hash == current_hash,
        }
        if expected_hash != current_hash:
            spine_ok = False
    check(
        "ISO-1",
        "The orchestrator, audit chain and approved MI9 repair match pinned hashes",
        spine_ok,
        spine_detail,
    )

    verdict = "PASS" if all(c["result"] == "PASS" for c in checks) else "FAIL"
    report = {
        "gate": "G5",
        "gate_name": "Disabled-Mode Baseline Equivalence",
        "absolute": True,
        "baseline_commit": BASELINE,
        "verdict": verdict,
        "checks": checks,
    }

    (OUT / "equivalence-report.json").write_text(json.dumps(report, indent=2) + "\n")

    print(f"\n{'ID':<18} {'RESULT':<7} DESCRIPTION")
    print("-" * 96)
    for c in checks:
        print(f"{c['id']:<18} {c['result']:<7} {c['description']}")
    print("-" * 96)
    print(f"GATE G5 VERDICT: {verdict}\n")

    return 0 if verdict == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
