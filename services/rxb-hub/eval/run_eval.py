"""Evaluarea cazurilor înghețate. Iese cu cod 1 dacă un prag nu e atins.

Pragurile care cer istoric (cbc_mape, pl_vs_perfect) se raportează ca
„neevaluat” până există istoric; NU se raportează ca trecute.
"""
from __future__ import annotations

import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from orchestrator.engine import close_day  # noqa: E402
from tools.cbc import effective_cbc  # noqa: E402
from tools.limits import below_breakeven, floor_ok, verdict  # noqa: E402
from tools.money import D  # noqa: E402
from tools.unknown import status_of  # noqa: E402
from tools.guard import check_hour  # noqa: E402
from tools.provision import provision_for  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))


def check_guard(c: dict) -> list[tuple[str, bool, str]]:
    res = []
    for h in c["hours"]:
        r = check_hour(h["hour"], h["rights"], h["nominate"], h["prices"], set(h.get("suspect", [])),
                       h.get("needs_intraday", False), h.get("md_leg_rights"))
        res.append((h["name"], r["ok"] == h["ok"], r.get("reason", "nominalizabil")))
    e = c["expect_expected_provision"]
    got = provision_for("UA-RO", "UA", e["mwh"])
    res.append(("provizion așteptat 28.09", got == D(e["provision"]), str(got)))
    return res


def check_file(path: str) -> list[tuple[str, bool, str]]:
    c = json.load(open(path, encoding="utf-8"))
    if "hours" in c:
        return check_guard(c)
    res = []
    k = c["int7_excluded"]
    v = verdict(k["sell"], k["cost"], k["cbc"])
    res.append(("int7 exclus", v["mode"] == "exclude", v["mode"]))
    k = c["int4_cbc_effective"]
    e = effective_cbc([tuple(t) for t in k["tranches"]])
    res.append(("int4 CBC efectiv", e == D(k["expect"]), str(e)))
    k = c["h10_placeholder"]
    ok = status_of(k["first"]) == "substitute" and status_of(k["then"]) == "real" and status_of(k["real_020"]) == "real"
    res.append(("h10 substituent marcat -> blocat; 0,20 real -> acceptat", ok, f"{k['first']} -> {k['then']}"))
    hits = [floor_ok(s, f) for s, f in c["floors"]]
    res.append(("floor-uri bătute", all(hits), f"{sum(hits)}/{len(hits)}"))
    k = c["h1_below_breakeven"]
    res.append(("h1 sub breakeven", below_breakeven(k["cost"], k["breakeven"]), "semnalat"))
    k = c["close_27_09"]
    d = close_day(k["positions"], k["ro_cumulative_before"])
    exp = k["expect"]
    got = {"brut": d["brut"], "provision_outside_pl": d["provision_outside_pl"],
           "ro_slice": d["ro_slice"], "ro_cumulative": d["ro_cumulative"], **d["parties"]}
    bad = {x: str(got.get(x)) for x in exp if got.get(x) != D(exp[x])}
    res.append(("închiderea 27.09", not bad, "exact" if not bad else json.dumps(bad)))
    return res


def main() -> int:
    th = json.load(open(os.path.join(HERE, "thresholds.json"), encoding="utf-8"))
    files = sorted(glob.glob(os.path.join(HERE, "cases", "*.json")))
    if not files:
        print("FAIL: niciun caz înghețat"); return 1
    results = [r for f in files for r in check_file(f)]
    passed = sum(1 for _, ok, _ in results if ok)
    rate = passed / len(results)
    for name, ok, detail in results:
        print(f"{'PASS' if ok else 'FAIL'}  {name}: {detail}")
    print(f"cazuri înghețate: {passed}/{len(results)} (prag {th['frozen_cases_pass_rate']})")
    print("cbc_mape, pl_vs_perfect: neevaluat, lipsește istoricul")
    report = {"frozen_pass_rate": rate, "cases": [{"name": n, "ok": o, "detail": d} for n, o, d in results],
              "unevaluated": ["cbc_mape", "pl_vs_perfect"]}
    os.makedirs(os.path.join(HERE, "reports"), exist_ok=True)
    json.dump(report, open(os.path.join(HERE, "reports", "latest.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)
    return 0 if rate >= th["frozen_cases_pass_rate"] else 1


if __name__ == "__main__":
    sys.exit(main())
