"""Provizion CBAM pe MWh intrat în RO din afara UE.

- 40 €/MWh origine UA, 30 €/MWh origine MD.
- Se aplică DOAR când energia intră în RO (ruta se termină în RO). Exportul
  RO-UA sau RO-MD nu primește provizion.
- Blocat în subcontul Encon, nesplitat, în afara P/L.
"""
from __future__ import annotations

from decimal import Decimal

from tools.money import D, eur
from tools.split import legs

RATES = {"UA": Decimal("40"), "MD": Decimal("30")}
HOLDER = "encon_subcont"


def provision_for(route: str, origin: str, volume_mwh) -> Decimal:
    z = legs(route)
    if not z or z[-1] != "RO":
        return Decimal("0.00")
    return eur(RATES.get((origin or "").upper(), Decimal(0)) * D(volume_mwh))


def settle_provision(provision, cbam_due=None, postponed: bool = False) -> dict:
    """Decontarea provizionului, după canonul v0.1.

    - Amânarea implementării CBAM: provizionul se împarte 50/50 cu UA
      (50% Yunex / 50% felia RO, felia RO 50% Encon / 50% NrgPath).
    - Altfel: se plătește CBAM-ul datorat; excesul peste datorat devine brut
      de împărțit după regula rutei. Un CBAM datorat peste provizion este
      deficit și se semnalează, nu se ascunde.
    - Cât timp CBAM-ul datorat e necunoscut, provizionul rămâne blocat.
    """
    from tools.split import split_ua_route
    p = D(provision)
    if postponed:
        return {"state": "eliberat_amanare", "split": split_ua_route(p)}
    if cbam_due is None:
        return {"state": "blocat", "held": eur(p)}
    due = D(cbam_due)
    if due > p:
        return {"state": "deficit", "deficit": eur(due - p)}
    return {"state": "decontat", "paid": eur(due), "excess_to_brut": eur(p - due)}
