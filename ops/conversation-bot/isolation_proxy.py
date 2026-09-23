"""Narrow, credential-owning Unix-socket relay. No public listening socket."""
import asyncio
import base64
import json
import os
from pathlib import Path
import re
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit
import httpx

MAX_BODY = 2 * 1024 * 1024
MAX_RESPONSE = 4 * 1024 * 1024
SOCKET = os.getenv("RONOR_EGRESS_SOCKET", "/run/egress/egress.sock")
CONFIG = os.getenv("RONOR_RELAY_CONFIG", "/run/secrets/relay.json")


def route(payload, config):
    """Validate logical endpoint and reconstruct request; never trust headers."""
    method, url = payload["method"], payload["url"]
    if method not in {"GET", "POST"} or not isinstance(url, str) or len(url) > 16384:
        raise ValueError("Invalid request")
    u = urlsplit(url)
    if u.username or u.password or u.fragment:
        raise ValueError("Invalid URL")
    body = base64.b64decode(payload.get("body", ""), validate=True)
    if len(body) > MAX_BODY:
        raise ValueError("Body limit")
    headers = {"Content-Type": "application/json", "Accept": "application/json",
               "User-Agent": "RONOR-Isolated-Relay/1"}
    query = parse_qs(u.query, keep_blank_values=True, strict_parsing=True)
    if any(len(v) != 1 for v in query.values()):
        raise ValueError("Duplicate query parameters")
    if u.scheme == "https" and u.hostname == "api.telegram.org" and u.port in (None, 443):
        match = re.fullmatch(r"/botproxy-managed/(getMe|getWebhookInfo|getUpdates|sendMessage)", u.path)
        if not match:
            raise ValueError("Telegram method denied")
        action = match[1]
        if action == "sendMessage":
            value = json.loads(body)
            if (method != "POST" or query or not isinstance(value, dict)
                    or set(value) - {"chat_id", "text", "disable_web_page_preview"}
                    or str(value.get("chat_id")) != str(config["chat_id"])
                    or not isinstance(value.get("text"), str) or not 1 <= len(value["text"]) <= 4096):
                raise ValueError("Telegram destination denied")
        elif method != "GET" or body:
            raise ValueError("Read-only Telegram request required")
        elif action == "getUpdates":
            if set(query) - {"offset", "timeout", "allowed_updates", "limit"}:
                raise ValueError("Polling parameters denied")
            if "timeout" in query and not 0 <= int(query["timeout"][0]) <= 30:
                raise ValueError("Polling duration denied")
            if "allowed_updates" in query and json.loads(query["allowed_updates"][0]) != ["message"]:
                raise ValueError("Update class denied")
            if "offset" in query and int(query["offset"][0]) < 0:
                raise ValueError("Destructive offset denied")
        elif query:
            raise ValueError("Unexpected query")
        target = urlunsplit(("https", "api.telegram.org",
                            "/bot" + config["telegram_token"] + "/" + action, u.query, ""))
        return "telegram", target, headers, body
    if u.scheme == "http" and u.hostname == "ronor-r-memory" and u.port == 8101:
        allowed = {("GET", "/health"), ("GET", "/search"), ("POST", "/store")}
        if (method, u.path) not in allowed:
            raise ValueError("Memory operation denied")
        if (u.path == "/health" and query) or (u.path == "/store" and query):
            raise ValueError("Unexpected query")
        if u.path == "/search":
            if set(query) - {"q", "top_k", "min_score"}:
                raise ValueError("Memory query denied")
            if not 1 <= len(query.get("q", [""])[0]) <= 2000:
                raise ValueError("Memory query size")
            if not 1 <= int(query.get("top_k", ["10"])[0]) <= 10:
                raise ValueError("Memory result limit")
            if not 0 <= float(query.get("min_score", ["0.3"])[0]) <= 1:
                raise ValueError("Memory score limit")
        if method == "GET" and body:
            raise ValueError("GET body denied")
        if u.path == "/store":
            value = json.loads(body)
            if (not isinstance(value, dict) or set(value) - {"content", "metadata"}
                    or not isinstance(value.get("content"), str)
                    or not 1 <= len(value["content"]) <= 20000
                    or not isinstance(value.get("metadata", {}), dict)):
                raise ValueError("Memory payload denied")
        headers["X-API-Key"] = config["memory_key"]
        return "memory", urlunsplit(("http", "ronor-r-memory:8101", u.path, u.query, "")), headers, body
    if u.scheme == "http" and u.hostname == "cida-api" and u.port == 8300:
        if method != "GET" or body or u.path not in {"/health", "/search"}:
            raise ValueError("CIDA operation denied")
        if u.path == "/health" and query:
            raise ValueError("Unexpected query")
        if u.path == "/search":
            if not config.get("cida_key"):
                raise ValueError("CIDA credential unavailable")
            if (set(query) - {"q", "limit", "mode"}
                    or not 1 <= len(query.get("q", [""])[0]) <= 2000
                    or not 1 <= int(query.get("limit", ["5"])[0]) <= 10
                    or query.get("mode", ["lexical"])[0] != "lexical"):
                raise ValueError("CIDA search denied")
        if config.get("cida_key"):
            headers["X-API-Key"] = config["cida_key"]
        return "cida", urlunsplit(("http", "cida-api:8300", u.path, u.query, "")), headers, body
    if (u.scheme == "https" and u.hostname == "dashscope-intl.aliyuncs.com"
            and u.port in (None, 443) and u.path == "/compatible-mode/v1/chat/completions"
            and method == "POST" and not query):
        value = json.loads(body)
        if (not isinstance(value, dict) or value.get("model") != "qwen-max"
                or type(value.get("max_tokens")) is not int
                or not 1 <= value["max_tokens"] <= 2048
                or value.get("stream", False) or value.get("n", 1) != 1
                or not isinstance(value.get("messages"), list)
                or len(value["messages"]) > 100):
            raise ValueError("Model request denied")
        headers["Authorization"] = "Bearer " + config["qwen_key"]
        return "model", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions", headers, body
    raise ValueError("Destination denied")


def envelope(status, body, content_type="application/json"):
    return {"status": status, "headers": {"Content-Type": content_type},
            "body": base64.b64encode(body).decode()}


async def process(payload, config):
    label, target, headers, body = route(payload, config)
    # Ignore client credentials, forwarding headers and proxy variables.
    # Redirects cannot escape the route allowlist.
    async with httpx.AsyncClient(timeout=70, trust_env=False, follow_redirects=False) as client:
        async with client.stream(payload["method"], target, headers=headers, content=body) as response:
            chunks, length = [], 0
            async for chunk in response.aiter_bytes():
                length += len(chunk)
                if length > MAX_RESPONSE:
                    raise ValueError("Response limit")
                chunks.append(chunk)
            print(json.dumps({"route": label, "status": response.status_code}), flush=True)
            return envelope(response.status_code, b"".join(chunks),
                            response.headers.get("content-type", "application/json"))


async def serve_client(reader, writer, config):
    result = envelope(502, b'{"error":"relay unavailable"}')
    try:
        header = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 10)
        if len(header) > 16384:
            raise ValueError("Header limit")
        lines = header.decode("ascii").split("\r\n")
        if lines[0] != "POST /forward HTTP/1.1":
            raise ValueError("Invalid relay method")
        headers = {}
        for line in lines[1:]:
            if not line:
                continue
            k, v = line.split(":", 1)
            k = k.lower()
            if k in headers:
                raise ValueError("Duplicate header")
            headers[k] = v.strip()
        if "transfer-encoding" in headers:
            raise ValueError("Chunked requests denied")
        size = int(headers.get("content-length", "0"))
        # Base64 envelope expands the original body.
        if not 1 <= size <= MAX_BODY * 2:
            raise ValueError("Envelope limit")
        payload = json.loads(await asyncio.wait_for(reader.readexactly(size), 15))
        result = await asyncio.wait_for(process(payload, config), 75)
    except (ValueError, KeyError, TypeError):
        result = envelope(403, b'{"error":"relay policy denied request"}')
        print('{"route":"denied","status":403}', flush=True)
    except asyncio.IncompleteReadError:
        # A socket-only readiness probe does not request any upstream action.
        writer.close()
        await writer.wait_closed()
        return
    except Exception as exc:
        print(json.dumps({"route": "error", "class": type(exc).__name__}), flush=True)
    try:
        data = json.dumps(result).encode()
        writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: "
                     + str(len(data)).encode() + b"\r\n\r\n" + data)
        await writer.drain()
    finally:
        writer.close()
        try:
            await writer.wait_closed()
        except (BrokenPipeError, ConnectionResetError):
            pass


async def main():
    config = json.loads(Path(CONFIG).read_text())
    if any(not config.get(k) for k in ["telegram_token", "chat_id", "memory_key", "qwen_key"]):
        raise RuntimeError("Relay credential configuration incomplete")
    if os.path.lexists(SOCKET):
        os.unlink(SOCKET)
    server = await asyncio.start_unix_server(lambda r, w: serve_client(r, w, config), path=SOCKET, limit=16384)
    os.chmod(SOCKET, 0o660)
    print('{"relay":"ready"}', flush=True)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
