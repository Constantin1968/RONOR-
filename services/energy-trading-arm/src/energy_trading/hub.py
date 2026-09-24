"""Regional hub: Romania as the reference market for surrounding zones.

Doctrine: RO (OPCOM DAM) is the hub price. Every neighbouring zone —
BG, RS, HU, MD, UA — is quoted as a *basis* against RO per delivery hour,
and the hub decides for each hour whether Romania should import from a
cheaper spoke, export to a dearer spoke, or wheel between two spokes
through RO (spoke → RO → spoke) when the combined basis covers both legs.
"""

from __future__ import annotations

import csv
from datetime import datetime
from pathlib import Path

from pydantic import BaseModel, Field

from energy_trading.interconnectors import REGISTRY, get_interconnector
from energy_trading.market_data import pivot_by_hour
from energy_trading.models import Interconnector, PricePoint

HUB_ZONE = "RO"
SPOKES: dict[str, str] = {
    "BG": "RO-BG",
    "RS": "RO-RS",
    "HU": "RO-HU",
    "MD": "RO-MD",
    "UA": "RO-UA",
}
"""Spoke zone → canonical border id to the hub."""

KNOWN_ZONES = {HUB_ZONE, *SPOKES}


class Basis(BaseModel):
    zone: str
    hour: int
    price: float
    ro_price: float
    basis: float = Field(description="zone price minus RO price (EUR/MWh)")
    direction: str = Field(description="import | export | flat — from RO's perspective")
    transport_cost: float
    net_edge: float = Field(description="|basis| minus transport, positive = actionable")
    capacity_mw: float


class WheelingOpp(BaseModel):
    hour: int
    from_zone: str
    to_zone: str
    buy_price: float
    sell_price: float
    gross_spread: float
    transport_cost: float
    net_spread: float
    capacity_mw: float
    expected_profit_eur: float


class HubSnapshot(BaseModel):
    day: str
    hub: str = HUB_ZONE
    basis: list[Basis]
    wheeling: list[WheelingOpp]
    summary: dict


def _border_for(zone: str) -> Interconnector:
    return get_interconnector(SPOKES[zone])


def _cap(
    availability: dict | None, border: Interconnector, from_zone: str, to_zone: str, hour: int
) -> float:
    if not availability:
        return border.capacity_mw
    for key in (f"{from_zone}-{to_zone}", border.id):
        val = availability.get(key)
        if val is None:
            continue
        if isinstance(val, dict):
            return float(val.get(hour, val.get(str(hour), border.capacity_mw)))
        return float(val)
    return border.capacity_mw


def compute_basis(
    prices: list[PricePoint],
    min_edge: float = 0.5,
    availability: dict | None = None,
) -> list[Basis]:
    """Quote every spoke against RO per hour, sized by directional capacity."""
    grid = pivot_by_hour(prices)
    out: list[Basis] = []
    for delivery, by_zone in sorted(grid.items()):
        ro = by_zone.get(HUB_ZONE)
        if ro is None:
            continue
        hour = delivery.hour
        for zone, border_id in SPOKES.items():
            if zone not in by_zone or border_id not in REGISTRY:
                continue
            border = REGISTRY[border_id]
            price = by_zone[zone]
            basis = price - ro
            if basis > 0:
                direction, cost = "export", border.transport_cost(ro)
                cap = _cap(availability, border, HUB_ZONE, zone, hour)
            elif basis < 0:
                direction, cost = "import", border.transport_cost(price)
                cap = _cap(availability, border, zone, HUB_ZONE, hour)
            else:
                direction, cost, cap = "flat", border.transport_cost(ro), 0.0
            net = abs(basis) - cost
            out.append(
                Basis(
                    zone=zone,
                    hour=hour,
                    price=round(price, 2),
                    ro_price=round(ro, 2),
                    basis=round(basis, 2),
                    direction=direction if net >= min_edge else "flat",
                    transport_cost=round(cost, 2),
                    net_edge=round(net, 2),
                    capacity_mw=round(cap, 1),
                )
            )
    return out


def find_wheeling(
    prices: list[PricePoint],
    min_net_spread: float = 1.0,
    availability: dict | None = None,
) -> list[WheelingOpp]:
    """Spoke → RO → spoke arbitrage: buy in the cheapest neighbour, sell in the dearest.

    Both legs pay their own tariff + losses; volume is the min of the two
    directional capacities for that hour.
    """
    grid = pivot_by_hour(prices)
    out: list[WheelingOpp] = []
    for delivery, by_zone in sorted(grid.items()):
        hour = delivery.hour
        present = [z for z in SPOKES if z in by_zone and SPOKES[z] in REGISTRY]
        for src in present:
            for dst in present:
                if src == dst:
                    continue
                buy, sell = by_zone[src], by_zone[dst]
                if sell <= buy:
                    continue
                b_in, b_out = REGISTRY[SPOKES[src]], REGISTRY[SPOKES[dst]]
                cost = b_in.transport_cost(buy) + b_out.transport_cost(buy)
                net = sell - buy - cost
                if net < min_net_spread:
                    continue
                cap = min(
                    _cap(availability, b_in, src, HUB_ZONE, hour),
                    _cap(availability, b_out, HUB_ZONE, dst, hour),
                )
                if cap <= 0:
                    continue
                out.append(
                    WheelingOpp(
                        hour=hour,
                        from_zone=src,
                        to_zone=dst,
                        buy_price=round(buy, 2),
                        sell_price=round(sell, 2),
                        gross_spread=round(sell - buy, 2),
                        transport_cost=round(cost, 2),
                        net_spread=round(net, 2),
                        capacity_mw=round(cap, 1),
                        expected_profit_eur=round(net * cap, 2),
                    )
                )
    out.sort(key=lambda w: w.expected_profit_eur, reverse=True)
    return out


def hub_snapshot(
    prices: list[PricePoint],
    day: str,
    min_edge: float = 0.5,
    availability: dict | None = None,
) -> HubSnapshot:
    basis = compute_basis(prices, min_edge=min_edge, availability=availability)
    wheeling = find_wheeling(prices, min_net_spread=max(1.0, min_edge), availability=availability)
    by_zone: dict[str, dict] = {}
    for b in basis:
        z = by_zone.setdefault(
            b.zone, {"hours": 0, "import_hours": 0, "export_hours": 0, "mean_basis": 0.0}
        )
        z["hours"] += 1
        z["mean_basis"] += b.basis
        if b.direction == "import":
            z["import_hours"] += 1
        elif b.direction == "export":
            z["export_hours"] += 1
    for z in by_zone.values():
        z["mean_basis"] = round(z["mean_basis"] / z["hours"], 2) if z["hours"] else 0.0
    summary = {
        "zones": by_zone,
        "wheeling_count": len(wheeling),
        "wheeling_expected_eur": round(sum(w.expected_profit_eur for w in wheeling), 2),
        "best_wheel": wheeling[0].model_dump() if wheeling else None,
    }
    return HubSnapshot(day=day, basis=basis, wheeling=wheeling, summary=summary)


def load_prices_csv(path: str | Path, day: datetime) -> list[PricePoint]:
    """Load hourly RO/UA/MD prices from data/prices_YYYY-MM-DD.csv (CET hours 1-24)."""
    cols = {"ro_dam_eur": "RO", "ua_dam_eur": "UA", "md_price_eur": "MD"}
    base = day.replace(hour=0, minute=0, second=0, microsecond=0)
    out: list[PricePoint] = []
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            hour = int(row["hour_cet"]) - 1
            for col, zone in cols.items():
                raw = (row.get(col) or "").strip()
                if not raw:
                    continue
                out.append(
                    PricePoint(
                        zone=zone,
                        delivery_start=base.replace(hour=hour),
                        price_eur_mwh=float(raw),
                    )
                )
    return out
