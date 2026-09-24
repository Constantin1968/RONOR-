"""Runtime configuration from environment variables (12-factor).

Every secret comes from the environment — never from code or the repo.
Copy ``.env.example`` to ``.env`` for local runs.
"""

from __future__ import annotations

import os
from pathlib import Path

from pydantic import BaseModel, Field


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    return default if raw is None else raw.strip().lower() in ("1", "true", "yes", "on")


class Settings(BaseModel):
    data_dir: Path = Field(default_factory=lambda: Path(os.getenv("ET_DATA_DIR", "data")))
    state_dir: Path = Field(default_factory=lambda: Path(os.getenv("ET_STATE_DIR", "state")))
    home_zone: str = Field(default_factory=lambda: os.getenv("ET_HOME_ZONE", "RO"))
    timezone: str = Field(default_factory=lambda: os.getenv("ET_TIMEZONE", "Europe/Bucharest"))

    scheduler_enabled: bool = Field(
        default_factory=lambda: _env_bool("ET_SCHEDULER_ENABLED", False)
    )
    weather_hour: int = Field(default_factory=lambda: int(os.getenv("ET_WEATHER_HOUR", "6")))
    hub_run_hour: int = Field(default_factory=lambda: int(os.getenv("ET_HUB_RUN_HOUR", "9")))
    evening_hour: int = Field(default_factory=lambda: int(os.getenv("ET_EVENING_HOUR", "18")))

    # 24/7 watch: new inputs are picked up within ET_WATCH_MINUTES, delivered hours are
    # settled every ET_SETTLE_MINUTES, and pending proposals trigger reminders before the
    # day-ahead gate closes (local time; SDAC 12:00 CET = 13:00 in Bucharest).
    watch_minutes: int = Field(default_factory=lambda: int(os.getenv("ET_WATCH_MINUTES", "1")))
    settle_minutes: int = Field(default_factory=lambda: int(os.getenv("ET_SETTLE_MINUTES", "60")))
    gate_closure: str = Field(default_factory=lambda: os.getenv("ET_GATE_CLOSURE", "13:00"))
    gate_reminders: list[int] = Field(
        default_factory=lambda: [
            int(x) for x in os.getenv("ET_GATE_REMINDERS", "60,15").split(",") if x.strip()
        ]
    )
    retry_minutes: int = Field(default_factory=lambda: int(os.getenv("ET_RETRY_MINUTES", "10")))
    max_retries: int = Field(default_factory=lambda: int(os.getenv("ET_MAX_RETRIES", "3")))
    heartbeat_minutes: int = Field(
        default_factory=lambda: int(os.getenv("ET_HEARTBEAT_MINUTES", "60"))
    )
    # Digital twin: published prices are pulled from OPCOM/OREE every ET_FETCH_MINUTES
    # (0 disables) and the P/L report for the delivered day is sent at ET_PNL_HOUR.
    fetch_minutes: int = Field(default_factory=lambda: int(os.getenv("ET_FETCH_MINUTES", "15")))
    pnl_hour: int = Field(default_factory=lambda: int(os.getenv("ET_PNL_HOUR", "7")))

    telegram_bot_token: str = Field(default_factory=lambda: os.getenv("TELEGRAM_BOT_TOKEN", ""))
    telegram_chat_id: str = Field(default_factory=lambda: os.getenv("TELEGRAM_CHAT_ID", ""))
    telegram_webhook_secret: str = Field(
        default_factory=lambda: os.getenv("TELEGRAM_WEBHOOK_SECRET", "")
    )
    telegram_allowed_chats: list[str] = Field(
        default_factory=lambda: [
            c.strip() for c in os.getenv("TELEGRAM_ALLOWED_CHATS", "").split(",") if c.strip()
        ]
    )

    alert_concentration_limit: float = Field(
        default_factory=lambda: float(os.getenv("ET_ALERT_CONCENTRATION", "0.6"))
    )
    alert_basis_eur_mwh: float = Field(
        default_factory=lambda: float(os.getenv("ET_ALERT_BASIS_EUR", "40"))
    )
    alert_min_atc_mw: float = Field(
        default_factory=lambda: float(os.getenv("ET_ALERT_MIN_ATC_MW", "50"))
    )

    # Sovereign LLM (Ollama on the RONOR node). Empty URL = keyword answers only.
    ollama_url: str = Field(default_factory=lambda: os.getenv("OLLAMA_URL", "").rstrip("/"))
    ollama_model: str = Field(default_factory=lambda: os.getenv("OLLAMA_MODEL", "qwen2.5"))
    ollama_timeout: float = Field(default_factory=lambda: float(os.getenv("OLLAMA_TIMEOUT", "60")))

    # Shared secret for machine-to-machine calls from the RONOR dispatcher
    # (/api/operator, /api/ops-upload). Empty = open (local/dev only).
    api_token: str = Field(default_factory=lambda: os.getenv("ET_API_TOKEN", ""))
    # Where the dashboard lives, for links in chat replies.
    public_url: str = Field(default_factory=lambda: os.getenv("ET_PUBLIC_URL", "").rstrip("/"))

    @property
    def telegram_enabled(self) -> bool:
        return bool(self.telegram_bot_token and self.telegram_chat_id)


settings = Settings()
