"""Bani: toate calculele se fac în Decimal, cu rotunjire declarată.

Niciun float nu intră în registru. Valorile vin ca text sau numere și sunt
convertite prin str() ca să nu moștenească erorile binare ale lui float.
"""
from __future__ import annotations

from decimal import ROUND_HALF_EVEN, Decimal, InvalidOperation

CENT = Decimal("0.01")
RATE = Decimal("0.0001")


def D(value) -> Decimal:
    """Convertește o valoare în Decimal. None rămâne None; nu se inventează 0."""
    if value is None:
        raise ValueError("valoare lipsă: folosește unknown.guard_price, nu 0")
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value).strip().replace(",", "."))
    except (InvalidOperation, AttributeError) as exc:
        raise ValueError(f"valoare nenumerică: {value!r}") from exc


def eur(value) -> Decimal:
    """Rotunjire la cent, bancară (ROUND_HALF_EVEN)."""
    return D(value).quantize(CENT, rounding=ROUND_HALF_EVEN)
