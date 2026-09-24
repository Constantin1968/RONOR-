"""Drop-in energy module for the RONOR dispatcher.

Copy this file next to your dispatcher and route Telegram messages through
``EnergyModule.handle``.  It returns the reply text, or ``None`` when the
message is not about energy (leave it to the other modules).

    energy = EnergyModule("http://energy:8000", token=os.environ["ET_API_TOKEN"],
                          trading_chats={"-1001234567890"})

    def on_message(msg):
        reply = energy.handle(msg, download_file=telegram_download)
        if reply is not None:
            send(msg["chat"]["id"], reply)

Only the standard library is used, so it can live in any container.
"""

from __future__ import annotations

import json
import mimetypes
import re
import uuid
from collections.abc import Callable
from urllib.request import Request, urlopen

ENERGY_COMMANDS = {
    "azi", "maine", "autorizez", "activeaza", "opreste", "dashboard", "ajutor", "status", "hub",
    "ntc", "meteo", "granite", "propuneri", "book", "nomineaza", "deconteaza", "suveranitate",
    "alerte", "claims", "doctrina",
}  # fmt: skip

ENERGY_WORDS = re.compile(
    r"\b(ro[-/ ]?ua|ua[-/ ]?ro|ua[-/ ]?md|md[-/ ]?ua|ro[-/ ]?md|md[-/ ]?ro|ntc|atc|cbc|mwh?|"
    r"eur/mwh|interval|nominal|autoriz|granit|capacit|pre[țt]uri|energie|hub|basis|"
    r"opcom|entso|transelectrica|ukrenergo|moldelectrica|xb-\d+|skip)\b",
    re.IGNORECASE,
)

DAY_RE = re.compile(r"\b(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\b")


def looks_like_energy(text: str) -> bool:
    return bool(text and ENERGY_WORDS.search(text))


def infer_day(text: str, default: str = "") -> str:
    """'NTC 14.09' → '2026-09-14' (year from today when missing)."""
    from datetime import UTC, datetime

    m = DAY_RE.search(text or "")
    if not m:
        return default
    d, mo, y = int(m.group(1)), int(m.group(2)), m.group(3)
    this_year = datetime.now(UTC).year
    year = int(y) if y and len(y) == 4 else (2000 + int(y) if y else this_year)
    try:
        from datetime import date

        return date(year, mo, d).isoformat()
    except ValueError:
        return default


class EnergyModule:
    def __init__(
        self,
        api_url: str,
        token: str = "",
        trading_chats: set[str] | None = None,
        brain: str = "ronor",
        timeout: float = 120.0,
    ):
        """``brain``: 'ronor' (Ollama + tools, /api/ronor) or 'operator' (deterministic)."""
        self.api_url = api_url.rstrip("/")
        self.token = token
        self.trading_chats = {str(c) for c in (trading_chats or set())}
        self.endpoint = "/api/ronor" if brain == "ronor" else "/api/operator"
        self.timeout = timeout

    # -- routing -----------------------------------------------------------
    def wants(self, msg: dict) -> bool:
        chat_id = str(msg.get("chat", {}).get("id", ""))
        text = msg.get("text") or msg.get("caption") or ""
        doc = msg.get("document") or {}
        if doc.get("file_name", "").lower().endswith((".xlsx", ".xlsm")):
            return True
        if chat_id in self.trading_chats:
            return True
        if text.startswith("/"):
            return text[1:].split("@")[0].split()[0].lower() in ENERGY_COMMANDS
        return looks_like_energy(text)

    def handle(self, msg: dict, download_file: Callable[[str], bytes] | None = None) -> str | None:
        if not self.wants(msg):
            return None
        chat_id = str(msg.get("chat", {}).get("id", ""))
        text = msg.get("text") or msg.get("caption") or ""
        frm = msg.get("from") or {}
        who = " ".join(p for p in (frm.get("first_name"), frm.get("last_name")) if p) or (
            f"@{frm['username']}" if frm.get("username") else f"telegram:{chat_id}"
        )
        doc = msg.get("document") or {}
        if doc.get("file_name", "").lower().endswith((".xlsx", ".xlsm")) and download_file:
            data = download_file(doc["file_id"])
            return self.upload_excel(doc["file_name"], data, infer_day(text))
        body = self._post(self.endpoint, {"text": text, "chat_id": chat_id, "who": who})
        if body.get("reply"):
            return body["reply"]
        return None if body.get("kind") == "ignored" else "(modulul de energie nu a răspuns)"

    # -- transport -----------------------------------------------------------
    def _headers(self, extra: dict | None = None) -> dict:
        h = dict(extra or {})
        if self.token:
            h["X-RONOR-Token"] = self.token
        return h

    def _post(self, path: str, payload: dict) -> dict:
        req = Request(
            f"{self.api_url}{path}",
            data=json.dumps(payload).encode(),
            headers=self._headers({"Content-Type": "application/json"}),
        )
        with urlopen(req, timeout=self.timeout) as resp:
            return json.loads(resp.read().decode())

    def upload_excel(self, filename: str, data: bytes, day: str) -> str:
        boundary = uuid.uuid4().hex
        ctype = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        body = (
            (
                f'--{boundary}\r\nContent-Disposition: form-data; name="file"; '
                f'filename="{filename}"\r\nContent-Type: {ctype}\r\n\r\n'
            ).encode()
            + data
            + f"\r\n--{boundary}--\r\n".encode()
        )
        url = f"{self.api_url}/api/ops-upload" + (f"?day={day}" if day else "")
        req = Request(
            url,
            data=body,
            headers=self._headers({"Content-Type": f"multipart/form-data; boundary={boundary}"}),
        )
        with urlopen(req, timeout=self.timeout) as resp:
            out = json.loads(resp.read().decode())
        return out.get("reply") or out.get("summary") or json.dumps(out, ensure_ascii=False)[:1500]
