import shutil
from datetime import UTC, datetime
from io import BytesIO
from pathlib import Path
from zoneinfo import ZoneInfo

from openpyxl import Workbook

from energy_trading.agent import AgentConfig, CrossBorderAgent
from energy_trading.alerts import (
    Alert,
    TelegramNotifier,
    rules_from_hub,
    rules_from_sovereignty,
    rules_from_weather,
)
from energy_trading.config import Settings
from energy_trading.scheduler import JobRunner, latest_file
from energy_trading.store import StateStore
from energy_trading.telegram_bot import TelegramIngestor, infer_day


def _settings(tmp_path: Path, **over) -> Settings:
    base = {
        "data_dir": Path("data"),
        "state_dir": tmp_path / "state",
        "scheduler_enabled": False,
        "telegram_bot_token": "",
        "telegram_chat_id": "",
        "telegram_webhook_secret": "s3cret",
        "telegram_allowed_chats": [],
        "fetch_minutes": 0,  # never touch OPCOM/OREE from tests
        "pnl_hour": 23,
    }
    base.update(over)
    return Settings(**base)


# -- store ---------------------------------------------------------------------


def test_store_append_read_and_snapshots(tmp_path):
    s = StateStore(tmp_path / "st")
    s.append("alerts", {"a": 1})
    s.append("alerts", {"a": 2})
    assert [r["a"] for r in s.read("alerts")] == [1, 2]
    assert s.read("alerts", limit=1)[0]["a"] == 2
    s.save("book", [{"id": "XB-0001"}])
    assert s.load("book")[0]["id"] == "XB-0001"
    assert s.load("missing", default="x") == "x"
    s.save_brief("2026-09-13", "hub", {"ok": True})
    assert s.list_briefs("2026-09-13") == ["2026-09-13_hub.json"]


# -- alerts --------------------------------------------------------------------


def test_rules_from_sovereignty_flags_concentration_and_net_import():
    balance = {
        "home_zone": "RO",
        "net_mw": -100.0,
        "per_border_mw": {"UA-MD": 900.0, "RO-UA": 100.0},
    }
    alerts = rules_from_sovereignty(balance, 0.6)
    assert {a.rule for a in alerts} == {"concentration", "net_importer"}


def test_rules_from_hub_wide_basis_and_best_wheel():
    snap = {
        "basis": [
            {"zone": "UA", "hour": 3, "basis": -55.5, "direction": "import", "capacity_mw": 197.0},
            {"zone": "BG", "hour": 3, "basis": -2.0, "direction": "flat", "capacity_mw": 800.0},
        ],
        "summary": {
            "best_wheel": {
                "from_zone": "UA",
                "to_zone": "MD",
                "hour": 3,
                "net_spread": 20.0,
                "capacity_mw": 100.0,
            }
        },
    }
    alerts = rules_from_hub(snap, 40.0)
    assert [a.rule for a in alerts] == ["wide_basis", "best_wheel"]
    assert alerts[0].context["zone"] == "UA" and alerts[0].context["hours"] == 1


def test_rules_from_ntc_thin_and_drop():
    from energy_trading.alerts import rules_from_ntc

    thin = {"MD-UA": {h: (60.0 if h == 15 else 10.0) for h in range(24)}}
    a = rules_from_ntc(thin, 50.0)
    assert len(a) == 1 and a[0].rule == "thin_cbc" and "ferestre utile: 15" in a[0].message
    today = {"UA-MD": {h: 100.0 for h in range(24)}}
    yesterday = {"UA-MD": {h: 500.0 for h in range(24)}}
    assert rules_from_ntc(today, 50.0) == []
    d = rules_from_ntc(today, 50.0, previous=yesterday)
    assert len(d) == 1 and "-80%" in d[0].message and d[0].context["prev_mean_mw"] == 500.0
    assert rules_from_ntc({"X": 300.0}, 50.0) == []  # flat values are not hourly tables


def test_rules_from_weather_reports_worker_error():
    brief = {"countries": {"UA": {"status": "error", "error": "timeout"}}, "hub_read": ["nota"]}
    rules = rules_from_weather(brief)
    assert rules[0].rule == "weather_worker_error" and rules[0].level == "warning"
    assert rules[1].rule == "weather_hub_read"


def test_notifier_noop_when_unconfigured(tmp_path):
    n = TelegramNotifier(_settings(tmp_path))
    assert n.enabled is False
    assert n.send("x") is False
    assert n.send_alerts("t", [Alert(level="info", rule="r", message="m")]) is False


# -- scheduler -----------------------------------------------------------------


def test_latest_file_prefers_exact_day_then_newest(tmp_path):
    for d in ("2026-09-13", "2026-09-14"):
        (tmp_path / f"ntc_{d}.csv").write_text("x")
    assert latest_file(tmp_path, "ntc", "2026-09-13").name == "ntc_2026-09-13.csv"
    assert latest_file(tmp_path, "ntc", "2030-01-01").name == "ntc_2026-09-14.csv"
    assert latest_file(tmp_path, "prices", "2030-01-01", fallback=False) is None
    assert latest_file(tmp_path, "nope") is None


def test_job_hub_run_never_labels_stale_prices_as_real(tmp_path):
    settings = _settings(tmp_path)
    runner = JobRunner(CrossBorderAgent(), settings, StateStore(settings.state_dir))
    res = runner.run("hub_run", day="2030-01-01")["result"]
    assert res["prices"] is None and res["evidence"] == "simulated"
    assert res["ntc_fallback"] is True


def test_job_hub_run_uses_real_data_and_files_briefs(tmp_path):
    settings = _settings(tmp_path)
    agent = CrossBorderAgent(config=AgentConfig(default_volume_mw=50.0))
    runner = JobRunner(agent, settings, StateStore(settings.state_dir))
    out = runner.run("hub_run", day="2026-09-13")
    assert out["status"] == "ok"
    res = out["result"]
    assert res["ntc"] == "ntc_2026-09-13.csv" and res["prices"] == "prices_2026-09-13.csv"
    assert res["evidence"] == "operator_provided"
    assert res["trades_proposed"] > 0
    assert set(runner.store.list_briefs("2026-09-13")) >= {
        "2026-09-13_hub.json",
        "2026-09-13_run.json",
    }
    assert runner.store.read("jobs")[-1]["job"] == "hub_run"
    assert runner.store.load("claims")


def test_job_evening_files_sovereignty(tmp_path):
    settings = _settings(tmp_path)
    agent = CrossBorderAgent(config=AgentConfig(default_volume_mw=50.0))
    runner = JobRunner(agent, settings, StateStore(settings.state_dir))
    runner.run("hub_run", day="2026-09-13")
    out = runner.run("evening", day="2026-09-13")
    assert out["status"] == "ok"
    assert "balance" in out["result"]["sovereignty"]
    assert any(a["rule"] == "concentration" for a in runner.store.read("alerts"))


def test_job_unknown_and_error_isolation(tmp_path):
    settings = _settings(tmp_path)
    runner = JobRunner(CrossBorderAgent(), settings, StateStore(settings.state_dir))
    try:
        runner.run("nope")
        raise AssertionError("expected ValueError")
    except ValueError:
        pass

    def boom(self, day=None):
        raise RuntimeError("kaput")

    runner.JOBS = {**runner.JOBS, "boom": boom}
    out = runner.run("boom")
    assert out["status"] == "error" and "kaput" in out["result"]["error"]
    assert runner.store.read("alerts")[-1]["rule"] == "job_error"


def test_state_survives_restart(tmp_path):
    settings = _settings(tmp_path)
    agent1 = CrossBorderAgent(config=AgentConfig(default_volume_mw=50.0))
    r1 = JobRunner(agent1, settings, StateStore(settings.state_dir))
    r1.run("hub_run", day="2026-09-13")
    ids = [t.id for t in agent1.book]
    n_claims = len(agent1.claims.entries)
    assert ids and n_claims

    agent2 = CrossBorderAgent(config=AgentConfig(default_volume_mw=50.0))
    r2 = JobRunner(agent2, settings, StateStore(settings.state_dir))
    assert r2.restored == {"trades": len(ids), "claims": n_claims}
    assert [t.id for t in agent2.book] == ids
    # an explicit-day rerun does not count as the scheduled daily run
    assert r2.due_jobs(datetime(2026, 9, 13, 12, 0, tzinfo=ZoneInfo(settings.timezone))) == [
        "weather",
        "hub_run",
    ]  # pnl is at 23 in tests
    new_claim = agent2.claims.file(kind="test", statement="x")
    assert new_claim.id == f"CLM-{n_claims + 1:04d}"


def test_due_jobs_respects_hours_and_idempotency(tmp_path):
    settings = _settings(tmp_path, weather_hour=6, pnl_hour=7, hub_run_hour=9, evening_hour=18)
    runner = JobRunner(CrossBorderAgent(), settings, StateStore(settings.state_dir))
    tz = ZoneInfo(settings.timezone)
    early = datetime(2026, 9, 13, 5, 0, tzinfo=tz)
    assert runner.due_jobs(early) == []
    mid = datetime(2026, 9, 13, 10, 0, tzinfo=tz)
    assert runner.due_jobs(mid) == ["weather", "pnl", "hub_run"]
    runner._last_run["pnl"] = "2026-09-13"
    runner._last_run["weather"] = "2026-09-13"
    assert runner.due_jobs(mid) == ["hub_run"]


# -- telegram ingestion --------------------------------------------------------


def test_infer_day_variants():
    now = datetime(2026, 9, 13, tzinfo=UTC)
    assert infer_day("ua-ro 13/09", now) == "2026-09-13"
    assert infer_day("ENCON bid 12.09.xlsx", now) == "2026-09-12"
    assert infer_day("NTC 14.09.2026", now) == "2026-09-14"
    assert infer_day("no date here", now) == "2026-09-13"


def _xlsx() -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.append(["Granita", "ATC_MW"])
    ws.append(["RO-UA", 450])
    buf = BytesIO()
    wb.save(buf)
    return buf.getvalue()


def test_ingestor_handles_document_and_text(tmp_path):
    settings = _settings(tmp_path, telegram_allowed_chats=["-100"])
    ing = TelegramIngestor(settings, StateStore(settings.state_dir))
    doc_update = {
        "message": {
            "chat": {"id": -100},
            "caption": "NTC 13.09",
            "document": {"file_id": "f1", "file_name": "ntc.xlsx"},
        }
    }
    res = ing.handle_update(doc_update, download=lambda fid: _xlsx())
    assert res.accepted and res.kind == "document" and res.day == "2026-09-13"
    assert res.intake.availability == {"RO-UA": 450.0}
    assert "RO-UA 450 MW" in res.reply

    text_update = {"message": {"chat": {"id": -100}, "text": "UA-MD ATC 600\nUA ora 18 pret 68"}}
    res2 = ing.handle_update(text_update)
    assert res2.accepted and res2.kind == "text"
    assert res2.intake.availability == {"UA-MD": 600.0}
    assert ing.store.read("ingest")[-1]["kind"] == "text"


def test_ingestor_ignores_unauthorized_chat_and_chatter(tmp_path):
    settings = _settings(tmp_path, telegram_allowed_chats=["-100"])
    ing = TelegramIngestor(settings, StateStore(settings.state_dir))
    assert not ing.handle_update(
        {"message": {"chat": {"id": -999}, "text": "RO-UA ATC 1"}}
    ).accepted
    res = ing.handle_update({"message": {"chat": {"id": -100}, "text": "Good morning"}})
    assert not res.accepted and res.kind == "ignored"
    assert ing.authorized("s3cret") and not ing.authorized("wrong") and not ing.authorized(None)


def test_chat_skip_decision_is_applied_to_hub_run(tmp_path):
    """Replays the real group exchange: NTC 14.09 + 'better to skip Ua-Md'."""
    settings = _settings(tmp_path)
    store = StateStore(settings.state_dir)
    ing = TelegramIngestor(settings, store)
    msg = "It is too low availabile cbc, I'm not sure will take anything, it is better to skip Ua-Md 14.09"
    res = ing.handle_update({"message": {"chat": {"id": 1}, "text": msg}})
    assert res.accepted and res.day == "2026-09-14"
    assert res.intake.availability == {"UA-MD": 0.0}
    assert res.intake.decisions and "UA-MD exclus" in res.intake.decisions[0]
    assert "🚫 UA-MD exclus" in res.reply and "ATC:" not in res.reply
    ov = store.load("briefs/2026-09-14_overrides")
    assert ov["availability"] == {"UA-MD": 0.0} and len(ov["decisions"]) == 1

    agent = CrossBorderAgent(config=AgentConfig(default_volume_mw=50.0))
    runner = JobRunner(agent, settings, store)
    r = runner.run("hub_run", day="2026-09-14")["result"]
    assert r["decisions"] == ov["decisions"]
    assert not any(t.from_zone == "UA" and t.to_zone == "MD" for t in agent.book)
    thin = [a for a in r["alerts"] if a["rule"] == "thin_cbc"]
    assert any(a["context"]["border"] == "UA-MD" and "-82%" in a["message"] for a in thin)
    assert any(a["rule"] == "operator_decision" for a in r["alerts"])

    # Without the decision (and before the auction result exists) the simulated run
    # does trade UA→MD at night on the NTC offer.
    data2 = tmp_path / "b" / "data"
    data2.mkdir(parents=True)
    for f in Path("data").glob("*.csv"):
        if f.name not in ("bids_2026-09-14.csv", "prices_2026-09-14.csv"):
            shutil.copy(f, data2 / f.name)
    agent2 = CrossBorderAgent(config=AgentConfig(default_volume_mw=50.0))
    runner2 = JobRunner(
        agent2, _settings(tmp_path / "b", data_dir=data2), StateStore(tmp_path / "b" / "state")
    )
    runner2.run("hub_run", day="2026-09-14")
    assert any(t.from_zone == "UA" and t.to_zone == "MD" for t in agent2.book)

    # With the auction result the chat decision still wins over the file.
    store3 = StateStore(tmp_path / "c" / "state")
    store3.save(
        "briefs/2026-09-14_overrides",
        {"availability": {"RO-UA": 0.0}, "prices": {"RO": {str(h): 60.0 for h in range(24)}}},
    )
    agent3 = CrossBorderAgent(config=AgentConfig(default_volume_mw=50.0))
    r3 = JobRunner(agent3, _settings(tmp_path / "c"), store3).run("hub_run", day="2026-09-14")
    assert r3["result"]["won_capacity"]["RO-UA"]  # we hold it...
    assert not any(t.from_zone == "RO" and t.to_zone == "UA" for t in agent3.book)  # ...but skip it


def test_chat_interval_prices_without_zone_are_held(tmp_path):
    settings = _settings(tmp_path)
    ing = TelegramIngestor(settings, StateStore(settings.state_dir))
    res = ing.handle_update(
        {
            "message": {
                "chat": {"id": 1},
                "text": "int 7 - 191 euro\nint 14 - 87 euro\nint 23 - 221 euro",
            }
        }
    )
    assert res.accepted
    assert res.intake.unassigned_prices == {6: 191.0, 13: 87.0, 22: 221.0}
    assert res.intake.prices_override == {}
    assert "fără zonă" in res.reply and "h7=191" in res.reply


def test_skip_phrasings():
    from energy_trading.ops_intake import parse_daily_note

    for text in (
        "skip UA-MD",
        "sărim ua/md",
        "fără UA-MD azi",
        "UA-MD off",
        "nu luăm UA-MD",
        "MD/UA closed",
    ):
        it = parse_daily_note(text, day="2026-09-14")
        assert it.decisions, text
        assert list(it.availability.values()) == [0.0], text
    both = parse_daily_note("RO-UA ATC 450 MW, skip UA-MD", day="2026-09-14")
    assert both.availability == {"RO-UA": 450.0, "UA-MD": 0.0}


def test_api_jobs_and_webhook_auth():
    from fastapi.testclient import TestClient

    from energy_trading import api

    c = TestClient(api.app)
    assert c.get("/api/jobs").status_code == 200
    assert c.post("/api/jobs/nope").status_code == 404
    r = c.post(
        "/api/telegram/webhook", json={"message": {"chat": {"id": 1}, "text": "RO-UA ATC 1"}}
    )
    assert r.status_code == 403
    api.ingestor.settings = api.settings.model_copy(update={"telegram_webhook_secret": "abc"})
    r2 = c.post(
        "/api/telegram/webhook",
        json={"message": {"chat": {"id": 1}, "text": "RO-UA ATC 450 MW"}},
        headers={"X-Telegram-Bot-Api-Secret-Token": "abc"},
    )
    assert r2.status_code == 200 and r2.json()["accepted"] is True
    assert c.get("/api/ingest-log").json()["count"] >= 1
    assert c.get("/api/alerts").status_code == 200
    assert c.get("/api/briefs").status_code == 200
