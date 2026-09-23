"""Local liveness only; no model call or Telegram message."""
import os
from pathlib import Path
import time

heartbeat = Path(os.getenv("RONOR_HEARTBEAT", "/var/lib/ronor-bot/heartbeat"))
try:
    fresh = 0 <= time.time() - float(heartbeat.read_text()) < 100
except (OSError, ValueError):
    fresh = False
raise SystemExit(0 if fresh else 1)
