"""Metricile pe istoric cerute pentru trecerea din Shadow în Gated.

Istoricul se acumulează în umbră, în registru (kind "outcome"), câte un rând pe
rută și oră, cu prognoza și rezultatul real:
  {"cbc_pred", "cbc_actual", "pl_realised", "pl_perfect", "sale", "floor"}

- cbc_mape: media erorii absolute relative a prognozei CBC. Orele cu CBC real 0
  nu intră în medie (nu se poate împărți la 0) și se raportează separat.
- pl_vs_perfect: rezultatul realizat împărțit la rezultatul ideal (privire înapoi),
  pe orele în care rezultatul ideal e pozitiv.
- floor_hit_rate: ponderea vânzărilor la sau peste prag.
- false_cbc_rate: ponderea orelor cu CBC prognozat > 0 unde CBC real a fost
  „fără drepturi” (cbc_actual null cu rights 0).

Sub numărul minim de zile din thresholds.json, metrica e „neevaluat”, niciodată „trecut”.
"""
from __future__ import annotations

from decimal import Decimal

from tools.money import D


def _rate(num: Decimal, den: Decimal):
    return None if den == 0 else (num / den).quantize(Decimal("0.0001"))


def metrics(outcomes: list[dict], min_days: int) -> dict:
    days = sorted({o["day"] for o in outcomes})
    if len(days) < min_days:
        return {"evaluated": False, "days": len(days), "min_days": min_days,
                "reason": f"istoric insuficient: {len(days)} din {min_days} zile"}
    errs, zero_actual = [], 0
    real = perf = Decimal(0)
    hits = sales = 0
    false_cbc = cbc_preds = 0
    for o in outcomes:
        if o.get("cbc_pred") is not None:
            cbc_preds += 1
            if o.get("cbc_actual") is None and D(o.get("rights_mw", "0")) == 0 and D(o["cbc_pred"]) > 0:
                false_cbc += 1
        if o.get("cbc_pred") is not None and o.get("cbc_actual") is not None:
            a = D(o["cbc_actual"])
            if a == 0:
                zero_actual += 1
            else:
                errs.append(abs(D(o["cbc_pred"]) - a) / abs(a))
        if o.get("pl_perfect") is not None and D(o["pl_perfect"]) > 0:
            perf += D(o["pl_perfect"])
            real += D(o.get("pl_realised") or "0")
        if o.get("sale") is not None and o.get("floor") is not None:
            sales += 1
            hits += 1 if D(o["sale"]) >= D(o["floor"]) else 0
    return {"evaluated": True, "days": len(days),
            "cbc_mape": _rate(sum(errs, Decimal(0)), Decimal(len(errs))) if errs else None,
            "cbc_zero_actual_excluded": zero_actual,
            "pl_vs_perfect": _rate(real, perf),
            "floor_hit_rate": _rate(Decimal(hits), Decimal(sales)),
            "false_cbc_rate": _rate(Decimal(false_cbc), Decimal(cbc_preds))}


def gate(m: dict, th: dict) -> dict:
    """Verdictul pentru Gated. Orice metrică lipsă sau neevaluată = nu trece."""
    if not m.get("evaluated"):
        return {"pass": False, "reason": m.get("reason", "neevaluat")}
    checks = {
        "cbc_mape": m["cbc_mape"] is not None and m["cbc_mape"] <= D(th["cbc_mape"]),
        "pl_vs_perfect": m["pl_vs_perfect"] is not None and m["pl_vs_perfect"] >= D(th["pl_vs_perfect"]),
        "floor_hit_rate": m["floor_hit_rate"] is not None and m["floor_hit_rate"] >= D(th["floor_hit_rate"]),
        "false_cbc_rate": m["false_cbc_rate"] is not None and m["false_cbc_rate"] <= D(th["false_cbc_rate"]),
    }
    return {"pass": all(checks.values()), "checks": checks}
