"""Motorul determinist al Etapei 1: tabelul limită/oră și închiderea zilei.

Nicio cifră nu vine dintr-un model de limbaj. Intrările vin din tabelele
postate în grup (NTC, forecast, CBC, vânzări) și sunt înregistrate în registru.
"""
from __future__ import annotations

from decimal import Decimal

from tools.limits import COEF_PIERDERI, SPREAD_MIN, TARIF, brut_mwh, buy_limit_ro
from tools.money import D, eur
from tools.provision import provision_for
from tools.split import split_for
from tools.unknown import is_unknown


def limits_table(forecast_ua: dict, cbc: dict, ntc: dict | None = None,
                 origin: str = "UA", route: str = "UA-RO") -> list[dict]:
    """forecast_ua, cbc, ntc: {oră: valoare}. Oră fără preț sau fără CBC -> unknown."""
    out = []
    for h in range(1, 25):
        p, c = forecast_ua.get(h), cbc.get(h)
        cap = (ntc or {}).get(h)
        row = {"hour": h, "ntc_mw": None if cap is None else D(cap)}
        if is_unknown(p) or c is None:
            row.update(mode="unknown", reason="preț sau CBC lipsă")
        else:
            row.update(mode="ok", buy_limit=buy_limit_ro(p, c),
                       provision_mwh=provision_for(route, origin, 1))
        out.append(row)
    return out


def close_position(route: str, origin: str, volume_mwh, sell, cost, cbc) -> dict:
    b = brut_mwh(sell, cost, cbc)
    brut = eur(b * D(volume_mwh))
    return {"route": route, "volume_mwh": D(volume_mwh), "brut_mwh": b, "brut": brut,
            "provision": provision_for(route, origin, volume_mwh),
            **split_for(route, brut, origin)}


def close_day(positions: list[dict], ro_cumulative_before=None) -> dict:
    closed = [close_position(**p) for p in positions]
    brut = sum((c["brut"] for c in closed), Decimal("0.00"))
    prov = sum((c["provision"] for c in closed), Decimal("0.00"))
    parties: dict[str, Decimal] = {}
    for c in closed:
        for k, v in c["split"].items():
            parties[k] = parties.get(k, Decimal("0.00")) + v
    ro = parties.get("encon", 0) + parties.get("nrgpath", 0) + parties.get("wattmd", 0)
    out = {"positions": closed, "brut": brut, "provision_outside_pl": prov,
           "parties": parties, "ro_slice": eur(ro)}
    if ro_cumulative_before is not None:
        out["ro_cumulative"] = eur(D(ro_cumulative_before) + ro)
    return out


PARAMS = {"tarif": TARIF, "spread_min": SPREAD_MIN, "coef_pierderi": COEF_PIERDERI}
