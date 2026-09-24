from datetime import UTC, datetime

from energy_trading.agent import AgentConfig, CrossBorderAgent
from energy_trading.arbitrage import find_opportunities
from energy_trading.interconnectors import (
    REGISTRY,
    ZONES,
    get_interconnector,
    normalize_border,
)
from energy_trading.market_data import Market, PricePoint, SimulatedProvider
from energy_trading.ops_intake import OverrideProvider, parse_daily_note


def test_eastern_borders_registered():
    for border in ("RO-UA", "UA-MD", "RO-MD", "UA-MD-RO", "RO-MD-UA"):
        assert border in REGISTRY, f"{border} missing from registry"
    assert {"RO", "UA", "MD"} <= set(ZONES)


def test_eastern_borders_are_explicit():
    assert get_interconnector("RO-UA").coupling == "explicit"
    assert get_interconnector("UA-MD").coupling == "explicit"


def test_border_aliases():
    assert normalize_border("UA/RO") == "RO-UA"
    assert normalize_border("MD/UA") == "UA-MD"
    assert normalize_border("MD/RO") == "RO-MD"
    assert get_interconnector("UA/RO").id == "RO-UA"


def _east_prices() -> list[PricePoint]:
    day = datetime(2026, 9, 12, tzinfo=UTC)
    return [
        PricePoint(
            zone="UA",
            delivery_start=day.replace(hour=18),
            market=Market.DAY_AHEAD,
            price_eur_mwh=70.0,
        ),
        PricePoint(
            zone="MD",
            delivery_start=day.replace(hour=18),
            market=Market.DAY_AHEAD,
            price_eur_mwh=104.0,
        ),
        PricePoint(
            zone="RO",
            delivery_start=day.replace(hour=18),
            market=Market.DAY_AHEAD,
            price_eur_mwh=97.0,
        ),
    ]


def test_eastern_arbitrage_ua_to_md_ro():
    opps = find_opportunities(_east_prices(), min_net_spread=0.5)
    ids = {o.interconnector_id for o in opps}
    assert "UA-MD" in ids
    ua_md = next(o for o in opps if o.interconnector_id == "UA-MD")
    assert ua_md.from_zone == "UA" and ua_md.net_spread > 0


def test_parse_daily_note_ro_format():
    intake = parse_daily_note(
        "RO-UA ATC 450 MW\nUA/MD ATC 600\nRO-MD capacitate 400 MW\n"
        "RO ora 18 pret 112,5\nMD 19h 121.0\nRO,20,118.5\n# comentariu\nlinia asta e invalida",
        day="2026-09-12",
    )
    assert intake.availability == {"RO-UA": 450.0, "UA-MD": 600.0, "RO-MD": 400.0}
    assert intake.prices_override["RO"][18] == 112.5
    assert intake.prices_override["MD"][19] == 121.0
    assert intake.prices_override["RO"][20] == 118.5
    assert any("nerecunoscut" in w for w in intake.warnings)


def test_parse_daily_note_unknown_border_warns():
    intake = parse_daily_note("XX-YY ATC 100 MW")
    assert intake.availability == {}
    assert any("necunoscută" in w for w in intake.warnings)


def test_override_provider_replaces_single_hour():
    day = datetime(2026, 9, 12, tzinfo=UTC)
    base = SimulatedProvider(seed=7)
    before = {p.delivery_start.hour: p.price_eur_mwh for p in base.day_ahead(["RO"], day)}
    provider = OverrideProvider(base, day, {"RO": {18: 150.0}})
    after = {p.delivery_start.hour: p.price_eur_mwh for p in provider.day_ahead(["RO"], day)}
    assert after[18] == 150.0
    assert after[17] == before[17]


def test_agent_run_with_overrides_and_availability():
    day = datetime(2026, 9, 12, tzinfo=UTC)
    agent = CrossBorderAgent(config=AgentConfig(default_volume_mw=50.0))
    provider = OverrideProvider(agent.provider, day, {"UA": {18: 60.0}, "MD": {18: 130.0}})
    prices = provider.day_ahead(["UA", "MD", "RO"], day)
    trades, log = agent.run_from_prices(prices, {"UA-MD": 300.0})
    ua_md = [t for t in trades if t.interconnector_id == "UA-MD"]
    assert ua_md and all(t.volume_mw <= 50.0 for t in ua_md)
    assert log.opportunities_scanned > 0


def test_api_ops_parse_and_run():
    from fastapi.testclient import TestClient

    from energy_trading.api import app

    c = TestClient(app)
    r = c.post(
        "/api/ops-parse",
        json={"day": "2026-09-12", "text": "RO-UA ATC 450 MW\nRO ora 18 pret 112,5"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["availability"] == {"RO-UA": 450.0}
    assert body["prices_override"]["RO"]["18"] == 112.5
    r2 = c.post(
        "/api/run",
        json={
            "day": "2026-09-12",
            "zones": ["RO", "UA", "MD"],
            "availability": body["availability"],
            "prices_override": body["prices_override"],
            "volume_mw": 50,
            "max_trades": 5,
        },
    )
    assert r2.status_code == 200
    assert r2.json()["log"]["opportunities_scanned"] > 0
