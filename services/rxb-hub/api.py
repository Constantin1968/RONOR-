"""RXB-Hub: serviciul brațului de trading din RONOR, Etapa 1 (Light).

RXB propune, RONOR decide. RXB nu nominalizează și nu execută în Etapa 1:
/api/nominate răspunde 403 până la trecerea în modul Gated.

Autentificare: antetul X-RONOR-Token, comparat în timp constant. Dacă
RXB_TOKEN lipsește din mediu, toate rutele autentificate răspund 503
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

VERSION = "0.1.0"
STAGE = os.environ.get("RXB_STAGE", "shadow")  # shadow | gated | arm

app = FastAPI(title="RXB-Hub", version=VERSION)
_ledger: Ledger | None = None


def ledger() -> Ledger:
    global _ledger
    if _ledger is None:
        _ledger = Ledger(os.environ.get("RXB_LEDGER_PATH", "/app/state/rxb-ledger.db"))
    return _ledger


def auth(x_ronor_token: Optional[str] = Header(default=None, alias="X-RONOR-Token")) -> None:
    expected = os.environ.get("RXB_TOKEN", "")
    if not expected:
        raise HTTPException(503, "RXB_TOKEN neconfigurat: serviciul refuză cererile")
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
            "ledger_key": bool(os.environ.get("RXB_LEDGER_HMAC_KEY")),
            "token_configured": bool(os.environ.get("RXB_TOKEN"))}


# ---------------------------------------------------------------- contract RXB
class LimitsIn(BaseModel):
    day: str
    route: str = "UA-RO"
    origin: str = "UA"
    forecast_ua: dict[int, Optional[str]]
    cbc: dict[int, Optional[str]]
    ntc: dict[int, Optional[str]] = Field(default_factory=dict)


@app.post("/rxb/limits", dependencies=[Depends(auth)])
def rxb_limits(body: LimitsIn, actor: str = Depends(who)):
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


@app.post("/rxb/forecast", dependencies=[Depends(auth)])
def rxb_input(body: InputIn, actor: str = Depends(who)):
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


@app.post("/rxb/dispute-learn", dependencies=[Depends(auth)])
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


@app.post("/rxb/close", dependencies=[Depends(auth)])
def rxb_close(body: CloseIn, actor: str = Depends(who)):
    dup = f1_double_pay(body.cbc_payments)
    if dup:
        raise HTTPException(409, f"F1: posibilă plată dublă CBC pe {dup}")
    result = close_day([p.model_dump() for p in body.positions], body.ro_cumulative_before)
    row = ledger().append("money", body.day, jsonable(result), actor)
    return jsonable({**result, "ledger_seq": row["seq"]})


# ---------------------------------------------------------------- compatibilitate cu botul RONOR
@app.post("/api/nominate", dependencies=[Depends(auth)])
def nominate():
    if STAGE != "arm":
        raise HTTPException(403, f"etapa {STAGE}: RXB nu nominalizează; decizia rămâne la RONOR și la operator")
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
        raise HTTPException(501, f"{path}: nu face parte din Etapa 1 RXB-Hub; folosește /rxb/limits, /rxb/close, /rxb/forecast")
    return handler


for _p in _NOT_IN_STAGE_1:
    app.add_api_route(_p, _stage1_stub(_p), methods=["GET", "POST"], dependencies=[Depends(auth)])
