import os
import subprocess
import sys
from decimal import Decimal

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from ledger.ledger import Ledger, LedgerKeyMissing  # noqa: E402
from tools.cbc import effective_cbc, f1_double_pay  # noqa: E402
from tools.limits import buy_limit_ro, verdict  # noqa: E402
from tools.provision import provision_for  # noqa: E402
from tools.split import split_for, split_pure_md, split_ua_route  # noqa: E402
from tools.unknown import real, status_of  # noqa: E402


def test_price_status_is_explicit():
    assert status_of(real("0", "OPCOM")) == "real"
    assert status_of(real("0.20", "OPCOM")) == "real"
    assert status_of(real("-5", "OPCOM")) == "real"
    assert status_of({"value": "0.20", "status": "substitute", "source": "foaie"}) == "substitute"
    assert status_of({"value": "55", "status": "real"}) == "unverified"   # fără proveniență
    assert status_of("55") == "unverified"                                   # fără status
    assert status_of(None) == "missing"
    assert effective_cbc([("10", "0")]) == Decimal("0.00")
    assert effective_cbc([("30", "0.99"), ("10", None)]) is None


def test_split_ua_sums_exactly():
    s = split_ua_route("100.01")
    assert sum(s.values()) == Decimal("100.01")
    assert s["yunex"] == Decimal("50.01") or s["yunex"] == Decimal("50.00")


def test_split_md_transit_and_pure():
    s = split_for("UA-MD-RO", "1000")["split"]
    assert s == {"yunex": Decimal("500.00"), "encon": Decimal("250.00"),
                 "nrgpath": Decimal("125.00"), "wattmd": Decimal("125.00")}
    assert split_pure_md("155")["wattmd"] + split_pure_md("155")["nrgpath"] == Decimal("155.00")
    assert split_for("MD-RO", "155")["rule"] == "ro-md-pur"


def test_provision_only_into_ro():
    assert provision_for("UA-RO", "UA", 23) == Decimal("920.00")
    assert provision_for("MD-RO", "MD", 10) == Decimal("300.00")
    assert provision_for("RO-UA", "RO", 50) == Decimal("0.00")


def test_limit_and_exclusion():
    assert buy_limit_ro("166.43", "0.74") == Decimal("162.66")
    assert verdict("161", "168", "0")["mode"] == "exclude"


def test_f1_double_pay():
    rows = [{"day": "d", "hour": 4, "route": "RO-UA", "cbc_price": "0.99", "rights_code": "A"},
            {"day": "d", "hour": 4, "route": "RO-UA", "cbc_price": "1.10", "rights_code": "A"},
            {"day": "d", "hour": 4, "route": "RO-UA", "cbc_price": "0", "rights_code": "B"}]
    assert f1_double_pay(rows) == [("d", 4, "RO-UA")]


def test_ledger_append_only_and_tamper(tmp_path):
    lg = Ledger(str(tmp_path / "l.db"), key=b"k")
    lg.append("money", "2026-09-27", {"brut": Decimal("1.00")}, "t")
    lg.append("money", "2026-09-27", {"brut": Decimal("2.00")}, "t")
    assert lg.verify()["ok"]
    with pytest.raises(Exception):
        lg.db.execute("UPDATE rxb_ledger SET payload='x'")
    with pytest.raises(Exception):
        lg.db.execute("DELETE FROM rxb_ledger")


def test_ledger_refuses_without_key(tmp_path, monkeypatch):
    monkeypatch.delenv("RXB_LEDGER_HMAC_KEY", raising=False)
    lg = Ledger(str(tmp_path / "l.db"))
    with pytest.raises(LedgerKeyMissing):
        lg.append("money", "d", {}, "t")


def test_frozen_cases_pass():
    r = subprocess.run([sys.executable, os.path.join(ROOT, "eval", "run_eval.py")], capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("RXB_TOKEN", "t0k")
    monkeypatch.setenv("RXB_LEDGER_HMAC_KEY", "k")
    monkeypatch.setenv("RXB_LEDGER_PATH", str(tmp_path / "l.db"))
    import api
    api._ledger = None
    from fastapi.testclient import TestClient
    return TestClient(api.app), api


def test_auth_fail_closed(client, monkeypatch):
    c, _ = client
    assert c.post("/rxb/limits", json={}).status_code == 401
    monkeypatch.delenv("RXB_TOKEN")
    assert c.post("/rxb/limits", json={}).status_code == 503


def test_limits_and_close_endpoints(client):
    c, _ = client
    h = {"X-RONOR-Token": "t0k", "X-Operator-Who": "test"}
    r = c.post("/rxb/limits", headers=h, json={"day": "2026-09-28", "forecast_ua": {"4": {"value": "166.43", "status": "real", "source": "t"}, "5": None},
                                              "cbc": {"4": "0.74"}})
    t = {row["hour"]: row for row in r.json()["table"]}
    assert r.status_code == 200 and t[4]["buy_limit"] == "162.66" and t[5]["mode"] == "unknown"
    r = c.post("/rxb/close", headers=h, json={"day": "2026-09-27", "ro_cumulative_before": "95038.62", "positions": [
        {"route": "UA-RO", "origin": "UA", "volume_mwh": "40", "sell": "164", "cost": "22.01", "cbc": "0.74"},
        {"route": "UA-RO", "origin": "UA", "volume_mwh": "42", "sell": "148", "cost": "21.89", "cbc": "0.67"}]})
    assert r.json()["ro_cumulative"] == "100460.96"
    assert c.post("/api/nominate", headers=h).status_code == 403
    assert c.get("/api/ledger/verify", headers=h).json()["ok"]


def test_provision_settlement():
    from tools.provision import settle_provision
    assert settle_provision("1600")["state"] == "blocat"
    s = settle_provision("1600", postponed=True)["split"]
    assert s["yunex"] == Decimal("800.00") and s["encon"] + s["nrgpath"] == Decimal("800.00")
    assert settle_provision("1600", cbam_due="1200")["excess_to_brut"] == Decimal("400.00")
    assert settle_provision("1600", cbam_due="1700")["state"] == "deficit"


def test_zero_rights_blocks_nomination():
    from tools.guard import check_hour
    assert not check_hour(4, "0", "0", {"ua": "40"})["ok"]
