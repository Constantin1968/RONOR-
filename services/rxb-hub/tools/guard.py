"""Garda de nominalizare (rxb-nomination-guard), după regulile din 27–28.09.2026.

O oră NU se nominalizează dacă:
- nu există drepturi sau MW nominalizați > MW deținuți (zero fără drepturi);
- prețul unui picior e unknown (11–13 pe 28.09, cu 0,20 substituent);
- prețul unui picior e suspect și neverificat (UA 1,70 pe int16, 28.09);
- ora depinde de o vânzare intraday încă nerealizată (17–24 pe 28.09);
- piciorul MD al rutei de tranzit are drepturi 0 (licitația MD pierdută).
Drepturile deținute fără nominalizare sunt corecte: CBC e deja sunk.
"""
from __future__ import annotations

from tools.money import D
from tools.unknown import is_unknown


def check_hour(hour: int, rights_mw, nominate_mw, prices: dict, suspect: set | None = None,
               needs_intraday: bool = False, md_leg_rights_mw=None) -> dict:
    suspect = suspect or set()
    if rights_mw is None or D(rights_mw) <= 0:
        return {"hour": hour, "ok": False, "reason": "fără drepturi"}
    if D(nominate_mw) > D(rights_mw):
        return {"hour": hour, "ok": False, "reason": f"nominalizare {nominate_mw} > drepturi {rights_mw}"}
    if md_leg_rights_mw is not None and D(md_leg_rights_mw) <= 0:
        return {"hour": hour, "ok": False, "reason": "piciorul MD are 0 MW: tranzitul nu există"}
    for leg, p in prices.items():
        if is_unknown(p):
            return {"hour": hour, "ok": False, "reason": f"{leg}: preț unknown"}
        if leg in suspect:
            return {"hour": hour, "ok": False, "reason": f"{leg}: preț suspect {p}, se verifică întâi"}
    if needs_intraday:
        return {"hour": hour, "ok": False, "reason": "depinde de o vânzare intraday nerealizată"}
    return {"hour": hour, "ok": True}
