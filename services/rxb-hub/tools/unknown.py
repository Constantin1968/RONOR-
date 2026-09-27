"""Starea prețului: se marchează explicit, nu după valoare (confirmat de Muse pe 27.09.2026).

Un preț are forma {"value": "...", "status": "...", "source": "..."}.
Statusurile sunt:
- real        preț confirmat, cu proveniență;
- missing     picior fără preț;
- substitute  valoare-substituent din foaia operatorului (ex. 0,20 pe h10 din 26.09);
- suspect     valoare de verificat (ex. UA 1,70 pe int16 din 28.09).

Garda blochează orice status diferit de real. 0 €, 0,20 € și prețurile
negative sunt prețuri reale dacă sunt marcate real. O valoare simplă, fără
status și fără proveniență, este considerată neverificată și e blocată.
"""
from __future__ import annotations

from tools.money import D

STATUSES = ("real", "missing", "substitute", "suspect")


def normalize(price) -> dict:
    if isinstance(price, dict):
        status = price.get("status")
        value = price.get("value")
        if status not in STATUSES:
            return {"value": value, "status": "unverified", "source": price.get("source")}
        if status == "real":
            if value is None or not price.get("source"):
                return {"value": value, "status": "unverified", "source": price.get("source")}
            try:
                D(value)
            except ValueError:
                return {"value": value, "status": "unverified", "source": price.get("source")}
        return {"value": value, "status": status, "source": price.get("source")}
    if price is None or (isinstance(price, str) and price.strip() == ""):
        return {"value": None, "status": "missing", "source": None}
    return {"value": price, "status": "unverified", "source": None}


def status_of(price) -> str:
    return normalize(price)["status"]


def is_real(price) -> bool:
    return status_of(price) == "real"


def value_of(price):
    return D(normalize(price)["value"])


def real(value, source: str) -> dict:
    return {"value": str(value), "status": "real", "source": source}


def guard_price(price, route: str, hour: int) -> dict:
    n = normalize(price)
    if n["status"] != "real":
        return {"mode": "hold", "reason": f"{route} h{hour}: preț {n['status']}, nu se execută"}
    return {"mode": "ok", "price": D(n["value"])}
