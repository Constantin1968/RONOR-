"""File-backed persistence so the runtime survives restarts.

JSON-lines for append-only streams (claims, alerts, job runs), JSON for
snapshots (book, latest briefs). Kept deliberately simple: one directory,
human-readable, backup-able with ``cp -r``. Swap for a database when the
volume demands it — the interface is the seam.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


def _now() -> str:
    return datetime.now(UTC).isoformat()


class StateStore:
    def __init__(self, root: Path | str):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / "briefs").mkdir(exist_ok=True)

    # -- append-only streams -----------------------------------------
    def append(self, stream: str, record: dict[str, Any]) -> None:
        record = {"ts": _now(), **record}
        with (self.root / f"{stream}.jsonl").open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")

    def read(self, stream: str, limit: int | None = None) -> list[dict[str, Any]]:
        path = self.root / f"{stream}.jsonl"
        if not path.exists():
            return []
        lines = path.read_text(encoding="utf-8").splitlines()
        if limit:
            lines = lines[-limit:]
        return [json.loads(line) for line in lines if line.strip()]

    # -- snapshots ------------------------------------------------------
    def save(self, name: str, payload: Any) -> Path:
        path = self.root / f"{name}.json"
        path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2, default=str), encoding="utf-8"
        )
        return path

    def load(self, name: str, default: Any = None) -> Any:
        path = self.root / f"{name}.json"
        if not path.exists():
            return default
        return json.loads(path.read_text(encoding="utf-8"))

    def save_brief(self, day: str, kind: str, payload: Any) -> Path:
        path = self.root / "briefs" / f"{day}_{kind}.json"
        path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2, default=str), encoding="utf-8"
        )
        return path

    def list_briefs(self, day: str | None = None) -> list[str]:
        files = sorted((self.root / "briefs").glob(f"{day or '*'}_*.json"))
        return [f.name for f in files]
