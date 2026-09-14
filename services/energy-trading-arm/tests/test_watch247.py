"""24/7 duties: watch, settle, gate reminders, retries, heartbeat, catch-up."""

from __future__ import annotations

import shutil
from datetime import UTC, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from energy_trading.agent import AgentConfig, CrossBorderAgent
from energy_trading.config import Settings
from energy_trading.scheduler import JobRunner
from energy_trading.store import StateStore
from tests.test_ops247 import _settings


class Outbox:
    def __init__(self):
        self.sent: list[str] = []

    enabled = True

    def send(self, text: str) -> bool:
        self.sent.append(text)
        return True

    def send_alerts(self, title, alerts) -> bool:
        self.sent.append(title + "\n" + "\n".join(a.message for a in alerts))
        return True


def _runner(tmp_path: Path, **over) -> tuple[JobRunner, Outbox, Settings]:
    data = tmp_path / "data"
    data.mkdir()
    for f in Path("data").glob("*.csv"):
        shutil.copy(f, data / f.name)
    settings = _settings(tmp_path, data_dir=data, **over)
    runner = JobRunner(
        CrossBorderAgent(config=AgentConfig(default_volume_mw=50.0)),
        settings,
        StateStore(settings.state_dir),
    )
    out = Outbox()
    runner.notifier = out
    return runner, out, settings


def test_watch_reruns_the_day_when_inputs_change(tmp_path):
    runner, out, settings = _runner(tmp_path)
    first = runner.run("watch")["result"]
    assert first["baseline"] > 0 and first["reruns"] == []
    assert runner.run("watch")["result"] == {"changed": [], "reruns": [], "pnl_reruns": []}
    # a new NTC file for a future day appears (as when the operator posts the table)
    future = (datetime.now(runner.tz).date() + timedelta(days=3)).isoformat()
    src = next(Path("data").glob("ntc_*.csv"))
    shutil.copy(src, settings.data_dir / f"ntc_{future}.csv")
    res = runner.run("watch")["result"]
    assert res["changed"] == [f"ntc_{future}.csv"] and res["reruns"] == [future]
    assert out.sent and out.sent[-1].startswith(f"🔄 Date noi pentru {future}: ntc_{future}")
    assert runner.store.load(f"briefs/{future}_result")["day"] == future
    # a chat override for that day also counts as new input
    runner.store.save_brief(
        future, "overrides", {"availability": {}, "prices": {}, "decisions": ["UA-MD exclus"]}
    )
    res = runner.run("watch")["result"]
    assert res["reruns"] == [future] and "override" in res["changed"][0]
    # past days are ignored; re-posting an identical file changes nothing
    shutil.copy(src, settings.data_dir / "ntc_2020-01-01.csv")
    assert runner.run("watch")["result"]["reruns"] == []
    shutil.copy(src, settings.data_dir / f"ntc_{future}.csv")
    assert runner.run("watch")["result"] == {"changed": [], "reruns": [], "pnl_reruns": []}


def test_settle_only_delivered_hours(tmp_path):
    runner, out, _ = _runner(tmp_path)
    agent = runner.agent
    runner.run("hub_run", day="2026-09-13")
    ids = [t.id for t in agent.book][:3]
    agent.nominate(ids, by="Natalia")
    # make one trade already delivered, keep the others in the future
    past = datetime.now(UTC) - timedelta(hours=3)
    agent.book[0].delivery_start = past
    for t in agent.book[1:3]:
        t.delivery_start = datetime.now(UTC) + timedelta(hours=5)
    res = runner.run("settle")["result"]
    assert res["settled"] == [ids[0]] and out.sent[-1].startswith("💶 Decontate 1 ore livrate")
    assert agent.book[0].status == "settled" and agent.book[1].status == "nominated"
    assert runner.store.load("book")[0]["status"] == "settled"
    assert runner.run("settle")["result"]["settled"] == []  # idempotent, silent
    assert "delivered trades settled" in agent.claims.entries[-1].statement


def test_gate_reminders_once_per_threshold(tmp_path):
    runner, out, settings = _runner(tmp_path, gate_closure="13:00", gate_reminders=[60, 15])
    tz = ZoneInfo(settings.timezone)
    tomorrow = (datetime.now(tz).date() + timedelta(days=1)).isoformat()
    runner.run("hub_run", day=tomorrow)
    if not any(t.status == "proposed" for t in runner.agent.book):
        # simulated prices may yield nothing for that day; plant one proposal
        runner.run("hub_run", day="2026-09-13")
        for t in runner.agent.book:
            t.delivery_start = t.delivery_start.replace(
                year=int(tomorrow[:4]), month=int(tomorrow[5:7]), day=int(tomorrow[8:10])
            )
    pending = sum(t.status == "proposed" for t in runner.agent.book)
    assert pending

    import energy_trading.scheduler as sched

    real_now = sched.datetime

    class Clock(real_now):
        _at = None

        @classmethod
        def now(cls, tz=None):
            return cls._at.astimezone(tz) if tz else cls._at

    sched.datetime = Clock
    try:
        base = datetime.now(tz).replace(hour=10, minute=0, second=0, microsecond=0)
        Clock._at = base
        assert runner.run("gate")["result"]["reminded"] is None  # 3h left: quiet
        Clock._at = base.replace(hour=12, minute=10)
        r = runner.run("gate")["result"]
        assert r["reminded"] == 60 and out.sent[-1].startswith(
            "⏰ Gate day-ahead 13:00 închide în 50 min"
        )
        assert f"{pending} propuneri pentru {tomorrow}" in out.sent[-1]
        n = len(out.sent)
        Clock._at = base.replace(hour=12, minute=20)
        assert runner.run("gate")["result"]["reminded"] is None and len(out.sent) == n  # no repeat
        Clock._at = base.replace(hour=12, minute=50)
        assert runner.run("gate")["result"]["reminded"] == 15
        Clock._at = base.replace(hour=13, minute=5)
        assert runner.run("gate")["result"]["gate"] == "closed"
    finally:
        sched.datetime = real_now
    # authorized → nothing pending → silent
    runner.agent.nominate([t.id for t in runner.agent.book if t.status == "proposed"], by="x")
    assert runner.run("gate")["result"] == {"pending": 0, "reminded": None}


def test_retry_then_escalate(tmp_path):
    runner, out, _ = _runner(
        tmp_path, retry_minutes=10, max_retries=2, weather_hour=23, hub_run_hour=23, evening_hour=23
    )
    calls = {"n": 0}

    def flaky(self, day=None):
        calls["n"] += 1
        raise RuntimeError("ENTSO-E timeout")

    runner.JOBS = {**runner.JOBS, "weather": flaky}
    now = datetime.now(runner.tz)
    r = runner.run("weather")
    assert r["status"] == "error" and runner.status()["retries"]["weather"]["attempt"] == 1
    assert out.sent[-1].startswith("Job weather a eșuat") and "reîncerc la" in out.sent[-1]
    assert runner.due_retries(now) == []
    assert runner.due_retries(now + timedelta(minutes=11)) == [("weather", None)]
    assert runner.tick(now + timedelta(minutes=11))[0] == "retry:weather"
    assert (
        runner.status()["retries"]["weather"]["attempt"] == 2 and len(out.sent) == 1
    )  # quiet retry
    runner.tick(now + timedelta(minutes=22))
    assert "weather" not in runner.status()["retries"]
    assert out.sent[-1].startswith("Job weather a eșuat definitiv") and calls["n"] == 3
    # a later success clears everything
    runner.JOBS = {**runner.JOBS, "weather": lambda self, day=None: {"ok": True}}
    assert runner.run("weather")["status"] == "ok" and runner.status()["retries"] == {}


def test_heartbeat_and_restart_report(tmp_path):
    runner, out, _ = _runner(tmp_path)
    beat = runner.run("heartbeat")["result"]
    assert beat["book"] == 0 and runner.store.load("heartbeat")["at"] == beat["at"]
    runner._on_start()
    assert out.sent == []  # fresh beat: nothing to report
    stale = (datetime.now(runner.tz) - timedelta(hours=5)).isoformat()
    runner.store.save("heartbeat", {**beat, "at": stale})
    runner._on_start()
    assert out.sent[-1].startswith("🔁 RONOR energie repornit după ~5.0 h fără puls")
    st = runner.status()
    assert st["uptime_minutes"] == 0 and st["heartbeat"]["at"] == stale
    assert set(st["next"]) == {
        "weather",
        "pnl",
        "hub_run",
        "evening",
        "watch",
        "settle",
        "heartbeat",
        "gate",
    }


def test_tick_runs_catchup_and_periodic_duties(tmp_path):
    runner, _out, settings = _runner(tmp_path, weather_hour=23, hub_run_hour=0, evening_hour=23)
    tz = ZoneInfo(settings.timezone)
    at = datetime.now(tz).replace(hour=1, minute=0)
    ran = runner.tick(at)
    # hub_run (00:00) was missed → caught up; the periodic duties run on first tick
    assert ran[0] == "hub_run" and {"watch", "settle", "heartbeat", "gate"} <= set(ran)
    assert runner._last_run["hub_run"] == at.date().isoformat()
    assert runner.tick(at + timedelta(seconds=30)) == []  # nothing due yet
    assert runner.tick(at + timedelta(minutes=1)) == ["watch", "gate"]  # per-minute duties
    later = runner.tick(at + timedelta(minutes=61))
    assert "settle" in later and "heartbeat" in later
    # quiet duties do not flood the job log
    jobs = [r["job"] for r in runner.store.read("jobs")]
    assert "gate" not in jobs and "heartbeat" not in jobs and "hub_run" in jobs and "settle" in jobs
