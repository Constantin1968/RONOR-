"""The 24/7 runner: the part that works while nobody is typing.

Daily jobs, each idempotent per day and filed in the claims register:

- ``weather``  (06:00) — parallel workers → regional brief → alerts
- ``pnl``      (07:00) — P/L Digital Twin for yesterday: operator vs twin vs
                          hindsight at the published clearing prices → one message
- ``hub_run``  (09:00) — hub basis + agent run on the latest NTC/prices
                          for the *next* delivery day → one daily brief
- ``evening``  (18:00) — sovereignty/P&L recap of the book → alerts

Missed daily jobs (service down at the hour) run as soon as it is back.

Continuous duties, between the daily jobs:

- ``fetch``    (every 15 min) — published clearing prices for today/tomorrow
                (OPCOM PZU for RO, OREE DAM + NBU rate for UA) → ``data/prices_*.csv``;
                hand-typed values are verified once and corrected when they differ
- ``watch``    (every N min) — any new/changed input (``data/ntc_*.csv``,
                ``data/prices_*.csv``, ``data/bids_*.csv``, chat overrides) → the affected day is
                recomputed at once and the brief re-sent with the reason
- ``settle``   (hourly) — nominated trades whose delivery hour has passed are
                settled; realised P&L reported when something settled
- ``gate``     (every tick) — pending proposals for tomorrow + day-ahead gate
                closing in ≤60 / ≤15 min → reminder to the operator
- ``heartbeat``(hourly) — liveness record; a long gap is reported on restart
- retries      — a failed job is retried every ET_RETRY_MINUTES, up to
                ET_MAX_RETRIES, then escalated once

Pure stdlib (threading), no external scheduler dependency. Jobs are also
callable on demand via ``JobRunner.run(name)`` and ``POST /api/jobs/{name}``.
Nominations are never automated: the runner proposes, humans nominate.
"""

from __future__ import annotations

import hashlib
import logging
import re
import threading
import time
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import ClassVar
from zoneinfo import ZoneInfo

from energy_trading.agent import CrossBorderAgent
from energy_trading.alerts import (
    Alert,
    TelegramNotifier,
    rules_from_hub,
    rules_from_ntc,
    rules_from_sovereignty,
    rules_from_weather,
)
from energy_trading.config import Settings
from energy_trading.hub import hub_snapshot, load_prices_csv
from energy_trading.interconnectors import INTERCONNECTORS, corridor_ic
from energy_trading.ops_intake import OverrideProvider, load_bids_csv, load_ntc_csv
from energy_trading.sources import FETCHERS, SourceUnavailable, merge_prices, missing_hours
from energy_trading.sovereignty import EVIDENCE_OPERATOR, EVIDENCE_PUBLISHED, EVIDENCE_SIMULATED
from energy_trading.store import StateStore
from energy_trading.twin_pnl import day_pnl, format_pnl, month_to_date
from energy_trading.weather import WeatherOrchestrator

log = logging.getLogger("energy_trading.scheduler")
_DAY_IN_NAME = re.compile(r"(\d{4}-\d{2}-\d{2})")
EAST = {"RO", "UA", "MD"}


def apply_won_capacity(availability: dict, won: dict) -> dict[str, dict[int, float]]:
    """Replace the eastern NTC view with the capacity we actually hold.

    NTC is what the TSO offered; the auction result is our position. Every eastern
    border/hour not in the result is 0 — no capacity, no bid. Returns the
    capacity applied (corridor → hour → MW), for the brief.
    """
    held = won.get("capacity", {})
    applied: dict[str, dict[int, float]] = {}
    for ic in INTERCONNECTORS:
        if not {ic.from_zone, ic.to_zone} <= EAST:
            continue
        keys = (
            [ic.id]
            if ic.id.count("-") >= 2
            else [
                f"{ic.from_zone}-{ic.to_zone}",
                f"{ic.to_zone}-{ic.from_zone}",
            ]
        )
        for key in keys:
            hours = held.get(key, {})
            availability[key] = {h: float(hours.get(h, 0.0)) for h in range(24)}
            if any(hours.values()):
                applied[key] = {h: mw for h, mw in sorted(hours.items()) if mw}
    return applied


def bid_limits(won: dict, prices: dict[str, dict[int, float]], min_spread: float) -> list[dict]:
    """The number the operator needs before the gate: the energy-leg limit price.

    For each corridor-hour with capacity, when exactly one end has a known price:
    buy-side limit ``(P_to − tariff − cbc − spread) / (1 + loss)`` when the source is
    unknown, sell-side limit ``P_from·(1 + loss) + tariff + cbc + spread`` when the
    sink is unknown. The operator's own limit (if filed) sits next to it.
    """
    out: list[dict] = []
    for corridor, hours in won.get("capacity", {}).items():
        ic, src, dst = corridor_ic(corridor)
        if ic is None:
            continue
        for hour, mw in sorted(hours.items()):
            if not mw:
                continue
            p_src, p_dst = prices.get(src, {}).get(hour), prices.get(dst, {}).get(hour)
            cbc = won.get("cbc", {}).get(corridor, {}).get(hour, 0.0)
            loss = 1 + ic.loss_pct / 100.0
            if p_dst is not None and p_src is None:
                side, known, zone = "buy", p_dst, src
                limit = (p_dst - ic.tariff_eur_mwh - cbc - min_spread) / loss
            elif p_src is not None and p_dst is None:
                side, known, zone = "sell", p_src, dst
                limit = p_src * loss + ic.tariff_eur_mwh + cbc + min_spread
            else:
                continue
            out.append(
                {
                    "corridor": corridor,
                    "hour": hour,
                    "interval": hour + 1,
                    "mw": mw,
                    "side": side,
                    "zone": zone,
                    "known_price": round(known, 2),
                    "cbc": cbc,
                    "model_limit": round(limit, 2),
                    "operator_limit": won.get("limits", {}).get(corridor, {}).get(hour),
                }
            )
    return out


def implied_cost_models(limits: list[dict]) -> dict[str, dict]:
    """What the operator's own limits say about their all-in cost per corridor.

    Least-squares fit ``operator_limit ≈ a·known_price + b`` over the filed limits;
    for a buy-side limit that reads as a proportional cost ``1 − a`` and a fixed cost
    ``−b`` €/MWh, for a sell-side limit ``a − 1`` and ``b``. This is the twin's
    calibration signal: the gap between it and the tariff/loss table is real cost
    the model does not know about yet.
    """
    by_corr: dict[str, list[dict]] = {}
    for r in limits:
        if r.get("operator_limit") is not None:
            by_corr.setdefault(r["corridor"], []).append(r)
    out: dict[str, dict] = {}
    for corridor, recs in by_corr.items():
        xs = [r["known_price"] for r in recs]
        ys = [r["operator_limit"] for r in recs]
        n = len(recs)
        if n < 3 or max(xs) == min(xs):
            continue
        mx, my = sum(xs) / n, sum(ys) / n
        sxx = sum((x - mx) ** 2 for x in xs)
        a = sum((x - mx) * (y - my) for x, y in zip(xs, ys, strict=True)) / sxx
        b = my - a * mx
        err = max(abs(a * x + b - y) for x, y in zip(xs, ys, strict=True))
        buy = recs[0]["side"] == "buy"
        ic, _, _ = corridor_ic(corridor)
        out[corridor] = {
            "side": recs[0]["side"],
            "points": n,
            "slope": round(a, 4),
            "intercept": round(b, 2),
            "max_abs_error": round(err, 2),
            "implied_proportional_pct": round((1 - a) * 100 if buy else (a - 1) * 100, 2),
            "implied_fixed_eur_mwh": round(-b if buy else b, 2),
            "model_loss_pct": ic.loss_pct if ic else None,
            "model_tariff_eur_mwh": ic.tariff_eur_mwh if ic else None,
        }
    return out


def _won_lines(result: dict) -> list[str]:
    """Brief lines for the auction result: what we hold and what to bid."""
    lines: list[str] = []
    won = result.get("won_capacity") or {}
    if not won:
        return lines
    parts = []
    for corridor, hours in won.items():
        mws = sorted({float(v) for v in hours.values()})
        mw_txt = f"{mws[0]:.0f}" if len(mws) == 1 else f"{mws[0]:.0f}–{mws[-1]:.0f}"
        parts.append(f"{corridor} {mw_txt} MW int {_ranges(sorted(int(h) + 1 for h in hours))}")
    lines.append("🎟 capacitate câștigată: " + "; ".join(parts) + " — restul Est = 0")
    by_corr: dict[str, list[dict]] = {}
    for rec in result.get("bid_limits") or []:
        by_corr.setdefault(rec["corridor"], []).append(rec)
    for corridor, recs in by_corr.items():
        side = "cumpără în" if recs[0]["side"] == "buy" else "vinde în"
        limits = [r["model_limit"] for r in recs]
        txt = (
            f"🎯 {corridor}: {side} {recs[0]['zone']} "
            f"{'sub' if recs[0]['side'] == 'buy' else 'peste'} "
            f"{min(limits):.0f}–{max(limits):.0f} €/MWh (model, {len(recs)}h"
        )
        ops = [
            (r["model_limit"], r["operator_limit"]) for r in recs if r["operator_limit"] is not None
        ]
        if ops:
            delta = sum(o - m for m, o in ops) / len(ops)
            txt += f"; operator {min(o for _, o in ops):.0f}–{max(o for _, o in ops):.0f}, Δ {delta:+.1f} față de model"
        lines.append(txt + ")")
    for corridor, m in (result.get("implied_costs") or {}).items():
        lines.append(
            f"📐 {corridor}: operatorul ofertează ≈ {m['slope']:.3f}×preț {m['intercept']:+.1f} "
            f"→ cost all-in ~{m['implied_proportional_pct']:.1f}% + {m['implied_fixed_eur_mwh']:.1f} €/MWh "
            f"(model: {m['model_loss_pct']}% + {m['model_tariff_eur_mwh']} €/MWh + CBC)"
        )
    for zone in result.get("missing_price_zones") or []:
        lines.append(
            f"⏳ {zone} fără preț pentru zi — propunerile pe coridoarele cu {zone} apar când intră prețul"
        )
    return lines


def daily_brief(result: dict, book: list) -> str:
    """The whole day in one message: what's closed, what's thin, what to do."""
    day = result["day"]
    real = result["evidence"] == EVIDENCE_OPERATOR
    cov = result.get("price_coverage") or {}
    src = result.get("sources") or {}
    cov_txt = (
        ", ".join(
            f"{z} {n}h" + (f" {src[z].split(' ')[0]}" if src.get(z) else "")
            for z, n in sorted(cov.items())
        )
        if cov
        else ""
    )
    lines = [
        f"📅 {day} — "
        + (
            f"prețuri reale ({cov_txt}); orele fără preț nu se tranzacționează"
            if real
            else "prețuri simulate, trimiteți prețurile zilei"
        )
    ]
    for b in result.get("no_ntc_borders", []):
        lines.append(f"⛔ {b}: fără NTC publicat pentru zi → netranzacționat")
    lines += _won_lines(result)
    decided = {d.split(" ")[0] for d in result.get("decisions", [])}
    closed, thin = [], []
    for a in result.get("alerts", []):
        # Once the auction is decided, the NTC view of thin borders is history.
        if (
            a["rule"] != "thin_cbc"
            or a["context"]["border"] in decided
            or result.get("won_capacity")
        ):
            continue
        border, usable = a["context"]["border"], a["context"]["usable_hours"]
        (thin if usable else closed).append((border, usable))
    for d in result.get("decisions", []):
        lines.append(f"🚫 {d.split(' (')[0]}")
    for border, _ in closed:
        lines.append(f"🚫 {border}: practic închis")
    for border, usable in thin:
        lines.append(f"🟠 {border}: doar {_ranges(usable)}")

    fresh = sorted(
        (t for t in book if t.status == "proposed" and t.delivery_start.date().isoformat() == day),
        key=lambda t: -t.expected_pnl,
    )
    if not fresh:
        lines.append("— nicio propunere (spread-uri prea mici sau capacitate blocată)")
        return "\n".join(lines)
    by_dir: dict[str, list] = {}
    for t in fresh:
        by_dir.setdefault(f"{t.from_zone}→{t.to_zone}", []).append(t)
    for direction, ts in sorted(by_dir.items(), key=lambda kv: -sum(t.expected_pnl for t in kv[1])):
        hours = _ranges(sorted({t.delivery_start.hour for t in ts}))
        lines.append(
            f"✅ {direction}: {len(ts)}h ({hours}), {sum(t.volume_mw for t in ts):.0f} MWh, "
            f"€{sum(t.expected_pnl for t in ts):,.0f}"
        )
    lines.append(f"Total așteptat €{sum(t.expected_pnl for t in fresh):,.0f}")
    lines.append(
        "Confirmă: „RONOR, autorizez tot” sau „autorizez " + " ".join(t.id for t in fresh[:3]) + "”"
    )
    return "\n".join(lines)


def _ranges(hours: list[int]) -> str:
    if not hours:
        return "—"
    out, start, prev = [], hours[0], hours[0]
    for h in hours[1:]:
        if h != prev + 1:
            out.append((start, prev))
            start = h
        prev = h
    out.append((start, prev))
    return ", ".join(f"{a:02d}h" if a == b else f"{a:02d}–{b:02d}h" for a, b in out)


def latest_file(
    data_dir: Path, prefix: str, day: str | None = None, fallback: bool = True
) -> Path | None:
    """``data/<prefix>_<day>.csv`` for the day; else the newest available when ``fallback``."""
    if day:
        exact = data_dir / f"{prefix}_{day}.csv"
        if exact.exists():
            return exact
        if not fallback:
            return None
    files = sorted(data_dir.glob(f"{prefix}_*.csv"))
    return files[-1] if files else None


class JobRunner:
    def __init__(self, agent: CrossBorderAgent, settings: Settings, store: StateStore):
        self.agent = agent
        self.settings = settings
        self.store = store
        self.notifier = TelegramNotifier(settings)
        self.tz = ZoneInfo(settings.timezone)
        self._last_run: dict[str, str] = store.load("last_run", {}) or {}
        self.restored = agent.restore(store.load("book"), store.load("claims"))
        if any(self.restored.values()):
            log.info("restored state: %s", self.restored)
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._last_tick: dict[str, datetime] = {}
        self._retries: dict[str, dict] = {}
        self.started_at: datetime | None = None

    # -- jobs ----------------------------------------------------------
    def job_weather(self, day: str | None = None) -> dict:
        day = day or datetime.now(self.tz).date().isoformat()
        brief = WeatherOrchestrator(days=3).run().model_dump()
        alerts = rules_from_weather(brief)
        self.store.save_brief(day, "weather", brief)
        self.agent.claims.file(
            kind="weather",
            statement=f"Prognoză {day}: {len(brief['countries'])} țări, {len(alerts)} semnale",
            evidence_level=EVIDENCE_OPERATOR,
            inputs_ref="open-meteo",
        )
        self._notify(f"Meteo {day}", alerts)
        return {"day": day, "brief": brief, "alerts": [a.model_dump() for a in alerts]}

    def job_hub_run(self, day: str | None = None, reason: str = "") -> dict:
        target = day or (datetime.now(self.tz).date() + timedelta(days=1)).isoformat()
        target_dt = datetime.fromisoformat(target)
        data_dir = self.settings.data_dir
        ntc_path = latest_file(data_dir, "ntc", target)
        ntc_is_fallback = bool(ntc_path) and ntc_path.name != f"ntc_{target}.csv"
        # Prices must be for the exact day: yesterday's prices are not evidence for today.
        prices_path = latest_file(data_dir, "prices", target, fallback=False)
        availability = load_ntc_csv(str(ntc_path)) if ntc_path else {}
        prev_day = (target_dt.date() - timedelta(days=1)).isoformat()
        prev_path = latest_file(data_dir, "ntc", prev_day, fallback=False)
        previous = load_ntc_csv(str(prev_path)) if prev_path and not ntc_is_fallback else None
        cbc_alerts = rules_from_ntc(availability, self.settings.alert_min_atc_mw, previous)
        # The capacity auction result, when we have it, is our real position for the day.
        bids_path = latest_file(data_dir, "bids", target, fallback=False)
        won = load_bids_csv(bids_path) if bids_path else {}
        won_capacity = apply_won_capacity(availability, won) if won else {}
        # Chat decisions for the day (skip border, ATC corrections, prices) beat the files.
        overrides = self.store.load(f"briefs/{target}_overrides") or {}
        for border, mw in overrides.get("availability", {}).items():
            availability[border] = float(mw)
        decisions = overrides.get("decisions", [])
        # A published NTC table is the whole truth for its domain: an eastern border it
        # does not list has no capacity we can rely on, so it is closed for the day.
        no_ntc: list[str] = []
        if availability:
            east = EAST
            for ic in INTERCONNECTORS:
                if not {ic.from_zone, ic.to_zone} <= east:
                    continue
                if ic.id.count("-") >= 2:  # transit corridor: only its own row counts
                    if ic.id not in availability:
                        availability[ic.id] = 0.0
                        no_ntc.append(ic.id)
                    continue
                for key in (f"{ic.from_zone}-{ic.to_zone}", f"{ic.to_zone}-{ic.from_zone}"):
                    if key not in availability and ic.id not in availability:
                        availability[key] = 0.0
                        no_ntc.append(key)
        zones = ["RO", "BG", "RS", "HU", "MD", "UA"]
        evidence = EVIDENCE_SIMULATED
        price_overrides = self._price_table(target, prices_path, overrides)
        if price_overrides:
            provider = OverrideProvider(self.agent.provider, target_dt, price_overrides)
            evidence = EVIDENCE_OPERATOR
            # Trade only where prices are real; the hub view still covers all spokes.
            trade_zones = sorted(price_overrides)
        else:
            provider = self.agent.provider
            trade_zones = zones
        prices = provider.day_ahead(zones, target_dt)
        snapshot = hub_snapshot(prices, target, availability=availability).model_dump()
        if price_overrides:
            # Trade only zone×hours with a real price: a simulated hour next to real
            # ones is exactly the kind of number that must never reach a bid.
            trade_prices = [
                p
                for p in prices
                if p.zone in trade_zones and p.delivery_start.hour in price_overrides[p.zone]
            ]
        else:
            trade_prices = [p for p in prices if p.zone in trade_zones]
        _trades, log_ = self.agent.run_from_prices(
            trade_prices, availability, evidence_level=evidence, extra_cost=won.get("cbc")
        )
        limits = bid_limits(won, price_overrides, self.agent.config.min_net_spread) if won else []
        missing_zones: list[str] = []
        if won_capacity:
            touched = {z for c in won_capacity for z in c.split("-")}
            missing_zones = sorted(z for z in touched if z not in price_overrides)
        alerts = cbc_alerts + rules_from_hub(snapshot, self.settings.alert_basis_eur_mwh)
        for d in decisions:
            alerts.append(Alert(level="info", rule="operator_decision", message=f"Aplicat: {d}"))
        self.store.save_brief(target, "hub", snapshot)
        self.store.save_brief(target, "run", log_.model_dump())
        self.store.save("book", [t.model_dump() for t in self.agent.book])
        result = {
            "day": target,
            "ntc": ntc_path.name if ntc_path else None,
            "ntc_fallback": ntc_is_fallback,
            "prices": prices_path.name if prices_path else None,
            "evidence": evidence,
            "price_coverage": {z: len(h) for z, h in sorted(price_overrides.items())},
            "sources": {z: s.get("source", "") for z, s in (self._sources(target) or {}).items()},
            "no_ntc_borders": sorted(no_ntc),
            "bids": bids_path.name if bids_path else None,
            "won_capacity": won_capacity,
            "bid_limits": limits,
            "implied_costs": implied_cost_models(limits),
            "missing_price_zones": missing_zones,
            "decisions": decisions,
            "trades_proposed": log_.trades_proposed,
            "expected_pnl_eur": log_.total_expected_pnl,
            "hub_summary": snapshot["summary"],
            "alerts": [a.model_dump() for a in alerts],
        }
        for a in alerts:
            self.store.append("alerts", {"title": f"Hub {target}", **a.model_dump()})
        self.store.save_brief(target, "result", result)
        # One plain message per day, not a list of alerts.
        brief = daily_brief(result, self.agent.book)
        self.notifier.send(f"🔄 {reason}\n{brief}" if reason else brief)
        return result

    def job_evening(self, day: str | None = None) -> dict:
        day = day or datetime.now(self.tz).date().isoformat()
        sov = self.agent.sovereignty(self.settings.home_zone)
        alerts = rules_from_sovereignty(sov["balance"], self.settings.alert_concentration_limit)
        self.store.save_brief(day, "evening", sov)
        self.agent.claims.file(
            kind="sovereignty",
            statement=(
                f"Recap {day}: net {sov['balance']['net_mw']} MW, "
                f"{sov['energy']['total_mwh']} MWh, {len(alerts)} alerte"
            ),
            evidence_level=EVIDENCE_OPERATOR,
        )
        self._notify(f"Recap seară {day}", alerts)
        return {"day": day, "sovereignty": sov, "alerts": [a.model_dump() for a in alerts]}

    # -- digital twin: read the market, then mark the day to it -----------------------
    def _price_table(
        self, day: str, prices_path: Path | None = None, overrides: dict | None = None
    ) -> dict[str, dict[int, float]]:
        """zone → delivery hour → €/MWh for ``day``: the day's file, then chat overrides."""
        if prices_path is None:
            prices_path = latest_file(self.settings.data_dir, "prices", day, fallback=False)
        if overrides is None:
            overrides = self.store.load(f"briefs/{day}_overrides") or {}
        table: dict[str, dict[int, float]] = {}
        if prices_path:
            for p in load_prices_csv(prices_path, datetime.fromisoformat(day)):
                table.setdefault(p.zone, {})[p.delivery_start.hour] = p.price_eur_mwh
        for zone, hours in overrides.get("prices", {}).items():
            table.setdefault(zone, {}).update({int(h): float(v) for h, v in hours.items()})
        return table

    def _sources(self, day: str) -> dict:
        return self.store.load(f"briefs/{day}_sources") or {}

    def job_fetch(self, day: str | None = None) -> dict:
        """Pull published clearing prices (OPCOM RO, OREE UA) into ``data/prices_<day>.csv``.

        Runs for today and tomorrow, only for zone×day still missing hours. "Not
        published yet" is the normal answer before ~12:45 CET and is not an error;
        ``watch`` picks the changed file up and reruns the day.
        """
        now = datetime.now(self.tz)
        days = (
            [day] if day else [now.date().isoformat(), (now.date() + timedelta(days=1)).isoformat()]
        )
        fetched, pending, mismatches = [], [], []
        for d in days:
            path = self.settings.data_dir / f"prices_{d}.csv"
            prov = self._sources(d)
            for zone, fetcher in FETCHERS.items():
                # Fetch what is missing; verify once what was typed in by hand.
                if not missing_hours(path, zone) and zone in prov:
                    continue
                try:
                    res = fetcher(datetime.fromisoformat(d).date(), 20.0)
                except SourceUnavailable as exc:
                    log.info("fetch %s %s: %s", zone, d, exc)
                    pending.append(f"{zone} {d}")
                    continue
                merged = merge_prices(path, res)
                prov[zone] = {k: v for k, v in res.items() if k != "prices"} | {
                    "hours": len(res["prices"]),
                    "verified_typed": not (merged["added"] or merged["changed"]),
                }
                self.store.save_brief(d, "sources", prov)
                if not (merged["added"] or merged["changed"]):
                    continue
                self.agent.claims.file(
                    kind="price_source",
                    statement=(
                        f"{zone} {d}: {len(merged['added'])} ore noi, "
                        f"{len(merged['changed'])} corectate din {res['source']}"
                    ),
                    evidence_level=EVIDENCE_PUBLISHED,
                    inputs_ref=res["url"],
                )
                fetched.append(f"{zone} {d} ({len(res['prices'])}h, {res['source']})")
                for m in merged["mismatches"]:
                    mismatches.append(
                        Alert(
                            level="warning",
                            rule="price_mismatch",
                            message=(
                                f"{zone} {d} int {m['hour']}: în fișier {m['file']:.2f}, "
                                f"{res['source']} spune {m['source']:.2f} → corectat"
                            ),
                            context={"zone": zone, "day": d, **m},
                        )
                    )
        if mismatches:
            self._notify("Prețuri corectate din sursă", mismatches)
        return {"fetched": fetched, "pending": pending, "mismatches": len(mismatches)}

    def job_pnl(self, day: str | None = None, reason: str = "") -> dict:
        """P/L Digital Twin for a delivered day (default: yesterday) → one message."""
        target = day or (datetime.now(self.tz).date() - timedelta(days=1)).isoformat()
        self.run("fetch", target)  # last chance to complete the day's prices
        prices = self._price_table(target)
        bids_path = latest_file(self.settings.data_dir, "bids", target, fallback=False)
        won = load_bids_csv(bids_path) if bids_path else {}
        result = self.store.load(f"briefs/{target}_result") or {}
        report = day_pnl(
            target,
            prices,
            won,
            self.agent.book,
            result.get("implied_costs"),
            home=self.settings.home_zone,
        )
        sources = self._sources(target)
        for zone, hours in prices.items():
            sources.setdefault(zone, {"source": "operator"})["hours"] = len(hours)
        self.store.save_brief(target, "pnl", report)
        self.store.append("pnl_twin", {"day": target, "net": report["net"]})
        month = month_to_date(self.store.read("pnl_twin", limit=400), target)
        if report["corridors"]:
            net = report["net"]
            op = f"€{net['operator']:,.0f}" if net["operator"] is not None else "nedeterminat"
            self.agent.claims.file(
                kind="pnl_twin",
                statement=(
                    f"P/L {target}: operator {op}, twin €{net['twin']:,.0f}, "
                    f"ideal €{net['perfect']:,.0f}"
                ),
                evidence_level=EVIDENCE_PUBLISHED if sources else EVIDENCE_OPERATOR,
                inputs_ref=f"briefs/{target}_pnl",
            )
        text = format_pnl(report, sources, month)
        self.notifier.send(f"🔄 {reason}\n{text}" if reason else text)
        return {"day": target, "report": report, "month": month, "text": text}

    # -- continuous duties --------------------------------------------------
    def fingerprint(self) -> dict[str, str]:
        """What the runner watches: input files and per-day chat overrides.

        Content hashes, not mtimes: filesystems differ in timestamp granularity and
        a re-posted identical table must not trigger a rerun.
        """
        fp: dict[str, str] = {}
        # ``disputes_*.jsonl`` is listed so a contested day is picked up by watch
        # the moment the trainer records a dispute; the actual re-run is caused
        # by the corrected rows written into ``bids_<day>.csv`` from the same
        # dispute request (see ``energy_trading.dispute.append_dispute``).
        for pattern in ("ntc_*.csv", "prices_*.csv", "bids_*.csv", "disputes_*.jsonl"):
            for f in sorted(self.settings.data_dir.glob(pattern)):
                fp[f.name] = hashlib.sha1(f.read_bytes()).hexdigest()
        for f in sorted(self.store.root.glob("briefs/*_overrides.json")):
            fp[f"override:{f.name}"] = hashlib.sha1(f.read_bytes()).hexdigest()
        return fp

    @staticmethod
    def _day_of(name: str) -> str | None:
        m = _DAY_IN_NAME.search(name)
        return m.group(1) if m else None

    def _has_results(self, name: str) -> bool:
        """Does this bids file already carry what was executed (fills or booked P/L)?"""
        try:
            won = load_bids_csv(self.settings.data_dir / name)
        except (OSError, ValueError, KeyError):
            return False
        return bool(won.get("filled") or won.get("realized"))

    def job_watch(self, day: str | None = None) -> dict:
        """Recompute every future/current day whose inputs changed since the last look."""
        now = datetime.now(self.tz)
        current = self.fingerprint()
        previous = self.store.load("watch", None)
        self.store.save("watch", current)
        if previous is None:  # first look: baseline only, nothing "changed"
            return {"changed": [], "reruns": [], "baseline": len(current)}
        changed = [k for k, v in current.items() if previous.get(k) != v]
        days: dict[str, list[str]] = {}
        delivered: list[str] = []  # a position/price file of a past day: real fills arrived
        today = now.date().isoformat()
        for name in changed:
            d = self._day_of(name)
            if not d:
                continue
            if d >= today:
                days.setdefault(d, []).append(name.replace("override:", "").replace(".json", ""))
            if d in delivered or not name.startswith(("bids_", "prices_")):
                continue
            # Today's position file with fills/results in it is already a delivery report.
            if d < today or (name.startswith("bids_") and self._has_results(name)):
                delivered.append(d)
        reruns = []
        for d, sources in sorted(days.items()):
            self.run(
                "hub_run", d, reason=f"Date noi pentru {d}: {', '.join(sources)} — ziua refăcută"
            )
            reruns.append(d)
        for d in sorted(delivered):
            self.run("pnl", d, reason=f"Operațiuni reale primite pentru {d} — P/L twin refăcut")
            reruns.append(d)
        return {"changed": changed, "reruns": reruns, "pnl_reruns": delivered}

    def job_settle(self, day: str | None = None) -> dict:
        now = datetime.now(UTC)
        lines, total = self.agent.settle_delivered(now)
        if lines:
            self.store.save("book", [t.model_dump() for t in self.agent.book])
            self.notifier.send(
                f"💶 Decontate {len(lines)} ore livrate — net realizat €{total:,.0f} "
                f"({', '.join(line.trade_id for line in lines[:6])}{' …' if len(lines) > 6 else ''})"
            )
        return {"settled": [line.trade_id for line in lines], "total_net_eur": total}

    def gate_closure_at(self, now: datetime) -> datetime:
        hh, mm = (int(x) for x in self.settings.gate_closure.split(":"))
        return now.replace(hour=hh, minute=mm, second=0, microsecond=0)

    def job_gate(self, day: str | None = None) -> dict:
        """Remind — once per threshold per day — while proposals for tomorrow await the human."""
        now = datetime.now(self.tz)
        tomorrow = (now.date() + timedelta(days=1)).isoformat()
        pending = [
            t
            for t in self.agent.book
            if t.status == "proposed" and t.delivery_start.date().isoformat() == tomorrow
        ]
        if not pending:
            return {"pending": 0, "reminded": None}
        gate = self.gate_closure_at(now)
        left = (gate - now).total_seconds() / 60
        if left <= 0:
            return {"pending": len(pending), "reminded": None, "gate": "closed"}
        sent = self.store.load("gate_reminded", {}) or {}
        done = set(sent.get(tomorrow, []))
        for threshold in sorted(self.settings.gate_reminders):
            if left <= threshold and threshold not in done:
                pnl = sum(t.expected_pnl for t in pending)
                self.notifier.send(
                    f"⏰ Gate day-ahead {self.settings.gate_closure} închide în {int(left)} min. "
                    f"{len(pending)} propuneri pentru {tomorrow} neautorizate (€{pnl:,.0f} așteptat). "
                    "„autorizez tot” sau „autorizez XB-…” — altfel rămân pe hârtie."
                )
                sent[tomorrow] = sorted(done | {threshold})
                self.store.save("gate_reminded", sent)
                return {"pending": len(pending), "reminded": threshold, "minutes_left": int(left)}
        return {"pending": len(pending), "reminded": None, "minutes_left": int(left)}

    def job_heartbeat(self, day: str | None = None) -> dict:
        now = datetime.now(self.tz)
        beat = {
            "at": now.isoformat(),
            "book": len(self.agent.book),
            "proposed": sum(t.status == "proposed" for t in self.agent.book),
            "nominated": sum(t.status == "nominated" for t in self.agent.book),
        }
        self.store.save("heartbeat", beat)
        return beat

    JOBS: ClassVar[dict[str, Callable]] = {
        "weather": job_weather,
        "hub_run": job_hub_run,
        "evening": job_evening,
        "pnl": job_pnl,
        "fetch": job_fetch,
        "watch": job_watch,
        "settle": job_settle,
        "gate": job_gate,
        "heartbeat": job_heartbeat,
    }
    DAILY: ClassVar[tuple[str, ...]] = ("weather", "pnl", "hub_run", "evening")
    QUIET: ClassVar[frozenset[str]] = frozenset(
        {"watch", "gate", "heartbeat", "fetch"}
    )  # not logged per tick

    def run(self, name: str, day: str | None = None, **kw) -> dict:
        if name not in self.JOBS:
            raise ValueError(f"Unknown job '{name}'. Known: {sorted(self.JOBS)}")
        started = time.time()
        try:
            result = self.JOBS[name](self, day, **kw)
            status = "ok"
            self._retries.pop(name, None)
        except Exception as exc:  # a job must never kill the runner
            log.exception("job %s failed", name)
            result, status = {"error": str(exc)}, "error"
            self._schedule_retry(name, day, str(exc))
        quiet = (
            name in self.QUIET
            and status == "ok"
            and not (result or {}).get("reruns")
            and not (result or {}).get("reminded")
            and not (result or {}).get("fetched")
        )
        if not quiet:
            self.store.append(
                "jobs",
                {
                    "job": name,
                    "status": status,
                    "seconds": round(time.time() - started, 2),
                    "day": day,
                },
            )
        now = datetime.now(self.tz)
        if name in self.DAILY and day is None:
            # Only the scheduled run (default target) counts as today's; reruns for a
            # specific day (watch, operator) must not make the 09:00 run skip itself.
            self._last_run[name] = now.date().isoformat()
            self.store.save("last_run", self._last_run)
        self._last_tick[name] = now
        self._persist_claims()
        return {"job": name, "status": status, "result": result}

    def _schedule_retry(self, name: str, day: str | None, error: str) -> None:
        attempt = self._retries.get(name, {}).get("attempt", 0) + 1
        if attempt > self.settings.max_retries:
            self._retries.pop(name, None)
            self._notify(
                f"Job {name} a eșuat definitiv",
                [
                    Alert(
                        level="critical",
                        rule="job_error",
                        message=f"{self.settings.max_retries} reîncercări epuizate: {error[:160]}",
                    )
                ],
            )
            return
        due = datetime.now(self.tz) + timedelta(minutes=self.settings.retry_minutes)
        self._retries[name] = {"attempt": attempt, "due": due, "day": day, "error": error[:200]}
        log.warning("job %s: retry %d/%d at %s", name, attempt, self.settings.max_retries, due)
        if attempt == 1:
            self._notify(
                f"Job {name} a eșuat",
                [
                    Alert(
                        level="warning",
                        rule="job_error",
                        message=f"{error[:160]} — reîncerc la {due:%H:%M}",
                    )
                ],
            )

    # -- scheduling loop ----------------------------------------------
    def due_jobs(self, now: datetime) -> list[str]:
        """Daily jobs whose hour has passed and that did not run today (catch-up included)."""
        today = now.date().isoformat()
        schedule = {
            "weather": self.settings.weather_hour,
            "pnl": self.settings.pnl_hour,
            "hub_run": self.settings.hub_run_hour,
            "evening": self.settings.evening_hour,
        }
        return [
            name
            for name, hour in schedule.items()
            if now.hour >= hour and self._last_run.get(name) != today
        ]

    def due_periodic(self, now: datetime) -> list[str]:
        every = {
            "fetch": self.settings.fetch_minutes,  # before watch: the new file is seen this tick
            "watch": self.settings.watch_minutes,
            "settle": self.settings.settle_minutes,
            "heartbeat": self.settings.heartbeat_minutes,
            "gate": 1,
        }
        out = []
        for name, minutes in every.items():
            if minutes <= 0:
                continue
            last = self._last_tick.get(name)
            if last is None or (now - last) >= timedelta(minutes=minutes):
                out.append(name)
        return out

    def due_retries(self, now: datetime) -> list[tuple[str, str | None]]:
        return [(n, r["day"]) for n, r in self._retries.items() if r["due"] <= now]

    def tick(self, now: datetime | None = None) -> list[str]:
        """One pass of the loop; returns what ran. Exposed for tests and /api/jobs/tick."""
        now = now or datetime.now(self.tz)
        ran = []
        for name, day in self.due_retries(now):
            self.run(name, day)
            ran.append(f"retry:{name}")
        for name in self.due_jobs(now):
            self.run(name)
            ran.append(name)
        for name in self.due_periodic(now):
            self.run(name)
            self._last_tick[name] = now  # the loop's clock, so tests can drive it
            ran.append(name)
        return ran

    def _loop(self) -> None:
        self._on_start()
        while not self._stop.is_set():
            try:
                self.tick()
            except Exception:
                log.exception("scheduler tick failed")
            self._stop.wait(30)

    def _on_start(self) -> None:
        """Report a long outage; the daily catch-up itself happens in the first tick."""
        self.started_at = datetime.now(self.tz)
        beat = self.store.load("heartbeat", None)
        if beat and beat.get("at"):
            gap = self.started_at - datetime.fromisoformat(beat["at"])
            if gap > timedelta(minutes=2 * self.settings.heartbeat_minutes):
                hours = gap.total_seconds() / 3600
                self.notifier.send(
                    f"🔁 RONOR energie repornit după ~{hours:.1f} h fără puls. "
                    "Recuperez job-urile zilei ratate și verific datele noi."
                )

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="et-scheduler", daemon=True)
        self._thread.start()
        log.info("scheduler started (tz=%s)", self.settings.timezone)

    def stop(self) -> None:
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2)

    @property
    def running(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    def next_runs(self, now: datetime | None = None) -> dict[str, str]:
        now = now or datetime.now(self.tz)
        out: dict[str, str] = {}
        for name, hour in (
            ("weather", self.settings.weather_hour),
            ("pnl", self.settings.pnl_hour),
            ("hub_run", self.settings.hub_run_hour),
            ("evening", self.settings.evening_hour),
        ):
            at = now.replace(hour=hour, minute=0, second=0, microsecond=0)
            if self._last_run.get(name) == now.date().isoformat() or at <= now:
                at += timedelta(days=1)
            out[name] = at.strftime("%d.%m %H:%M")
        for name, minutes in (
            ("fetch", self.settings.fetch_minutes),
            ("watch", self.settings.watch_minutes),
            ("settle", self.settings.settle_minutes),
            ("heartbeat", self.settings.heartbeat_minutes),
        ):
            if minutes <= 0:
                continue
            last = self._last_tick.get(name)
            at = (last + timedelta(minutes=minutes)) if last else now
            out[name] = at.strftime("%H:%M")
        out["gate"] = self.gate_closure_at(now).strftime("%H:%M")
        return out

    def status(self) -> dict:
        now = datetime.now(self.tz)
        return {
            "running": self.running,
            "timezone": self.settings.timezone,
            "uptime_minutes": int((now - self.started_at).total_seconds() // 60)
            if self.started_at
            else None,
            "schedule": {
                "weather": f"{self.settings.weather_hour:02d}:00",
                "pnl": f"{self.settings.pnl_hour:02d}:00",
                "hub_run": f"{self.settings.hub_run_hour:02d}:00",
                "evening": f"{self.settings.evening_hour:02d}:00",
                "fetch": f"la {self.settings.fetch_minutes} min (OPCOM, OREE/NBU)",
                "watch": f"la {self.settings.watch_minutes} min",
                "settle": f"la {self.settings.settle_minutes} min",
                "gate": f"{self.settings.gate_closure} (memento la {', '.join(map(str, self.settings.gate_reminders))} min)",
                "heartbeat": f"la {self.settings.heartbeat_minutes} min",
            },
            "next": self.next_runs(now),
            "last_run": self._last_run,
            "retries": {
                n: {**r, "due": r["due"].strftime("%H:%M")} for n, r in self._retries.items()
            },
            "watching": len(self.store.load("watch", {}) or {}),
            "heartbeat": self.store.load("heartbeat", None),
            "restored": self.restored,
            "telegram": self.notifier.enabled,
            "recent": self.store.read("jobs", limit=10),
        }

    # -- helpers --------------------------------------------------------
    def _notify(self, title: str, alerts: list[Alert]) -> None:
        for a in alerts:
            self.store.append("alerts", {"title": title, **a.model_dump()})
        self.notifier.send_alerts(title, alerts)

    def _persist_claims(self) -> None:
        self.store.save("claims", [c.model_dump() for c in self.agent.claims.entries])
