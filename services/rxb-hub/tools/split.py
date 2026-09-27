"""Împărțirea banilor, după canonul v0.1.0.

1. UA implicat oriunde pe rută (UA-RO, RO-UA, UA-MD-RO, RO-MD-UA, UA-MD):
   50% Yunex / 50% felia RO; felia RO -> Encon 50% / NrgPath 50%.
   Pe tranzit prin MD, partea NrgPath se împarte 50/50 cu WattMD (subJV).
   DE CONFIRMAT: interpretarea „subJV NrgPath/WattMD 50/50 pe tranzit MD”
   ca împărțire a părții NrgPath (25% -> 12,5% + 12,5%), Encon neatins.
2. RO<->MD pur, fără UA: WattMD 50% / NrgPath 50%.
3. Provizionul CBAM NU intră aici: e separat, în afara P/L (tools/provision.py).

Pierderile se împart după aceleași cote. Suma cotelor este exact brutul;
restul de rotunjire la cent merge la ultima cotă, ca să nu se piardă bani.
"""
from __future__ import annotations

from decimal import Decimal

from tools.money import D, eur

PARTIES = ("yunex", "encon", "nrgpath", "wattmd")


def legs(route: str) -> list[str]:
    return [z.strip().upper() for z in route.replace(">", "-").split("-") if z.strip()]


def involves_ua(route: str, origin: str | None = None) -> bool:
    return "UA" in legs(route) or (origin or "").upper() == "UA"


def transits_md(route: str) -> bool:
    z = legs(route)
    return "MD" in z[1:-1]


def is_pure_ro_md(route: str, origin: str | None = None) -> bool:
    return set(legs(route)) == {"RO", "MD"} and not involves_ua(route, origin)


def _alloc(total: Decimal, shares: dict[str, Decimal]) -> dict[str, Decimal]:
    out = {p: Decimal("0.00") for p in PARTIES}
    keys = [k for k, v in shares.items() if v != 0]
    running = Decimal(0)
    for k in keys[:-1]:
        out[k] = eur(total * shares[k])
        running += out[k]
    if keys:
        out[keys[-1]] = eur(total) - running
    return out


def split_ua_route(brut, md_transit: bool = False) -> dict[str, Decimal]:
    half = Decimal("0.5")
    quarter = Decimal("0.25")
    if md_transit:
        eighth = Decimal("0.125")
        shares = {"yunex": half, "encon": quarter, "nrgpath": eighth, "wattmd": eighth}
    else:
        shares = {"yunex": half, "encon": quarter, "nrgpath": quarter}
    return _alloc(D(brut), shares)


def split_pure_md(brut) -> dict[str, Decimal]:
    return _alloc(D(brut), {"wattmd": Decimal("0.5"), "nrgpath": Decimal("0.5")})


def split_for(route: str, brut, origin: str | None = None) -> dict:
    if involves_ua(route, origin):
        rule = "ua-md-tranzit" if transits_md(route) else "ua"
        return {"rule": rule, "split": split_ua_route(brut, md_transit=transits_md(route))}
    if is_pure_ro_md(route, origin):
        return {"rule": "ro-md-pur", "split": split_pure_md(brut)}
    raise ValueError(f"rută fără regulă de împărțire în canon: {route} (origine {origin})")
