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
