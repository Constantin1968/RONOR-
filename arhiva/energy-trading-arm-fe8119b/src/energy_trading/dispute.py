"""Trainer / operator dispute channel — RONOR extension over v0.2.0.

Muse's v0.2.0 sandbox has no dispute concept. Feedback there is either a
structured position update (``/api/ops-upload``, which writes ``bids_<day>.csv``
via ``write_bids_csv``) or a free-form note (``/api/ops-parse``, which flows
through ``parse_daily_note``). Neither is right for a contest of a specific
proposed / settled trade: the intake parser is deliberately aggressive on
borders / MW / prices / hours, so a natural-language dispute
("coridorul RO->UA la ora 14 e greșit, real e HU->RO la 15") would produce
phantom availability / prices / overrides for the day before anyone noticed.

The dispute file is therefore its own channel:

- Append-only ``disputes_<day>.jsonl`` under ``data/``. One JSON object per
  line, never rewritten. Corrections are new lines against the same
  ``ticket_id`` / ``trade_id``.
- Structured ``corrective_action`` (optional) is what materialises into
  ``bids_<day>.csv`` via the existing ``write_bids_csv``, so the twin picks
  the corrected day up on the next ``watch`` tick.
- Free-text ``reason`` never touches ``ops_intake`` regexes; it lives in the
  jsonl only, as evidence of why a bids row was corrected.

Prepared by AMB · Mayleven Ecosystem.
"""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field, field_validator

from energy_trading.config import settings
from energy_trading.ops_intake import write_bids_csv

# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

_DAY_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class CorrectiveAction(BaseModel):
    """Structured, machine-applyable correction. All fields optional; whichever
    are present are merged into ``bids_<day>.csv`` via ``write_bids_csv``.

    The keys map 1:1 to ``write_bids_csv``'s expected shape
    (``capacity`` / ``cbc`` / ``limits`` / ``filled`` / ``realized`` →
    corridor → hour → value).
    """

    capacity: dict[str, dict[int, float]] | None = None
    cbc: dict[str, dict[int, float]] | None = None
    limits: dict[str, dict[int, float]] | None = None
    filled: dict[str, dict[int, float]] | None = None
    realized: dict[str, dict[int, float]] | None = None

    def to_bids_dict(self) -> dict[str, dict[str, dict[int, float]]]:
        out: dict[str, dict[str, dict[int, float]]] = {}
        for kind in ("capacity", "cbc", "limits", "filled", "realized"):
            v = getattr(self, kind)
            if v:
                out[kind] = v
        return out


class DisputeRequest(BaseModel):
    """Payload for POST /api/dispute.

    ``ticket_id`` is the RONOR-side ticket (e.g. ``run-2026-09-15-abc``). It is
    always required so the dispute is bound to a concrete session/proposal.
    ``trade_id`` is optional — a dispute may contest an entire session
    ('this whole day's proposals are wrong because...') or a specific trade.
    """

    ticket_id: str = Field(min_length=1, max_length=200)
    trade_id: str | None = Field(default=None, max_length=200)
    day: str = Field(description="ISO date the dispute is against")
    reason: str = Field(min_length=1, max_length=8000)
    corrective_action: CorrectiveAction | None = None

    @field_validator("day")
    @classmethod
    def _iso_day(cls, v: str) -> str:
        if not _DAY_ISO.match(v):
            raise ValueError("day must be YYYY-MM-DD")
        # Sanity: also parse it, so 2026-02-30 is rejected.
        datetime.fromisoformat(v)
        return v


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------


def _disputes_path(day: str) -> Path:
    return Path(settings.data_dir) / f"disputes_{day}.jsonl"


def _bids_path(day: str) -> Path:
    return Path(settings.data_dir) / f"bids_{day}.csv"


def append_dispute(req: DisputeRequest, actor: str) -> dict[str, Any]:
    """Record a dispute. Returns a summary dict for the HTTP response.

    Two side-effects:
      1. Append one line to ``disputes_<day>.jsonl``.
      2. If a structured ``corrective_action`` is present, merge it into
         ``bids_<day>.csv`` so ``watch`` re-runs the day.

    Order matters: the jsonl is written FIRST. If the bids merge fails, the
    dispute is still recorded (never lose the audit trail); the caller sees
    the error in the response.
    """
    now = datetime.now(UTC).isoformat()
    record: dict[str, Any] = {
        "recorded_at": now,
        "actor": actor,
        "ticket_id": req.ticket_id,
        "trade_id": req.trade_id,
        "day": req.day,
        "reason": req.reason,
        "corrective_action": (
            req.corrective_action.model_dump(exclude_none=True)
            if req.corrective_action is not None
            else None
        ),
    }

    path = _disputes_path(req.day)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")

    materialised: dict[str, Any] | None = None
    if req.corrective_action is not None:
        bids = req.corrective_action.to_bids_dict()
        if bids:
            materialised = write_bids_csv(_bids_path(req.day), bids, req.day)

    return {
        "recorded": True,
        "day": req.day,
        "ticket_id": req.ticket_id,
        "trade_id": req.trade_id,
        "actor": actor,
        "recorded_at": now,
        "jsonl_path": str(path),
        "materialised": materialised,
    }


def list_disputes(day: str | None = None) -> dict[str, Any]:
    """List disputes; optionally filtered to one day.

    Read-only. Never rewrites the jsonl.
    """
    root = Path(settings.data_dir)
    pattern = f"disputes_{day}.jsonl" if day else "disputes_*.jsonl"
    entries: list[dict[str, Any]] = []
    for p in sorted(root.glob(pattern)):
        try:
            with open(p, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entries.append(json.loads(line))
                    except json.JSONDecodeError:
                        # Skip corrupt line but keep going; do NOT silently drop file.
                        entries.append({"_corrupt_line": line, "_file": p.name})
        except OSError:
            continue
    return {"count": len(entries), "disputes": entries}
