from datetime import UTC, datetime

from energy_trading.agent import AgentConfig, CrossBorderAgent
from energy_trading.arbitrage import find_opportunities
from energy_trading.interconnectors import get_interconnector
from energy_trading.market_data import SimulatedProvider
from energy_trading.models import Market, PricePoint, RiskLimits
from energy_trading.risk import Portfolio, remit_screen
from energy_trading.settlement import settle


def _prices() -> list[PricePoint]:
    day = datetime(2026, 9, 12, tzinfo=UTC)
    return [
        PricePoint(
            zone="FR",
            delivery_start=day.replace(hour=18),
            market=Market.DAY_AHEAD,
            price_eur_mwh=80.0,
        ),
        PricePoint(
            zone="DE-LU",
            delivery_start=day.replace(hour=18),
            market=Market.DAY_AHEAD,
            price_eur_mwh=100.0,
        ),
    ]


def test_transport_cost_includes_losses():
    ic = get_interconnector("FR-DE")
    assert ic.transport_cost(100.0) == 0.35 + 0.4


def test_arbitrage_finds_profitable_direction():
    opps = find_opportunities(_prices(), min_net_spread=0.5)
    fr_de = [o for o in opps if o.interconnector_id == "FR-DE"]
    assert fr_de, "expected FR->DE-LU opportunity"
    assert fr_de[0].from_zone == "FR" and fr_de[0].net_spread > 0


def test_no_opportunity_when_spread_below_cost():
    day = datetime(2026, 9, 12, tzinfo=UTC)
    flat = [
        PricePoint(
            zone="FR",
            delivery_start=day.replace(hour=3),
            market=Market.DAY_AHEAD,
            price_eur_mwh=90.0,
        ),
        PricePoint(
            zone="DE-LU",
            delivery_start=day.replace(hour=3),
            market=Market.DAY_AHEAD,
            price_eur_mwh=90.1,
        ),
    ]
    assert find_opportunities(flat, min_net_spread=0.5) == []


def test_risk_blocks_over_limit():
    limits = RiskLimits(max_mw_per_border=50.0)
    agent = CrossBorderAgent(
        provider=SimulatedProvider(), config=AgentConfig(risk=limits, default_volume_mw=100.0)
    )
    _, log = agent.run_from_prices(_prices())
    assert log.trades_rejected >= 1
    assert all(t.status != "proposed" or t.volume_mw <= 50 for t in agent.book)


def test_remit_screen_flags_abuse_language():
    assert remit_screen("possible spoof pattern?", 100, 1000)


def test_settlement_marks_nominated():
    agent = CrossBorderAgent(config=AgentConfig(default_volume_mw=50.0))
    trades, _ = agent.run_from_prices(_prices())
    assert trades
    agent.nominate([t.id for t in trades])
    lines, total = settle([t for t in agent.book if t.status == "nominated"])
    assert total > 0 and all(
        t.status == "settled" for t in agent.book if t.id in {ln.trade_id for ln in lines}
    )


def test_api_run_and_book():
    from fastapi.testclient import TestClient

    from energy_trading.api import app

    c = TestClient(app)
    assert c.get("/api/health").status_code == 200
    r = c.post("/api/run", json={"day": "2026-09-12", "volume_mw": 50, "max_trades": 5})
    assert r.status_code == 200
    assert r.json()["log"]["opportunities_scanned"] > 0
    assert c.get("/api/book").status_code == 200


def test_portfolio_mtm():
    p = Portfolio()
    agent = CrossBorderAgent(config=AgentConfig(default_volume_mw=10.0))
    trades, _ = agent.run_from_prices(_prices())
    p.add(trades)
    assert isinstance(p.mtm({}), float)
