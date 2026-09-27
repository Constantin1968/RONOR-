"""Minimal MCP server (stdio, JSON-RPC 2.0) exposing the energy capabilities.

No SDK dependency: the protocol surface an MCP host needs from a tool server is
small — ``initialize``, ``notifications/initialized``, ``ping``, ``tools/list``,
``tools/call``.  Each tool call becomes an operator command executed against a
live module over HTTP, so any agent in the RONOR node (an Ollama-based
orchestrator, Claude/Cursor-style clients, CIDA workers) can drive the same
brain the Telegram bot uses.

Run:  ET_API_URL=http://energy:8000 ET_API_TOKEN=... python -m energy_trading.mcp_server
"""

from __future__ import annotations

import json
import logging
import os
import sys
from typing import Any, TextIO

from energy_trading.capabilities import BY_NAME, mcp_tools, to_command
from energy_trading.ronor_agent import Executor, HttpExecutor

log = logging.getLogger(__name__)

PROTOCOL_VERSION = "2025-06-18"
SERVER_INFO = {"name": "ronor-energy", "version": "0.2.0"}


class McpServer:
    def __init__(self, execute: Executor, who: str = "mcp"):
        self.execute = execute
        self.who = who

    # -- request handling --------------------------------------------------
    def handle(self, request: dict) -> dict | None:
        """One JSON-RPC message in, one response out (``None`` for notifications)."""
        method = request.get("method", "")
        rid = request.get("id")
        params = request.get("params") or {}
        if method.startswith("notifications/"):
            return None
        try:
            result = self._dispatch(method, params)
        except KeyError as exc:
            return self._error(rid, -32601, f"Method not found: {exc.args[0]}")
        except ValueError as exc:
            return self._error(rid, -32602, str(exc))
        return {"jsonrpc": "2.0", "id": rid, "result": result}

    def _dispatch(self, method: str, params: dict) -> dict:
        if method == "initialize":
            return {
                "protocolVersion": params.get("protocolVersion") or PROTOCOL_VERSION,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": SERVER_INFO,
                "instructions": (
                    "Energy cross-border trading module (RO/UA/MD, Romania as regional hub). "
                    "Call 'ziua' first for the day's picture. Only call 'autorizeaza' when the "
                    "human operator explicitly authorizes; it is recorded under their name."
                ),
            }
        if method == "ping":
            return {}
        if method == "tools/list":
            return {"tools": mcp_tools()}
        if method == "tools/call":
            name = params.get("name", "")
            if name not in BY_NAME:
                raise ValueError(f"Unknown tool: {name}")
            args = params.get("arguments") or {}
            meta = params.get("_meta") or {}
            who = str(meta.get("who") or self.who)
            try:
                text = self.execute(to_command(name, args), who)
                return {"content": [{"type": "text", "text": text}], "isError": False}
            except Exception as exc:  # noqa: BLE001 — surfaced to the client as a tool error
                return {
                    "content": [{"type": "text", "text": f"{name} failed: {exc}"}],
                    "isError": True,
                }
        raise KeyError(method)

    @staticmethod
    def _error(rid: Any, code: int, message: str) -> dict:
        return {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}}

    # -- transport -------------------------------------------------------------
    def serve(self, inp: TextIO = sys.stdin, out: TextIO = sys.stdout) -> None:
        for line in inp:
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
            except json.JSONDecodeError:
                out.write(json.dumps(self._error(None, -32700, "Parse error")) + "\n")
                out.flush()
                continue
            resp = self.handle(req)
            if resp is not None:
                out.write(json.dumps(resp, ensure_ascii=False) + "\n")
                out.flush()


def main() -> int:
    logging.basicConfig(level=logging.INFO, stream=sys.stderr)
    ex = HttpExecutor(
        os.getenv("ET_API_URL", "http://localhost:8000"), os.getenv("ET_API_TOKEN", "")
    )
    McpServer(ex, who=os.getenv("MCP_WHO", "mcp")).serve()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
