from datetime import UTC, datetime

from energy_trading.hub import (
    HUB_ZONE,
    SPOKES,
    compute_basis,
    find_wheeling,
    hub_snapshot,
    load_prices_csv,
)
from energy_trading.interconnectors import REGISTRY, normalize_border
from energy_trading.models import PricePoint
from energy_trading.ops_intake import load_ntc_csv
from energy_trading.weather import (
    GRID_POINTS,
    CountryForecast,
    DailySignal,
    RegionalBrief,
    classify,
    hub_read,
)

DAY = datetime(2026, 9, 13, tzinfo=UTC)


def _pp(zone: str, hour: int, price: float) -> PricePoint:
    return PricePoint(zone=zone, delivery_start=DAY.replace(hour=hour), price_eur_mwh=price)


def test_hub_spokes_registered():
    assert HUB_ZONE == "RO"
    for zone, border in SPOKES.items():
        assert border in REGISTRY, f"{zone} spoke {border} missing"
    assert normalize_border("BG/RO") == "RO-BG"
    assert normalize_border("HU-RO") == "RO-HU"


def test_basis_direction_from_ro_perspective():
    prices = [_pp("RO", 10, 100.0), _pp("UA", 10, 60.0), _pp("HU", 10, 130.0), _pp("BG", 10, 100.2)]
    basis = {b.zone: b for b in compute_basis(prices, min_edge=0.5)}
    assert basis["UA"].direction == "import" and basis["UA"].basis == -40.0
    assert basis["HU"].direction == "export" and basis["HU"].basis == 30.0
    assert basis["BG"].direction == "flat"


def test_basis_uses_directional_capacity():
    prices = [_pp("RO", 19, 100.0), _pp("UA", 19, 60.0)]
    avail = {"UA-RO": {19: 162.0}, "RO-UA": {19: 549.0}}
    b = compute_basis(prices, availability=avail)[0]
    assert b.direction == "import" and b.capacity_mw == 162.0


def test_wheeling_buys_cheapest_sells_dearest():
    prices = [_pp("RO", 12, 100.0), _pp("UA", 12, 50.0), _pp("HU", 12, 140.0), _pp("BG", 12, 95.0)]
    wheels = find_wheeling(prices, min_net_spread=1.0)
    assert wheels and wheels[0].from_zone == "UA" and wheels[0].to_zone == "HU"
    assert wheels[0].net_spread < wheels[0].gross_spread


def test_wheeling_respects_zero_capacity():
    prices = [_pp("RO", 12, 100.0), _pp("UA", 12, 50.0), _pp("HU", 12, 140.0)]
    wheels = find_wheeling(prices, availability={"UA-RO": {12: 0.0}})
    assert all(not (w.from_zone == "UA" and w.to_zone == "HU") for w in wheels)


def test_hub_snapshot_on_real_13_09_data():
    prices = load_prices_csv("data/prices_2026-09-13.csv", DAY)
    ntc = load_ntc_csv("data/ntc_2026-09-13.csv")
    snap = hub_snapshot(prices, "2026-09-13", availability=ntc)
    ua = snap.summary["zones"]["UA"]
    assert ua["import_hours"] >= 20 and ua["mean_basis"] < -30
    # Hour 19 CET (delivery 18): UA 216.20 > RO 210.30 → only export hour
    export_hours = [b.hour for b in snap.basis if b.zone == "UA" and b.direction == "export"]
    assert export_hours == [18]
    assert snap.summary["wheeling_count"] > 0


def test_weather_classify_thresholds():
    assert classify(30.0, 30.0, 25.0) == ("high", "high", "high")
    assert classify(18.0, 10.0, 5.0) == ("low", "low", "low")
    assert classify(24.0, 20.0, 15.0) == ("normal", "normal", "normal")


def test_weather_grid_points_cover_region():
    assert set(GRID_POINTS) == {"RO", "BG", "RS", "HU", "MD", "UA"}


def _brief(ro_wind: str, bg_demand: str) -> RegionalBrief:
    def cf(country: str, wind: str, demand: str) -> CountryForecast:
        return CountryForecast(
            country=country,
            points=["x"],
            daily=[
                DailySignal(
                    date="2026-09-13",
                    temp_mean=20.0,
                    temp_max=25.0,
                    temp_min=15.0,
                    wind100_mean_kmh=30.0 if wind == "high" else 10.0,
                    wind_share_gt25=0.5,
                    solar_sum_mj=15.0,
                    precip_mm=0.0,
                    demand=demand,
                    wind=wind,
                    solar="normal",
                )
            ],
        )

    return RegionalBrief(
        days=1,
        countries={"RO": cf("RO", ro_wind, "normal"), "BG": cf("BG", "low", bg_demand)},
    )


def test_hub_read_translates_signals():
    notes = hub_read(_brief("high", "high"))
    assert any("export RO" in n for n in notes)
    assert any(n.startswith("BG cerere ridicată") for n in notes)


def test_hub_read_reports_worker_errors():
    brief = RegionalBrief(
        days=1,
        countries={
            "UA": CountryForecast(country="UA", points=["Kyiv"], status="error", error="timeout")
        },
    )
    assert any("UA: prognoză indisponibilă" in n for n in hub_read(brief))


def test_api_hub_endpoint():
    from fastapi.testclient import TestClient

    from energy_trading.api import app

    c = TestClient(app)
    r = c.post(
        "/api/hub",
        json={"day": "2026-09-13", "prices_override": {"RO": {12: 100.0}, "UA": {12: 50.0}}},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["hub"] == "RO"
    ua12 = next(b for b in body["basis"] if b["zone"] == "UA" and b["hour"] == 12)
    assert ua12["direction"] == "import"
