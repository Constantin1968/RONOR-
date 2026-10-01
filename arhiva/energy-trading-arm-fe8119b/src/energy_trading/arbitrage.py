"""Cross-border spread / arbitrage engine."""

from __future__ import annotations

from datetime import datetime

from energy_trading.interconnectors import INTERCONNECTORS
from energy_trading.market_data import pivot_by_hour
from energy_trading.models import Interconnector, Market, Opportunity, PricePoint


def evaluate_border(
    ic: Interconnector,
    price_from: float,
    price_to: float,
    delivery: datetime,
    market: Market,
    available_mw: float | None = None,
    extra_cost_eur_mwh: float = 0.0,
) -> Opportunity:
    """Net spread for one border-hour; ``extra_cost_eur_mwh`` is e.g. the CBC price paid."""
    gross = price_to - price_from
    cost = ic.transport_cost(price_from) + extra_cost_eur_mwh
    net = gross - cost
    cap = available_mw if available_mw is not None else ic.capacity_mw
    volume = max(0.0, cap) if net > 0 else 0.0
    return Opportunity(
        interconnector_id=ic.id,
        from_zone=ic.from_zone,
        to_zone=ic.to_zone,
        delivery_start=delivery,
        market=market,
        price_from=round(price_from, 2),
        price_to=round(price_to, 2),
        gross_spread=round(gross, 2),
        transport_cost=round(cost, 2),
        net_spread=round(net, 2),
        max_volume_mw=round(volume, 1),
        expected_profit_eur=round(max(0.0, net * volume), 2),
        direction="forward",
    )


AvailabilityValue = float | dict[int, float]
"""Per-border availability: flat MW, or hourly MW keyed by delivery hour (0-23)."""

Availability = dict[str, AvailabilityValue]


def _avail_for(
    availability: Availability | None,
    ic_id: str,
    from_zone: str,
    to_zone: str,
    hour: int,
    default_mw: float,
) -> float:
    """Resolve directional, then canonical, then default capacity for one hour.

    Multi-hop corridors (``UA-MD-RO``) are only ever resolved by their own id: the
    two-zone pair would hand them the direct border's capacity and count it twice.
    Their reverse flow is a different registered corridor (``RO-MD-UA``) evaluated
    on its own — explicit capacity is directional, so the reverse gets nothing here.
    """
    if not availability:
        return default_mw
    if ic_id.count("-") >= 2:
        parts = ic_id.split("-")
        if parts[0] != from_zone or parts[-1] != to_zone:
            return 0.0
        keys = (ic_id,)
    else:
        keys = (f"{from_zone}-{to_zone}", ic_id)
    for key in keys:
        if key in availability:
            value = availability[key]
            if isinstance(value, dict):
                return float(value.get(hour, value.get(str(hour), default_mw)))  # type: ignore[arg-type]
            return float(value)
    return default_mw


def find_opportunities(
    prices: list[PricePoint],
    interconnectors: list[Interconnector] | None = None,
    min_net_spread: float = 0.5,
    availability: Availability | None = None,
    extra_cost: Availability | None = None,
) -> list[Opportunity]:
    """Scan every border x delivery hour in both flow directions.

    Implicit coupling usually clears the profitable direction automatically,
    but explicit borders (GB, CH) must be nominated directionally, so both
    orientations are evaluated and only the economic one is kept per hour.
    ``extra_cost`` (same keys/shape as ``availability``) adds a per-MWh cost such
    as the capacity price paid in an explicit auction.
    """
    ics = interconnectors if interconnectors is not None else INTERCONNECTORS
    grid = pivot_by_hour(prices)
    opps: list[Opportunity] = []
    for delivery, by_zone in grid.items():
        market = next((p.market for p in prices if p.delivery_start == delivery), Market.DAY_AHEAD)
        for ic in ics:
            if ic.from_zone not in by_zone or ic.to_zone not in by_zone:
                continue
            hour = delivery.hour
            avail_fwd = _avail_for(
                availability, ic.id, ic.from_zone, ic.to_zone, hour, ic.capacity_mw
            )
            avail_rev = _avail_for(
                availability, ic.id, ic.to_zone, ic.from_zone, hour, ic.capacity_mw
            )
            cost_fwd = _avail_for(extra_cost, ic.id, ic.from_zone, ic.to_zone, hour, 0.0)
            cost_rev = _avail_for(extra_cost, ic.id, ic.to_zone, ic.from_zone, hour, 0.0)
            fwd = evaluate_border(
                ic,
                by_zone[ic.from_zone],
                by_zone[ic.to_zone],
                delivery,
                market,
                avail_fwd,
                cost_fwd,
            )
            # Reverse flow uses mirrored tariff/loss on the opposite leg price.
            rev_ic = Interconnector(
                id=ic.id,
                from_zone=ic.to_zone,
                to_zone=ic.from_zone,
                capacity_mw=ic.capacity_mw,
                tariff_eur_mwh=ic.tariff_eur_mwh,
                loss_pct=ic.loss_pct,
                coupling=ic.coupling,
                tso=ic.tso,
            )
            rev = evaluate_border(
                rev_ic,
                by_zone[ic.to_zone],
                by_zone[ic.from_zone],
                delivery,
                market,
                avail_rev,
                cost_rev,
            )
            best = fwd if fwd.net_spread >= rev.net_spread else rev
            if best.net_spread >= min_net_spread and best.max_volume_mw > 0:
                best.score = round(best.net_spread * best.max_volume_mw, 2)
                opps.append(best)
    opps.sort(key=lambda o: o.expected_profit_eur, reverse=True)
    return opps
