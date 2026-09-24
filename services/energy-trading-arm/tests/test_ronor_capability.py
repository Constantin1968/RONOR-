"""RONOR capability pack: tool registry, Ollama tool loop, MCP server, dispatcher plugin."""

from __future__ import annotations

import importlib.util
import io
import json
import subprocess
import sys
from pathlib import Path

import pytest

from energy_trading.capabilities import BY_NAME, TOOLS, mcp_tools, openai_tools, to_command
from energy_trading.mcp_server import McpServer
from energy_trading.ronor_agent import SYSTEM, RonorAgent, guard_allows, modelfile

ROOT = Path(__file__).resolve().parent.parent


def test_registry_maps_to_real_commands(tmp_path):
    from tests.test_operator_bot import _bot

    bot, _ = _bot(tmp_path)
    for t in TOOLS:
        if t.name == "noteaza":
            continue
        cmd = t.to_command({k: "14.09" if k == "day" else "3" for k in t.params})
        assert cmd.split()[0][1:] in bot.commands, (t.name, cmd)
    assert to_command("ziua", {}) == "/azi"
    assert to_command("ziua", {"day": "maine"}) == "/azi maine"
    assert to_command("autorizeaza", {"ids": "tot"}) == "/autorizez tot"
    with pytest.raises(KeyError):
        to_command("inexistent")
    names = {t["function"]["name"] for t in openai_tools()}
    assert names == set(BY_NAME) and len(names) == 21
    ro = {t["name"]: t["annotations"]["readOnlyHint"] for t in mcp_tools()}
    assert ro["ziua"] is True and ro["autorizeaza"] is False


def test_generated_files_match_registry():
    tools = json.loads((ROOT / "ronor" / "tools.json").read_text())
    assert tools["openai"] == openai_tools() and tools["mcp"] == mcp_tools()
    mf = (ROOT / "ronor" / "Modelfile").read_text()
    assert mf.startswith("FROM qwen2.5") and "Nu inventezi" in mf and modelfile("qwen2.5") == mf


def test_guard_blocks_unrequested_mutations():
    assert guard_allows("ziua", "bla")
    assert not guard_allows("autorizeaza", "cum stă ziua?", {"ids": "tot"})
    assert not guard_allows("autorizeaza", "ce trebuie să autorizez?", {"ids": "tot"})
    assert guard_allows("autorizeaza", "autorizez XB-0001", {"ids": "XB-0001"})
    assert guard_allows("autorizeaza", "XB-0001 ok", {"ids": "xb-0001"})
    # the model may not widen what the human authorized
    assert not guard_allows("autorizeaza", "autorizez XB-0001", {"ids": "XB-0001 XB-0002"})
    assert not guard_allows("autorizeaza", "autorizez XB-0001", {"ids": "tot"})
    assert guard_allows("autorizeaza", "autorizez tot", {"ids": "tot"})
    assert not guard_allows("autorizeaza", "autorizez", {"ids": "tot"})
    assert not guard_allows("opreste", "ce capacitate avem?")
    assert guard_allows("opreste", "oprește agentul")
    assert guard_allows("noteaza", "skip UA-MD")
    assert not guard_allows("inexistent", "orice")


class FakeOllama:
    """Scripted /api/chat: a list of responses, records what it was asked."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.calls: list[dict] = []

    def __call__(self, path, payload):
        assert path == "/api/chat" and payload["tools"]
        self.calls.append(payload)
        return self.responses.pop(0)


def _tool_call(name, **args):
    return {
        "message": {
            "role": "assistant",
            "content": "",
            "tool_calls": [{"function": {"name": name, "arguments": args}}],
        }
    }


def _final(text):
    return {"message": {"role": "assistant", "content": text}}


def test_agent_calls_tools_then_answers():
    executed = []

    def execute(cmd, who):
        executed.append((cmd, who))
        return f"REZULTAT[{cmd}]"

    fake = FakeOllama(
        [
            _tool_call("ziua", day="14.09"),
            _tool_call("capacitate", day="14.09"),
            _final("Mâine: REZULTAT bine."),
        ]
    )
    agent = RonorAgent(execute, "http://ollama", "ronor-energy", post=fake)
    out = agent.answer("cum stă ziua de mâine 14.09?", who="Natalia")
    assert out == {
        "reply": "Mâine: REZULTAT bine.",
        "tools": ["ziua", "capacitate"],
        "mode": "ollama",
    }
    assert executed == [("/azi 14.09", "Natalia"), ("/ntc 14.09", "Natalia")]
    # tool results were fed back to the model, system prompt carries the doctrine
    msgs = fake.calls[-1]["messages"]
    assert msgs[0]["content"] == SYSTEM
    assert next(m for m in msgs if m.get("role") == "tool")["content"] == "REZULTAT[/azi 14.09]"
    assert "[Natalia] cum stă" in msgs[1]["content"]


def test_agent_refuses_unrequested_authorization_and_tells_model():
    executed = []
    fake = FakeOllama([_tool_call("autorizeaza", ids="tot"), _final("Nu am autorizat nimic.")])
    agent = RonorAgent(lambda c, w: executed.append(c) or "x", "http://ollama", "m", post=fake)
    out = agent.answer("explică-mi situația")
    assert executed == []  # the guard never let the command run
    tool_msg = next(m for m in fake.calls[-1]["messages"] if m.get("role") == "tool")
    assert tool_msg["content"].startswith("Refuzat: 'autorizeaza'")
    assert out["reply"] == "Nu am autorizat nimic."


def test_agent_falls_back_when_ollama_fails_or_is_off():
    def boom(path, payload):
        raise OSError("connection refused")

    agent = RonorAgent(lambda c, w: f"DET[{c}]", "http://ollama", "m", post=boom)
    out = agent.answer("/status")
    assert out == {"reply": "DET[/status]", "tools": [], "mode": "fallback"}
    off = RonorAgent(lambda c, w: f"DET[{c}]", "", "m")
    assert off.answer("/azi")["mode"] == "fallback"


def test_agent_hands_over_last_tool_output_when_model_stays_silent():
    fake = FakeOllama([_tool_call("status"), _final("")])
    agent = RonorAgent(lambda c, w: "STARE OK", "http://ollama", "m", post=fake)
    assert agent.answer("status?")["reply"] == "STARE OK"


def test_mcp_server_handshake_and_tool_call():
    seen = []
    srv = McpServer(lambda c, w: seen.append((c, w)) or f"OUT[{c}]", who="mcp")
    init = srv.handle(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {"protocolVersion": "2025-06-18"},
        }
    )
    assert (
        init["result"]["serverInfo"]["name"] == "ronor-energy"
        and "tools" in init["result"]["capabilities"]
    )
    assert srv.handle({"jsonrpc": "2.0", "method": "notifications/initialized"}) is None
    assert srv.handle({"jsonrpc": "2.0", "id": 2, "method": "ping"})["result"] == {}
    listed = srv.handle({"jsonrpc": "2.0", "id": 3, "method": "tools/list"})["result"]["tools"]
    assert {t["name"] for t in listed} == set(BY_NAME)
    call = srv.handle(
        {
            "jsonrpc": "2.0",
            "id": 4,
            "method": "tools/call",
            "params": {"name": "ziua", "arguments": {"day": "14.09"}, "_meta": {"who": "Natalia"}},
        }
    )
    assert call["result"] == {
        "content": [{"type": "text", "text": "OUT[/azi 14.09]"}],
        "isError": False,
    }
    assert seen == [("/azi 14.09", "Natalia")]
    bad = srv.handle(
        {"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "nope"}}
    )
    assert bad["error"]["code"] == -32602
    assert (
        srv.handle({"jsonrpc": "2.0", "id": 6, "method": "resources/list"})["error"]["code"]
        == -32601
    )

    def failing(c, w):
        raise RuntimeError("down")

    err = McpServer(failing).handle(
        {"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": "status"}}
    )
    assert err["result"]["isError"] and "down" in err["result"]["content"][0]["text"]


def test_mcp_server_stdio_transport():
    srv = McpServer(lambda c, w: "ok")
    inp = io.StringIO(
        '{"jsonrpc":"2.0","id":1,"method":"ping"}\nnot json\n\n{"jsonrpc":"2.0","method":"notifications/x"}\n'
    )
    out = io.StringIO()
    srv.serve(inp, out)
    lines = [json.loads(line) for line in out.getvalue().splitlines()]
    assert lines[0]["result"] == {} and lines[1]["error"]["code"] == -32700 and len(lines) == 2


def test_api_ronor_endpoint_falls_back_without_ollama():
    from fastapi.testclient import TestClient

    from energy_trading import api

    c = TestClient(api.app)
    r = c.post("/api/ronor", json={"text": "/granite", "who": "Natalia"})
    body = r.json()
    assert r.status_code == 200 and body["mode"] == "fallback" and "RO-UA" in body["reply"]
    assert body["who"] == "Natalia"
    assert c.get("/api/health").json()["ronor_brain"] == {
        "ollama": False,
        "model": api.settings.ollama_model,
    }


def test_api_ronor_uses_model_when_available(monkeypatch):
    from fastapi.testclient import TestClient

    from energy_trading import api

    # Not deterministically routable ("explică" → knowledge), so the model decides the tool.
    fake = FakeOllama([_tool_call("granite"), _final("Acoperim granițele RO/UA/MD.")])
    monkeypatch.setattr(api.ronor, "ollama_url", "http://ollama")
    monkeypatch.setattr(api.ronor, "_post", fake)
    c = TestClient(api.app)
    body = c.post("/api/ronor", json={"text": "explică-mi ce granițe ai tu"}).json()
    assert body["mode"] == "ollama" and body["tools"] == ["granite"]
    assert body["reply"] == "Acoperim granițele RO/UA/MD."
    tool_out = next(m for m in fake.calls[-1]["messages"] if m.get("role") == "tool")["content"]
    assert "RO-UA" in tool_out  # the real module answered the tool call


def test_api_ronor_routes_obvious_messages_before_the_model(monkeypatch):
    from fastapi.testclient import TestClient

    from energy_trading import api

    # Clear intent: deterministic answer, the model is never called.
    fake = FakeOllama([])
    monkeypatch.setattr(api.ronor, "ollama_url", "http://ollama")
    monkeypatch.setattr(api.ronor, "_post", fake)
    c = TestClient(api.app)
    body = c.post("/api/ronor", json={"text": "ce capacitate avem pe 14.09?"}).json()
    assert body["mode"] == "routed" and body["tools"] == ["ntc"] and fake.calls == []
    assert "RO-UA" in body["reply"]
    # An ops note goes to the intake, not to a command, and is applied to the day.
    body = c.post("/api/ronor", json={"text": "skip UA-MD 21.09", "who": "Natalia"}).json()
    assert body["mode"] == "routed" and body["tools"] == ["noteaza"] and "UA-MD" in body["reply"]
    assert "UA-MD" in " ".join(api.store.load("briefs/2026-09-21_overrides")["decisions"])


def test_route_hit_never_consults_the_model():
    execd = []
    fake = FakeOllama([])  # any call would raise IndexError → fallback → test fails
    agent = RonorAgent(
        lambda c, w: execd.append((c, w)) or "✅ Nominalizate 2 — autorizat de Natalia",
        "http://ollama",
        "m",
        post=fake,
        route=lambda t: "/autorizez XB-0001 XB-0002",
    )
    out = agent.answer("autorizez XB-0001 XB-0002", who="Natalia")
    assert execd == [("/autorizez XB-0001 XB-0002", "Natalia")] and fake.calls == []
    assert out == {
        "reply": "✅ Nominalizate 2 — autorizat de Natalia",
        "tools": ["autorizez"],
        "mode": "routed",
    }
    # a raw ops note routed to the intake is reported as 'noteaza'
    note = RonorAgent(
        lambda c, w: "🚫 UA-MD exclus", "http://ollama", "m", post=fake, route=lambda t: t
    )
    assert note.answer("skip UA-MD") == {
        "reply": "🚫 UA-MD exclus",
        "tools": ["noteaza"],
        "mode": "routed",
    }

    # routed command failing → deterministic fallback, not silence
    def boom(c, w):
        raise RuntimeError("x")

    broken = RonorAgent(
        boom, "http://ollama", "m", post=fake, route=lambda t: "/azi", fallback=lambda t, w: "DET"
    )
    assert broken.answer("ziua")["reply"] == "DET"


def test_numbers_grounding():
    from energy_trading.ronor_agent import numbers_grounded

    assert numbers_grounded("Medie 400 MW, 21 ore, €26.323", ["400 MW · 21h · €26,323"])
    assert not numbers_grounded("Medie 450 MW", ["400 MW"])
    assert numbers_grounded("fără cifre", [])


def test_agent_numbers_without_tools_fall_back():
    agent3 = RonorAgent(
        lambda c, w: f"DET[{c}]", "http://ollama", "m", post=FakeOllama([_final("Sunt 7 granițe.")])
    )
    assert agent3.answer("explică") == {"reply": "DET[explică]", "tools": [], "mode": "fallback"}


def test_api_ops_upload_applies_overrides(tmp_path):
    import openpyxl
    from fastapi.testclient import TestClient

    from energy_trading import api

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(["Border", "ATC MW"])
    ws.append(["RO-UA", 400])
    ws.append(["UA-MD", 0])
    buf = io.BytesIO()
    wb.save(buf)
    c = TestClient(api.app)
    r = c.post(
        "/api/ops-upload?day=2026-09-20&source=ronor",
        files={
            "file": (
                "ntc.xlsx",
                buf.getvalue(),
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            )
        },
    )
    body = r.json()
    assert r.status_code == 200 and body["availability"]["RO-UA"] == 400 and body["reply"]
    saved = api.store.load("briefs/2026-09-20_overrides")
    assert saved and saved["availability"]["RO-UA"] == 400


def _plugin():
    spec = importlib.util.spec_from_file_location(
        "dispatcher_plugin", ROOT / "ronor" / "dispatcher_plugin.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_dispatcher_plugin_routing_and_relay():
    plugin = _plugin()
    assert plugin.looks_like_energy("NTC RO-UA 14.09 400 MW") and not plugin.looks_like_energy(
        "bună dimineața"
    )
    assert plugin.infer_day("NTC 14.09.2026") == "2026-09-14" and plugin.infer_day("x", "d") == "d"
    em = plugin.EnergyModule("http://energy:8000", token="t", trading_chats={"-100"})
    assert em.endpoint == "/api/ronor"
    assert em.wants({"chat": {"id": -100}, "text": "salut"})  # trading group: everything
    assert em.wants({"chat": {"id": 1}, "text": "/azi@RONORBot"})
    assert not em.wants({"chat": {"id": 1}, "text": "/health"})
    assert not em.wants({"chat": {"id": 1}, "text": "ce mai faci"})
    assert em.wants({"chat": {"id": 1}, "document": {"file_name": "NTC.xlsx", "file_id": "f"}})

    posted = []

    def fake_post(path, payload):
        posted.append((path, payload))
        return {"reply": "RĂSPUNS", "kind": "command"}

    em._post = fake_post
    msg = {"chat": {"id": 1}, "from": {"first_name": "Natalia", "last_name": "P"}, "text": "/azi"}
    assert em.handle(msg) == "RĂSPUNS"
    assert posted == [("/api/ronor", {"text": "/azi", "chat_id": "1", "who": "Natalia P"})]
    assert em.handle({"chat": {"id": 1}, "text": "ce mai faci"}) is None
    em._post = lambda p, b: {"reply": "", "kind": "ignored"}
    assert em.handle({"chat": {"id": -100}, "text": "mulțumesc"}) is None


def test_cli_prints_modelfile():
    out = subprocess.run(
        [sys.executable, "-m", "energy_trading.ronor_agent", "--modelfile", "qwen3.5"],
        capture_output=True,
        text=True,
        check=True,
        cwd=ROOT,
        env={"PYTHONPATH": str(ROOT / "src"), "PATH": ""},
    ).stdout
    assert out.startswith("FROM qwen3.5") and "SYSTEM" in out
