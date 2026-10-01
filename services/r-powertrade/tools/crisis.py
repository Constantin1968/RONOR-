"""Regimul de criză, înghețat pentru 01.10.2026 (atacul asupra infrastructurii energetice UA).

Regula în vigoare (status: regulă înghețată):
- plafon pe interval 10 MW; pe intervalele 8 și 16, plafon obligatoriu 8 MW;
- spread minim dublu: 1,0 în loc de 0,5 (pragurile de vânzare și cumpărare);
- piața intrazilnică numai după câștigul confirmat al pieței pentru ziua următoare;
- seara, intervalele 17–21, pauză fără aprobare scrisă;
- numai ore cu preț real (garda de status din tools/unknown.py rămâne valabilă);
- fără presupuneri de capacitate: drepturile trebuie să existe (garda din tools/guard.py).

Propunerea analistului (status: propunere, NEAPROBATĂ): plafon strict 8 MW pe toate
intervalele. Se activează doar cu strict=True și doar ca scenariu.

Împărțirea unei nominalizări în tranșe (de ex. 20 = 10 + 10) NU ocolește plafonul:
plafonul se aplică pe interval, nu pe tranșă. Regulă aprobată de suveran pe 02.10.2026.
"""
from __future__ import annotations

from decimal import Decimal

from tools.money import D

CAP_MW = Decimal("10")
CAP_MANDATORY_8 = Decimal("8")
MANDATORY_8_HOURS = frozenset({8, 16})
STRICT_CAP_MW = Decimal("8")
SPREAD_MIN_CRISIS = Decimal("1.0")
EVENING_PAUSE_HOURS = frozenset({17, 18, 19, 20, 21})


def cap_for(hour: int, strict: bool = False) -> Decimal:
    if strict:
        return STRICT_CAP_MW
    return CAP_MANDATORY_8 if int(hour) in MANDATORY_8_HOURS else CAP_MW


def check_crisis(hour: int, nominate_mw, intraday_mw=0, da_won_confirmed: bool = False,
                 written_approval: str | None = None, strict: bool = False) -> dict:
    """Verifică o oră față de regimul de criză. Întoarce toate încălcările, nu doar prima."""
    h = int(hour)
    violations = []
    cap = cap_for(h, strict)
    total = D(nominate_mw)
    if total > cap:
        violations.append(f"h{h}: {total} MW peste plafonul de criză {cap} MW")
    if D(intraday_mw) > 0 and not da_won_confirmed:
        violations.append(f"h{h}: intrazilnic {D(intraday_mw)} MW fără câștig confirmat pe ziua următoare")
    if h in EVENING_PAUSE_HOURS and not (written_approval or "").strip():
        violations.append(f"h{h}: seara 17–21 e pauză fără aprobare scrisă")
    return {"hour": h, "ok": not violations, "cap_mw": cap, "violations": violations,
            "rule": "propunere 8 strict (neaprobată)" if strict else "regula în vigoare"}


def md_closure_locked(now_hhmm: str, gate_hhmm: str = "14:15") -> bool:
    """Închiderea pe Moldova e ireversibilă după ora porții (14:15 pe 30.09.2026)."""
    return now_hhmm >= gate_hhmm
