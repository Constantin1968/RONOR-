"""Potențialul executabil al unei zile, cu plafon, cost scufundat și provizion.

Fiecare rând este o rută pe o oră:
  {"hour", "route", "origin", "rights_mw", "margin_mwh", "cbc"}
- margin_mwh = vânzare − prag; pragul include deja costul capacității (CBC),
  deci CBC se plătește separat DOAR pe MW câștigați și nefolosiți (cost scufundat).
- Volumul executabil = min(drepturi, plafon). Plafonul vine din tools/crisis.py.
- Provizionul CBAM se calculează pe MWh executați care intră în RO și rămâne
  în afara profitului (tools/provision.py).

Rezultatul este un scenariu condiționat: dacă o intrare din care s-a calculat
marja nu are status real, potențialul nu susține nominalizarea.
"""
from __future__ import annotations

from decimal import Decimal

from tools.crisis import cap_for
from tools.money import D, eur
from tools.provision import provision_for


def potential(rows: list[dict], crisis: bool = True, strict: bool = False) -> dict:
    out = []
    gross = sunk = prov = Decimal("0.00")
    for r in rows:
        rights = D(r["rights_mw"])
        cap = cap_for(r["hour"], strict) if crisis else rights
        mw = min(rights, cap)
        unused = rights - mw
        g = eur(mw * D(r["margin_mwh"]))
        s = eur(unused * D(r["cbc"]))
        p = provision_for(r["route"], r.get("origin", "UA"), mw)
        gross += g
        sunk += s
        prov += p
        out.append({"hour": int(r["hour"]), "route": r["route"], "exec_mw": mw, "unused_mw": unused,
                    "gross": g, "sunk_cbc": s, "provision": p})
    net = eur(gross - sunk)
    return {"rows": out, "gross": eur(gross), "sunk_cbc": eur(sunk), "net": net,
            "ro_slice_gross": eur(gross / 2), "provision_outside_pl": eur(prov),
            "rule": "fără plafon" if not crisis else ("propunere 8 strict (neaprobată)" if strict else "regula în vigoare")}
