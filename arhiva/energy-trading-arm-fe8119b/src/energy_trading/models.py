"""Core domain models for cross-border power trading."""

from __future__ import annotations

from datetime import datetime
from enum import Enum

from pydantic import BaseModel, Field


class Market(str, Enum):
    DAY_AHEAD = "day_ahead"
    INTRADAY = "intraday"
    BALANCING = "balancing"


class Coupling(str, Enum):
    IMPLICIT = "implicit"  # SDAC / SIDC market coupling (Euphemia/XBID)
    EXPLICIT = "explicit"  # JAO explicit capacity auction


class PricePoint(BaseModel):
    zone: str = Field(description="Bidding zone EIC-style code, e.g. DE-LU, FR, NL")
    delivery_start: datetime
    market: Market = Market.DAY_AHEAD
    price_eur_mwh: float


class Interconnector(BaseModel):
    id: str = Field(description="e.g. FR-DE, IFA2-GB-FR")
    from_zone: str
    to_zone: str
    capacity_mw: float = Field(gt=0, description="Available transfer capacity (ATC/NTC)")
    tariff_eur_mwh: float = Field(default=0.0, ge=0.0, description="Explicit capacity + TSO fees")
    loss_pct: float = Field(default=0.0, ge=0.0, le=20.0, description="Loss factor percent")
    coupling: Coupling = Coupling.IMPLICIT
    tso: str = ""
    ramping_mw_per_min: float = 10.0

    def transport_cost(self, price_from: float) -> float:
        """Per-MWh cost of moving 1 MWh across the border."""
        return self.tariff_eur_mwh + price_from * self.loss_pct / 100.0


class Opportunity(BaseModel):
    interconnector_id: str
    from_zone: str
    to_zone: str
    delivery_start: datetime
    market: Market
    price_from: float
    price_to: float
    gross_spread: float
    transport_cost: float
    net_spread: float
    max_volume_mw: float
    expected_profit_eur: float
    score: float = 0.0
    direction: str = "forward"


class Trade(BaseModel):
    id: str
    interconnector_id: str
    from_zone: str
    to_zone: str
    delivery_start: datetime
    market: Market
    volume_mw: float
    buy_price: float
    sell_price: float
    transport_cost: float
    expected_pnl: float
    status: str = "proposed"  # proposed | nominated | scheduled | settled | rejected
    reason: str = ""
    nominated_by: str = Field(default="", description="Operator who authorized the nomination")
    nominated_at: datetime | None = None
    created_at: datetime = Field(default_factory=datetime.utcnow)


class RiskLimits(BaseModel):
    max_mw_per_border: float = 200.0
    max_mw_total: float = 800.0
    max_notional_eur: float = 500_000.0
    min_net_spread_eur_mwh: float = 0.50
    max_var_95_eur: float = 100_000.0
    allowed_zones: list[str] = Field(default_factory=list)
    blocked_borders: list[str] = Field(default_factory=list)
