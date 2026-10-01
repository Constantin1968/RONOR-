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
    # Corecția din 01.10.2026: pe tranzit, felia RO e pe Encon Group, nu pe WATT.
    assert s == {"yunex": Decimal("500.00"), "encon": Decimal("250.00"),
                 "nrgpath": Decimal("250.00"), "wattmd": Decimal("0.00")}
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
        lg.db.execute("UPDATE powertrade_ledger SET payload='x'")
    with pytest.raises(Exception):
        lg.db.execute("DELETE FROM powertrade_ledger")


def test_ledger_refuses_without_key(tmp_path, monkeypatch):
    monkeypatch.delenv("POWERTRADE_LEDGER_HMAC_KEY", raising=False)
    lg = Ledger(str(tmp_path / "l.db"))
    with pytest.raises(LedgerKeyMissing):
        lg.append("money", "d", {}, "t")


def test_frozen_cases_pass():
    r = subprocess.run([sys.executable, os.path.join(ROOT, "eval", "run_eval.py")], capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("POWERTRADE_TOKEN", "t0k")
    monkeypatch.setenv("POWERTRADE_LEDGER_HMAC_KEY", "k")
    monkeypatch.setenv("POWERTRADE_LEDGER_PATH", str(tmp_path / "l.db"))
    import api
    api._ledger = None
    from fastapi.testclient import TestClient
    return TestClient(api.app), api


def test_auth_fail_closed(client, monkeypatch):
    c, _ = client
    assert c.post("/powertrade/limits", json={}).status_code == 401
    monkeypatch.delenv("POWERTRADE_TOKEN")
    assert c.post("/powertrade/limits", json={}).status_code == 503


def test_limits_and_close_endpoints(client):
    c, _ = client
    h = {"X-RONOR-Token": "t0k", "X-Operator-Who": "test"}
    r = c.post("/powertrade/limits", headers=h, json={"day": "2026-09-28", "forecast_ua": {"4": {"value": "166.43", "status": "real", "source": "t"}, "5": None},
                                              "cbc": {"4": "0.74"}})
    t = {row["hour"]: row for row in r.json()["table"]}
    assert r.status_code == 200 and t[4]["buy_limit"] == "162.66" and t[5]["mode"] == "unknown"
    r = c.post("/powertrade/close", headers=h, json={"day": "2026-09-27", "ro_cumulative_before": "95038.62", "positions": [
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


def test_sell_floor_and_bid_rules():
    from tools.limits import sell_floor_ro, check_bid
    from tools.cbc import CBC_UA_MD_2026_09_29, effective_cbc
    f = sell_floor_ro("100", "11.6")
    assert f == Decimal("114.13")  # (100 + 11,6 + 0,9 + 0,5) × 1,01
    assert check_bid("buy", "-2")["flag"] == "frana"
    assert check_bid("sell", "-2", f)["flag"] == "rosu"
    assert check_bid("sell", "114.12", f)["ok"] is False
    assert check_bid("sell", "114.13", f)["ok"] is True
    assert check_bid("sell", "150")["ok"] is False  # fără prag nu se nominalizează
    c = CBC_UA_MD_2026_09_29
    assert effective_cbc([(c["step1"]["mw"], c["step1"]["price"]), (c["step2"]["mw"], c["step2"]["price"])]) == Decimal("18.48")


# ---------------------------------------------------------------- Etapa 2
def test_crisis_caps_and_rules():
    from tools.crisis import cap_for, check_crisis, md_closure_locked
    assert cap_for(8) == Decimal("8") and cap_for(16) == Decimal("8") and cap_for(3) == Decimal("10")
    assert cap_for(3, strict=True) == Decimal("8")
    assert not check_crisis(3, "11")["ok"]
    assert not check_crisis(19, "5")["ok"] and check_crisis(19, "5", written_approval="ok")["ok"]
    assert not check_crisis(2, "5", intraday_mw="9")["ok"]
    assert md_closure_locked("14:16") and not md_closure_locked("14:14")


def test_potential_sunk_cost_and_provision():
    from tools.potential import potential
    p = potential([{"hour": 8, "route": "UA-MD-RO", "origin": "UA", "rights_mw": "21",
                    "margin_mwh": "63.69", "cbc": "2.88"}])
    assert p["gross"] == Decimal("509.52") and p["sunk_cbc"] == Decimal("37.44")
    assert p["provision_outside_pl"] == Decimal("320.00")
    assert potential([{"hour": 3, "route": "RO-UA", "origin": "RO", "rights_mw": "5",
                       "margin_mwh": "1", "cbc": "0"}])["provision_outside_pl"] == Decimal("0.00")


def test_history_metrics_unevaluated_then_gate():
    from eval.history import gate, metrics
    th = {"cbc_mape": 0.15, "pl_vs_perfect": 0.75, "floor_hit_rate": 1.0, "false_cbc_rate": 0.0}
    rows = [{"day": "d1", "cbc_pred": "1.0", "cbc_actual": "1.1", "pl_realised": "80", "pl_perfect": "100",
             "sale": "150", "floor": "140", "rights_mw": "10"}]
    m = metrics(rows, min_days=2)
    assert m["evaluated"] is False and gate(m, th)["pass"] is False
    rows.append({**rows[0], "day": "d2", "cbc_actual": "0"})
    m = metrics(rows, min_days=2)
    assert m["evaluated"] and m["cbc_zero_actual_excluded"] == 1
    assert m["pl_vs_perfect"] == Decimal("0.8000") and gate(m, th)["pass"] is True


def test_stage2_endpoints_shadow(client):
    c, _ = client
    h = {"X-RONOR-Token": "t0k", "X-Operator-Who": "test"}
    r = c.post("/powertrade/potential", headers=h, json={"day": "2026-10-02", "rows": [
        {"hour": 8, "route": "UA-MD-RO", "rights_mw": "21", "margin_mwh": "63.69", "cbc": "2.88"}]})
    assert r.status_code == 200 and r.json()["gross"] == "509.52" and r.json()["supports_nomination"] is False
    real_p = {"value": "100", "status": "real", "source": "t"}
    r = c.post("/powertrade/propose", headers=h, json={"day": "2026-10-02", "hours": [
        {"hour": 2, "route": "UA-MD", "rights_mw": "20", "nominate_mw": "20", "prices": {"ua": real_p}},
        {"hour": 3, "route": "UA-MD", "rights_mw": "20", "nominate_mw": "10", "prices": {"ua": real_p}},
        {"hour": 4, "route": "UA-MD", "rights_mw": "20", "nominate_mw": "10", "prices": {}}]})
    j = r.json()
    assert j["default_decision"] == "nu"
    assert [x["eligible"] for x in j["hours"]] == [False, True, False]
    assert c.post("/powertrade/decide", headers=h, json={"day": "2026-10-02", "proposal_seq": j["proposal_seq"],
                                                          "decision": "da"}).status_code == 403
    assert c.get("/powertrade/metrics", headers=h).json()["gated_gate"]["pass"] is False
    assert c.post("/api/nominate", headers=h).status_code == 403


def test_stage2_decide_in_gated(client, monkeypatch):
    c, api = client
    monkeypatch.setattr(api, "STAGE", "gated")
    h = {"X-RONOR-Token": "t0k", "X-Operator-Who": "test"}
    seq = c.post("/powertrade/propose", headers=h, json={"day": "d", "hours": []}).json()["proposal_seq"]
    assert c.post("/powertrade/decide", headers=h, json={"day": "d", "proposal_seq": seq, "decision": "da"}).status_code == 422
    r = c.post("/powertrade/decide", headers=h, json={"day": "d", "proposal_seq": seq, "decision": "da",
                                                       "approval_ref": "scris"})
    assert r.status_code == 200 and r.json()["executes"] is False
    assert c.post("/api/nominate", headers=h).status_code == 403
