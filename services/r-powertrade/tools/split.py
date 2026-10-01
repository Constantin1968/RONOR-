"""Împărțirea banilor, după canonul v0.1.0.

1. UA implicat oriunde pe rută (UA-RO, RO-UA, UA-MD-RO, RO-MD-UA, UA-MD):
   50% Yunex / 50% felia RO; felia RO -> Encon Group 50% / NrgPath 50%,
   adică Yunex 50% / Encon Group 25% / NrgPath 25%, INCLUSIV pe tranzitul
   prin MD. Encon Group = Encon + WATT (WATT e afiliatul Encon și e în
   interiorul grupului); felia Encon Group se înregistrează pe „encon”.
   Corecția din 01.10.2026 („scos partea Watt de pe tranzit”) înlocuiește
   atribuirea pe WATT din 28.09.2026. Totalul Encon Group nu se schimbă.
2. RO<->MD pur, fără UA: WattMD 50% / NrgPath 50%. Este singura linie WATT separată.
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
    # md_transit se păstrează în semnătură pentru trasabilitate; cotele sunt
    # aceleași pe tranzit și pe rutele directe (corecția din 01.10.2026).
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


def encon_group(split: dict) -> Decimal:
    """Encon Group = Encon + WATT (afiliat)."""
    return split.get("encon", Decimal(0)) + split.get("wattmd", Decimal(0))
