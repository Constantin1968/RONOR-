from datetime import UTC, datetime

from energy_trading.agent import AgentConfig, CrossBorderAgent
from energy_trading.market_data import Market, PricePoint
from energy_trading.sovereignty import (
    EVIDENCE_OPERATOR,
    EVIDENCE_SIMULATED,
    ClaimsRegister,
    energy_report,
    sovereignty_report,
    trade_carbon_t,
    trade_energy_mwh,
)


def _trade(**kw):
    from energy_trading.models import Trade

    base = {
        "id": "XB-0001",
        "interconnector_id": "UA-MD",
        "from_zone": "UA",
        "to_zone": "MD",
        "delivery_start": datetime(2026, 9, 12, 18, tzinfo=UTC),
        "market": Market.DAY_AHEAD,
        "volume_mw": 100.0,
        "buy_price": 70.0,
        "sell_price": 104.0,
        "transport_cost": 1.5,
        "expected_pnl": 3250.0,
    }
    base.update(kw)
    return Trade(**base)


def test_energy_and_carbon_per_trade():
    t = _trade()
    assert trade_energy_mwh(t) == 100.0
    assert trade_carbon_t(t) == round(100.0 * 80.0 / 1_000_000, 3)


def test_energy_report_keeps_physics_beside_economics():
    rep = energy_report([_trade(), _trade(id="XB-0002")])
    assert rep["total_mwh"] == 200.0
    assert rep["total_expected_pnl_eur"] == 6500.0
    assert "carbon_defaults" in rep


def test_sovereignty_flags_net_importer():
    trades = [_trade(), _trade(id="XB-0002", from_zone="RO", to_zone="UA")]
    rep = sovereignty_report(trades, "MD")
    assert rep["imports_mw"] == 100.0
    assert rep["exports_mw"] == 0.0
    assert any("importator net" in f for f in rep["flags"])


def test_sovereignty_flags_concentration():
    trades = [_trade() for _ in range(3)]
    rep = sovereignty_report(trades, "RO", concentration_limit=0.6)
    assert any("concentrează" in f for f in rep["flags"])


def test_claims_register_files_and_confirms():
    reg = ClaimsRegister()
    entry = reg.file(kind="run", statement="3 trades, €100", evidence_level=EVIDENCE_SIMULATED)
    assert entry.id.startswith("CLM-") and entry.status == "provisional"
    reg.confirm(entry.id)
    assert reg.list()[0].status == "confirmed"
    assert reg.list("settlement") == []


def test_agent_run_files_claim_with_evidence():
    agent = CrossBorderAgent(config=AgentConfig(default_volume_mw=10.0))
    day = datetime(2026, 9, 12, tzinfo=UTC)
    prices = [
        PricePoint(
            zone="UA",
            delivery_start=day.replace(hour=18),
            market=Market.DAY_AHEAD,
            price_eur_mwh=60.0,
        ),
        PricePoint(
            zone="MD",
            delivery_start=day.replace(hour=18),
            market=Market.DAY_AHEAD,
            price_eur_mwh=130.0,
        ),
    ]
    _, log = agent.run_from_prices(prices, evidence_level=EVIDENCE_OPERATOR)
    assert log.evidence_level == EVIDENCE_OPERATOR
    assert log.claim_id
    assert agent.claims.list("run")[0].evidence_level == EVIDENCE_OPERATOR


def test_agent_nomination_and_settlement_file_claims():
    agent = CrossBorderAgent(config=AgentConfig(default_volume_mw=10.0))
    day = datetime(2026, 9, 12, tzinfo=UTC)
    prices = [
        PricePoint(
            zone="UA",
            delivery_start=day.replace(hour=18),
            market=Market.DAY_AHEAD,
            price_eur_mwh=60.0,
        ),
        PricePoint(
            zone="MD",
            delivery_start=day.replace(hour=18),
            market=Market.DAY_AHEAD,
            price_eur_mwh=130.0,
        ),
    ]
    trades, _ = agent.run_from_prices(prices)
    agent.nominate([t.id for t in trades])
    lines, total = agent.settle_book()
    assert total > 0 and lines
    assert {c.kind for c in agent.claims.entries} >= {"run", "nomination", "settlement"}


def test_api_claims_and_sovereignty():
    from fastapi.testclient import TestClient

    from energy_trading.api import app

    c = TestClient(app)
    c.post("/api/reset")
    c.post(
        "/api/run",
        json={"day": "2026-09-12", "zones": ["RO", "UA", "MD"], "volume_mw": 50, "max_trades": 3},
    )
    claims = c.get("/api/claims").json()
    assert claims["count"] >= 1
    sov = c.get("/api/sovereignty", params={"home": "RO"}).json()
    assert sov["balance"]["home_zone"] == "RO"
    assert "energy" in sov and sov["energy"]["total_mwh"] > 0
    c.post("/api/reset")
    assert c.get("/api/claims").json()["count"] == 0
