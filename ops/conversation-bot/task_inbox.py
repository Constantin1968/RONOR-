"""Durable intake with concurrent cancellation; never auto-replay uncertain work."""
import asyncio
import json
import os
import sqlite3
from pathlib import Path


class TaskInbox:
    def __init__(self, path):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        # Create privately, without a create-then-chmod disclosure window.
        fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
        os.close(fd)
        os.chmod(path, 0o600)
        self.db = sqlite3.connect(path)
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("""CREATE TABLE IF NOT EXISTS tasks(
            id INTEGER PRIMARY KEY, payload TEXT NOT NULL, state TEXT NOT NULL,
            reason TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)""")
        # A crash after a remote effect cannot safely be replayed.
        self.db.execute("""UPDATE tasks SET state='interrupted',
            reason='process restarted; effects unknown; operator review required'
            WHERE state='running'""")
        # Crash between durably receiving STOP and applying it: apply the stop
        # before a worker can claim any queued message after restart.
        if self.db.execute("SELECT 1 FROM tasks WHERE state='control' LIMIT 1").fetchone():
            self.db.execute("UPDATE tasks SET state='cancelled' WHERE state='pending'")
            self.db.execute("""UPDATE tasks SET state='succeeded',
                reason='STOP recovered after restart' WHERE state='control'""")
        self.db.commit()

    def accept(self, update_id, payload, state="pending"):
        with self.db:
            result = self.db.execute(
                "INSERT OR IGNORE INTO tasks(id,payload,state) VALUES (?,?,?)",
                (update_id, json.dumps(payload, ensure_ascii=False), state))
        return result.rowcount == 1

    def set_state(self, update_id, state, reason=None):
        with self.db:
            self.db.execute("""UPDATE tasks SET state=?,reason=?,
                updated_at=CURRENT_TIMESTAMP WHERE id=?""", (state, reason, update_id))

    def cancel_pending(self):
        with self.db:
            self.db.execute("UPDATE tasks SET state='cancelled' WHERE state='pending'")

    def claim(self):
        with self.db:
            row = self.db.execute(
                "SELECT id,payload FROM tasks WHERE state='pending' ORDER BY id LIMIT 1"
            ).fetchone()
            if row:
                self.db.execute("UPDATE tasks SET state='running' WHERE id=?", (row[0],))
        return (row[0], json.loads(row[1])) if row else None

    def offset(self):
        row = self.db.execute("SELECT MAX(id) FROM tasks").fetchone()
        return row[0] + 1 if row[0] is not None else None

    def close(self):
        self.db.close()


class TaskWorker:
    def __init__(self, inbox, handler):
        self.inbox, self.handler = inbox, handler
        self.active = None
        self.active_id = None

    async def run(self):
        while True:
            claimed = self.inbox.claim()
            if not claimed:
                await asyncio.sleep(0.1)
                continue
            task_id, payload = claimed
            self.active_id = task_id
            self.active = asyncio.create_task(self.handler(payload))
            try:
                await self.active
            except asyncio.CancelledError:
                self.inbox.set_state(task_id, "cancelled", "STOP acknowledged; remote effects not undone")
                # Cancellation of the worker itself is shutdown, not another job.
                if asyncio.current_task().cancelling():
                    raise
            except Exception as exc:
                self.inbox.set_state(task_id, "failed", type(exc).__name__)
            else:
                self.inbox.set_state(task_id, "succeeded")
            finally:
                self.active = None
                self.active_id = None

    async def stop(self):
        self.inbox.cancel_pending()
        active = self.active
        if active is not None and not active.done():
            active.cancel()
            try:
                await active
            except asyncio.CancelledError:
                pass
