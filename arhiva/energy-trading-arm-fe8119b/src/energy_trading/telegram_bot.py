"""Telegram bot ingestion: the group posts, the agent ingests.

Add the bot to the trading group, point the webhook at
``POST /api/telegram/webhook``. Every ``.xlsx`` document and every text
message is parsed through the ops intake; the bot replies with what it
understood. Nothing is nominated from chat — only ingested and filed.

Security: requests must carry the ``X-Telegram-Bot-Api-Secret-Token``
header matching ``TELEGRAM_WEBHOOK_SECRET``; chats not in
``TELEGRAM_ALLOWED_CHATS`` (when set) are ignored.
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Callable
from datetime import UTC, datetime
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from pydantic import BaseModel, Field

from energy_trading.config import Settings
from energy_trading.ops_intake import (
    OpsIntake,
    parse_daily_note,
    read_table_ops,
    write_bids_csv,
)
from energy_trading.store import StateStore

log = logging.getLogger("energy_trading.telegram")

DAY_RE = re.compile(r"(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?")


class IngestResult(BaseModel):
    accepted: bool
    kind: str = Field(description="document | text | command | question | ignored")
    chat_id: str = ""
    day: str = ""
    intake: OpsIntake | None = None
    reply: str = ""


def infer_day(text: str, default: datetime) -> str:
    """Pull a dd.mm[.yyyy] date out of a caption/message, else use default."""
    m = DAY_RE.search(text or "")
    if not m:
        return default.date().isoformat()
    dd, mm, yy = m.group(1), m.group(2), m.group(3)
    year = default.year if not yy else int(yy) if len(yy) == 4 else 2000 + int(yy)
    try:
        return datetime(year, int(mm), int(dd), tzinfo=UTC).date().isoformat()
    except ValueError:
        return default.date().isoformat()


def sender_name(msg: dict, chat_id: str) -> str:
    """Human-readable author of a Telegram message, for the audit trail."""
    frm = msg.get("from") or {}
    name = " ".join(p for p in (frm.get("first_name"), frm.get("last_name")) if p).strip()
    if not name and frm.get("username"):
        name = "@" + frm["username"]
    return name or (msg.get("author_signature") or "") or f"telegram:{chat_id}"


def format_reply(intake: OpsIntake) -> str:
    lines = [f"📥 Ingerat pentru {intake.day or 'azi'}"]
    for d in intake.decisions:
        lines.append(f"🚫 {d}")
    atc = {
        k: v for k, v in intake.availability.items() if not any(k in d for d in intake.decisions)
    }
    if atc:
        lines.append("ATC: " + ", ".join(f"{k} {v:.0f} MW" for k, v in atc.items()))
    if intake.prices_override:
        n = sum(len(h) for h in intake.prices_override.values())
        lines.append(f"Prețuri: {n} valori pe {', '.join(intake.prices_override)}")
    for line in intake.position_summary():
        lines.append(f"📌 Poziție: {line}")
    if intake.bids and not intake.position_summary():
        lines.append("📌 Poziție: 0 MW pe toate coridoarele (nimic câștigat)")
    if intake.unassigned_prices:
        pts = ", ".join(f"h{h + 1}={p:.0f}" for h, p in sorted(intake.unassigned_prices.items()))
        lines.append(f"❓ Prețuri fără zonă ({pts}) — răspundeți cu piața: „RO”, „UA” sau „MD”")
    if not (
        intake.availability or intake.prices_override or intake.unassigned_prices or intake.bids
    ):
        lines.append("Nimic structurat recunoscut.")
    real_warnings = [w for w in intake.warnings if "fără zonă" not in w]
    if real_warnings:
        lines.append(f"⚠️ {len(real_warnings)} avertismente (prima: {real_warnings[0][:80]})")
    return "\n".join(lines)


class TelegramIngestor:
    def __init__(
        self,
        settings: Settings,
        store: StateStore,
        timeout: float = 15.0,
        operator: Callable[[str, str], str] | None = None,
    ):
        self.settings = settings
        self.store = store
        self.timeout = timeout
        self.operator = operator  # OperatorBot.handle — commands + free-text Q&A

    # -- Bot API -------------------------------------------------------
    def _api(self, method: str, **params) -> dict:
        url = f"https://api.telegram.org/bot{self.settings.telegram_bot_token}/{method}"
        body = urlencode(params).encode() if params else None
        with urlopen(Request(url, data=body), timeout=self.timeout) as resp:
            return json.loads(resp.read().decode())

    def download_document(self, file_id: str) -> bytes:
        info = self._api("getFile", file_id=file_id)
        path = info["result"]["file_path"]
        url = f"https://api.telegram.org/file/bot{self.settings.telegram_bot_token}/{path}"
        with urlopen(url, timeout=self.timeout) as resp:
            return resp.read()

    def reply(self, chat_id: str, text: str) -> None:
        if not self.settings.telegram_bot_token:
            return
        try:
            self._api("sendMessage", chat_id=chat_id, text=text[:4000])
        except (URLError, OSError, ValueError) as exc:
            log.warning("telegram reply failed: %s", exc)

    def set_webhook(self, public_url: str, commands: list[dict] | None = None) -> dict:
        result = self._api(
            "setWebhook",
            url=f"{public_url.rstrip('/')}/api/telegram/webhook",
            secret_token=self.settings.telegram_webhook_secret,
            allowed_updates=json.dumps(["message", "channel_post"]),
        )
        if commands:
            result["commands"] = self._api("setMyCommands", commands=json.dumps(commands))
        return result

    # -- update handling ----------------------------------------------
    def authorized(self, header_secret: str | None) -> bool:
        return (
            bool(self.settings.telegram_webhook_secret)
            and header_secret == self.settings.telegram_webhook_secret
        )

    def handle_update(self, update: dict, download=None) -> IngestResult:
        msg = update.get("message") or update.get("channel_post") or {}
        chat_id = str(msg.get("chat", {}).get("id", ""))
        who = sender_name(msg, chat_id)
        allowed = self.settings.telegram_allowed_chats
        if allowed and chat_id not in allowed:
            return IngestResult(
                accepted=False, kind="ignored", chat_id=chat_id, reply="chat neautorizat"
            )
        now = datetime.now(UTC)
        doc = msg.get("document")
        caption = msg.get("caption", "") or ""
        text = msg.get("text", "") or ""
        if doc and str(doc.get("file_name", "")).lower().endswith((".xlsx", ".xlsm", ".csv")):
            day = infer_day(caption + " " + doc.get("file_name", ""), now)
            fetch = download or self.download_document
            try:
                data = fetch(doc["file_id"])
            except (URLError, OSError, KeyError, ValueError) as exc:
                return IngestResult(
                    accepted=False,
                    kind="document",
                    chat_id=chat_id,
                    day=day,
                    reply=f"descărcare eșuată: {exc}",
                )
            intake = read_table_ops(data, doc.get("file_name", ""), day=day)
            self._file(chat_id, "document", doc.get("file_name", ""), intake)
            return IngestResult(
                accepted=True,
                kind="document",
                chat_id=chat_id,
                day=day,
                intake=intake,
                reply=format_reply(intake),
            )
        if text.startswith("/"):
            if not self.operator:
                return IngestResult(accepted=False, kind="ignored", chat_id=chat_id, reply="")
            reply = self.operator(text, who)
            self.store.append(
                "ingest", {"chat_id": chat_id, "kind": "command", "source": text[:80]}
            )
            return IngestResult(accepted=True, kind="command", chat_id=chat_id, reply=reply)
        if text:
            day = infer_day(text, now)
            intake = parse_daily_note(text, day=day)
            if not (intake.availability or intake.prices_override or intake.unassigned_prices):
                # Not ops data: an instruction/question for the operator bot, or plain chatter.
                if self.operator:
                    reply = self.operator(text, who)
                    if reply and not reply.startswith("Nu am găsit"):
                        return IngestResult(
                            accepted=True, kind="question", chat_id=chat_id, reply=reply
                        )
                return IngestResult(
                    accepted=False, kind="ignored", chat_id=chat_id, day=day, reply=""
                )
            self._file(chat_id, "text", text[:80], intake)
            return IngestResult(
                accepted=True,
                kind="text",
                chat_id=chat_id,
                day=day,
                intake=intake,
                reply=format_reply(intake),
            )
        return IngestResult(accepted=False, kind="ignored", chat_id=chat_id, reply="")

    def _file(self, chat_id: str, kind: str, source: str, intake: OpsIntake) -> None:
        self.store.append(
            "ingest",
            {
                "chat_id": chat_id,
                "kind": kind,
                "source": source,
                "day": intake.day,
                "availability": intake.availability,
                "decisions": intake.decisions,
                "price_points": sum(len(h) for h in intake.prices_override.values()),
                "position_rows": sum(len(h) for h in intake.bids.get("capacity", {}).values()),
                "warnings": len(intake.warnings),
            },
        )
        if intake.day and intake.bids:
            # Our position (won capacity, CBC, limits, fills, results) → the twin's input file.
            # The 24/7 watch sees the file change: today/tomorrow get a fresh hub run, a
            # delivered day gets its P/L Digital Twin recomputed with the real fills.
            written = write_bids_csv(
                self.settings.data_dir / f"bids_{intake.day}.csv", intake.bids, intake.day
            )
            log.info("position for %s → %s (%s rows)", intake.day, written["path"], written["rows"])
        self.store.save_brief(
            intake.day or "unknown",
            f"ingest_{kind}_{int(datetime.now(UTC).timestamp())}",
            intake.model_dump(),
        )
        if intake.day and (intake.availability or intake.prices_override):
            # Day overrides feed the scheduled hub_run: chat decisions beat the NTC file.
            current = self.store.load(f"briefs/{intake.day}_overrides") or {
                "availability": {},
                "prices": {},
                "decisions": [],
            }
            current["availability"].update(intake.availability)
            for zone, hours in intake.prices_override.items():
                current["prices"].setdefault(zone, {}).update({str(h): p for h, p in hours.items()})
            current["decisions"] = list(dict.fromkeys(current["decisions"] + intake.decisions))
            self.store.save_brief(intake.day, "overrides", current)
