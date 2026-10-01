"""Public price sources: the twin reads the market itself instead of waiting for a screenshot.

- **RO** — OPCOM PZU (day-ahead) results CSV, EUR/MWh, 15-minute MTU averaged to hours.
  OPCOM intervals are CET (SDAC day), same convention as ``data/prices_*.csv``.
- **UA** — OREE DAM hourly results (UAH/MWh, Kyiv time, zone 2 = IPS of Ukraine),
  converted with the NBU official EUR rate of the *auction* day (D-1) and shifted
  Kyiv → CET (Kyiv hour h+1 is CET hour h). CET hour 24 is next day's Kyiv hour 1.
- **MD** — no public day-ahead market; stays operator-provided.

Every fetched number is merged into ``data/prices_<day>.csv`` (source beats a
hand-typed value; a disagreement is reported, not hidden) and the provenance is
written next to it so a claim can always say where a price came from.
Fetchers raise ``SourceUnavailable`` when the day is not published yet — that is
normal before 12:45 CET for D+1 and the caller simply retries later.
"""

from __future__ import annotations

import csv
import html as _html
import json
import logging
import re
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from io import StringIO
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

log = logging.getLogger("energy_trading.sources")

OPCOM_CSV = "https://www.opcom.ro/rapoarte-pzu-raportPIP-export-csv/{d}/{m}/{y}/en"
OREE_DAM = "https://www.oree.com.ua/index.php/PXS/get_pxs_hdata/{d:02d}.{m:02d}.{y}/DAM/2"
NBU_RATE = (
    "https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?valcode=EUR&date={ymd}&json"
)
UA_AGENT = "Mozilla/5.0 (compatible; RONOR-energy-twin/1.0)"

PRICE_COLUMNS = {"RO": "ro_dam_eur", "UA": "ua_dam_eur", "MD": "md_price_eur"}


class SourceUnavailable(Exception):
    """Not published yet, unreachable, or unparseable — retry later."""


def _get(url: str, timeout: float) -> str:
    try:
        with urlopen(Request(url, headers={"User-Agent": UA_AGENT}), timeout=timeout) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except (HTTPError, URLError, TimeoutError, OSError) as exc:
        raise SourceUnavailable(f"{url}: {exc}") from exc


# -- RO: OPCOM ---------------------------------------------------------------------


def parse_opcom_csv(text: str) -> dict[int, float]:
    """Hourly EUR/MWh (CET hour 1-24) from the OPCOM PIP export; 15-min rows are averaged."""
    rows = list(csv.reader(StringIO(text)))
    quarters: dict[int, list[float]] = {}
    resolution = "PT60M"
    for row in rows:
        if len(row) < 3 or row[0].strip().lower() != "romania":
            continue
        try:
            interval, price = int(row[1]), float(row[2].replace(",", "."))
        except ValueError:
            continue
        if len(row) >= 7 and row[6].strip():
            resolution = row[6].strip()
        quarters.setdefault(interval, []).append(price)
    if not quarters:
        raise SourceUnavailable("OPCOM: no 'Romania' rows (not published yet?)")
    per_hour = 4 if resolution.upper() == "PT15M" or len(quarters) > 24 else 1
    hourly: dict[int, list[float]] = {}
    for interval, prices in quarters.items():
        hour = (interval - 1) // per_hour + 1
        hourly.setdefault(hour, []).extend(prices)
    out = {h: round(sum(v) / len(v), 2) for h, v in sorted(hourly.items()) if 1 <= h <= 24}
    if len(out) < 23:
        raise SourceUnavailable(f"OPCOM: only {len(out)} hours parsed")
    return out


def fetch_ro_dam(day: date, timeout: float = 20.0) -> dict:
    url = OPCOM_CSV.format(d=day.day, m=day.month, y=day.year)
    text = _get(url, timeout)
    if not text.strip():
        raise SourceUnavailable(f"OPCOM: empty export for {day} (not published yet)")
    return {
        "zone": "RO",
        "prices": parse_opcom_csv(text),
        "source": "OPCOM PZU",
        "url": url,
        "unit": "EUR/MWh",
        "fetched_at": datetime.now(UTC).isoformat(),
    }


# -- UA: OREE + NBU ----------------------------------------------------------------

_ROW = re.compile(r"<tr[^>]*>(.*?)</tr>", re.DOTALL)
_CELL = re.compile(r"<t[dh][^>]*>(.*?)</t[dh]>", re.DOTALL)


def parse_oree_html(payload: str) -> dict[int, float]:
    """Kyiv hour (1-24) → UAH/MWh from the OREE ``get_pxs_hdata`` JSON/HTML fragment."""
    try:
        html = json.loads(payload).get("html", "")
    except json.JSONDecodeError:
        html = payload
    out: dict[int, float] = {}
    hour_col, price_col = 1, 2  # OREE rows carry a hidden index cell first
    for row in _ROW.findall(html):
        cells = [_html.unescape(re.sub(r"<[^>]+>", "", c)).strip() for c in _CELL.findall(row)]
        if any("Година" in c for c in cells):  # header: locate columns by name
            hour_col = next(i for i, c in enumerate(cells) if "Година" in c)
            price_col = next(i for i, c in enumerate(cells) if c.startswith("Ціна"))
            continue
        if len(cells) <= max(hour_col, price_col):
            continue
        try:
            hour = int(cells[hour_col])
            price = float(cells[price_col].replace(" ", "").replace(",", "."))
        except ValueError:
            continue
        if 1 <= hour <= 25:
            out[hour] = price
    if len(out) < 23 or not any(out.values()):
        raise SourceUnavailable(f"OREE: {len(out)} hours, all-zero={not any(out.values())}")
    return out


def fetch_nbu_eur_rate(day: date, timeout: float = 20.0) -> float:
    url = NBU_RATE.format(ymd=day.strftime("%Y%m%d"))
    try:
        data = json.loads(_get(url, timeout))
        return float(data[0]["rate"])
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        raise SourceUnavailable(f"NBU rate {day}: {exc}") from exc


def fetch_ua_dam(day: date, timeout: float = 20.0) -> dict:
    """UA DAM for delivery ``day`` in CET hours, EUR/MWh (NBU rate of the auction day D-1)."""
    url = OREE_DAM.format(d=day.day, m=day.month, y=day.year)
    kyiv = parse_oree_html(_get(url, timeout))
    rate = fetch_nbu_eur_rate(day - timedelta(days=1), timeout)
    prices = {h: round(kyiv[h + 1] / rate, 2) for h in range(1, 24) if (h + 1) in kyiv}
    # CET hour 24 = Kyiv hour 1 of the next delivery day, when that day is out.
    nxt = day + timedelta(days=1)
    try:
        kyiv_next = parse_oree_html(
            _get(OREE_DAM.format(d=nxt.day, m=nxt.month, y=nxt.year), timeout)
        )
        if 1 in kyiv_next:
            prices[24] = round(kyiv_next[1] / rate, 2)
    except SourceUnavailable:
        pass
    return {
        "zone": "UA",
        "prices": prices,
        "source": "OREE DAM (IPS) / NBU EUR",
        "url": url,
        "unit": "EUR/MWh",
        "rate_uah_eur": rate,
        "rate_day": (day - timedelta(days=1)).isoformat(),
        "fetched_at": datetime.now(UTC).isoformat(),
    }


FETCHERS: dict[str, Callable[[date, float], dict]] = {"RO": fetch_ro_dam, "UA": fetch_ua_dam}


# -- merge into data/prices_<day>.csv ------------------------------------------------


def read_prices_file(path: Path) -> dict[int, dict[str, str]]:
    rows = {h: {c: "" for c in PRICE_COLUMNS.values()} for h in range(1, 25)}
    if path.exists():
        with path.open(newline="") as f:
            for row in csv.DictReader(f):
                try:
                    h = int(row["hour_cet"])
                except (KeyError, ValueError):
                    continue
                for col in PRICE_COLUMNS.values():
                    rows.setdefault(h, {})[col] = (row.get(col) or "").strip()
    return rows


def write_prices_file(path: Path, rows: dict[int, dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["hour_cet", *PRICE_COLUMNS.values()])
        for h in range(1, 25):
            w.writerow([h, *(rows.get(h, {}).get(c, "") for c in PRICE_COLUMNS.values())])


def missing_hours(path: Path, zone: str) -> list[int]:
    """CET hours (1-24) without a price for ``zone`` in the day's file (24 when no file)."""
    col = PRICE_COLUMNS[zone]
    rows = read_prices_file(path)
    return [h for h in range(1, 25) if not rows[h].get(col)]


def merge_prices(path: Path, fetched: dict, tolerance: float = 0.05) -> dict:
    """Write fetched prices into the day's file. Returns what changed and what disagreed.

    The published clearing price wins over a typed one, but a typed value that differs
    is reported as a mismatch — the operator should know their sheet was off.
    """
    col = PRICE_COLUMNS[fetched["zone"]]
    rows = read_prices_file(path)
    added, changed, mismatches = [], [], []
    for h, price in sorted(fetched["prices"].items()):
        old = rows[h].get(col, "")
        new = f"{price:.2f}"
        if not old:
            added.append(h)
        elif abs(float(old) - price) > tolerance:
            mismatches.append({"hour": h, "file": float(old), "source": price})
            changed.append(h)
        else:
            continue
        rows[h][col] = new
    if added or changed:
        write_prices_file(path, rows)
    return {"zone": fetched["zone"], "added": added, "changed": changed, "mismatches": mismatches}
