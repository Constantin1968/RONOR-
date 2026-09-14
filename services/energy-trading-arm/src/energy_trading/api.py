"""FastAPI service exposing the cross-border trading agent."""

from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated

from fastapi import Depends, FastAPI, File, Header, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from energy_trading.agent import AgentConfig, CrossBorderAgent
from energy_trading.config import settings
from energy_trading.dispute import DisputeRequest, append_dispute, list_disputes
from energy_trading.hub import hub_snapshot
from energy_trading.interconnectors import INTERCONNECTORS, ZONES
from energy_trading.market_data import SimulatedProvider
from energy_trading.operator_bot import OperatorBot, bot_commands_menu
from energy_trading.ops_intake import OverrideProvider, parse_daily_note, read_table_ops
from energy_trading.ronor_agent import RonorAgent
from energy_trading.scheduler import JobRunner, daily_brief
from energy_trading.sovereignty import EVIDENCE_OPERATOR
from energy_trading.store import StateStore
from energy_trading.telegram_bot import TelegramIngestor, format_reply
from energy_trading.weather import GRID_POINTS, WeatherOrchestrator

STATIC_DIR = Path(__file__).resolve().parent.parent.parent / "static"

agent = CrossBorderAgent(provider=SimulatedProvider(), config=AgentConfig())
store = StateStore(settings.state_dir)
runner = JobRunner(agent, settings, store)
operator = OperatorBot(agent, runner, store, settings)
ingestor = TelegramIngestor(settings, store, operator=operator.handle)


def run_operator_text(text: str, who: str, chat_id: str = "api") -> dict:
    """Ops note or command or question — the ingestor decides; the bot answers."""
    update = {
        "message": {"chat": {"id": chat_id or "api"}, "from": {"first_name": who}, "text": text}
    }
    result = ingestor.handle_update(update)
    reply = result.reply
    if not result.accepted and not reply:
        reply = operator.handle(text, who)
    return {"kind": result.kind, "accepted": result.accepted, "reply": reply}


def _execute_for_ronor(command: str, who: str) -> str:
    return run_operator_text(command, who, chat_id="ronor")["reply"] or ""


def _route_for_ronor(text: str) -> str | None:
    """Ops notes (NTC pasted as text, interval prices, 'skip UA-MD') are the operator's
    data and go to the intake as-is; clear commands/intents map to a bot command."""
    intake = parse_daily_note(text)
    if intake.availability or intake.prices_override or intake.decisions:
        return text
    return operator.route(text)


ronor = RonorAgent(
    _execute_for_ronor,
    settings.ollama_url,
    settings.ollama_model,
    timeout=max(settings.ollama_timeout, 120.0),
    route=_route_for_ronor,
)


def persist_state() -> None:
    store.save("book", [t.model_dump() for t in agent.book])
    store.save("claims", [c.model_dump() for c in agent.claims.entries])


def require_api_token(x_ronor_token: Annotated[str | None, Header()] = None) -> None:
    """Machine-to-machine guard for the RONOR dispatcher; open when ET_API_TOKEN is unset."""
    if settings.api_token and x_ronor_token != settings.api_token:
        raise HTTPException(401, "invalid or missing X-RONOR-Token")


@asynccontextmanager
async def lifespan(_: FastAPI):
    if settings.scheduler_enabled:
        runner.start()
    yield
    runner.stop()


app = FastAPI(
    title="Energy Trading Agent — Power Cross-Border Operations",
    version="0.2.0",
    lifespan=lifespan,
)


class RunRequest(BaseModel):
    day: str = Field(description="ISO date, e.g. 2026-09-12")
    zones: list[str] | None = None
    availability: dict[str, float | dict[int, float]] | None = None
    prices_override: dict[str, dict[int, float]] | None = Field(
        default=None, description="Zone -> hour(0-23) -> price EUR/MWh, e.g. from /api/ops-parse"
    )
    min_net_spread: float | None = None
    max_trades: int | None = None
    volume_mw: float | None = None


class OpsParseRequest(BaseModel):
    day: str = Field(description="ISO date the note refers to")
    text: str = Field(description="Pasted daily-operations note (RO/EN free text)")


class NominateRequest(BaseModel):
    trade_ids: list[str]


@app.get("/api/health")
def health() -> dict:
    return {
        "status": "ok",
        "time": datetime.now(UTC).isoformat(),
        "zones": ZONES,
        "scheduler": runner.running,
        "heartbeat": (runner.store.load("heartbeat", None) or {}).get("at"),
        "telegram": runner.notifier.enabled,
        "ronor_brain": {"ollama": ronor.enabled, "model": settings.ollama_model},
    }


@app.get("/api/interconnectors")
def list_interconnectors() -> dict:
    return {"count": len(INTERCONNECTORS), "items": [ic.model_dump() for ic in INTERCONNECTORS]}


@app.post("/api/run")
def run_agent(req: RunRequest) -> dict:
    try:
        day = datetime.fromisoformat(req.day)
    except ValueError:
        raise HTTPException(400, f"Invalid day '{req.day}', expected ISO date")
    if req.min_net_spread is not None:
        agent.config.min_net_spread = req.min_net_spread
    if req.max_trades is not None:
        agent.config.max_trades_per_run = req.max_trades
    if req.volume_mw is not None:
        agent.config.default_volume_mw = req.volume_mw
    if req.prices_override:
        provider = OverrideProvider(agent.provider, day, req.prices_override)
        prices = provider.day_ahead(req.zones or ZONES, day)
        trades, log = agent.run_from_prices(
            prices, req.availability or {}, evidence_level=EVIDENCE_OPERATOR
        )
    else:
        trades, log = agent.run_day(day, zones=req.zones, availability=req.availability)
    persist_state()
    return {
        "trades": [t.model_dump() for t in trades],
        "log": log.model_dump(),
        "portfolio": agent.summary(),
    }


@app.get("/api/book")
def book() -> dict:
    return {
        "count": len(agent.book),
        "trades": [t.model_dump() for t in agent.book],
        "summary": agent.summary(),
    }


@app.post("/api/nominate")
def nominate(req: NominateRequest, request: Request) -> dict:
    done = agent.nominate(
        req.trade_ids, evidence_level=EVIDENCE_OPERATOR, by=operator_identity(request)
    )
    persist_state()
    return {"nominated": [t.model_dump() for t in done]}


@app.post("/api/settle")
def settle_book() -> dict:
    lines, total = agent.settle_book()
    persist_state()
    return {"lines": [vars(line) for line in lines], "total_net_eur": total}


@app.post("/api/ops-parse")
def ops_parse(req: OpsParseRequest) -> dict:
    """Parse a pasted daily-operations note into availability + price overrides."""
    try:
        datetime.fromisoformat(req.day)
    except ValueError:
        raise HTTPException(400, f"Invalid day '{req.day}', expected ISO date")
    return parse_daily_note(req.text, day=req.day).model_dump()


@app.post("/api/ops-upload", dependencies=[Depends(require_api_token)])
async def ops_upload(
    file: Annotated[UploadFile, File()],
    day: str = "2026-09-12",
    apply: bool = True,
    source: str = "upload",
) -> dict:
    """Upload a daily-operations workbook (.xlsx) or .csv from WhatsApp/e-mail/RONOR.

    With ``apply`` (default) the parsed NTC / prices / decisions become the day's
    overrides and the operator's position (capacity won, CBC, limits, fills, results)
    becomes ``data/bids_<day>.csv`` — exactly what happens when the file is posted in
    Telegram — and ``reply`` carries the human-readable summary for the dispatcher.
    """
    if not file.filename or not file.filename.lower().endswith((".xlsx", ".xlsm", ".csv")):
        raise HTTPException(400, "Se acceptă doar fișiere .xlsx sau .csv")
    try:
        datetime.fromisoformat(day)
    except ValueError:
        raise HTTPException(400, f"Invalid day '{day}', expected ISO date")
    data = await file.read()
    if len(data) > 10 * 1024 * 1024:
        raise HTTPException(400, "Fișier prea mare (limita 10 MB)")
    intake = read_table_ops(data, file.filename, day=day)
    out = intake.model_dump()
    if apply:
        ingestor._file(source, "document", file.filename, intake)
        out["reply"] = format_reply(intake)
    return out


@app.post("/api/dispute", dependencies=[Depends(require_api_token)])
def dispute(
    req: DisputeRequest,
    x_operator_who: Annotated[str | None, Header(alias="X-Operator-Who")] = None,
) -> dict:
    """Record a trainer / operator dispute against a ticket or a specific trade.

    The dispute is appended to ``data/disputes_<day>.jsonl`` (never rewritten).
    If ``corrective_action`` carries structured values (capacity / cbc / limits /
    filled / realized keyed by corridor and hour), they are merged into
    ``data/bids_<day>.csv`` via ``write_bids_csv`` so the twin re-runs the day
    on the next ``watch`` tick. Free-text ``reason`` never touches the intake
    regex parser — it lives in the jsonl only, as audit evidence.
    """
    actor = (x_operator_who or "").strip() or "unknown"
    return append_dispute(req, actor=actor)


@app.get("/api/disputes")
def disputes(day: str | None = None) -> dict:
    """Read back disputes, optionally filtered to one ISO day."""
    if day is not None:
        try:
            datetime.fromisoformat(day)
        except ValueError:
            raise HTTPException(400, f"Invalid day '{day}', expected ISO date")
    return list_disputes(day)


@app.get("/api/claims")
def claims(kind: str | None = None) -> dict:
    entries = agent.claims.list(kind)
    return {"count": len(entries), "claims": [e.model_dump() for e in entries]}


@app.get("/api/sovereignty")
def sovereignty(home: str = "RO") -> dict:
    return agent.sovereignty(home)


class HubRequest(BaseModel):
    day: str
    zones: list[str] | None = None
    prices_override: dict[str, dict[int, float]] | None = None
    availability: dict[str, float | dict[int, float]] | None = None
    min_edge: float = 0.5


@app.post("/api/hub")
def hub(req: HubRequest) -> dict:
    """RO-as-hub view: basis of every spoke vs RO + spoke→RO→spoke wheeling."""
    try:
        day = datetime.fromisoformat(req.day)
    except ValueError:
        raise HTTPException(400, f"Invalid day '{req.day}', expected ISO date")
    zones = req.zones or ["RO", "BG", "RS", "HU", "MD", "UA"]
    provider = (
        OverrideProvider(agent.provider, day, req.prices_override)
        if req.prices_override
        else agent.provider
    )
    prices = provider.day_ahead(zones, day)
    return hub_snapshot(
        prices, req.day, min_edge=req.min_edge, availability=req.availability
    ).model_dump()


@app.get("/api/weather")
def weather(days: int = 3, countries: str | None = None) -> dict:
    """Parallel weather workers for RO + neighbours; energy signals + hub read."""
    wanted = [c.strip().upper() for c in countries.split(",")] if countries else None
    if wanted and any(c not in GRID_POINTS for c in wanted):
        raise HTTPException(400, f"Unknown country in {wanted}; known: {sorted(GRID_POINTS)}")
    brief = WeatherOrchestrator(countries=wanted, days=max(1, min(days, 7))).run()
    return brief.model_dump()


# -- 24/7 operations: jobs, alerts, Telegram ingestion ------------------------


@app.get("/api/jobs")
def jobs_status() -> dict:
    return runner.status()


@app.post("/api/jobs/tick")
def run_tick() -> dict:
    """One pass of the 24/7 loop, now: retries, due daily jobs, watch/settle/gate/heartbeat."""
    return {"ran": runner.tick(), "next": runner.next_runs()}


@app.post("/api/jobs/{name}")
def run_job(name: str, day: str | None = None) -> dict:
    try:
        return runner.run(name, day)
    except ValueError as exc:
        raise HTTPException(404, str(exc))


@app.get("/api/alerts")
def alerts(limit: int = 50) -> dict:
    items = store.read("alerts", limit=max(1, min(limit, 500)))
    return {"count": len(items), "alerts": items}


@app.get("/api/briefs")
def briefs(day: str | None = None) -> dict:
    return {"files": store.list_briefs(day)}


@app.get("/api/ingest-log")
def ingest_log(limit: int = 50) -> dict:
    items = store.read("ingest", limit=max(1, min(limit, 500)))
    return {"count": len(items), "items": items}


@app.post("/api/telegram/webhook")
async def telegram_webhook(
    request: Request,
    x_telegram_bot_api_secret_token: Annotated[str | None, Header()] = None,
) -> dict:
    if not ingestor.authorized(x_telegram_bot_api_secret_token):
        raise HTTPException(403, "invalid webhook secret")
    update = await request.json()
    result = ingestor.handle_update(update)
    if result.accepted and result.reply:
        ingestor.reply(result.chat_id, result.reply)
    return {"accepted": result.accepted, "kind": result.kind, "day": result.day}


@app.post("/api/telegram/set-webhook")
def telegram_set_webhook(public_url: str) -> dict:
    if not settings.telegram_bot_token or not settings.telegram_webhook_secret:
        raise HTTPException(400, "TELEGRAM_BOT_TOKEN și TELEGRAM_WEBHOOK_SECRET trebuie setate")
    return ingestor.set_webhook(public_url, commands=bot_commands_menu())


class OperatorAsk(BaseModel):
    text: str = Field(description="A slash command or free-text question, as typed in Telegram")
    chat_id: str = Field(default="", description="Origin chat (for the ingest log)")
    who: str = Field(default="", description="Human behind the message, if the caller knows it")


def operator_identity(request: Request, fallback: str = "") -> str:
    """Who is acting: Tailscale identity headers (when served via `tailscale serve`),
    else what the caller told us, else the client address."""
    h = request.headers
    ts = h.get("tailscale-user-name") or h.get("tailscale-user-login")
    if ts:
        return ts
    if fallback:
        return fallback
    return f"dashboard@{request.client.host if request.client else 'local'}"


@app.post("/api/operator", dependencies=[Depends(require_api_token)])
def operator_ask(req: OperatorAsk, request: Request) -> dict:
    """Same brain as the Telegram bot, over HTTP — deterministic.

    This is the integration point for an existing RONOR backend that already
    owns the bot's Telegram updates: forward the text here, relay the reply.
    Ops notes and questions both work — the ingestor decides which it is.
    """
    who = operator_identity(request, req.who)
    out = run_operator_text(req.text, who, req.chat_id)
    return {"text": req.text, "who": who, **out}


@app.post("/api/ronor", dependencies=[Depends(require_api_token)])
def ronor_ask(req: OperatorAsk, request: Request) -> dict:
    """RONOR's own model driving the module through tools.

    With ``OLLAMA_URL`` set, the sovereign model reads the message, calls the
    capabilities it needs (``ziua``, ``capacitate``, ``de_autorizat`` …) and
    composes the answer from their output only.  Without Ollama — or if it
    fails — this is exactly ``/api/operator``.  Mutating tools run only when
    the operator's message asks for them, whatever the model decides.
    """
    who = operator_identity(request, req.who)
    out = ronor.answer(req.text, who)
    return {"text": req.text, "who": who, **out}


@app.get("/api/day")
def day_view(day: str | None = None, refresh: bool = False) -> dict:
    """Operator view of one day: brief text, borders, decisions, what awaits authorization."""
    target = day or datetime.now(UTC).date().isoformat()
    result = None if refresh else store.load(f"briefs/{target}_result")
    if result is None:
        out = runner.run("hub_run", target)
        if out["status"] != "ok":
            raise HTTPException(500, out["result"].get("error", "run failed"))
        result = out["result"]
    pending = [
        t.model_dump()
        for t in agent.book
        if t.status == "proposed" and t.delivery_start.date().isoformat() == target
    ]
    nominated = [
        t.model_dump()
        for t in agent.book
        if t.status != "proposed" and t.delivery_start.date().isoformat() == target
    ]
    return {
        "day": target,
        "brief": daily_brief(result, agent.book),
        "evidence": result["evidence"],
        "sources": {
            "ntc": result["ntc"],
            "prices": result["prices"],
            "ntc_fallback": result["ntc_fallback"],
        },
        "decisions": result["decisions"],
        "borders": [a for a in result["alerts"] if a["rule"] == "thin_cbc"],
        "hub": result["hub_summary"],
        "pending": pending,
        "nominated": nominated,
        "scheduler": runner.status(),
    }


@app.post("/api/reset")
def reset() -> dict:
    from energy_trading.sovereignty import ClaimsRegister

    agent.book.clear()
    agent.history.clear()
    agent.claims = ClaimsRegister()
    persist_state()
    return {"status": "reset", "summary": agent.summary()}


if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    idx = STATIC_DIR / "index.html"
    if not idx.exists():
        raise HTTPException(404, "Dashboard not built")
    return FileResponse(str(idx))
