"""Threshold alerting + notification channels.

Rules are pure functions over run outputs; the notifier is the only
side-effecting piece and never raises into the trading pipeline.
"""

from __future__ import annotations

import json
import logging
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from pydantic import BaseModel, Field

from energy_trading.config import Settings

log = logging.getLogger("energy_trading.alerts")


class Alert(BaseModel):
    level: str = Field(description="info | warning | critical")
    rule: str
    message: str
    context: dict = Field(default_factory=dict)


def rules_from_sovereignty(balance: dict, limit: float) -> list[Alert]:
    out: list[Alert] = []
    total = sum(balance.get("per_border_mw", {}).values()) or 0.0
    for border, mw in balance.get("per_border_mw", {}).items():
        if total and mw / total > limit:
            out.append(
                Alert(
                    level="warning",
                    rule="concentration",
                    message=f"{border} concentrează {mw / total:.0%} din volum (limita {limit:.0%})",
                    context={"border": border, "share": round(mw / total, 3)},
                )
            )
    if balance.get("net_mw", 0) < 0:
        out.append(
            Alert(
                level="info",
                rule="net_importer",
                message=f"{balance.get('home_zone')} importator net: {abs(balance['net_mw']):.0f} MW",
                context={"net_mw": balance["net_mw"]},
            )
        )
    return out


def _hour_ranges(hours: list[int]) -> str:
    if not hours:
        return "nicio oră utilă"
    ranges, start, prev = [], hours[0], hours[0]
    for h in hours[1:]:
        if h != prev + 1:
            ranges.append((start, prev))
            start = h
        prev = h
    ranges.append((start, prev))
    return "ferestre utile: " + ", ".join(
        f"{a:02d}" if a == b else f"{a:02d}–{b:02d}" for a, b in ranges
    )


def rules_from_ntc(
    availability: dict,
    min_atc_mw: float,
    previous: dict | None = None,
    drop_share: float = 0.6,
) -> list[Alert]:
    """Thin CBC (most hours under ``min_atc_mw``) or a sharp drop vs the previous NTC day."""
    out: list[Alert] = []
    for border, hours in sorted(availability.items()):
        if not isinstance(hours, dict) or not hours:
            continue
        vals = list(hours.values())
        mean = sum(vals) / len(vals)
        thin = sum(1 for v in vals if v < min_atc_mw)
        usable = [h for h, v in sorted(hours.items()) if v >= min_atc_mw]
        prev_hours = (previous or {}).get(border)
        prev_mean = (
            sum(prev_hours.values()) / len(prev_hours)
            if isinstance(prev_hours, dict) and prev_hours
            else None
        )
        dropped = prev_mean is not None and prev_mean > 0 and mean <= prev_mean * (1 - drop_share)
        if thin < len(vals) / 2 and not dropped:
            continue
        why = []
        if thin >= len(vals) / 2:
            why.append(f"{thin}/{len(vals)} ore sub {min_atc_mw:.0f} MW")
        if dropped:
            why.append(
                f"medie {prev_mean:.0f}→{mean:.0f} MW față de ziua precedentă "
                f"({mean / prev_mean - 1:+.0%})"
            )
        out.append(
            Alert(
                level="warning",
                rule="thin_cbc",
                message=(
                    f"{border}: CBC subțire — {'; '.join(why)}; {_hour_ranges(usable)}. "
                    "Recomandare: skip sau doar ferestrele utile."
                ),
                context={
                    "border": border,
                    "mean_mw": round(mean, 1),
                    "prev_mean_mw": round(prev_mean, 1) if prev_mean is not None else None,
                    "thin_hours": thin,
                    "usable_hours": usable,
                },
            )
        )
    return out


def rules_from_hub(snapshot: dict, basis_threshold: float) -> list[Alert]:
    """One alert per zone: how many hours breach the basis threshold, and the widest."""
    out: list[Alert] = []
    by_zone: dict[str, list[dict]] = {}
    for b in snapshot.get("basis", []):
        if abs(b.get("basis", 0.0)) >= basis_threshold and b.get("direction") != "flat":
            by_zone.setdefault(b["zone"], []).append(b)
    for zone, hits in by_zone.items():
        widest = max(hits, key=lambda x: abs(x["basis"]))
        hours = ", ".join(f"{h['hour']:02d}" for h in sorted(hits, key=lambda x: x["hour"])[:8])
        more = f" (+{len(hits) - 8})" if len(hits) > 8 else ""
        out.append(
            Alert(
                level="info",
                rule="wide_basis",
                message=(
                    f"{zone}: {len(hits)} ore cu basis ≥ {basis_threshold:.0f} €/MWh vs RO, "
                    f"max {widest['basis']:+.2f} la ora {widest['hour']:02d} "
                    f"({widest['direction']}, {widest['capacity_mw']:.0f} MW); ore: {hours}{more}"
                ),
                context={"zone": zone, "hours": len(hits), "widest": widest},
            )
        )
    best = snapshot.get("summary", {}).get("best_wheel")
    if best:
        out.append(
            Alert(
                level="info",
                rule="best_wheel",
                message=(
                    f"Wheeling {best['from_zone']}→RO→{best['to_zone']} ora {best['hour']:02d}: "
                    f"net {best['net_spread']:.2f} €/MWh × {best['capacity_mw']:.0f} MW"
                ),
                context=best,
            )
        )
    return out


def rules_from_weather(brief: dict) -> list[Alert]:
    out: list[Alert] = []
    for country, cf in brief.get("countries", {}).items():
        if cf.get("status") == "error":
            out.append(
                Alert(
                    level="warning",
                    rule="weather_worker_error",
                    message=f"Worker meteo {country} a eșuat: {cf.get('error', '')[:80]}",
                    context={"country": country},
                )
            )
    for note in brief.get("hub_read", []):
        out.append(Alert(level="info", rule="weather_hub_read", message=note))
    return out


class TelegramNotifier:
    """Send alerts to a Telegram chat via Bot API. No-op when unconfigured."""

    def __init__(self, settings: Settings, timeout: float = 10.0):
        self.token = settings.telegram_bot_token
        self.chat_id = settings.telegram_chat_id
        self.timeout = timeout

    @property
    def enabled(self) -> bool:
        return bool(self.token and self.chat_id)

    def send(self, text: str) -> bool:
        if not self.enabled:
            log.info("telegram disabled; message: %s", text[:120])
            return False
        url = f"https://api.telegram.org/bot{self.token}/sendMessage"
        body = urlencode({"chat_id": self.chat_id, "text": text[:4000]}).encode()
        try:
            with urlopen(Request(url, data=body), timeout=self.timeout) as resp:
                return json.loads(resp.read().decode()).get("ok", False)
        except (URLError, OSError, ValueError) as exc:
            log.warning("telegram send failed: %s", exc)
            return False

    def send_alerts(self, title: str, alerts: list[Alert], max_lines: int = 12) -> bool:
        if not alerts:
            return False
        icons = {"critical": "🔴", "warning": "🟠", "info": "🔵"}
        lines = [f"{icons.get(a.level, '•')} {a.message}" for a in alerts[:max_lines]]
        if len(alerts) > max_lines:
            lines.append(f"… +{len(alerts) - max_lines} alerte")
        return self.send(f"⚡ {title}\n" + "\n".join(lines))
