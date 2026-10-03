"""R-PowerTrade: serviciul brațului de trading din Ronor, Etapa 1 (Light).

R-PowerTrade propune, Ronor decide. R-PowerTrade nu nominalizează și nu execută în Etapa 1:
/api/nominate răspunde 403 până la trecerea în modul Gated.

Autentificare: antetul X-RONOR-Token, comparat în timp constant. Dacă
POWERTRADE_TOKEN lipsește din mediu, toate rutele autentificate răspund 503
(fail closed), nu se deschid.
"""
from __future__ import annotations

import hmac
import os
from decimal import Decimal
from typing import Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from ledger.ledger import Ledger, LedgerKeyMissing
from orchestrator.engine import PARAMS, close_day, limits_table
from tools.cbc import f1_double_pay
from tools.crisis import check_crisis
from tools.guard import check_hour
from tools.potential import potential

VERSION = "0.2.0"
STAGE = os.environ.get("POWERTRADE_STAGE", "shadow")  # shadow | gated | arm

app = FastAPI(title="R-PowerTrade", version=VERSION)
_ledger: Ledger | None = None


def ledger() -> Ledger:
    global _ledger
    if _ledger is None:
        _ledger = Ledger(os.environ.get("POWERTRADE_LEDGER_PATH", "/app/state/powertrade-ledger.db"))
    return _ledger


def auth(x_ronor_token: Optional[str] = Header(default=None, alias="X-RONOR-Token")) -> None:
    expected = os.environ.get("POWERTRADE_TOKEN", "")
    if not expected:
        raise HTTPException(503, "POWERTRADE_TOKEN neconfigurat: serviciul refuză cererile")
    if not x_ronor_token or not hmac.compare_digest(x_ronor_token, expected):
        raise HTTPException(401, "token invalid")


def who(x_operator_who: Optional[str] = Header(default=None, alias="X-Operator-Who")) -> str:
    return x_operator_who or "necunoscut"


def jsonable(o):
    if isinstance(o, Decimal):
        return str(o)
    if isinstance(o, dict):
        return {k: jsonable(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [jsonable(v) for v in o]
    return o


@app.exception_handler(LedgerKeyMissing)
def _ledger_key_missing(_: Request, exc: LedgerKeyMissing):
    return JSONResponse(status_code=503, content={"detail": str(exc)})


# ---------------------------------------------------------------- sănătate
@app.get("/health")
@app.get("/api/health")
def health():
    return {"status": "ok", "version": VERSION, "stage": STAGE,
            "ledger_key": bool(os.environ.get("POWERTRADE_LEDGER_HMAC_KEY")),
            "token_configured": bool(os.environ.get("POWERTRADE_TOKEN"))}


# ---------------------------------------------------------------- contract R-PowerTrade
class LimitsIn(BaseModel):
    day: str
    route: str = "UA-RO"
    origin: str = "UA"
    forecast_ua: dict[int, Optional[dict]]
    cbc: dict[int, Optional[str]]
    ntc: dict[int, Optional[str]] = Field(default_factory=dict)


@app.post("/powertrade/limits", dependencies=[Depends(auth)])
def powertrade_limits(body: LimitsIn, actor: str = Depends(who)):
    cbc = {h: v for h, v in body.cbc.items() if v is not None}
    table = limits_table(body.forecast_ua, cbc, body.ntc, body.origin, body.route)
    row = ledger().append("decision", body.day, {"kind": "limits", "params": PARAMS, "table": table},
                          actor, route=body.route)
    return jsonable({"day": body.day, "params": PARAMS, "table": table, "ledger_seq": row["seq"]})


class InputIn(BaseModel):
    day: str
    kind: str  # ntc | forecast | cbc | sale
    route: Optional[str] = None
    values: dict[int, Optional[str]]
    source: str = "grup"


@app.post("/powertrade/forecast", dependencies=[Depends(auth)])
def powertrade_input(body: InputIn, actor: str = Depends(who)):
    if body.kind not in ("ntc", "forecast", "cbc", "sale"):
        raise HTTPException(422, "kind trebuie să fie ntc, forecast, cbc sau sale")
    row = ledger().append("input", body.day, body.model_dump(), actor, route=body.route)
    return {"recorded": True, "ledger_seq": row["seq"]}


class DisputeIn(BaseModel):
    ticket_id: str
    day: str
    reason: str
    trade_id: Optional[str] = None
    corrective_action: Optional[dict] = None


@app.post("/powertrade/dispute-learn", dependencies=[Depends(auth)])
@app.post("/api/dispute", dependencies=[Depends(auth)])
def dispute(body: DisputeIn, actor: str = Depends(who)):
    # Textul motivului nu este parsat niciodată în cifre (Decizia 1 Muse).
    row = ledger().append("dispute", body.day, body.model_dump(), actor)
    return {"recorded": True, "day": body.day, "ticket_id": body.ticket_id,
            "trade_id": body.trade_id, "actor": actor, "recorded_at": row["created_at"],
            "jsonl_path": f"ledger:{row['seq']}", "materialised": None}


@app.get("/api/disputes", dependencies=[Depends(auth)])
def disputes(day: Optional[str] = None):
    import json
    rows = ledger().rows("dispute", day)
    return {"count": len(rows), "disputes": [json.loads(r["payload"]) for r in rows]}


class Position(BaseModel):
    route: str
    origin: str
    volume_mwh: str
    sell: str
    cost: str
    cbc: str


class CloseIn(BaseModel):
    day: str
    positions: list[Position]
    ro_cumulative_before: Optional[str] = None
    cbc_payments: list[dict] = Field(default_factory=list)


@app.post("/powertrade/close", dependencies=[Depends(auth)])
def powertrade_close(body: CloseIn, actor: str = Depends(who)):
    dup = f1_double_pay(body.cbc_payments)
    if dup:
        raise HTTPException(409, f"F1: posibilă plată dublă CBC pe {dup}")
    result = close_day([p.model_dump() for p in body.positions], body.ro_cumulative_before)
    row = ledger().append("money", body.day, jsonable(result), actor)
    return jsonable({**result, "ledger_seq": row["seq"]})


# ---------------------------------------------------------------- Etapa 2: potențial, propuneri, istoric
class PotentialRow(BaseModel):
    hour: int
    route: str
    origin: str = "UA"
    rights_mw: str
    margin_mwh: str
    cbc: str


class PotentialIn(BaseModel):
    day: str
    rows: list[PotentialRow]
    crisis: bool = True
    strict: bool = False
    inputs_status: str = "suspect"  # statusul cel mai slab al intrărilor din care s-au calculat marjele


@app.post("/powertrade/potential", dependencies=[Depends(auth)])
def powertrade_potential(body: PotentialIn, actor: str = Depends(who)):
    result = potential([r.model_dump() for r in body.rows], body.crisis, body.strict)
    result["supports_nomination"] = body.inputs_status == "real"
    row = ledger().append("decision", body.day, {"kind": "potential", **jsonable(result),
                                                 "inputs_status": body.inputs_status}, actor)
    return jsonable({**result, "ledger_seq": row["seq"]})


class ProposalHour(BaseModel):
    hour: int
    route: str
    rights_mw: Optional[str] = None
    nominate_mw: str
    intraday_mw: str = "0"
    da_won_confirmed: bool = False
    md_leg_rights_mw: Optional[str] = None
    prices: dict[str, Optional[dict]] = Field(default_factory=dict)
    written_approval: Optional[str] = None


class ProposalIn(BaseModel):
    day: str
    hours: list[ProposalHour]
    crisis: bool = True


@app.post("/powertrade/propose", dependencies=[Depends(auth)])
def powertrade_propose(body: ProposalIn, actor: str = Depends(who)):
    """Propunere de nominalizare. Răspunsul implicit este NU; propunerea nu execută nimic."""
    checked = []
    for h in body.hours:
        g = check_hour(h.hour, h.rights_mw, h.nominate_mw, h.prices, set(),
                       needs_intraday=False, md_leg_rights_mw=h.md_leg_rights_mw)
        c = check_crisis(h.hour, h.nominate_mw, h.intraday_mw, h.da_won_confirmed,
                         h.written_approval) if body.crisis else {"ok": True, "violations": []}
        reasons = ([] if g["ok"] else [g["reason"]]) + c["violations"]
        if not h.prices:
            reasons.append("fără prețuri: nu se nominalizează pe necunoscut")
        checked.append({"hour": h.hour, "route": h.route, "nominate_mw": h.nominate_mw,
                        "eligible": not reasons, "reasons": reasons})
    payload = {"kind": "proposal", "stage": STAGE, "default_decision": "nu", "hours": checked}
    row = ledger().append("proposal", body.day, payload, actor)
    return jsonable({**payload, "proposal_seq": row["seq"]})


class DecisionIn(BaseModel):
    day: str
    proposal_seq: int
    decision: str  # da | nu
    approval_ref: Optional[str] = None


@app.post("/powertrade/decide", dependencies=[Depends(auth)])
def powertrade_decide(body: DecisionIn, actor: str = Depends(who)):
    """Înregistrează Da/Nu pe o propunere. Nu nominalizează: nominalizarea rămâne separată."""
    if STAGE == "shadow":
        raise HTTPException(403, "etapa shadow: deciziile Da/Nu se activează în Gated")
    if body.decision not in ("da", "nu"):
        raise HTTPException(422, "decizia trebuie să fie da sau nu")
    if body.decision == "da" and not (body.approval_ref or "").strip():
        raise HTTPException(422, "un Da cere referința aprobării scrise")
    props = [r for r in ledger().rows("proposal") if r["seq"] == body.proposal_seq]
    if not props:
        raise HTTPException(404, "propunere inexistentă")
    row = ledger().append("approval", body.day, body.model_dump(), actor)
    return {"recorded": True, "decision": body.decision, "ledger_seq": row["seq"], "executes": False}


class OutcomeIn(BaseModel):
    day: str
    rows: list[dict]


@app.post("/powertrade/outcome", dependencies=[Depends(auth)])
def powertrade_outcome(body: OutcomeIn, actor: str = Depends(who)):
    """Rezultatele reale pe rută și oră, pentru metricile pe istoric."""
    row = ledger().append("outcome", body.day, {"rows": body.rows}, actor)
    return {"recorded": True, "rows": len(body.rows), "ledger_seq": row["seq"]}


@app.get("/powertrade/metrics", dependencies=[Depends(auth)])
def powertrade_metrics():
    import json
    import os as _os
    from eval.history import gate, metrics
    th = json.load(open(_os.path.join(_os.path.dirname(__file__), "eval", "thresholds.json"), encoding="utf-8"))
    outcomes = []
    for r in ledger().rows("outcome"):
        for o in json.loads(r["payload"])["rows"]:
            outcomes.append({"day": r["day"], **o})
    m = metrics(outcomes, int(th.get("min_history_days", 20)))
    return jsonable({"metrics": m, "gated_gate": gate(m, th), "stage": STAGE})


# ---------------------------------------------------------------- compatibilitate cu botul Ronor
@app.post("/api/nominate", dependencies=[Depends(auth)])
def nominate():
    if STAGE != "arm":
        raise HTTPException(403, f"etapa {STAGE}: R-PowerTrade nu nominalizează; decizia rămâne la Ronor și la operator")
    raise HTTPException(501, "nominalizarea automată nu e implementată")


@app.get("/api/book", dependencies=[Depends(auth)])
def book():
    return {"count": 0, "trades": [], "summary": {"count": 0}}


@app.get("/api/ledger/verify", dependencies=[Depends(auth)])
def ledger_verify():
    return ledger().verify()


_NOT_IN_STAGE_1 = ("/api/run", "/api/settle", "/api/operator", "/api/ronor", "/api/ops-upload",
                   "/api/day", "/api/claims")


def _stage1_stub(path: str):
    def handler():
        raise HTTPException(501, f"{path}: nu face parte din Etapa 1 R-PowerTrade; folosește /powertrade/limits, /powertrade/close, /powertrade/forecast")
    return handler


for _p in _NOT_IN_STAGE_1:
    app.add_api_route(_p, _stage1_stub(_p), methods=["GET", "POST"], dependencies=[Depends(auth)])
