"""Risk, REMIT compliance, and portfolio state."""

from __future__ import annotations

import statistics
from dataclasses import dataclass, field

from energy_trading.models import RiskLimits, Trade


@dataclass
class RiskReport:
    ok: bool
    breaches: list[str] = field(default_factory=list)
    total_mw: float = 0.0
    notional_eur: float = 0.0
    var_95_eur: float = 0.0
    per_border_mw: dict[str, float] = field(default_factory=dict)


def historical_var(trades: list[Trade], confidence: float = 0.95) -> float:
    """Simple historical-simulation VaR on expected PnL distribution."""
    if not trades:
        return 0.0
    pnls = sorted(t.expected_pnl for t in trades)
    idx = max(0, int((1 - confidence) * len(pnls)) - 1)
    worst = pnls[idx]
    return round(max(0.0, -worst if worst < 0 else worst * 0.25), 2)


def check_limits(proposed: list[Trade], existing: list[Trade], limits: RiskLimits) -> RiskReport:
    per_border: dict[str, float] = {}
    for t in [*existing, *proposed]:
        per_border[t.interconnector_id] = per_border.get(t.interconnector_id, 0.0) + t.volume_mw
    total_mw = sum(t.volume_mw for t in [*existing, *proposed])
    notional = sum(t.volume_mw * max(t.buy_price, t.sell_price) for t in [*existing, *proposed])
    var = historical_var([*existing, *proposed])
    breaches: list[str] = []
    for border, mw in per_border.items():
        if mw > limits.max_mw_per_border:
            breaches.append(
                f"{border}: {mw:.0f}MW exceeds per-border limit {limits.max_mw_per_border:.0f}MW"
            )
    if total_mw > limits.max_mw_total:
        breaches.append(
            f"Total {total_mw:.0f}MW exceeds portfolio limit {limits.max_mw_total:.0f}MW"
        )
    if notional > limits.max_notional_eur:
        breaches.append(f"Notional €{notional:,.0f} exceeds €{limits.max_notional_eur:,.0f}")
    if var > limits.max_var_95_eur:
        breaches.append(f"VaR95 €{var:,.0f} exceeds €{limits.max_var_95_eur:,.0f}")
    for t in proposed:
        if t.interconnector_id in limits.blocked_borders:
            breaches.append(f"{t.interconnector_id} is blocked (outage/sanction)")
        if limits.allowed_zones and (
            t.from_zone not in limits.allowed_zones or t.to_zone not in limits.allowed_zones
        ):
            breaches.append(f"Trade {t.id} touches zone outside allow-list")
    return RiskReport(
        ok=not breaches,
        breaches=breaches,
        total_mw=round(total_mw, 1),
        notional_eur=round(notional, 2),
        var_95_eur=var,
        per_border_mw=per_border,
    )


REMIT_KEYWORDS = ("insider", "manipulat", "wash trade", "spoof", "layering")


def remit_screen(note: str, volume_mw: float, capacity_mw: float) -> list[str]:
    """Lightweight REMIT / market-abuse pre-trade screen.

    Flags physical withholding (nominating far below available capacity at
    scarcity spreads is fine economically, but systematically offering zero
    while holding capacity is reportable) and abusive language in trader notes.
    """
    flags: list[str] = []
    lowered = note.lower()
    if any(k in lowered for k in REMIT_KEYWORDS):
        flags.append("Note references potentially abusive behaviour — escalate to compliance")
    return flags


@dataclass
class Portfolio:
    trades: list[Trade] = field(default_factory=list)

    def add(self, trades: list[Trade]) -> None:
        self.trades.extend(trades)

    def mtm(self, latest: dict[tuple[str, str], float]) -> float:
        """Mark-to-market against latest spreads keyed by (border, hour-iso)."""
        total = 0.0
        for t in self.trades:
            spread = latest.get(
                (t.interconnector_id, t.delivery_start.isoformat()), t.sell_price - t.buy_price
            )
            total += (spread - t.transport_cost) * t.volume_mw
        return round(total, 2)

    def exposure_by_border(self) -> dict[str, float]:
        exp: dict[str, float] = {}
        for t in self.trades:
            exp[t.interconnector_id] = exp.get(t.interconnector_id, 0.0) + t.volume_mw
        return exp

    def stdev_pnl(self) -> float:
        if len(self.trades) < 2:
            return 0.0
        return round(statistics.pstdev([t.expected_pnl for t in self.trades]), 2)
