"""Digital twin: prices read from the exchanges, and the day marked to them (P/L)."""

from __future__ import annotations

import json
from datetime import UTC, date, datetime
from pathlib import Path

import pytest

from energy_trading import scheduler as sched
from energy_trading import sources
from energy_trading.agent import AgentConfig, CrossBorderAgent
from energy_trading.models import Market, Trade
from energy_trading.operator_bot import OperatorBot
from energy_trading.scheduler import JobRunner
from energy_trading.sources import (
    SourceUnavailable,
    fetch_ua_dam,
    merge_prices,
    missing_hours,
    parse_opcom_csv,
    parse_oree_html,
)
from energy_trading.store import StateStore
from energy_trading.twin_pnl import day_pnl, format_pnl, month_to_date
from tests.test_ops247 import _settings

FIX = Path("tests/fixtures")


# -- parsers -----------------------------------------------------------------------


def test_opcom_quarter_hours_average_to_cet_hours():
    hourly = parse_opcom_csv((FIX / "opcom_2026-09-13_en.csv").read_text())
    assert len(hourly) == 24
    assert hourly[1] == 177.83  # (191.99 + 180.01 + 173.30 + 166.01) / 4
    assert hourly[24] == 210.59
    with pytest.raises(SourceUnavailable):
        parse_opcom_csv("header only\n")


def test_oree_table_and_kyiv_to_cet_conversion(monkeypatch):
    payload = (FIX / "oree_2026-09-14_dam2.json").read_text()
    kyiv = parse_oree_html(payload)
    assert kyiv[1] == 6800.0 and kyiv[2] == 4600.0 and kyiv[24] == 6200.0

    def fake_get(url: str, timeout: float) -> str:
        if "14.09.2026" in url:
            return payload
        if "bank.gov.ua" in url:
            assert "date=20260913" in url  # rate of the auction day, D-1
            return json.dumps([{"rate": 51.7643, "cc": "EUR"}])
        raise SourceUnavailable("next day not published")

    monkeypatch.setattr(sources, "_get", fake_get)
    res = fetch_ua_dam(date(2026, 9, 14))
    # CET hour h = Kyiv hour h+1, in EUR at the NBU rate: matches the operator's sheet.
    assert res["prices"][1] == 88.86 and res["prices"][5] == 119.77 and res["prices"][20] == 240.01
    assert 24 not in res["prices"]  # needs the next day's Kyiv hour 1
    assert res["rate_uah_eur"] == 51.7643 and res["zone"] == "UA"


# -- merge -------------------------------------------------------------------------


def test_merge_fills_gaps_and_reports_typos(tmp_path):
    path = tmp_path / "prices_2026-09-14.csv"
    path.write_text("hour_cet,ro_dam_eur,ua_dam_eur,md_price_eur\n1,,88.86,\n2,,77.00,\n")
    assert missing_hours(path, "RO") == list(range(1, 25))
    assert missing_hours(path, "UA") == list(range(3, 25))
    fetched = {"zone": "UA", "prices": {1: 88.86, 2: 77.27, 3: 77.25}}
    m = merge_prices(path, fetched)
    assert m["added"] == [3] and m["changed"] == [2]
    assert m["mismatches"] == [{"hour": 2, "file": 77.0, "source": 77.27}]
    assert missing_hours(path, "UA") == list(range(4, 25))
    text = path.read_text()
    assert "2,,77.27," in text and text.count("\n") == 25  # always 24 rows


# -- P/L math ----------------------------------------------------------------------


def _trade(day: str, hour: int, ic: str, src: str, dst: str, mw: float) -> Trade:
    return Trade(
        id=f"T{hour}",
        interconnector_id=ic,
        from_zone=src,
        to_zone=dst,
        delivery_start=datetime.fromisoformat(day).replace(hour=hour, tzinfo=UTC),
        market=Market.DAY_AHEAD,
        volume_mw=mw,
        buy_price=0.0,
        sell_price=0.0,
        transport_cost=0.0,
        expected_pnl=0.0,
    )


def test_day_pnl_limits_fills_perfect_and_cbc():
    day = "2026-09-14"
    # RO→UA export, 15 MW, three hours. RO-UA tariff 0.90, loss 1%.
    won = {
        "capacity": {"RO-UA": {0: 15.0, 1: 15.0, 2: 15.0}},
        "cbc": {"RO-UA": {0: 0.2, 1: 0.2, 2: 0.0}},
        "limits": {"RO-UA": {0: 70.0, 1: 50.0, 2: 260.0}},
        "filled": {},
    }
    prices = {
        "RO": {
            0: 60.0,
            1: 60.0,
            2: 250.0,
        },  # h0 fills (60 ≤ 70), h1 no (60 > 50), h2 fills at a loss
        "UA": {0: 100.0, 1: 100.0, 2: 240.0},
    }
    rep = day_pnl(day, prices, won, [], home="RO")
    c = rep["corridors"][0]
    s0 = 100 - 60 - (0.9 + 0.6)  # 38.5 net spread before CBC
    s2 = 240 - 250 - (0.9 + 2.5)  # -13.4
    assert c["filled_hours"] == [1, 3] and c["missed_hours"] == [2] and c["bad_fills"] == [3]
    assert c["positive_hours"] == [1, 2]
    assert c["perfect"] == round(2 * s0 * 15, 2)
    assert c["operator"] == round((s0 + s2) * 15, 2)
    assert c["cbc_paid"] == round(0.4 * 15, 2)  # paid on every held hour
    assert rep["operator_known"] and rep["net"]["operator"] == round((s0 + s2) * 15 - 6.0, 2)
    assert rep["net"]["perfect"] == round(2 * s0 * 15 - 6.0, 2)
    assert 0 < rep["capture"]["operator"] < 1

    # The twin's own proposal for h0, marked to the same prices (CBC inside).
    book = [_trade(day, 0, "RO-UA", "RO", "UA", 15.0)]
    rep2 = day_pnl(day, prices, won, book, home="RO")
    assert rep2["net"]["twin"] == round((s0 - 0.2) * 15, 2)

    # Own-cost view: 5% + 18 fixed on the source price.
    implied = {"RO-UA": {"implied_proportional_pct": 5.0, "implied_fixed_eur_mwh": 18.0}}
    rep3 = day_pnl(day, prices, won, [], implied, home="RO")
    own0 = 100 - 60 - (3.0 + 18.0)
    own2 = 240 - 250 - (12.5 + 18.0)
    assert rep3["net"]["operator_own_costs"] == round((own0 + own2) * 15 - 6.0, 2)
    assert rep3["own_costs_applied"]


def test_day_pnl_unknowns_are_not_zeros():
    day = "2026-09-14"
    won = {
        "capacity": {"MD-RO": {0: 15.0, 1: 15.0}, "UA-MD-RO": {3: 15.0}},
        "cbc": {"MD-RO": {0: 0.0, 1: 0.0}, "UA-MD-RO": {3: 0.59}},
        "limits": {"UA-MD-RO": {3: 132.0}},  # sell limit in RO (home is the sink)
        "filled": {},
    }
    prices = {"RO": {0: 150.0, 1: 150.0, 3: 160.0}, "UA": {3: 77.27}}  # no MD price at all
    rep = day_pnl(day, prices, won, [], home="RO")
    md = next(c for c in rep["corridors"] if c["corridor"] == "MD-RO")
    assert md["unknown_hours"] == [1, 2] and md["perfect"] == 0.0
    tr = next(c for c in rep["corridors"] if c["corridor"] == "UA-MD-RO")
    assert tr["filled_hours"] == [4]  # 160 ≥ 132
    assert rep["operator_known"]  # unknown-price hours are not 'undetermined'
    text = format_pnl(rep, {"RO": {"source": "OPCOM PZU", "hours": 3}})
    assert "❔ MD→RO 15 MW int 01–02: fără preț" in text
    assert "UA→RO via UA-MD-RO" in text and "Surse: RO OPCOM PZU 3h" in text

    # No limit, no fill report → the operator figure is unknown, never zero.
    won["limits"] = {}
    rep2 = day_pnl(day, prices, won, [], home="RO")
    assert not rep2["operator_known"] and rep2["net"]["operator"] is None
    assert "operator nedeterminat" in format_pnl(rep2)

    # A fill report for the corridor decides every hour of it.
    won["filled"] = {"UA-MD-RO": {3: 10.0}}
    rep3 = day_pnl(day, prices, won, [], home="RO")
    assert rep3["operator_known"] and rep3["totals"]["filled_mwh"] == 10.0


def test_month_to_date_skips_undetermined_days():
    recs = [
        {"day": "2026-09-12", "net": {"operator": None, "twin": 100.0, "perfect": 500.0}},
        {"day": "2026-09-13", "net": {"operator": 50.0, "twin": 80.0, "perfect": 200.0}},
        {
            "day": "2026-09-13",
            "net": {"operator": 60.0, "twin": 80.0, "perfect": 200.0},
        },  # rerun wins
        {"day": "2026-08-31", "net": {"operator": 9.0, "twin": 9.0, "perfect": 9.0}},
    ]
    m = month_to_date(recs, "2026-09-14")
    assert m == {
        "days": 2,
        "operator": 60.0,
        "operator_days": 1,
        "perfect_on_operator_days": 200.0,
        "twin": 180.0,
        "perfect": 700.0,
    }


# -- jobs --------------------------------------------------------------------------


def _runner(tmp_path: Path, **over) -> JobRunner:
    import shutil

    data = tmp_path / "data"
    data.mkdir()
    for f in Path("data").glob("*.csv"):
        shutil.copy(f, data / f.name)
    settings = _settings(tmp_path, data_dir=data, **over)
    return JobRunner(
        CrossBorderAgent(config=AgentConfig(default_volume_mw=50.0)),
        settings,
        StateStore(settings.state_dir),
    )


def test_fetch_job_writes_prices_provenance_and_watch_reruns_the_day(tmp_path, monkeypatch):
    runner = _runner(tmp_path, fetch_minutes=15)
    sent: list[str] = []
    runner.notifier.send = lambda text: sent.append(text) or True  # type: ignore[method-assign]
    ro = {h: 60.0 for h in range(1, 25)}

    def fake_ro(day: date, timeout: float) -> dict:
        return {"zone": "RO", "prices": ro, "source": "OPCOM PZU", "url": "test://opcom"}

    def not_yet(day: date, timeout: float) -> dict:
        raise SourceUnavailable("not published")

    monkeypatch.setattr(sched, "FETCHERS", {"RO": fake_ro, "UA": not_yet})
    runner.run("watch")  # baseline fingerprint
    out = runner.run("fetch", "2026-09-14")["result"]
    assert out["fetched"] == ["RO 2026-09-14 (24h, OPCOM PZU)"] and out["pending"] == [
        "UA 2026-09-14"
    ]
    assert missing_hours(runner.settings.data_dir / "prices_2026-09-14.csv", "RO") == []
    prov = runner.store.load("briefs/2026-09-14_sources")
    assert prov["RO"]["source"] == "OPCOM PZU" and prov["RO"]["verified_typed"] is False
    assert any(c.kind == "price_source" for c in runner.agent.claims.entries)
    # Second pass: nothing missing, provenance present → no call, nothing fetched.
    assert runner.run("fetch", "2026-09-14")["result"]["fetched"] == []
    # The watch sees the new file and reruns 14.09: now RO has a price → proposals on won capacity.
    w = runner.run("watch")["result"]
    assert "2026-09-14" in w["reruns"]
    brief = sent[-1]
    assert "RO 24h OPCOM" in brief and "✅ RO→UA" in brief


def test_pnl_job_end_to_end_on_13_09(tmp_path, monkeypatch):
    runner = _runner(tmp_path)
    monkeypatch.setattr(
        sched, "FETCHERS", {"RO": lambda d, t: (_ for _ in ()).throw(SourceUnavailable("off"))}
    )
    sent: list[str] = []
    runner.notifier.send = lambda text: sent.append(text) or True  # type: ignore[method-assign]
    runner.run("hub_run", "2026-09-13")  # the twin's own proposals for the day
    out = runner.run("pnl", "2026-09-13")
    assert out["status"] == "ok"
    rep = out["result"]["report"]
    ua_ro = next(c for c in rep["corridors"] if c["corridor"] == "UA-RO")
    assert ua_ro["filled_hours"] == [7, 14, 23]  # 'nominated 15 MW' notes in bids_2026-09-13.csv
    assert ua_ro["operator"] > 0 and ua_ro["perfect"] > ua_ro["operator"]
    assert rep["net"]["twin"] > 0  # the twin proposed UA→RO hours and they paid
    assert not rep["operator_known"]  # RO-UA / UA-MD / transit have no limits or fills
    text = out["result"]["text"]
    assert text.startswith("📊 P/L Digital Twin — 2026-09-13 (livrat)")
    assert "prins 3h din" in text and "operator nedeterminat" in text
    assert sent[-1] == text
    assert runner.store.load("briefs/2026-09-13_pnl")["day"] == "2026-09-13"
    assert runner.store.read("pnl_twin")[-1]["day"] == "2026-09-13"


def test_operator_bot_pl_intent_and_command(tmp_path, monkeypatch):
    runner = _runner(tmp_path)
    monkeypatch.setattr(sched, "FETCHERS", {})
    bot = OperatorBot(runner.agent, runner, runner.store, runner.settings)
    assert bot.intent("cât am făcut ieri?") == ("pl", "ieri")
    assert bot.intent("P/L pe 13.09") == ("pl", "13.09")
    assert bot.intent("a ieșit OPCOM?") == ("preturi", "")
    assert bot.handle("/pl 13.09").startswith("📊 P/L Digital Twin — 2026-09-13")
    assert "deja complete" in bot.handle("/preturi 13.09") or "nepublicat" in bot.handle(
        "/preturi 13.09"
    )
