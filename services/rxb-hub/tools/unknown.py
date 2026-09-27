"""Picior fără preț = unknown, niciodată 0.

Reguli:
- None, șir gol sau un marcaj explicit de substituent -> unknown.
- Valorile-substituent cunoscute din foile operatorilor (0,20, cazul h10 din
  26.09.2026) -> unknown. Lista e în config și e deliberat scurtă.
- 0 € este un preț REAL (CBC int4 = 0 €; prețuri zero sau negative pe DAM).
  Nu este tratat ca lipsă.
"""
from __future__ import annotations

from decimal import Decimal

from tools.money import D

PLACEHOLDER_VALUES = frozenset({Decimal("0.20")})


def is_unknown(price, placeholder: bool = False) -> bool:
    if placeholder or price is None:
        return True
    if isinstance(price, str) and price.strip() in ("", "?", "-", "n/a", "unknown"):
        return True
    try:
        return D(price) in PLACEHOLDER_VALUES
    except ValueError:
        return True


def guard_price(price, route: str, hour: int, placeholder: bool = False) -> dict:
    if is_unknown(price, placeholder):
        return {"mode": "hold", "reason": f"{route} h{hour}: preț lipsă -> unknown, nu se execută"}
    return {"mode": "ok", "price": D(price)}
