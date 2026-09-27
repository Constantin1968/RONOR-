"""CBC: costul capacității transfrontaliere.

- CBC este sunk o singură dată pe oră deținută; tranșele se ponderează cu MW.
- O tranșă fără preț face tot rezultatul unknown (nu se presupune 0).
- F1: două prețuri CBC pentru aceeași zi/oră/rută = risc de plată dublă.
"""
from __future__ import annotations

from collections import defaultdict
from decimal import Decimal

from tools.money import D, eur
from tools.unknown import normalize


def effective_cbc(tranches: list[tuple]) -> Decimal | None:
    """tranches = [(mw, preț), ...]. Cazul int4: [(30, 0.99), (10, 0)] -> 0.74."""
    total_mw = Decimal(0)
    total_cost = Decimal(0)
    for mw, price in tranches:
        # CBC 0 € e real; doar lipsa prețului sau un substituent îl face unknown.
        n = normalize(price) if isinstance(price, dict) else {"value": price, "status": "real" if price not in (None, "") else "missing"}
        if n["status"] != "real":
            return None
        total_mw += D(mw)
        total_cost += D(mw) * D(n["value"])
    if total_mw == 0:
        return None
    return eur(total_cost / total_mw)


def f1_double_pay(rows: list[dict]) -> list[tuple]:
    """rows: dict cu day, hour, route, cbc_price, rights_code.

    Semnalează (day, hour, route) cu mai multe prețuri CBC pe ACELAȘI cod de
    drepturi. Tranșele distincte (coduri diferite) sunt legitime.
    """
    seen: dict[tuple, set] = defaultdict(set)
    for r in rows:
        key = (r["day"], int(r["hour"]), r["route"], r.get("rights_code"))
        seen[key].add(D(r["cbc_price"]))
    return [k[:3] for k, prices in seen.items() if len(prices) > 1]
