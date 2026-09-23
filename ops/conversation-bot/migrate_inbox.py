"""After the old poller stops, preserve unacknowledged updates without replay."""
import asyncio
import json
import os
from relay_transport import http_client
from task_inbox import TaskInbox

async def main():
    os.umask(0o077)
    inbox = TaskInbox("/var/lib/ronor-bot/inbox.sqlite")
    counts = {"interrupted": 0, "ignored": 0}
    try:
        async with http_client(timeout=15) as client:
            for _ in range(10):
                params = {"timeout": 0, "limit": 100, "allowed_updates": json.dumps(["message"])}
                if inbox.offset() is not None:
                    params["offset"] = inbox.offset()
                response = await client.get(
                    "https://api.telegram.org/botproxy-managed/getUpdates", params=params)
                if response.status_code != 200 or response.json().get("ok") is not True:
                    raise RuntimeError("Migration poll not acknowledged")
                updates = response.json()["result"]
                if not updates:
                    print(json.dumps({"migration_complete": True, **counts,
                                      "automatic_replay": False}))
                    return
                for update in updates:
                    msg = update.get("message", {})
                    chat = str(msg.get("chat", {}).get("id", ""))
                    text = msg.get("text")
                    if chat == os.environ["TELEGRAM_CHAT_ID"] and isinstance(text, str):
                        state, payload = "interrupted", {"chat_id": chat, "text": text}
                    else:
                        state, payload = "ignored", {}
                    if inbox.accept(update["update_id"], payload, state):
                        counts[state] += 1
                # The next poll confirms only rows already committed to SQLite.
            raise RuntimeError("Migration batch limit reached; keep bot stopped for review")
    finally:
        inbox.close()

asyncio.run(main())
