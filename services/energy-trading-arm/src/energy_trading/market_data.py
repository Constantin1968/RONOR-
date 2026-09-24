"""Market data providers: simulated feed, CSV loader, ENTSO-E stub."""

from __future__ import annotations

import csv
import math
import random
from datetime import datetime, timedelta
from pathlib import Path

from energy_trading.models import Market, PricePoint

# Representative base prices (EUR/MWh) used by the simulator.
BASE_PRICES: dict[str, float] = {
    "DE-LU": 92.0,
    "FR": 88.0,
    "NL": 94.0,
    "BE": 95.0,
    "ES": 78.0,
    "IT-N": 118.0,
    "CH": 105.0,
    "AT": 96.0,
    "DK1": 84.0,
    "NO2": 52.0,
    "GB": 102.0,
    "PL": 99.0,
    "RO": 97.0,
    "UA": 70.0,
    "MD": 104.0,
    "BG": 99.0,
    "RS": 101.0,
    "HU": 103.0,
}

PEAK_HOURS = set(range(8, 21))


class MarketDataProvider:
    def day_ahead(self, zones: list[str], day: datetime) -> list[PricePoint]:
        raise NotImplementedError


class SimulatedProvider(MarketDataProvider):
    """Deterministic synthetic day-ahead prices with daily/peak shape + noise."""

    def __init__(self, seed: int = 7, volatility: float = 6.0):
        self.seed = seed
        self.volatility = volatility

    def day_ahead(self, zones: list[str], day: datetime) -> list[PricePoint]:
        rng = random.Random(self.seed + int(day.strftime("%Y%m%d")))
        points: list[PricePoint] = []
        day_start = day.replace(hour=0, minute=0, second=0, microsecond=0)
        for zone in zones:
            base = BASE_PRICES.get(zone, 90.0)
            zone_shift = rng.uniform(-4, 4)
            for h in range(24):
                peak = 14.0 if h in PEAK_HOURS else -10.0
                shape = 6.0 * math.sin((h - 6) / 24 * 2 * math.pi)
                noise = rng.gauss(0, self.volatility / 2.5)
                # Occasional scarcity spike in high-price zones
                spike = (
                    rng.choice([0, 0, 0, 0, rng.uniform(15, 45)])
                    if zone in ("IT-N", "GB") and h in (18, 19)
                    else 0
                )
                price = max(1.0, base + zone_shift + peak + shape + noise + spike)
                points.append(
                    PricePoint(
                        zone=zone,
                        delivery_start=day_start + timedelta(hours=h),
                        market=Market.DAY_AHEAD,
                        price_eur_mwh=round(price, 2),
                    )
                )
        return points


class CsvProvider(MarketDataProvider):
    """Load prices from CSV: zone,delivery_start,market,price_eur_mwh."""

    def __init__(self, path: str | Path):
        self.path = Path(path)

    def day_ahead(self, zones: list[str], day: datetime) -> list[PricePoint]:
        wanted = {z for z in zones}
        out: list[PricePoint] = []
        with self.path.open() as f:
            for row in csv.DictReader(f):
                if row.get("zone") not in wanted:
                    continue
                ts = datetime.fromisoformat(row["delivery_start"])
                if ts.date() != day.date():
                    continue
                out.append(
                    PricePoint(
                        zone=row["zone"],
                        delivery_start=ts,
                        market=Market(row.get("market", "day_ahead")),
                        price_eur_mwh=float(row["price_eur_mwh"]),
                    )
                )
        return out


class EntsoeProvider(MarketDataProvider):
    """Stub for the ENTSO-E Transparency Platform REST API.

    Wire a real token by setting ENTSOE_API_KEY and implementing document
    type A44 (day-ahead prices) retrieval. Until then it falls back to the
    simulator so the agent stays operable offline.
    """

    def __init__(self, api_key: str | None = None, fallback: MarketDataProvider | None = None):
        self.api_key = api_key
        self.fallback = fallback or SimulatedProvider()

    def day_ahead(self, zones: list[str], day: datetime) -> list[PricePoint]:
        # TODO: call https://web-api.tp.entsoe.eu/api?documentType=A44...
        # Requires bidding-zone EIC mapping + token. Falls back for now.
        return self.fallback.day_ahead(zones, day)


def pivot_by_hour(points: list[PricePoint]) -> dict[datetime, dict[str, float]]:
    """Reshape price points into {delivery_start: {zone: price}}."""
    grid: dict[datetime, dict[str, float]] = {}
    for p in points:
        grid.setdefault(p.delivery_start, {})[p.zone] = p.price_eur_mwh
    return grid
