"""Autonomous cross-border trading agent."""

from __future__ import annotations

import itertools
from datetime import UTC, datetime, timedelta

from pydantic import BaseModel, Field

from energy_trading.arbitrage import find_opportunities
from energy_trading.interconnectors import INTERCONNECTORS, REGISTRY
from energy_trading.market_data import MarketDataProvider, SimulatedProvider, pivot_by_hour
from energy_trading.models import Opportunity, PricePoint, RiskLimits, Trade
from energy_trading.risk import check_limits, remit_screen
from energy_trading.sovereignty import (
    EVIDENCE_SIMULATED,
    ClaimsRegister,
    energy_report,
    sovereignty_report,
)

HOUR = timedelta(hours=1)


def _aware(dt: datetime) -> datetime:
    """Delivery timestamps are stored naive-UTC by some providers; compare safely."""
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


class AgentConfig(BaseModel):
    min_net_spread: float = 0.50
    max_trades_per_run: int = 12
    default_volume_mw: float = 100.0
    use_full_capacity: bool = False
    note: str = ""
    risk: RiskLimits = Field(default_factory=RiskLimits)


class DecisionLog(BaseModel):
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    opportunities_scanned: int
    trades_proposed: int
    trades_rejected: int
    total_expected_pnl: float
    evidence_level: str = EVIDENCE_SIMULATED
    claim_id: str = ""
    rejections: list[str] = Field(default_factory=list)


class CrossBorderAgent:
    """Sense (prices+capacity) → rank spreads → apply risk/REMIT → nominate."""

    def __init__(
        self, provider: MarketDataProvider | None = None, config: AgentConfig | None = None
    ):
        self.provider = provider or SimulatedProvider()
        self.config = config or AgentConfig()
        self.book: list[Trade] = []
        self.history: list[DecisionLog] = []
        self.claims = ClaimsRegister()
        self._seq = itertools.count(1)

    def restore(self, book: list[dict] | None, claims: list[dict] | None) -> dict[str, int]:
        """Reload persisted state; trade ids continue after the highest restored one."""
        if book:
            self.book = [Trade.model_validate(t) for t in book]
            high = max((int(t.id.split("-")[-1]) for t in self.book), default=0)
            self._seq = itertools.count(high + 1)
        n_claims = self.claims.restore(claims) if claims else 0
        return {"trades": len(self.book), "claims": n_claims}

    # -- pipeline -----------------------------------------------------
    def run_day(
        self,
        day: datetime,
        zones: list[str] | None = None,
        availability: dict[str, float | dict[int, float]] | None = None,
        evidence_level: str = EVIDENCE_SIMULATED,
    ) -> tuple[list[Trade], DecisionLog]:
        zones = zones or sorted(
            {ic.from_zone for ic in INTERCONNECTORS} | {ic.to_zone for ic in INTERCONNECTORS}
        )
        prices = self.provider.day_ahead(zones, day)
        return self.run_from_prices(prices, availability or {}, evidence_level=evidence_level)

    def run_from_prices(
        self,
        prices: list[PricePoint],
        availability: dict[str, float | dict[int, float]] | None = None,
        evidence_level: str = EVIDENCE_SIMULATED,
        extra_cost: dict[str, float | dict[int, float]] | None = None,
    ) -> tuple[list[Trade], DecisionLog]:
        availability = availability or {}
        opps = find_opportunities(
            prices,
            min_net_spread=self.config.min_net_spread,
            availability=availability,
            extra_cost=extra_cost,
        )
        proposed: list[Trade] = []
        rejections: list[str] = []
        for opp in opps:
            if len(proposed) >= self.config.max_trades_per_run:
                rejections.append(
                    f"Cap {self.config.max_trades_per_run} trades/run reached; {len(opps) - len(proposed)} left unscanned"
                )
                break
            trade = self._opportunity_to_trade(opp)
            flags = remit_screen(
                self.config.note, trade.volume_mw, REGISTRY[trade.interconnector_id].capacity_mw
            )
            if flags:
                trade.status = "rejected"
                trade.reason = "; ".join(flags)
                rejections.append(f"{trade.id}: {trade.reason}")
                continue
            verdict = check_limits([trade], self.book, self.config.risk)
            if not verdict.ok:
                trade.status = "rejected"
                trade.reason = "; ".join(verdict.breaches)
                rejections.append(
                    f"{trade.id} {trade.interconnector_id}@{trade.delivery_start:%H:%M}: {trade.reason}"
                )
                continue
            proposed.append(trade)
        self.book.extend(proposed)
        total_pnl = round(sum(t.expected_pnl for t in proposed), 2)
        day_ref = prices[0].delivery_start.date().isoformat() if prices else "n/a"
        claim = self.claims.file(
            kind="run",
            statement=(
                f"{len(proposed)} trades proposed from {len(opps)} opportunities, "
                f"expected PnL €{total_pnl:,.2f}"
            ),
            evidence_level=evidence_level,
            inputs_ref=f"day={day_ref} provider={type(self.provider).__name__}",
        )
        log = DecisionLog(
            opportunities_scanned=len(opps),
            trades_proposed=len(proposed),
            trades_rejected=len(rejections),
            total_expected_pnl=total_pnl,
            evidence_level=evidence_level,
            claim_id=claim.id,
            rejections=rejections,
        )
        self.history.append(log)
        return proposed, log

    # -- helpers ------------------------------------------------------
    def _opportunity_to_trade(self, opp: Opportunity) -> Trade:
        n = next(self._seq)
        volume = (
            opp.max_volume_mw
            if self.config.use_full_capacity
            else min(self.config.default_volume_mw, opp.max_volume_mw)
        )
        net_unit = opp.price_to - opp.price_from - opp.transport_cost
        return Trade(
            id=f"XB-{n:04d}",
            interconnector_id=opp.interconnector_id,
            from_zone=opp.from_zone,
            to_zone=opp.to_zone,
            delivery_start=opp.delivery_start,
            market=opp.market,
            volume_mw=round(volume, 1),
            buy_price=opp.price_from,
            sell_price=opp.price_to,
            transport_cost=opp.transport_cost,
            expected_pnl=round(max(0.0, net_unit * volume), 2),
            status="proposed",
            reason=f"net {opp.net_spread} €/MWh",
        )

    def nominate(
        self, trade_ids: list[str], evidence_level: str = EVIDENCE_SIMULATED, by: str = ""
    ) -> list[Trade]:
        """Simulate TSO nomination (Euphemia/XBID for implicit, JAO eCAT for explicit).

        ``by`` is the human who authorized it — the audit trail of the doctrine.
        """
        out = []
        now = datetime.now(UTC)
        for t in self.book:
            if t.id in trade_ids and t.status == "proposed":
                t.status = "nominated"
                t.nominated_by = by
                t.nominated_at = now
                out.append(t)
        if out:
            who = f" by {by}" if by else ""
            self.claims.file(
                kind="nomination",
                statement=f"{len(out)} trades nominated{who} ({', '.join(t.id for t in out)})",
                evidence_level=evidence_level,
                inputs_ref=by,
            )
        return out

    def settle_delivered(self, now: datetime) -> tuple[list, float]:
        """Settle only trades whose delivery has ended — what a 24/7 runner does hourly."""
        from energy_trading.settlement import settle

        eligible = [
            t
            for t in self.book
            if t.status in ("nominated", "scheduled") and _aware(t.delivery_start) + HOUR <= now
        ]
        lines, total = settle(eligible)
        if lines:
            self.claims.file(
                kind="settlement",
                statement=(
                    f"{len(lines)} delivered trades settled at {now:%Y-%m-%d %H:%M}, "
                    f"realised net €{total:,.2f}"
                ),
                evidence_level=EVIDENCE_SIMULATED,
            )
        return lines, total

    def settle_book(self, realised_spreads: dict[str, float] | None = None) -> tuple[list, float]:
        """Settle nominated trades and file the realised figure as a claim."""
        from energy_trading.settlement import settle

        eligible = [t for t in self.book if t.status in ("nominated", "scheduled")]
        lines, total = settle(eligible)
        if lines:
            self.claims.file(
                kind="settlement",
                statement=f"{len(lines)} trades settled, realised net €{total:,.2f}",
                evidence_level=EVIDENCE_SIMULATED,
            )
        return lines, total

    def sovereignty(self, home_zone: str = "RO") -> dict:
        """Home-zone balance + energy ledger for the current book."""
        return {
            "balance": sovereignty_report(self.book, home_zone),
            "energy": energy_report(self.book),
        }

    def summary(self) -> dict:
        grid = pivot_by_hour([])  # placeholder to keep import used in light contexts
        _ = grid
        return {
            "open_trades": len([t for t in self.book if t.status in ("proposed", "nominated")]),
            "total_expected_pnl": round(sum(t.expected_pnl for t in self.book), 2),
            "total_volume_mw": round(sum(t.volume_mw for t in self.book), 1),
            "runs": len(self.history),
        }
