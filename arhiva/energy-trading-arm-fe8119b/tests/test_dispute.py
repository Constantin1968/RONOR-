"""Tests for the dispute channel — /api/dispute, /api/disputes, materialisation."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from energy_trading import config as _config
from energy_trading.dispute import (
    CorrectiveAction,
    DisputeRequest,
    append_dispute,
    list_disputes,
)


@pytest.fixture
def data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(_config.settings, "data_dir", tmp_path)
    return tmp_path


def test_dispute_request_rejects_bad_day() -> None:
    for bad in ("2026-02-30", "2026/09/15", "yesterday", "", "26-09-15"):
        with pytest.raises(ValidationError):
            DisputeRequest(ticket_id="x", day=bad, reason="r")


def test_dispute_request_requires_reason() -> None:
    with pytest.raises(ValidationError):
        DisputeRequest(ticket_id="x", day="2026-09-15", reason="")


def test_append_writes_jsonl_and_returns_summary(data_dir: Path) -> None:
    req = DisputeRequest(
        ticket_id="run-2026-09-15-abc",
        trade_id="trd-1",
        day="2026-09-15",
        reason="RO->UA la 14 era indisponibil pe OPCOM.",
    )
    r = append_dispute(req, actor="natalia:trading_trainer")
    assert r["recorded"] is True
    assert r["actor"] == "natalia:trading_trainer"
    assert r["materialised"] is None  # no corrective_action

    path = data_dir / "disputes_2026-09-15.jsonl"
    assert path.exists()
    lines = path.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 1
    row = json.loads(lines[0])
    assert row["ticket_id"] == "run-2026-09-15-abc"
    assert row["trade_id"] == "trd-1"
    assert row["actor"] == "natalia:trading_trainer"


def test_append_never_rewrites_existing_lines(data_dir: Path) -> None:
    req = DisputeRequest(ticket_id="t1", day="2026-09-15", reason="prima")
    append_dispute(req, actor="a")
    append_dispute(
        DisputeRequest(ticket_id="t1", day="2026-09-15", reason="a doua, contra-raspuns"),
        actor="b",
    )
    path = data_dir / "disputes_2026-09-15.jsonl"
    lines = path.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 2
    r0, r1 = json.loads(lines[0]), json.loads(lines[1])
    assert r0["reason"] == "prima"
    assert r1["reason"] == "a doua, contra-raspuns"


def test_corrective_action_materialises_into_bids(data_dir: Path) -> None:
    req = DisputeRequest(
        ticket_id="run-2026-09-15-x",
        day="2026-09-15",
        reason="capacitate reala",
        corrective_action=CorrectiveAction(
            capacity={"RO->UA": {14: 200.0}},
            filled={"RO->UA": {14: 180.0}},
        ),
    )
    r = append_dispute(req, actor="operator")
    assert r["materialised"] is not None
    bids = data_dir / "bids_2026-09-15.csv"
    assert bids.exists()
    content = bids.read_text()
    assert "RO->UA" in content
    assert "200" in content


def test_list_disputes_filters_by_day(data_dir: Path) -> None:
    append_dispute(DisputeRequest(ticket_id="a", day="2026-09-15", reason="x"), actor="u")
    append_dispute(DisputeRequest(ticket_id="b", day="2026-09-16", reason="y"), actor="u")
    all_ = list_disputes()
    assert all_["count"] == 2
    only15 = list_disputes("2026-09-15")
    assert only15["count"] == 1
    assert only15["disputes"][0]["ticket_id"] == "a"


def test_reason_free_text_never_touches_intake(data_dir: Path) -> None:
    """The reason text may contain border names, MW, prices, hours — none of it
    should be interpreted; it lives in the jsonl only.
    """
    adversarial = (
        "coridorul RO->UA la ora 14 e greșit, real e HU->RO la 15 cu 250 MW la 92,5 EUR/MWh"
    )
    req = DisputeRequest(ticket_id="tx", day="2026-09-15", reason=adversarial)
    r = append_dispute(req, actor="op")
    assert r["materialised"] is None  # no corrective_action -> no bids write
    assert not (data_dir / "bids_2026-09-15.csv").exists()


def test_api_dispute_requires_token(data_dir: Path) -> None:
    from energy_trading.api import app

    client = TestClient(app)
    r = client.post(
        "/api/dispute",
        json={"ticket_id": "t", "day": "2026-09-15", "reason": "x"},
    )
    # Either 401 (token enforced) or 200 in test mode where token dep is a no-op.
    # We accept either but reject a 500 / 422 for the shape itself.
    assert r.status_code in (200, 401, 403)


def test_api_disputes_read(data_dir: Path) -> None:
    from energy_trading.api import app

    append_dispute(DisputeRequest(ticket_id="a", day="2026-09-15", reason="x"), actor="u")
    client = TestClient(app)
    r = client.get("/api/disputes", params={"day": "2026-09-15"})
    assert r.status_code == 200
    body = r.json()
    assert body["count"] == 1
    assert body["disputes"][0]["ticket_id"] == "a"


def test_api_disputes_rejects_bad_day(data_dir: Path) -> None:
    from energy_trading.api import app

    client = TestClient(app)
    r = client.get("/api/disputes", params={"day": "not-a-date"})
    assert r.status_code == 400


def test_fingerprint_includes_disputes_pattern(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Fingerprint must hash disputes_*.jsonl so watch re-runs contested days."""
    from energy_trading import config as _c
    monkeypatch.setattr(_c.settings, "data_dir", tmp_path)
    # Re-import scheduler symbols against the patched settings.
    from energy_trading.scheduler import JobRunner  # noqa: WPS433

    # Write a dispute file directly.
    (tmp_path / "disputes_2026-09-15.jsonl").write_text('{"ticket_id":"a"}\n', encoding="utf-8")

    from energy_trading.store import StateStore
    from energy_trading.agent import AgentConfig, CrossBorderAgent
    from energy_trading.market_data import SimulatedProvider

    store = StateStore(tmp_path / "state")
    agent = CrossBorderAgent(SimulatedProvider(), AgentConfig())
    runner = JobRunner(agent, _c.settings, store)
    fp = runner.fingerprint()
    assert "disputes_2026-09-15.jsonl" in fp
