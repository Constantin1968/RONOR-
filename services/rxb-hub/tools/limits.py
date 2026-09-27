"""Limite și spread, după canonul v0.1.0.

limită_cumpărare_RO(h) = (preț_UA(h) − tarif − CBC(h) − spread_min) / coef_pierderi
Parametrii confirmați de Muse pe 27.09.2026: tarif 0,9, spread minim 0,5,
coeficient de pierderi 1,01.
"""
from __future__ import annotations

from decimal import Decimal

from tools.money import D, eur

TARIF = Decimal("0.9")
SPREAD_MIN = Decimal("0.5")
COEF_PIERDERI = Decimal("1.01")


def buy_limit_ro(price_ua, cbc, tarif=TARIF, spread_min=SPREAD_MIN, coef=COEF_PIERDERI) -> Decimal:
    return eur((D(price_ua) - D(tarif) - D(cbc) - D(spread_min)) / D(coef))


def brut_mwh(price_sell, cost_buy, cbc, tarif=TARIF) -> Decimal:
    """Brut pe MWh pe un picior: vânzare − cost − CBC − tarif."""
    return eur(D(price_sell) - D(cost_buy) - D(cbc) - D(tarif))


def verdict(price_sell, cost_buy, cbc, tarif=TARIF, spread_min=SPREAD_MIN) -> dict:
    """Execută doar dacă brutul acoperă spread-ul minim; altfel exclude.

    Cazul int7 din 26.09.2026: cost 168 > RO 161 -> exclus.
    """
    b = brut_mwh(price_sell, cost_buy, cbc, tarif)
    if b <= D(spread_min):
        return {"mode": "exclude", "brut_mwh": b,
                "reason": f"brut {b} €/MWh sub spread-ul minim {spread_min}"}
    return {"mode": "ok", "brut_mwh": b}


def floor_ok(sale_price, floor) -> bool:
    """O vânzare IDM e validă doar la sau peste floor."""
    return D(sale_price) >= D(floor)


def below_breakeven(cost, breakeven) -> bool:
    """Costul acoperit sub breakeven închide riscul overnight (cazul h1)."""
    return D(cost) < D(breakeven)
