"""Capacity-auction results: what we hold beats what the TSO offered."""

from __future__ import annotations

from pathlib import Path

from energy_trading.agent import AgentConfig, CrossBorderAgent
from energy_trading.ops_intake import load_bids_csv
from energy_trading.scheduler import JobRunner, bid_limits, daily_brief, implied_cost_models
from energy_trading.store import StateStore
from tests.conftest import data_before_opcom
from tests.test_ops247 import _settings

DAY = "2026-09-14"


def _runner(tmp_path: Path) -> JobRunner:
    # The moment these assertions describe: auction won, OPCOM for 14.09 not out yet.
    settings = _settings(tmp_path, data_dir=data_before_opcom(tmp_path))
    return JobRunner(
        CrossBorderAgent(config=AgentConfig(default_volume_mw=50.0)),
        settings,
        StateStore(settings.state_dir),
    )


def test_load_bids_csv_reads_capacity_cbc_and_limits():
    won = load_bids_csv(f"data/bids_{DAY}.csv")
    assert won["capacity"]["RO-UA"] == {h: 15.0 for h in range(23)}
    assert won["capacity"]["MD-RO"] == {0: 15.0, 1: 15.0, 2: 15.0}
    assert won["capacity"]["UA-MD-RO"] == {3: 15.0, 4: 15.0}
    assert won["cbc"]["RO-UA"][0] == 0.23 and won["cbc"]["RO-UA"][10] == 0.0
    assert won["limits"]["RO-UA"][0] == 66.0 and won["limits"]["UA-MD-RO"][4] == 190.0
    assert "MD-RO" not in won["limits"]


def test_won_capacity_replaces_ntc_and_yields_bid_limits(tmp_path):
    runner = _runner(tmp_path)
    out = runner.run("hub_run", DAY)
    assert out["status"] == "ok"
    res = out["result"]
    assert res["bids"] == f"bids_{DAY}.csv"
    assert set(res["won_capacity"]) == {"RO-UA", "MD-RO", "UA-MD-RO"}
    # RO price not in yet: nothing to propose, but the operator gets the limits.
    assert res["trades_proposed"] == 0
    assert res["missing_price_zones"] == ["MD", "RO"]
    limits = {(r["corridor"], r["interval"]): r for r in res["bid_limits"]}
    h1 = limits[("RO-UA", 1)]
    assert h1["side"] == "buy" and h1["zone"] == "RO" and h1["known_price"] == 88.86
    # (88.86 - 0.9 tariff - 0.23 CBC - 0.5 spread) / 1.01 loss
    assert h1["model_limit"] == round((88.86 - 0.9 - 0.23 - 0.5) / 1.01, 2)
    assert h1["operator_limit"] == 66.0
    t4 = limits[("UA-MD-RO", 4)]
    assert t4["side"] == "sell" and t4["zone"] == "RO"
    assert t4["model_limit"] == round(77.27 * 1.019 + 1.9 + 0.59 + 0.5, 2)
    assert ("MD-RO", 1) not in limits  # neither end priced
    fit = res["implied_costs"]["RO-UA"]
    assert 0.94 < fit["slope"] < 0.95 and -19 < fit["intercept"] < -17.5
    assert fit["max_abs_error"] < 0.6
    brief = daily_brief(res, runner.agent.book)
    assert "🎟 capacitate câștigată: RO-UA 15 MW int 01–23h" in brief
    assert "🎯 RO-UA: cumpără în RO sub" in brief
    assert "📐 RO-UA" in brief and "⏳ RO fără preț" in brief
    assert "practic închis" not in brief  # NTC thin-border view is history once decided


def test_with_ro_prices_trades_only_on_won_capacity_with_cbc(tmp_path):
    runner = _runner(tmp_path)
    ro = {str(h): 60.0 for h in range(24)}  # cheap RO all day → export RO→UA where UA is high
    runner.store.save(f"briefs/{DAY}_overrides", {"prices": {"RO": ro}})
    res = runner.run("hub_run", DAY)["result"]
    trades = [t for t in runner.agent.book if t.delivery_start.date().isoformat() == DAY]
    assert trades and all(t.volume_mw == 15.0 for t in trades)
    assert {(t.from_zone, t.to_zone) for t in trades} == {("RO", "UA")}
    hours = {t.delivery_start.hour for t in trades}
    assert {4, 19, 20} <= hours and 10 not in hours  # UA 36.26 at int 11 is below RO
    h4 = next(t for t in trades if t.delivery_start.hour == 4)  # int 5: CBC 0.05
    assert h4.transport_cost == round(0.9 + 60.0 * 0.01 + 0.05, 2)  # CBC is in the cost
    assert res["trades_proposed"] == len(trades) == 12  # max_trades_per_run cap


def test_transit_capacity_is_directional():
    from datetime import UTC, datetime

    from energy_trading.arbitrage import find_opportunities
    from energy_trading.models import PricePoint

    t = datetime(2026, 9, 14, 3, tzinfo=UTC)
    avail = {"UA-MD-RO": {3: 30.0}, "RO-MD-UA": {3: 0.0}, "UA-RO": 0.0, "RO-UA": 0.0}
    cheap_ua = [PricePoint(zone="UA", delivery_start=t, price_eur_mwh=50.0)]
    ro = [PricePoint(zone="RO", delivery_start=t, price_eur_mwh=100.0)]
    opps = find_opportunities(cheap_ua + ro, availability=avail)
    assert [(o.interconnector_id, o.from_zone, o.to_zone) for o in opps] == [
        ("UA-MD-RO", "UA", "RO")
    ]
    # Flip the spread: the forward row must not serve the reverse flow.
    dear_ua = [PricePoint(zone="UA", delivery_start=t, price_eur_mwh=150.0)]
    assert find_opportunities(dear_ua + ro, availability=avail) == []


def test_bid_limits_and_fit_are_pure_functions():
    won = {
        "capacity": {"RO-UA": {0: 15.0, 1: 15.0, 2: 15.0}},
        "cbc": {"RO-UA": {0: 0.0, 1: 0.0, 2: 0.0}},
        "limits": {"RO-UA": {0: 90.0, 1: 40.0, 2: 140.0}},
    }
    prices = {"UA": {0: 100.0, 1: 50.0, 2: 150.0}}
    lim = bid_limits(won, prices, 0.5)
    assert [r["interval"] for r in lim] == [1, 2, 3]
    fit = implied_cost_models(lim)["RO-UA"]
    assert fit["slope"] == 1.0 and fit["intercept"] == -10.0
    assert fit["implied_fixed_eur_mwh"] == 10.0 and fit["implied_proportional_pct"] == 0.0
    assert bid_limits(won, {}, 0.5) == []  # nothing known, nothing to limit
