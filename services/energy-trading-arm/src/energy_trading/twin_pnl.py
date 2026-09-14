"""P/L Digital Twin: for a delivered day, three numbers that must be allowed to disagree.

- **operator** — what the position actually earned: capacity held (``bids_<day>.csv``),
  the operator's limit orders (a buy limit fills when the clearing price is at or
  below it, a sell limit when at or above) or their reported ``filled_mw``, priced at
  the published clearing prices. CBC is paid on every held hour, filled or not.
- **twin** — what the agent's own proposals for the day would have earned at the
  same prices (its book, not its expectations).
- **perfect** — hindsight: every held hour with a positive net spread, nothing else.

All three use the model's transport cost (tariff + losses + CBC). Where the operator's
own limits have revealed a different all-in cost (``implied_costs`` from the day's
run), the operator figure is repeated at that cost too — that is the number they
recognise in their own books. Nothing here is a forecast; a missing price makes the
hour *unknown*, never zero.
"""

from __future__ import annotations

from datetime import datetime

from energy_trading.interconnectors import corridor_ic
from energy_trading.models import Trade

HOME = "RO"


def _fmt_ranges(hours: list[int]) -> str:
    if not hours:
        return "—"
    hours = sorted(set(hours))
    out, start, prev = [], hours[0], hours[0]
    for h in hours[1:]:
        if h != prev + 1:
            out.append((start, prev))
            start = h
        prev = h
    out.append((start, prev))
    return ", ".join(f"{a:02d}" if a == b else f"{a:02d}–{b:02d}" for a, b in out)


def day_pnl(
    day: str,
    prices: dict[str, dict[int, float]],
    won: dict,
    book: list[Trade],
    implied_costs: dict[str, dict] | None = None,
    home: str = HOME,
) -> dict:
    """Operator / twin / perfect P/L for ``day``; ``prices`` is zone → delivery hour → €/MWh."""
    implied_costs = implied_costs or {}
    corridors: list[dict] = []
    tot = {
        "operator": 0.0,
        "operator_own_costs": 0.0,
        "twin": 0.0,
        "perfect": 0.0,
        "cbc_paid": 0.0,
        "held_mwh": 0.0,
        "unknown_mwh": 0.0,
        "filled_mwh": 0.0,
        "reported": 0.0,
    }
    any_own_costs = False
    any_reported = False
    for corridor, hours in sorted(won.get("capacity", {}).items()):
        ic, src, dst = corridor_ic(corridor)
        if ic is None:
            continue
        cbc_tab = won.get("cbc", {}).get(corridor, {})
        limits = won.get("limits", {}).get(corridor, {})
        filled_tab = won.get("filled", {}).get(corridor, {})
        realized_tab = won.get("realized", {}).get(corridor, {})
        own = implied_costs.get(corridor)
        c = {
            "corridor": corridor,
            "from": src,
            "to": dst,
            "mw": max(hours.values()) if hours else 0.0,
            "held_hours": sorted(h + 1 for h, mw in hours.items() if mw),
            "unknown_hours": [],
            "positive_hours": [],
            "filled_hours": [],
            "missed_hours": [],  # positive spread, not filled
            "bad_fills": [],  # filled at a loss
            "undetermined_hours": [],  # no limit and no fill report
            "operator": 0.0,
            "operator_own_costs": 0.0,
            "twin": 0.0,
            "perfect": 0.0,
            "cbc_paid": 0.0,
            # What the operator's own sheet books for the day (their P&L column), if sent.
            "reported": round(sum(realized_tab.values()), 2) if realized_tab else None,
            "hours": [],
        }
        if realized_tab:
            any_reported = True
            tot["reported"] += sum(realized_tab.values())
        for h, mw in sorted(hours.items()):
            if not mw:
                continue
            cbc = float(cbc_tab.get(h, 0.0))
            c["cbc_paid"] += cbc * mw
            p_src, p_dst = prices.get(src, {}).get(h), prices.get(dst, {}).get(h)
            if p_src is None or p_dst is None:
                c["unknown_hours"].append(h + 1)
                tot["unknown_mwh"] += mw
                continue
            transport = ic.transport_cost(p_src)
            spread = p_dst - p_src - transport  # CBC is sunk, accounted once per held hour
            if spread > 0:
                c["positive_hours"].append(h + 1)
                c["perfect"] += spread * mw
            if h in filled_tab:
                fill_mw = min(float(filled_tab[h]), mw)
            elif filled_tab:  # the operator reported fills for this corridor: silence = none
                fill_mw = 0.0
            elif h in limits:
                limit = limits[h]
                hit = (p_src <= limit) if src == home else (p_dst >= limit)
                fill_mw = mw if hit else 0.0
            else:
                c["undetermined_hours"].append(h + 1)
                fill_mw = None
            row = {
                "interval": h + 1,
                "mw": mw,
                "p_from": p_src,
                "p_to": p_dst,
                "spread_net": round(spread, 2),
                "cbc": cbc,
                "filled_mw": fill_mw,
                "reported": realized_tab.get(h),
            }
            if fill_mw:
                c["filled_hours"].append(h + 1)
                c["operator"] += spread * fill_mw
                tot["filled_mwh"] += fill_mw
                if spread < 0:
                    c["bad_fills"].append(h + 1)
                if own:
                    any_own_costs = True
                    own_cost = (
                        p_src * own["implied_proportional_pct"] / 100.0
                        + own["implied_fixed_eur_mwh"]
                    )
                    c["operator_own_costs"] += (p_dst - p_src - own_cost) * fill_mw
            elif fill_mw == 0.0 and spread > 0:
                c["missed_hours"].append(h + 1)
            c["hours"].append(row)
        # The twin's own proposals for this corridor, marked to the published prices.
        for t in book:
            if (
                t.delivery_start.date().isoformat() != day
                or t.status == "rejected"
                or t.interconnector_id != ic.id
                or (t.from_zone, t.to_zone) != (src, dst)
            ):
                continue
            h = t.delivery_start.hour
            p_src, p_dst = prices.get(src, {}).get(h), prices.get(dst, {}).get(h)
            if p_src is None or p_dst is None:
                continue
            cbc = float(cbc_tab.get(h, 0.0))
            c["twin"] += (p_dst - p_src - ic.transport_cost(p_src) - cbc) * t.volume_mw
        if not own:
            c["operator_own_costs"] = c["operator"]
        for k in ("operator", "operator_own_costs", "twin", "perfect", "cbc_paid"):
            c[k] = round(c[k], 2)
            tot[k] += c[k]
        tot["held_mwh"] += sum(hours.values())
        corridors.append(c)
    # Results the operator books on corridors the position file does not hold
    # (e.g. a summary-sheet leg we could not map to a held corridor) still count.
    seen = {c["corridor"] for c in corridors}
    reported_unmatched = {
        corridor: round(sum(tab.values()), 2)
        for corridor, tab in won.get("realized", {}).items()
        if corridor not in seen and tab
    }
    if reported_unmatched:
        any_reported = True
        tot["reported"] += sum(reported_unmatched.values())
    perfect_net = tot["perfect"] - tot["cbc_paid"]
    twin_net = tot["twin"]  # CBC already inside the twin's per-trade cost
    undetermined = sum(len(c["undetermined_hours"]) for c in corridors)
    # An operator figure is only a figure when every priced hour has a limit or a fill.
    operator_known = bool(corridors) and undetermined == 0
    operator_net = tot["operator"] - tot["cbc_paid"] if operator_known else None
    reported = round(tot["reported"], 2) if any_reported else None
    # Calibration gap: what the operator books minus what the twin computes for the same
    # fills at published prices — costs, fees or a pricing basis the model does not see yet.
    gap = (
        round(reported - operator_net, 2)
        if reported is not None and operator_net is not None
        else None
    )
    return {
        "day": day,
        "corridors": corridors,
        "totals": {k: round(v, 2) for k, v in tot.items()},
        "operator_known": operator_known,
        "undetermined_hours": undetermined,
        "net": {
            "operator": round(operator_net, 2) if operator_net is not None else None,
            "operator_own_costs": round(tot["operator_own_costs"] - tot["cbc_paid"], 2)
            if operator_known
            else None,
            "twin": round(twin_net, 2),
            "perfect": round(perfect_net, 2),
            "reported": reported,
            "reported_gap": gap,
        },
        "capture": {
            "operator": round(operator_net / perfect_net, 3)
            if operator_net is not None and perfect_net > 0
            else None,
            "twin": round(twin_net / perfect_net, 3) if perfect_net > 0 else None,
        },
        "own_costs_applied": any_own_costs and operator_known,
        "reported_unmatched": reported_unmatched,
        "computed_at": datetime.now().astimezone().isoformat(),
    }


def format_pnl(report: dict, sources: dict | None = None, month: dict | None = None) -> str:
    """The daily P/L Digital Twin message."""
    day = report["day"]
    lines = [f"📊 P/L Digital Twin — {day} (livrat)"]
    if sources:
        parts = []
        for zone, s in sorted(sources.items()):
            parts.append(f"{zone} {s.get('source', 'operator')} {s.get('hours', '?')}h")
        lines.append("Surse: " + " · ".join(parts))
    if not report["corridors"]:
        lines.append("— nicio capacitate deținută în ziua asta (fără bids_*.csv)")
    for c in report["corridors"]:
        head = f"{c['from']}→{c['to']}" + (
            f" via {c['corridor']}" if c["corridor"].count("-") >= 2 else ""
        )
        held = f"{c['mw']:.0f} MW int {_fmt_ranges(c['held_hours'])}"
        if c["unknown_hours"] and len(c["unknown_hours"]) == len(c["held_hours"]):
            lines.append(f"❔ {head} {held}: fără preț pe un capăt → nedeterminat")
            continue
        pos, filled = len(c["positive_hours"]), len(c["filled_hours"])
        if c["undetermined_hours"] and not c["filled_hours"]:
            verdict = (
                f"{pos}h pozitive (ideal €{c['perfect']:,.0f}); fără limite/fill-uri → "
                "nu știu ce ai prins"
            )
        else:
            verdict = (
                f"prins {filled}h din {pos}h pozitive · real €{c['operator']:,.0f} · "
                f"ideal €{c['perfect']:,.0f}"
            )
            if c["missed_hours"]:
                verdict += f" · ratat int {_fmt_ranges(c['missed_hours'])}"
            if c["bad_fills"]:
                verdict += f" · în pierdere int {_fmt_ranges(c['bad_fills'])}"
        if c["twin"]:
            verdict += f" · twin €{c['twin']:,.0f}"
        if c.get("reported") is not None:
            verdict += f" · raportat €{c['reported']:,.0f}"
        if c["unknown_hours"]:
            verdict += f" · fără preț int {_fmt_ranges(c['unknown_hours'])}"
        lines.append(f"• {head} {held}: {verdict}")
    net, cap = report["net"], report["capture"]
    if report["corridors"]:
        if net["operator"] is None:
            op_txt = (
                f"operator nedeterminat ({report['undetermined_hours']}h fără limită/fill — "
                "trimite-mi limitele sau ce ai prins)"
            )
        else:
            cap_txt = f", captură {cap['operator']:.0%}" if cap["operator"] is not None else ""
            op_txt = f"operator €{net['operator']:,.0f}{cap_txt}"
        lines.append(
            f"Total zi: {op_txt} · ideal €{net['perfect']:,.0f} "
            f"· twin €{net['twin']:,.0f} · CBC plătit €{report['totals']['cbc_paid']:,.0f}"
        )
        if report.get("own_costs_applied"):
            lines.append(f"La costul tău implicit: €{net['operator_own_costs']:,.0f}")
        if net.get("reported") is not None:
            gap = net.get("reported_gap")
            gap_txt = (
                f" · diferență față de calculul meu {gap:+,.0f} € (costuri/bază pe care nu le văd încă)"
                if gap is not None and abs(gap) >= 1
                else (" · concordă cu calculul meu" if gap is not None else "")
            )
            lines.append(f"Raportat de tine: €{net['reported']:,.0f}{gap_txt}")
            if report.get("reported_unmatched"):
                extra = ", ".join(f"{k} €{v:,.0f}" for k, v in report["reported_unmatched"].items())
                lines.append(f"  din care pe coridoare fără poziție în bids: {extra}")
    if month and month.get("days"):
        op_m = (
            f"operator €{month['operator']:,.0f} ({month['operator_days']} zile determinate"
            + (
                f", captură {month['operator'] / month['perfect_on_operator_days']:.0%}"
                if month.get("perfect_on_operator_days")
                else ""
            )
            + ")"
        )
        lines.append(
            f"Luna ({month['days']} zile): {op_m} · twin €{month['twin']:,.0f} "
            f"· ideal €{month['perfect']:,.0f}"
        )
    return "\n".join(lines)


def month_to_date(records: list[dict], day: str) -> dict:
    """Sum the latest record per day for the month of ``day``."""
    latest: dict[str, dict] = {}
    for r in records:
        if r.get("day", "")[:7] == day[:7]:
            latest[r["day"]] = r
    out = {
        "days": len(latest),
        "operator": 0.0,
        "operator_days": 0,
        "perfect_on_operator_days": 0.0,
        "twin": 0.0,
        "perfect": 0.0,
    }
    for r in latest.values():
        net = r.get("net", {})
        for k in ("twin", "perfect"):
            out[k] += float(net.get(k) or 0.0)
        # The operator's booked result is the truth when they sent it; otherwise the
        # figure computed from their fills. Undetermined days do not drag the sum to zero.
        operator = net.get("reported") if net.get("reported") is not None else net.get("operator")
        if operator is not None:
            out["operator"] += float(operator)
            out["operator_days"] += 1
            out["perfect_on_operator_days"] += float(net.get("perfect") or 0.0)
    return {k: (round(v, 2) if isinstance(v, float) else v) for k, v in out.items()}
