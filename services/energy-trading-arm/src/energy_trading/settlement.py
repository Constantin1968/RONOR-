"""Settlement: turn nominated trades into realised cashflows."""

from __future__ import annotations

from dataclasses import dataclass

from energy_trading.models import Trade


@dataclass
class SettlementLine:
    trade_id: str
    energy_revenue_eur: float
    transport_cost_eur: float
    net_eur: float


def settle(
    trades: list[Trade], realised_spreads: dict[str, float] | None = None
) -> tuple[list[SettlementLine], float]:
    realised_spreads = realised_spreads or {}
    lines: list[SettlementLine] = []
    for t in trades:
        if t.status not in ("nominated", "scheduled"):
            continue
        spread = realised_spreads.get(t.id, t.sell_price - t.buy_price)
        revenue = spread * t.volume_mw
        cost = t.transport_cost * t.volume_mw
        lines.append(
            SettlementLine(t.id, round(revenue, 2), round(cost, 2), round(revenue - cost, 2))
        )
        t.status = "settled"
    return lines, round(sum(line.net_eur for line in lines), 2)
