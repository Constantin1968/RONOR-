"""Offline relay and shutdown checks. No external requests, secrets or messages."""
import asyncio
import base64
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "ops/conversation-bot"))
import isolation_proxy as relay
from relay_transport import http_client
from task_inbox import TaskInbox, TaskWorker

CONFIG = dict(telegram_token="fixture-token", chat_id="owner", memory_key="fixture-memory",
              cida_key="fixture-cida", qwen_key="fixture-model")


def request(url, method="GET", body=None):
    return dict(url=url, method=method, headers={"Authorization": "injected"},
                body=base64.b64encode(json.dumps(body).encode() if body is not None else b"").decode())


class PolicyTests(unittest.TestCase):
    def test_fixed_routes_replace_credentials(self):
        for url, name, header in [
            ("http://cida-api:8300/search?q=fixture&mode=lexical", "cida", "X-API-Key"),
            ("http://ronor-r-memory:8101/search?q=fixture", "memory", "X-API-Key"),
        ]:
            label, target, headers, _ = relay.route(request(url), CONFIG)
            self.assertEqual(label, name)
            self.assertNotIn("Authorization", headers)
            self.assertEqual(headers[header], CONFIG[name + "_key"])
        result = relay.route(request("https://api.telegram.org/botproxy-managed/getMe"), CONFIG)
        self.assertIn("/botfixture-token/getMe", result[1])

    def test_admin_ssrf_encoded_paths_and_redirect_destinations_denied(self):
        urls = [
            "http://169.254.169.254/latest/meta-data",
            "http://127.0.0.1:2375/containers/json",
            "http://cida-api:8300/admin", "http://cida-api:8300/%73earch?q=x",
            "http://cida-api:8300/search?q=x&mode=semantic",
            "http://cida-api:8300/search?q=x&q=y",
            "http://cida-api:8300/search?q=x&limit=100",
            "http://cida-api:8300/search?q=x#fragment",
            "http://user@cida-api:8300/health",
            "http://ronor-r-memory:8101/store/bulk",
            "https://api.telegram.org/botproxy-managed/deleteWebhook",
            "https://api.telegram.org/botproxy-managed/getUpdates?offset=-1",
            "https://dashscope-intl.aliyuncs.com.evil.invalid/compatible-mode/v1/chat/completions",
        ]
        for url in urls:
            with self.subTest(url=url), self.assertRaises(ValueError):
                relay.route(request(url), CONFIG)

    def test_messages_only_to_owner(self):
        url = "https://api.telegram.org/botproxy-managed/sendMessage"
        relay.route(request(url, "POST", {"chat_id": "owner", "text": "fixture"}), CONFIG)
        with self.assertRaises(ValueError):
            relay.route(request(url, "POST", {"chat_id": "stranger", "text": "fixture"}), CONFIG)

    def test_missing_cida_key_cannot_be_replaced_by_client_headers(self):
        with self.assertRaises(ValueError):
            relay.route(request("http://cida-api:8300/search?q=x"), CONFIG | {"cida_key": ""})
        result = relay.route(request("http://cida-api:8300/health"), CONFIG | {"cida_key": ""})
        self.assertNotIn("X-API-Key", result[2])

    def test_model_limit_and_store_schema(self):
        url = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions"
        valid = {"model": "qwen-max", "messages": [], "max_tokens": 2048}
        result = relay.route(request(url, "POST", valid), CONFIG)
        self.assertEqual(result[2]["Authorization"], "Bearer fixture-model")
        for changes in [{"model": "other"}, {"max_tokens": 2049}, {"stream": True}, {"n": 2}]:
            with self.assertRaises(ValueError):
                relay.route(request(url, "POST", valid | changes), CONFIG)
        with self.assertRaises(ValueError):
            relay.route(request("http://ronor-r-memory:8101/store", "POST",
                                {"content": "fixture", "delete": True}), CONFIG)


class SocketTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_unix_transport_with_mock_upstream_and_policy_denial(self):
        calls = []
        async def fake_process(payload, config):
            label, target, headers, body = relay.route(payload, config)
            calls.append(label)
            return relay.envelope(200, b'{"ok":true}')
        with tempfile.TemporaryDirectory() as tmp:
            path = tmp + "/relay.sock"
            with patch.dict(os.environ, {"RONOR_EGRESS_SOCKET": path}), patch.object(relay, "process", fake_process):
                server = await asyncio.start_unix_server(
                    lambda r, w: relay.serve_client(r, w, CONFIG), path=path)
                async with server, http_client(timeout=2) as client:
                    good = await client.get("http://cida-api:8300/health")
                    self.assertTrue(good.json()["ok"])
                    denied = await client.get("http://127.0.0.1:2375/containers/json")
                    self.assertEqual(denied.status_code, 403)
                self.assertEqual(calls, ["cida"])

    async def test_shutdown_marks_inflight_uncertain_not_replayed(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = tmp + "/inbox.sqlite"
            box = TaskInbox(path)
            started = asyncio.Event()
            async def handler(payload):
                started.set()
                await asyncio.sleep(100)
            box.accept(1, {"text": "fixture"})
            worker = TaskWorker(box, handler)
            runner = asyncio.create_task(worker.run())
            await started.wait()
            runner.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await runner
            self.assertEqual(box.db.execute("SELECT state FROM tasks").fetchone()[0], "interrupted")
            box.close()
            box = TaskInbox(path)
            self.assertIsNone(box.claim())
            box.close()


if __name__ == "__main__":
    unittest.main()
