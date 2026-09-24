from pathlib import Path

from energy_trading.agent import AgentConfig, CrossBorderAgent
from energy_trading.config import Settings
from energy_trading.operator_bot import KnowledgeBase, OperatorBot, bot_commands_menu
from energy_trading.scheduler import JobRunner
from energy_trading.store import StateStore
from energy_trading.telegram_bot import TelegramIngestor


def _bot(tmp_path: Path, **over) -> tuple[OperatorBot, TelegramIngestor]:
    settings = Settings(
        **{
            "data_dir": Path("data"),
            "state_dir": tmp_path / "state",
            "scheduler_enabled": False,
            "telegram_bot_token": "",
            "telegram_chat_id": "",
            "telegram_webhook_secret": "s",
            "telegram_allowed_chats": [],
            "fetch_minutes": 0,  # no OPCOM/OREE calls from tests
            "pnl_hour": 23,
            **over,
        }
    )
    store = StateStore(settings.state_dir)
    agent = CrossBorderAgent(config=AgentConfig(default_volume_mw=50.0))
    runner = JobRunner(agent, settings, store)
    bot = OperatorBot(agent, runner, store, settings)
    return bot, TelegramIngestor(settings, store, operator=bot.handle)


def test_help_and_unknown(tmp_path):
    bot, _ = _bot(tmp_path)
    assert "/autorizez" in bot.handle("/ajutor") and "/azi" in bot.handle("/ajutor")
    assert bot.handle("/start").startswith("Vorbește-mi normal")
    assert "Nu cunosc" in bot.handle("/xyz")
    assert "Hub RO" in bot.handle("/hub@RONORBot 13.09")  # bot-suffixed command form


def test_one_message_day(tmp_path):
    from tests.conftest import data_before_opcom

    bot, ing = _bot(tmp_path, data_dir=data_before_opcom(tmp_path))
    ing.handle_update({"message": {"chat": {"id": 1}, "text": "better to skip Ua-Md 14.09"}})
    today = bot.handle("/azi 13.09")
    assert today.startswith("📅 2026-09-13 — prețuri reale (MD 7h, RO 24h, UA 24h)")
    # data/bids_2026-09-13.csv is the auction result: held capacity, not the NTC offer.
    assert "🎟 capacitate câștigată: RO-UA 15 MW int 01–12h, 17–23h; UA-RO 15 MW" in today
    assert "✅ UA→RO" in today and "MD→RO" not in today  # MD-RO not won → 0
    assert "autorizez XB-" in today
    tomorrow = bot.handle("/maine 14.09")
    assert "prețuri reale (UA 23h)" in tomorrow and "🚫 UA-MD exclus" in tomorrow
    assert "🎯 RO-UA: cumpără în RO sub" in tomorrow and "⏳ RO fără preț" in tomorrow
    assert "🟠 UA-" not in tomorrow  # NTC thin-border view is history once the auction is won
    assert bot.handle("/maine") == bot.handle("/zi maine")


def test_hub_ntc_borders_on_real_data(tmp_path):
    bot, _ = _bot(tmp_path)
    hub = bot.handle("/hub 13.09")
    assert "2026-09-13" in hub and "date reale" in hub and "Wheeling top" in hub
    ntc = bot.handle("/ntc 13.09")
    assert "UA-RO" in ntc and "RO-UA" in ntc and "MW" in ntc
    borders = bot.handle("/granite")
    assert "RO-UA" in borders and "UA-MD-RO" in borders and "RO-BG" in borders
    simulated = bot.handle("/hub 2030-01-01")
    assert "simulate" in simulated


def test_propose_nominate_settle_flow(tmp_path):
    bot, _ = _bot(tmp_path)
    out = bot.handle("/propuneri 13.09")
    assert "propuneri noi" in out and "XB-00" in out and "/nomineaza" in out
    assert any(t.id == "XB-0001" for t in bot.agent.book)
    again = bot.handle("/propuneri 13.09")
    assert "0 propuneri noi — book-ul are deja" in again
    assert "proposed:" in bot.handle("/book")
    nom = bot.handle("/nomineaza xb-0001 XB-0002 XB-9999", who="Natalia")
    assert "Nominalizate 2" in nom and "XB-9999" in nom and "autorizat de Natalia" in nom
    book = {t["id"]: t for t in bot.store.load("book")}
    assert book["XB-0001"]["nominated_by"] == "Natalia" and book["XB-0001"]["nominated_at"]
    assert "by Natalia" in bot.handle("/claims 3")
    assert bot.handle("/nomineaza") == "Folosește: /nomineaza XB-0001 XB-0002"
    assert "Decontate 2" in bot.handle("/deconteaza")
    assert "nomination" in bot.handle("/claims 3")
    assert bot.store.load("book")[0]["status"] == "settled"
    sov = bot.handle("/suveranitate")
    assert "Dependență de import" in sov
    assert "Alerte" in bot.handle("/alerte 3")
    status = bot.handle("/status")
    assert ("Veghez" in status or "Oprit" in status) and "Book:" in status and "Urmează" in status


def test_knowledge_base_answers_from_docs(tmp_path):
    kb = KnowledgeBase()
    assert kb.sections
    assert "HUB" in kb.answer("ce este basis-ul fata de RO?").upper()
    assert kb.answer("") == ""
    assert kb.answer("xylophone quantum zebra") == ""
    bot, _ = _bot(tmp_path)
    assert "Doctrina" in bot.handle("/doctrina")
    assert "Nu am găsit" in bot.handle("buna")


def test_ingestor_routes_commands_and_questions(tmp_path):
    _, ing = _bot(tmp_path)
    cmd = ing.handle_update({"message": {"chat": {"id": 1}, "text": "/granite"}})
    assert cmd.accepted and cmd.kind == "command" and "RO-UA" in cmd.reply
    q = ing.handle_update(
        {"message": {"chat": {"id": 1}, "text": "cum functioneaza hub-ul regional?"}}
    )
    assert q.accepted and q.kind == "question" and q.reply.startswith("📖")
    chatter = ing.handle_update({"message": {"chat": {"id": 1}, "text": "ok"}})
    assert not chatter.accepted and chatter.kind == "ignored"
    ops = ing.handle_update({"message": {"chat": {"id": 1}, "text": "RO-UA ATC 450 MW"}})
    assert ops.accepted and ops.kind == "text"  # ops data still wins over Q&A
    assert ing.store.read("ingest")[0]["kind"] == "command"


def test_ingestor_without_operator_ignores_commands(tmp_path):
    settings = Settings(
        state_dir=tmp_path / "s", telegram_webhook_secret="s", telegram_allowed_chats=[]
    )
    ing = TelegramIngestor(settings, StateStore(settings.state_dir))
    res = ing.handle_update({"message": {"chat": {"id": 1}, "text": "/hub"}})
    assert not res.accepted and res.kind == "ignored"


def test_commands_menu_matches_handlers(tmp_path):
    bot, _ = _bot(tmp_path)
    for item in bot_commands_menu():
        assert item["command"] in bot.commands


def test_ollama_grounded_answer_and_fallback(tmp_path):
    from energy_trading.operator_bot import OllamaAnswerer

    seen = {}

    def fake_post(path, payload):
        seen["path"], seen["payload"] = path, payload
        return {"message": {"content": "Basis = prețul zonei minus prețul RO."}}

    llm = OllamaAnswerer("http://contabo:11434", "qwen2.5", post=fake_post)
    kb = KnowledgeBase()
    secs = kb.retrieve("ce este basis?", k=2)
    out = llm.answer("ce este basis?", secs, "book: gol")
    assert out.startswith("🧠") and "minus" in out
    assert seen["path"] == "/api/chat" and seen["payload"]["model"] == "qwen2.5"
    assert seen["payload"]["stream"] is False
    user_msg = seen["payload"]["messages"][1]["content"]
    assert "CONTEXT:" in user_msg and "STARE LIVE:" in user_msg and "book: gol" in user_msg

    def broken_post(path, payload):
        raise OSError("gpu busy")

    broken = OllamaAnswerer("http://contabo:11434", "qwen2.5", post=broken_post)
    assert broken.answer("ce este basis?", secs, "") == ""
    assert OllamaAnswerer("", "qwen2.5").enabled is False

    bot, _ = _bot(tmp_path, ollama_url="http://contabo:11434", ollama_model="qwen2.5")
    bot.llm._post = broken_post
    assert bot.ask("ce este basis-ul fata de RO?").startswith("📖")  # degraded, still answers
    bot.llm._post = fake_post
    assert bot.ask("ce este basis-ul fata de RO?").startswith("🧠")
    assert "Ollama qwen2.5" in bot.handle("/status")


def test_api_operator_token_guard():
    from fastapi.testclient import TestClient

    from energy_trading import api

    c = TestClient(api.app)
    api.settings.api_token = "ronor-secret"
    try:
        assert c.post("/api/operator", json={"text": "/granite"}).status_code == 401
        ok = c.post(
            "/api/operator",
            json={"text": "RO-UA ATC 450 MW", "chat_id": "-100"},
            headers={"X-RONOR-Token": "ronor-secret"},
        )
        assert ok.status_code == 200 and ok.json()["kind"] == "text"
        assert "RO-UA 450 MW" in ok.json()["reply"]
        q = c.post(
            "/api/operator", json={"text": "/granite"}, headers={"X-RONOR-Token": "ronor-secret"}
        )
        assert q.json()["kind"] == "command" and "RO-UA" in q.json()["reply"]
    finally:
        api.settings.api_token = ""


def test_natural_language_intents(tmp_path):
    bot, ing = _bot(tmp_path, weather_hour=23, hub_run_hour=23, evening_hour=23)
    assert bot.intent("RONOR, activează agentul de trading energie electrică") == ("activeaza", "")
    assert bot.intent("hai să vedem cum stau lucrurile azi 13.09") == ("azi", "13.09")
    assert bot.intent("ce trebuie să autorizez eu?") == ("autorizez", "")
    assert bot.intent("RONOR autorizez XB-0001 XB-0002") == ("autorizez", "xb-0001 xb-0002")
    assert bot.intent("autorizez tot") == ("autorizez", "tot")
    assert bot.intent("nominează XB-0001") == ("autorizez", "xb-0001")
    assert bot.intent("XB-0003 XB-0004 ok") == ("autorizez", "xb-0003 xb-0004")
    assert bot.intent("da, hai cu XB-0005") == ("autorizez", "xb-0005")
    assert bot.intent("arată-mi dashboard-ul") == ("dashboard", "")
    assert bot.intent("ce capacitate avem pe 14.09?") == ("ntc", "14.09")
    assert bot.intent("cum e vremea?") == ("meteo", "")
    assert bot.intent("ești acolo?") == ("status", "")
    assert bot.intent("oprește agentul") == ("opreste", "")
    assert bot.intent("ok") == (None, "")

    r = ing.handle_update({"message": {"chat": {"id": 1}, "text": "RONOR, activează agentul"}})
    assert r.accepted and "Agentul de trading e activ" in r.reply and bot.runner.running
    bot.handle("oprește")
    assert not bot.runner.running

    assert "Nu ai nimic de autorizat" in bot.handle("ce trebuie să autorizez?")
    bot.handle("cum stau lucrurile azi 13.09")
    listing = bot.handle("ce trebuie să autorizez eu?")
    assert listing.startswith("🔏 De autorizat: 12 propuneri")
    assert "Nominalizate 2" in bot.handle("RONOR autorizez XB-0001 XB-0002")
    assert "Nominalizate 10" in bot.handle("autorizez tot")
    assert (
        ing.handle_update({"message": {"chat": {"id": 1}, "text": "mulțumesc"}}).kind == "ignored"
    )


def test_api_day_view():
    from fastapi.testclient import TestClient

    from energy_trading import api

    c = TestClient(api.app)
    c.post("/api/reset")
    v = c.get("/api/day?day=2026-09-13&refresh=1").json()
    assert v["day"] == "2026-09-13" and v["evidence"] == "operator_provided"
    assert v["brief"].startswith("📅 2026-09-13") and v["pending"]
    assert v["sources"]["ntc"] == "ntc_2026-09-13.csv"
    cached = c.get("/api/day?day=2026-09-13").json()
    assert cached["brief"] == v["brief"]
    assert c.get("/").status_code == 200 and c.get("/static/avansat.html").status_code == 200


def test_api_operator_endpoint():
    from fastapi.testclient import TestClient

    from energy_trading import api

    c = TestClient(api.app)
    r = c.post("/api/operator", json={"text": "/granite"})
    assert r.status_code == 200 and "RO-UA" in r.json()["reply"]
    assert r.json()["who"].startswith("dashboard@")
    # Tailscale identity headers win over anything the caller claims.
    r_ts = c.post(
        "/api/operator",
        json={"text": "/status", "who": "cineva"},
        headers={"Tailscale-User-Login": "natalia@ronor.ts.net", "Tailscale-User-Name": "Natalia"},
    )
    assert r_ts.json()["who"] == "Natalia"
    assert c.post("/api/operator", json={"text": "/status", "who": "Ion"}).json()["who"] == "Ion"
    api.ingestor.settings = api.settings.model_copy(update={"telegram_webhook_secret": "k"})
    r2 = c.post(
        "/api/telegram/webhook",
        json={"message": {"chat": {"id": 7}, "text": "/status"}},
        headers={"X-Telegram-Bot-Api-Secret-Token": "k"},
    )
    assert r2.status_code == 200 and r2.json()["kind"] == "command"


def test_telegram_sender_name():
    from energy_trading.telegram_bot import sender_name

    assert sender_name({"from": {"first_name": "Natalia", "last_name": "P"}}, "1") == "Natalia P"
    assert sender_name({"from": {"username": "nat"}}, "1") == "@nat"
    assert sender_name({}, "42") == "telegram:42"


def test_api_nominate_records_identity():
    from fastapi.testclient import TestClient

    from energy_trading import api

    c = TestClient(api.app)
    c.post("/api/reset")
    c.post("/api/run", json={"day": "2026-09-13"})
    tid = api.agent.book[0].id
    r = c.post(
        "/api/nominate",
        json={"trade_ids": [tid]},
        headers={"Tailscale-User-Login": "natalia@ronor.ts.net"},
    )
    nominated = r.json()["nominated"]
    assert nominated and nominated[0]["nominated_by"] == "natalia@ronor.ts.net"
    assert nominated[0]["nominated_at"]
