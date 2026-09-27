"""Registrul RXB: numai adăugare, fiecare rând semnat HMAC-SHA256 și înlănțuit.

- Fără UPDATE, fără DELETE: o corecție este un rând nou.
- Fiecare rând poartă semnătura propriului conținut canonic și hash-ul
  rândului anterior; verify() detectează orice modificare sau ștergere.
- Cheia vine din RXB_LEDGER_HMAC_KEY. Fără cheie, scrierea refuză (fail closed).
- Stocare: SQLite în volumul de stare (Etapa 1). Postgres în Etapa 2, aceeași schemă.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import sqlite3
import threading
from datetime import datetime, timezone
from decimal import Decimal

SCHEMA = """
CREATE TABLE IF NOT EXISTS rxb_ledger (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,          -- decision | rights | money | dispute | input
  day        TEXT NOT NULL,
  hour       INTEGER,
  route      TEXT,
  payload    TEXT NOT NULL,          -- JSON canonic, sume ca text Decimal
  actor      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  key_id     TEXT NOT NULL,
  prev_hash  TEXT NOT NULL,
  sig        TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS rxb_ledger_no_update BEFORE UPDATE ON rxb_ledger
BEGIN SELECT RAISE(ABORT, 'registru numai adaugare'); END;
CREATE TRIGGER IF NOT EXISTS rxb_ledger_no_delete BEFORE DELETE ON rxb_ledger
BEGIN SELECT RAISE(ABORT, 'registru numai adaugare'); END;
"""

GENESIS = "0" * 64


def _canon(obj) -> str:
    def enc(o):
        if isinstance(o, Decimal):
            return str(o)
        raise TypeError(f"tip neserializabil în registru: {type(o).__name__}")
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=enc)


class LedgerKeyMissing(RuntimeError):
    pass


class Ledger:
    def __init__(self, path: str, key: bytes | None = None, key_id: str | None = None):
        self.path = path
        k = key if key is not None else os.environ.get("RXB_LEDGER_HMAC_KEY", "").encode()
        self.key = k or None
        self.key_id = key_id or os.environ.get("RXB_LEDGER_KEY_ID", "k1")
        self._lock = threading.Lock()
        if path != ":memory:":
            os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.executescript(SCHEMA)

    def _sign(self, body: str) -> str:
        return hmac.new(self.key, body.encode(), hashlib.sha256).hexdigest()

    @staticmethod
    def _body(r: dict) -> str:
        return _canon({k: r[k] for k in ("kind", "day", "hour", "route", "payload",
                                         "actor", "created_at", "key_id", "prev_hash")})

    def append(self, kind: str, day: str, payload: dict, actor: str,
               hour: int | None = None, route: str | None = None) -> dict:
        if not self.key:
            raise LedgerKeyMissing("RXB_LEDGER_HMAC_KEY lipsește: registrul refuză scrierea")
        with self._lock:
            last = self.db.execute("SELECT sig FROM rxb_ledger ORDER BY seq DESC LIMIT 1").fetchone()
            row = {"kind": kind, "day": day, "hour": hour, "route": route,
                   "payload": _canon(payload), "actor": actor,
                   "created_at": datetime.now(timezone.utc).isoformat(),
                   "key_id": self.key_id, "prev_hash": last[0] if last else GENESIS}
            row["sig"] = self._sign(self._body(row))
            cur = self.db.execute(
                "INSERT INTO rxb_ledger(kind,day,hour,route,payload,actor,created_at,key_id,prev_hash,sig)"
                " VALUES(?,?,?,?,?,?,?,?,?,?)",
                tuple(row[k] for k in ("kind", "day", "hour", "route", "payload", "actor",
                                       "created_at", "key_id", "prev_hash", "sig")))
            self.db.commit()
            row["seq"] = cur.lastrowid
            return row

    def rows(self, kind: str | None = None, day: str | None = None) -> list[dict]:
        q = "SELECT seq,kind,day,hour,route,payload,actor,created_at,key_id,prev_hash,sig FROM rxb_ledger"
        cond, args = [], []
        if kind:
            cond.append("kind=?"); args.append(kind)
        if day:
            cond.append("day=?"); args.append(day)
        if cond:
            q += " WHERE " + " AND ".join(cond)
        cols = ("seq", "kind", "day", "hour", "route", "payload", "actor", "created_at",
                "key_id", "prev_hash", "sig")
        return [dict(zip(cols, r)) for r in self.db.execute(q + " ORDER BY seq", args)]

    def verify(self) -> dict:
        if not self.key:
            return {"ok": False, "reason": "cheie lipsă"}
        prev = GENESIS
        for r in self.rows():
            if r["prev_hash"] != prev:
                return {"ok": False, "seq": r["seq"], "reason": "lanț rupt"}
            if not hmac.compare_digest(r["sig"], self._sign(self._body(r))):
                return {"ok": False, "seq": r["seq"], "reason": "semnătură invalidă"}
            prev = r["sig"]
        return {"ok": True, "rows": len(self.rows())}
