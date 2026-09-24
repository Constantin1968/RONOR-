"""Weather forecast workers for the regional hub (RO + BG, RS, HU, MD, UA).

One ``WeatherWorker`` per country pulls Open-Meteo (free, keyless) for a
few grid-relevant points, aggregates to country level and derives three
energy signals: demand (temperature), wind (100 m wind speed), solar
(shortwave radiation). ``WeatherOrchestrator`` runs the workers in
parallel threads and produces the regional brief the hub consumes.

Network failures never raise: the worker returns ``status="error"`` and the
orchestrator files it, so the trading pipeline degrades gracefully.
"""

from __future__ import annotations

import json
import statistics
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import UTC, datetime
from typing import Any
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import urlopen

from pydantic import BaseModel, Field

OPEN_METEO = "https://api.open-meteo.com/v1/forecast"
TIMEZONE = "Europe/Bucharest"

GRID_POINTS: dict[str, list[tuple[str, float, float]]] = {
    "RO": [
        ("Bucuresti", 44.43, 26.10),
        ("Constanta/Dobrogea", 44.17, 28.63),
        ("Cluj", 46.77, 23.59),
    ],
    "BG": [("Sofia", 42.70, 23.32), ("Varna", 43.21, 27.91)],
    "RS": [("Beograd", 44.79, 20.45)],
    "HU": [("Budapest", 47.50, 19.04)],
    "MD": [("Chisinau", 47.01, 28.86)],
    "UA": [("Kyiv", 50.45, 30.52), ("Odesa", 46.48, 30.72)],
}

WIND_HIGH_KMH = 28.0
WIND_LOW_KMH = 12.0
SOLAR_HIGH_MJ = 20.0
SOLAR_LOW_MJ = 10.0


class DailySignal(BaseModel):
    date: str
    temp_mean: float
    temp_max: float
    temp_min: float
    wind100_mean_kmh: float
    wind_share_gt25: float
    solar_sum_mj: float
    precip_mm: float
    demand: str
    wind: str
    solar: str


class CountryForecast(BaseModel):
    country: str
    points: list[str]
    status: str = "ok"
    error: str = ""
    daily: list[DailySignal] = Field(default_factory=list)


class RegionalBrief(BaseModel):
    generated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    days: int
    countries: dict[str, CountryForecast]
    hub_read: list[str] = Field(default_factory=list)


def classify(temp_mean: float, wind_mean: float, solar_sum: float) -> tuple[str, str, str]:
    if temp_mean > 27 or temp_mean < 5:
        demand = "high"
    elif 15 <= temp_mean <= 22:
        demand = "low"
    else:
        demand = "normal"
    wind = "high" if wind_mean > WIND_HIGH_KMH else "low" if wind_mean < WIND_LOW_KMH else "normal"
    solar = "high" if solar_sum > SOLAR_HIGH_MJ else "low" if solar_sum < SOLAR_LOW_MJ else "normal"
    return demand, wind, solar


def _fetch_point(lat: float, lon: float, days: int, timeout: float) -> dict[str, Any]:
    params = {
        "latitude": lat,
        "longitude": lon,
        "hourly": "temperature_2m,wind_speed_100m,shortwave_radiation,precipitation",
        "forecast_days": days,
        "timezone": TIMEZONE,
    }
    with urlopen(f"{OPEN_METEO}?{urlencode(params)}", timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def _aggregate_point(raw: dict[str, Any]) -> dict[str, dict[str, list[float]]]:
    """Group hourly series by date → {date: {var: [values]}}."""
    hourly = raw["hourly"]
    grouped: dict[str, dict[str, list[float]]] = {}
    for i, ts in enumerate(hourly["time"]):
        date = ts[:10]
        slot = grouped.setdefault(date, {"t": [], "w": [], "s": [], "p": []})
        for key, var in (
            ("t", "temperature_2m"),
            ("w", "wind_speed_100m"),
            ("s", "shortwave_radiation"),
            ("p", "precipitation"),
        ):
            val = hourly[var][i]
            if val is not None:
                slot[key].append(float(val))
    return grouped


class WeatherWorker:
    """Fetch + aggregate the forecast for one country."""

    def __init__(self, country: str, days: int = 3, timeout: float = 10.0):
        if country not in GRID_POINTS:
            raise ValueError(f"Unknown country '{country}'. Known: {sorted(GRID_POINTS)}")
        self.country = country
        self.days = days
        self.timeout = timeout

    def run(self) -> CountryForecast:
        points = GRID_POINTS[self.country]
        merged: dict[str, dict[str, list[float]]] = {}
        try:
            for _, lat, lon in points:
                for date, vars_ in _aggregate_point(
                    _fetch_point(lat, lon, self.days, self.timeout)
                ).items():
                    slot = merged.setdefault(date, {"t": [], "w": [], "s": [], "p": []})
                    for k, vals in vars_.items():
                        slot[k].extend(vals)
        except (URLError, OSError, KeyError, ValueError, json.JSONDecodeError) as exc:
            return CountryForecast(
                country=self.country, points=[p[0] for p in points], status="error", error=str(exc)
            )
        daily: list[DailySignal] = []
        n_points = len(points)
        for date in sorted(merged):
            v = merged[date]
            if not v["t"]:
                continue
            temp_mean = statistics.fmean(v["t"])
            wind_mean = statistics.fmean(v["w"]) if v["w"] else 0.0
            # W/m² hourly → MJ/m² per day, averaged over points
            solar_sum = sum(v["s"]) * 3600 / 1_000_000 / n_points
            precip = sum(v["p"]) / n_points
            demand, wind, solar = classify(temp_mean, wind_mean, solar_sum)
            daily.append(
                DailySignal(
                    date=date,
                    temp_mean=round(temp_mean, 1),
                    temp_max=round(max(v["t"]), 1),
                    temp_min=round(min(v["t"]), 1),
                    wind100_mean_kmh=round(wind_mean, 1),
                    wind_share_gt25=round(sum(1 for w in v["w"] if w > 25) / len(v["w"]), 2)
                    if v["w"]
                    else 0.0,
                    solar_sum_mj=round(solar_sum, 1),
                    precip_mm=round(precip, 1),
                    demand=demand,
                    wind=wind,
                    solar=solar,
                )
            )
        return CountryForecast(country=self.country, points=[p[0] for p in points], daily=daily)


class WeatherOrchestrator:
    """Run one worker per country in parallel and derive the hub read."""

    def __init__(self, countries: list[str] | None = None, days: int = 3, timeout: float = 10.0):
        self.countries = countries or list(GRID_POINTS)
        self.days = days
        self.timeout = timeout

    def run(self) -> RegionalBrief:
        results: dict[str, CountryForecast] = {}
        with ThreadPoolExecutor(max_workers=len(self.countries)) as pool:
            futures = {
                pool.submit(WeatherWorker(c, self.days, self.timeout).run): c
                for c in self.countries
            }
            for fut in as_completed(futures):
                cf = fut.result()
                results[cf.country] = cf
        brief = RegionalBrief(days=self.days, countries=dict(sorted(results.items())))
        brief.hub_read = hub_read(brief)
        return brief


def hub_read(brief: RegionalBrief, day_index: int = 0) -> list[str]:
    """Translate signals into cross-border expectations with RO as hub."""
    notes: list[str] = []
    ro = brief.countries.get("RO")
    if ro and ro.status == "ok" and len(ro.daily) > day_index:
        d = ro.daily[day_index]
        if d.wind == "high":
            notes.append(
                f"RO eolian ridicat ({d.wind100_mean_kmh} km/h la 100 m) → presiune de export RO, preț RO în scădere"
            )
        elif d.wind == "low":
            notes.append(
                f"RO eolian scăzut ({d.wind100_mean_kmh} km/h) → RO mai dependent de import în vârf"
            )
        if d.solar == "high":
            notes.append(
                f"RO solar puternic ({d.solar_sum_mj} MJ/m²) → adâncire preț la amiază, spread orar UA→RO se îngustează la 11–15"
            )
        if d.demand == "high":
            notes.append(
                f"RO cerere ridicată (T medie {d.temp_mean}°C) → ferestre de import mai largi"
            )
    for zone in ("BG", "RS", "HU", "MD", "UA"):
        cf = brief.countries.get(zone)
        if not cf or cf.status != "ok" or len(cf.daily) <= day_index:
            if cf and cf.status == "error":
                notes.append(f"{zone}: prognoză indisponibilă ({cf.error[:60]})")
            continue
        d = cf.daily[day_index]
        if d.demand == "high":
            notes.append(
                f"{zone} cerere ridicată (T {d.temp_mean}°C) → cerere de import dinspre RO"
            )
        if d.wind == "high" or d.solar == "high":
            notes.append(
                f"{zone} regenerabile ridicate (vânt {d.wind100_mean_kmh} km/h, solar {d.solar_sum_mj} MJ/m²) → ofertă ieftină spre RO"
            )
    if not notes:
        notes.append(
            "Regim meteo neutru — bază de preț determinată de combustibil și hidro, nu de regenerabile"
        )
    return notes
