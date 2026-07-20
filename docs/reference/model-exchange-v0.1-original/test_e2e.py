#!/usr/bin/env python3
"""RONOR Model Exchange v0.1 — end-to-end test suite."""
import json
import urllib.request

BASE = "http://localhost:3900"
PASS, FAIL = 0, 0


def post(path, body):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, json.load(e)


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=30) as r:
        return r.status, json.load(r)


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  PASS  {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}  {detail}")


print("== T1: calculation → deterministic core, pinned by P3 ==")
s, d = post("/api/query", {"query": "What is (1284.5 * 7.2) / 3.14 + 250?", "task_type": "calculation"})
check("HTTP 200", s == 200, s)
check("deterministic selected", d.get("model", {}).get("id") == "ronor/deterministic-core", d.get("model"))
check("P3 pin flagged", any(x.get("pinned_by_policy") for x in d["routing"]["scores"]))
check("zero cost", d["cost"]["this_request_usd"] == 0)
check("100% verified", d["assurance"]["verified_confidence"] == 100)
check("answer contains value", "3195" in d["answer"], d["answer"][:100])

print("== T2: sovereign confidentiality → only sovereign engines ==")
s, d = post("/api/query", {"query": "What is 42 * 1911?", "task_type": "calculation", "confidentiality_level": "sovereign"})
check("HTTP 200", s == 200, s)
check("only deterministic eligible", len(d["routing"]["scores"]) == 1)
check("P1 rule applied", any(e["rule"] == "P1_SOVEREIGN_ONLY" for e in d["policy"]["evaluations"]))
check("answer 80262", "80262" in d["answer"], d["answer"][:100])

print("== T3: sovereign + reasoning → rejected (no sovereign generative engine) ==")
s, d = post("/api/query", {"query": "Explain quantum computing.", "task_type": "reasoning", "confidentiality_level": "sovereign"})
check("HTTP 422", s == 422, s)
check("status rejected", d.get("status") == "rejected")
check("trace issued", bool(d.get("trace_id")))

print("== T4: Anthropic-only allowlist → simulated Claude response ==")
s, d = post("/api/query", {"query": "Summarize the case for provider-neutral AI orchestration.", "task_type": "summarization", "allowed_providers": ["Anthropic"]})
check("HTTP 200", s == 200, s)
check("claude selected", d["model"]["id"] == "anthropic/claude-sonnet-4", d.get("model"))
check("flagged simulated", d["model"]["simulated"] is True)
check("assurance caps simulated at 50", d["assurance"]["verified_confidence"] <= 50)

print("== T5: max_cost = 0.0001 → OpenAI/Anthropic excluded by P6 ==")
s, d = post("/api/query", {"query": "What is 5 + 5?", "task_type": "calculation", "max_cost": 0.0001})
check("HTTP 200", s == 200, s)
check("deterministic only", d["model"]["id"] == "ronor/deterministic-core")
p6 = next((e for e in d["policy"]["evaluations"] if e["rule"] == "P6_COST_CEILING"), None)
check("P6 excluded generative engines", p6 is not None and len(p6["excluded"]) == 2, p6)

print("== T6: max_latency=100 for reasoning → rejected ==")
s, d = post("/api/query", {"query": "Explain inflation.", "task_type": "reasoning", "max_latency": 100})
check("HTTP 422 rejected", s == 422 and d["status"] == "rejected", (s, d.get("status")))

print("== T7: calculation with non-computable query → deterministic fails, falls back to OpenAI ==")
s, d = post("/api/query", {"query": "Calculate the compound annual growth rate concept and explain what it means", "task_type": "calculation"})
check("HTTP 200", s == 200, s)
atts = d["routing"]["fallback_attempts"]
check("first attempt deterministic failed", atts[0]["model_id"] == "ronor/deterministic-core" and not atts[0]["ok"], atts)
check("fell back to another engine", d["model"]["id"] != "ronor/deterministic-core", d["model"])

print("== T8: validation errors ==")
s, d = post("/api/query", {"query": ""})
check("empty query → 400", s == 400, s)
s, d = post("/api/query", {"query": "hi", "task_type": "banana"})
check("bad task_type → 400", s == 400, s)

print("== T9: registry endpoint ==")
s, d = get("/api/registry")
check("HTTP 200", s == 200)
check("3 models", len(d["models"]) == 3)
check("weights exposed", "quality" in d["weights"])

print("== T10: traces + costs ledgers ==")
s, d = get("/api/traces?limit=50")
check("traces recorded", len(d["traces"]) >= 7, len(d["traces"]))
check("hash chain present", all(t.get("hash") and t.get("prev_hash") for t in d["traces"]))
s, d = get("/api/costs")
check("total requests > 0", d["total_requests"] > 0)
check("by_model populated", len(d["by_model"]) >= 2, list(d["by_model"].keys()))

print(f"\n===== RESULT: {PASS} passed, {FAIL} failed =====")
exit(1 if FAIL else 0)
