"""Daily-operations intake: parse pasted ops notes into agent inputs.

Accepts free-form text (Romanian or English) such as::

    RO-UA ATC 450 MW
    UA/MD ATC 600
    RO ora 18 pret 112,5
    MD 19h 121.0
    RO,20,118.5

and returns structured ``availability`` (MW per canonical border) and
``prices_override`` (EUR/MWh per zone per hour) ready for ``/api/run``.

Excel workbooks (``.xlsx``) are supported via :func:`read_excel_ops`, which
understands three layouts: free-form rows, border/price tables with headers,
and hour-matrix sheets (zones × 0–23).
"""

from __future__ import annotations

import re
from datetime import datetime
from io import BytesIO
from pathlib import Path
from zipfile import BadZipFile

from pydantic import BaseModel, Field

from energy_trading.interconnectors import REGISTRY, corridor_ic, normalize_border
from energy_trading.market_data import MarketDataProvider
from energy_trading.models import PricePoint

# Column families of the operator's own position sheet ("Capacity won / CBC Price /
# Bid Limit Price / Nominated / Profit"), matched against the header text.
POSITION_KINDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("cbc", ("cbc", "capacity price", "pret capac", "preț capac", "atc price")),
    ("limits", ("bid limit", "limit", "limita", "limită")),
    ("realized", ("profit", "p&l", "p/l", "pnl", "rezultat", "result", "castig", "câștig")),
    (
        "filled",
        ("nominat", "filled", "fill", "executed", "executat", "realizat", "livrat", "matched"),
    ),
    (
        "capacity",
        ("capacity won", "won", "alocat", "castigat", "câștigat", "capacity", "capacitate", "mw"),
    ),
)
HELP_SHEET_RE = re.compile(r"^(cum|readme|instruc|info|legend|ajutor|help|note)", re.IGNORECASE)
BID_COLUMNS = (
    "delivery_day",
    "corridor",
    "hour_cet",
    "capacity_mw",
    "cbc_price_eur_mwh",
    "bid_limit_eur_mwh",
    "filled_mw",
    "realized_eur",
    "note",
)

BORDER_RE = re.compile(
    r"(?P<border>[A-Za-z]{2}(?:[-/][A-Za-z]{2}){1,2})\s+"
    r"(?:ATC|NTC|capacitate|capacity)?\s*(?P<mw>\d+(?:[.,]\d+)?)\s*(?:MW)?",
    re.IGNORECASE,
)
PRICE_RE = re.compile(
    r"(?P<zone>[A-Za-z-]{2,6})[,\s]+(?:ora\s+)?(?P<hour>\d{1,2})\s*h?[,\s]+"
    r"(?:pre[țt]|price)?\s*(?P<price>\d+(?:[.,]\d+)?)",
    re.IGNORECASE,
)
# Operator decisions in chat: "skip Ua-Md", "sărim UA-MD", "fără RO-UA", "UA-MD off".
SKIP_RE = re.compile(
    r"(?:\b(?:skip|s[ăa]rim|s[ăa]ri|f[ăa]r[ăa]|exclude|excludem|nu\s+lu[ăa]m|no)\s+"
    r"(?P<b1>[A-Za-z]{2}(?:[-/][A-Za-z]{2}){1,2})\b)"
    r"|(?:\b(?P<b2>[A-Za-z]{2}(?:[-/][A-Za-z]{2}){1,2})\s+(?:skip|off|closed|[îi]nchis|exclus)\b)",
    re.IGNORECASE,
)
# Counterparty shorthand: "int 7 - 191 euro" (CET interval 1-24, zone unstated).
INTERVAL_PRICE_RE = re.compile(
    r"\bint(?:erval)?\.?\s*(?P<interval>\d{1,2})\s*[-–:=]\s*(?P<price>\d+(?:[.,]\d+)?)\s*(?:euro|eur|€)",
    re.IGNORECASE,
)
KNOWN_ZONES = {
    "RO",
    "UA",
    "MD",
    "DE-LU",
    "FR",
    "NL",
    "BE",
    "ES",
    "IT-N",
    "CH",
    "AT",
    "DK1",
    "NO2",
    "GB",
    "PL",
}


class OpsIntake(BaseModel):
    day: str = ""
    availability: dict[str, float] = Field(default_factory=dict)
    prices_override: dict[str, dict[int, float]] = Field(default_factory=dict)
    decisions: list[str] = Field(
        default_factory=list, description="Operator decisions, e.g. 'UA-MD exclus (skip)'"
    )
    unassigned_prices: dict[int, float] = Field(
        default_factory=dict, description="Interval prices posted without a zone (hour 0-23)"
    )
    bids: dict[str, dict[str, dict[int, float]]] = Field(
        default_factory=dict,
        description=(
            "Our position from the operator's sheet: capacity / cbc / limits / filled / "
            "realized, each corridor → delivery hour (0-23) → value"
        ),
    )
    warnings: list[str] = Field(default_factory=list)

    def position_summary(self) -> list[str]:
        """One line per corridor held, for the ingest reply."""
        out = []
        for corridor, hours in sorted(self.bids.get("capacity", {}).items()):
            held = {h: mw for h, mw in hours.items() if mw}
            if not held:
                continue
            bits = [f"{corridor} {max(held.values()):.0f} MW × {len(held)}h"]
            cbc = [v for h, v in self.bids.get("cbc", {}).get(corridor, {}).items() if h in held]
            if cbc:
                bits.append(f"CBC {min(cbc):.2f}–{max(cbc):.2f}")
            filled = [v for v in self.bids.get("filled", {}).get(corridor, {}).values() if v]
            if filled:
                bits.append(f"prins {len(filled)}h")
            realized = self.bids.get("realized", {}).get(corridor, {})
            if realized:
                bits.append(f"rezultat raportat €{sum(realized.values()):,.0f}")
            out.append(" · ".join(bits))
        return out


def _num(raw: str) -> float:
    return float(raw.replace(",", "."))


def _set_price(intake: OpsIntake, zone: str, hour: int, price: float, where: int | str) -> None:
    """First value wins: explicit detail sheets beat bulk matrix defaults."""
    existing = intake.prices_override.setdefault(zone, {})
    if hour in existing:
        if existing[hour] != price:
            intake.warnings.append(
                f"{where}: {zone} ora {hour} are deja {existing[hour]} — se păstrează prima valoare"
            )
        return
    existing[hour] = price


def _feed_line(line: str, intake: OpsIntake, lineno: int | str) -> bool:
    """Feed one free-form line into the intake. Returns True if understood."""
    matched = False
    skipped: set[str] = set()
    for m in SKIP_RE.finditer(line):
        raw = m.group("b1") or m.group("b2")
        border = normalize_border(raw)
        if border not in REGISTRY:
            intake.warnings.append(f"linia {lineno}: graniță necunoscută '{raw}' — ignorată")
            continue
        intake.availability[border] = 0.0
        intake.decisions.append(f"{border} exclus (decizie operator: '{line.strip()[:60]}')")
        skipped.add(border)
        matched = True
    for m in BORDER_RE.finditer(line):
        border = normalize_border(m.group("border"))
        if border in skipped:
            continue
        if border not in REGISTRY:
            intake.warnings.append(
                f"linia {lineno}: graniță necunoscută '{m.group('border')}' — ignorată"
            )
            continue
        intake.availability[border] = _num(m.group("mw"))
        matched = True
    for m in INTERVAL_PRICE_RE.finditer(line):
        interval = int(m.group("interval"))
        if not 1 <= interval <= 24:
            intake.warnings.append(f"linia {lineno}: interval {interval} invalid — ignorat")
            continue
        intake.unassigned_prices[interval - 1] = _num(m.group("price"))
        matched = True
    if intake.unassigned_prices and not any("fără zonă" in w for w in intake.warnings):
        intake.warnings.append(
            "prețuri pe interval fără zonă — specificați piața (RO/UA/MD) ca să fie folosite"
        )
    for m in PRICE_RE.finditer(line):
        zone = m.group("zone").upper()
        if zone not in KNOWN_ZONES:
            continue
        hour = int(m.group("hour"))
        if not 0 <= hour <= 23:
            intake.warnings.append(f"linia {lineno}: ora {hour} invalidă — ignorată")
            continue
        _set_price(intake, zone, hour, _num(m.group("price")), f"linia {lineno}")
        matched = True
    if not matched:
        intake.warnings.append(f"linia {lineno}: format nerecunoscut — ignorată ('{line[:60]}')")
    return matched


def parse_daily_note(text: str, day: str = "") -> OpsIntake:
    """Parse a pasted daily-operations note into availability + price overrides."""
    intake = OpsIntake(day=day)
    for lineno, line in enumerate(text.splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        _feed_line(line, intake, lineno)
    return intake


class OverrideProvider(MarketDataProvider):
    """Wrap a base provider, replacing individual zone×hour prices.

    ``overrides`` maps zone → hour (0-23) → price in EUR/MWh, e.g. from
    ``parse_daily_note``. Everything else falls through to the base feed.
    """

    def __init__(
        self, base: MarketDataProvider, day: datetime, overrides: dict[str, dict[int, float]]
    ):
        self.base = base
        self.day = day.replace(hour=0, minute=0, second=0, microsecond=0)
        self.overrides = {
            z: {int(h): float(p) for h, p in hours.items()} for z, hours in overrides.items()
        }

    def day_ahead(self, zones: list[str], day: datetime) -> list[PricePoint]:
        points = self.base.day_ahead(zones, day)
        for p in points:
            if p.delivery_start.date() != self.day.date():
                continue
            override = self.overrides.get(p.zone, {}).get(p.delivery_start.hour)
            if override is not None:
                p.price_eur_mwh = override
        return points


def _cell_text(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def _is_hour_header(cells: list[str]) -> list[int] | None:
    """Detect an hour-matrix header: ≥6 integers in 0–23. Returns hour per column."""
    hours: list[int | None] = []
    hits = 0
    for c in cells:
        try:
            h = int(float(c))
            if 0 <= h <= 23 and str(int(float(c))) == c.strip():
                hours.append(h)
                hits += 1
                continue
        except (ValueError, TypeError):
            pass
        hours.append(None)
    if hits >= 6:
        return hours  # type: ignore[return-value]
    return None


def _looks_like_border_table(cells: list[str]) -> bool:
    text = " ".join(cells).lower()
    return ("granit" in text or "border" in text or "frontier" in text) and (
        "atc" in text or "ntc" in text or "mw" in text or "capacitate" in text or "capacity" in text
    )


def _looks_like_price_table(cells: list[str]) -> bool:
    tokens = " ".join(cells).lower().split()
    text = " ".join(tokens)
    return (
        ("zon" in text or "zone" in text)
        and any(t.startswith("or") or t in ("hour", "h") for t in tokens)
        and ("pre" in text or "price" in text)
    )


_NUM_RE = re.compile(r"[-+]?\d+(?:[.,]\d+)?")


def _as_number(raw: str) -> float | None:
    """Cell → float for '15', '0,23', '€ 1.250,5', '-1'; None for text/blank."""
    txt = raw.strip().replace("€", "").replace("EUR", "").replace(" ", "")
    if not txt or txt in {"-", "—", "n/a", "N/A"}:
        return None
    if txt.count(",") == 1 and txt.count(".") >= 1:  # 1.250,5 → 1250.5
        txt = txt.replace(".", "").replace(",", ".")
    elif txt.count(".") > 1:  # 1.250.000
        txt = txt.replace(".", "")
    else:
        txt = txt.replace(",", ".")
    try:
        return float(txt)
    except ValueError:
        return None


def corridor_key(text: str) -> str | None:
    """'Ua - Md' → 'UA-MD', 'Transfer' → 'UA-MD-RO', anything else → None."""
    t = re.sub(r"\s+", "", text.upper()).replace("/", "-").replace("→", "-").replace(">", "-")
    if t in {"TRANSFER", "TRANZIT", "TRANSIT", "UA-MD-RO", "UAMDRO"}:
        return "UA-MD-RO"
    if re.fullmatch(r"[A-Z]{2}(?:-[A-Z]{2}){1,2}", t):
        ic, _, _ = corridor_ic(t)
        return t if ic else None
    return None


def _position_kind(text: str) -> str | None:
    low = text.lower()
    for kind, needles in POSITION_KINDS:
        if any(n in low for n in needles):
            return kind
    return None


def _price_zone(text: str) -> str | None:
    low = text.lower()
    if not ("price" in low or "pret" in low or "preț" in low or "dam" in low or "pzu" in low):
        return None
    for tok in re.findall(r"[A-Za-z]{2,3}", text):
        if tok.upper() in KNOWN_ZONES:
            return tok.upper()
    return None


def _position_columns(head: list[str], sub: list[str]) -> dict[int, tuple[str, str]] | None:
    """Map column → (kind, corridor|zone|"") for the operator's position sheet.

    ``head`` is the group row (``Intervals CET | Capacity won | CBC Price | Bid Limit
    Price | Nominated | Ro Price``); merged group cells span the corridor sub-header
    ``sub`` (``Ua-Md | Md-Ro | Ro-Ua | Ua-Ro | Transfer``). Single-row headers such as
    ``Capacity won Ro-Ua`` work too. Returns None when this is not that table.
    """
    joined = " ".join(head).lower()
    if not any(k in joined for k in ("capacity won", "cbc", "bid limit", "nominat", "filled")):
        return None
    if any(_as_number(c) is not None for c in sub) or not any(corridor_key(c) for c in sub):
        sub = []
    cols: dict[int, tuple[str, str]] = {}
    group = ""
    for j in range(max(len(head), len(sub))):
        if j < len(head) and head[j]:
            group = head[j]
        corridor = (corridor_key(head[j]) if j < len(head) and corridor_key(head[j]) else None) or (
            corridor_key(sub[j]) if j < len(sub) else None
        )
        low = group.lower()
        zone = _price_zone(group)
        if zone and not corridor:
            cols[j] = ("price", zone)
        elif corridor and (kind := _position_kind(group)):
            cols[j] = (kind, corridor)
        elif not corridor and any(k in low for k in ("interval", "ora", "hour", "cet")):
            cols[j] = ("interval", "")
    if not any(kind not in ("price", "interval") for kind, _ in cols.values()):
        return None
    return cols


DAY_TOTAL = -1  # hour key for a per-day figure (the operator's summary sheet has no hours)


def _is_summary_header(cells: list[str]) -> bool:
    """The operator's monthly *Import / Export* sheet: 'AZI Import/Export | TOTAL ...'."""
    low = " ".join(cells).lower()
    return ("azi" in low or "today" in low or "astazi" in low or "astăzi" in low) and (
        "import" in low or "export" in low or "profit" in low
    )


def _summary_row(cells: list[str], state: dict) -> tuple[str, float | None, float | None] | None:
    """One leg row of the summary → (corridor, MW today, profit today).

    Rows are ``group | size | leg | MW azi | Profit azi | MW total | Profit total``;
    the group cell is merged down over its legs. ``group X-Y`` + ``leg Y-Z`` is the
    transit ``X-Y-Z``; ``group X-Y`` + ``leg X-Y`` (or a lone label) is the direct border.
    """
    tokens = [(j, corridor_key(c)) for j, c in enumerate(cells) if corridor_key(c)]
    if not tokens:
        return None
    if len(tokens) >= 2:
        (gcol, group), (lcol, leg) = tokens[0], tokens[-1]
        state["group"], state["gcol"], state["lcol"] = group, gcol, lcol
    else:
        lcol, leg = tokens[0]
        gcol = state.get("gcol", 0)
        group_cell = cells[gcol].strip() if gcol < len(cells) else ""
        if state.get("group") and lcol == state.get("lcol") and not group_cell:
            group = state["group"]  # continuation row under a merged group cell
        else:
            group, state["group"] = leg, None
    if group != leg and group.count("-") == 1 and leg.count("-") == 1:
        a, b = group.split("-")
        c, d = leg.split("-")
        corridor = f"{a}-{b}-{d}" if b == c else leg
    else:
        corridor = leg
    nums = [_as_number(c) for c in cells[lcol + 1 :]]
    nums = [n for n in nums if n is not None]
    if not nums:
        return None
    mw_today = nums[0] if len(nums) >= 2 else None
    profit_today = nums[1] if len(nums) >= 2 else nums[0]
    return corridor, mw_today, profit_today


def _rows_into_intake(rows: list[list[str]], intake: OpsIntake, title: str) -> None:
    """Feed one sheet (or CSV) of rows into the intake, detecting each table's layout."""
    mode: str | None = None
    hour_cols: list[int | None] = []
    pos_cols: dict[int, tuple[str, str]] = {}
    pos_icol = 0
    skip_next = False
    summary_state: dict = {}
    for idx, cells in enumerate(rows):
        row_idx = idx + 1
        if skip_next:
            skip_next = False
            continue
        if not any(cells):
            continue
        if mode == "summary":
            low = cells[0].strip().lower()
            if low.startswith(("total", "sum")):
                mode = None
                continue
            if " ".join(cells).lower().strip() in ("mw profit mw profit", "mw profit"):
                continue  # the MW | Profit sub-header
            parsed = _summary_row(cells, summary_state)
            if parsed is None:
                if any(corridor_key(c) for c in cells):
                    continue  # a group label row without figures
                mode = None
            else:
                corridor, _mw, profit = parsed
                tab = intake.bids.setdefault("realized", {}).setdefault(corridor, {})
                tab[DAY_TOTAL] = tab.get(DAY_TOTAL, 0.0) + (profit or 0.0)
                continue
        if mode == "position":
            raw = cells[pos_icol] if pos_icol < len(cells) else ""
            n = _as_number(raw)
            if n is None or not 1 <= n <= 24 or n != int(n):
                mode = None
                if cells[0].strip().lower().startswith(("total", "sum", "media", "avg")):
                    continue
            else:
                hour = int(n) - 1
                for col, (kind, key) in pos_cols.items():
                    val = _as_number(cells[col]) if col < len(cells) else None
                    if val is None:
                        continue
                    if kind == "price":
                        _set_price(intake, key, hour, val, f"{title}:{row_idx}")
                    elif kind != "interval":
                        intake.bids.setdefault(kind, {}).setdefault(key, {})[hour] = val
                continue
        if mode is None:
            if _is_summary_header(cells):
                mode = "summary"
                summary_state = {}
                continue
            filled_cells = [c for c in cells if c]
            if (
                len(filled_cells) == 1
                and not any(ch.isdigit() for ch in filled_cells[0])
                and not SKIP_RE.search(filled_cells[0])
            ):
                continue  # a sheet title such as "Import / Export" or "UA-MD-RO"
            nxt = rows[idx + 1] if idx + 1 < len(rows) else []
            cols = _position_columns(cells, nxt)
            if cols:
                mode = "position"
                pos_cols = {c: kc for c, kc in cols.items() if kc[0] != "interval"}
                pos_icol = next((c for c, kc in cols.items() if kc[0] == "interval"), 0)
                skip_next = bool(nxt) and any(corridor_key(c) for c in nxt)
                continue
            hour_cols = _is_hour_header(cells) or []
            if hour_cols:
                mode = "matrix"
                continue
            if _looks_like_border_table(cells):
                mode = "borders"
                continue
            if _looks_like_price_table(cells):
                mode = "prices"
                continue
            _feed_line(" ".join(c for c in cells if c), intake, f"{title}:{row_idx}")
            continue
        if mode == "matrix":
            zone = (cells[0] or "").upper()
            if zone not in KNOWN_ZONES:
                mode = None
                _feed_line(" ".join(c for c in cells if c), intake, f"{title}:{row_idx}")
                continue
            for col, hour in enumerate(hour_cols):
                if hour is None or col >= len(cells) or not cells[col]:
                    continue
                try:
                    _set_price(
                        intake,
                        zone,
                        hour,
                        float(cells[col].replace(",", ".")),
                        f"{title}:{row_idx}",
                    )
                except ValueError:
                    intake.warnings.append(
                        f"{title}:{row_idx}: preț invalid '{cells[col]}' — ignorat"
                    )
        elif mode == "borders":
            border_raw = cells[0].upper().replace("/", "-")
            border = normalize_border(border_raw)
            mw = next((c for c in cells[1:] if re.fullmatch(r"\d+(?:[.,]\d+)?", c)), "")
            if border in REGISTRY and mw:
                intake.availability[border] = _num(mw)
            else:
                mode = None
        elif mode == "prices":
            zone = (cells[0] or "").upper()
            try:
                hour = int(float(cells[1])) if len(cells) > 1 and cells[1] else -1
                price = float(cells[2].replace(",", ".")) if len(cells) > 2 and cells[2] else None
            except ValueError:
                hour, price = -1, None
            if zone in KNOWN_ZONES and 0 <= hour <= 23 and price is not None:
                _set_price(intake, zone, hour, price, f"{title}:{row_idx}")
            else:
                mode = None


def read_excel_ops(data: bytes, day: str = "") -> OpsIntake:
    """Parse a daily-operations ``.xlsx`` workbook into availability + overrides + position.

    Understands, per sheet: the operator's position table (Capacity won / CBC Price /
    Bid Limit Price / Nominated / Profit per corridor × CET interval, with Ro/Ua Price
    columns), hour-matrix layout (zones × hours 0–23), header tables (border/ATC or
    zone/hour/price), and free-form rows.
    """
    from openpyxl import load_workbook
    from openpyxl.utils.exceptions import InvalidFileException

    intake = OpsIntake(day=day)
    try:
        wb = load_workbook(BytesIO(data), data_only=True, read_only=True)
    except (InvalidFileException, BadZipFile, OSError, ValueError) as exc:
        intake.warnings.append(f"fișier Excel invalid: {exc}")
        return intake
    for sheet in wb.worksheets:
        if HELP_SHEET_RE.match(sheet.title):
            continue
        rows = [[_cell_text(v) for v in row] for row in sheet.iter_rows(values_only=True)]
        _rows_into_intake(rows, intake, sheet.title)
    return intake


def read_csv_ops(data: bytes, day: str = "", title: str = "csv") -> OpsIntake:
    """Same layouts as :func:`read_excel_ops`, from a ``.csv`` export (``,`` ``;`` or tab)."""
    import csv as _csv

    intake = OpsIntake(day=day)
    text = data.decode("utf-8-sig", errors="replace")
    sample = text[:2048]
    delim = max((",", ";", "\t"), key=sample.count)
    rows = [[c.strip() for c in r] for r in _csv.reader(text.splitlines(), delimiter=delim)]
    _rows_into_intake(rows, intake, title)
    return intake


def read_table_ops(data: bytes, filename: str, day: str = "") -> OpsIntake:
    """Dispatch an uploaded operations file by extension (.xlsx/.xlsm or .csv)."""
    if filename.lower().endswith(".csv"):
        return read_csv_ops(data, day=day, title=Path(filename).stem)
    return read_excel_ops(data, day=day)


def _hour_cet(raw: str) -> int:
    """CSV ``hour_cet`` → 1-24, or 0 for the per-day row (``day``/``total``)."""
    raw = raw.strip().lower()
    return 0 if raw in ("day", "total", "zi", "") else int(float(raw))


def _num_cell(v: float) -> str:
    return f"{v:.4f}".rstrip("0").rstrip(".") if v != int(v) else str(int(v))


def write_bids_csv(path: str | Path, bids: dict, day: str) -> dict:
    """Merge the operator's position into ``data/bids_<day>.csv`` (the twin's input).

    Rows are corridor × CET interval. Existing rows keep their notes and any column
    the new sheet does not carry, so the morning's auction result and the evening's
    fills/results land in the same file. Rows with no capacity, fill or result are
    dropped (a 0 MW corridor in the sheet is not a position).
    """
    import csv as _csv

    path = Path(path)
    field_of = {
        "capacity": "capacity_mw",
        "cbc": "cbc_price_eur_mwh",
        "limits": "bid_limit_eur_mwh",
        "filled": "filled_mw",
        "realized": "realized_eur",
    }
    rows: dict[tuple[str, int], dict[str, str]] = {}
    if path.exists():
        with open(path, newline="") as f:
            for r in _csv.DictReader(f):
                key = (r["corridor"].strip().upper(), _hour_cet(r["hour_cet"]))
                rows[key] = {c: (r.get(c) or "").strip() for c in BID_COLUMNS}
    changed = 0
    corridors = {c for kind in bids.values() for c in kind}
    for corridor in sorted(corridors):
        hours = {h for kind in bids.values() for h in kind.get(corridor, {})}
        for h in sorted(hours):
            get = lambda k, c=corridor, hh=h: bids.get(k, {}).get(c, {}).get(hh)
            cap, filled, realized = get("capacity"), get("filled"), get("realized")
            key = (corridor, h + 1)  # the day-total pseudo hour lands on 0
            if not cap and not filled and not realized and key not in rows:
                continue
            row = rows.setdefault(
                key,
                dict.fromkeys(BID_COLUMNS, "")
                | {
                    "delivery_day": day,
                    "corridor": corridor,
                    "hour_cet": "day" if h == DAY_TOTAL else str(h + 1),
                },
            )
            for kind, field in field_of.items():
                v = get(kind)
                if v is None:
                    continue
                old = _as_number(row.get(field, ""))
                if old is None or abs(old - v) > 1e-9:
                    changed += 1
                row[field] = _num_cell(v)
            if not _as_number(row["capacity_mw"]) and filled:
                row["capacity_mw"] = _num_cell(filled)
                row["note"] = (row["note"] + "; " if row["note"] else "") + "capacity = fill"
    rows = {
        k: r
        for k, r in rows.items()
        if _as_number(r["capacity_mw"]) or r["filled_mw"] or r["realized_eur"]
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="") as f:
        w = _csv.DictWriter(f, fieldnames=BID_COLUMNS)
        w.writeheader()
        for key in sorted(rows):
            w.writerow(rows[key])
    return {
        "path": str(path),
        "rows": len(rows),
        "changed": changed,
        "corridors": sorted({k[0] for k in rows}),
    }


NTC_COLUMNS = ("UA_RO_value", "RO_UA_value", "UA_MD_value", "MD_UA_value")


def load_ntc_csv(path: str) -> dict[str, dict[int, float]]:
    """Load a directional hourly NTC table (e.g. data/ntc_2026-09-12.csv).

    Returns availability keyed by directional border (``UA-RO``, ``RO-UA``,
    ``UA-MD``, ``MD-UA``) with delivery hour (0-23) → MW. Table hours are
    CET 1-24; hour *h* maps to delivery hour *h-1*. Uses the ``*_value``
    (available) columns, not ``*_max``.
    """
    import csv as _csv

    availability: dict[str, dict[int, float]] = {}
    with open(path, newline="") as f:
        for row in _csv.DictReader(f):
            hour = int(row["hour_cet"]) - 1
            for col in NTC_COLUMNS:
                border = col.replace("_value", "").replace("_", "-")
                availability.setdefault(border, {})[hour] = float(row[col])
    return availability


def load_bids_csv(path: str | Path) -> dict[str, dict[str, dict[int, float]]]:
    """Load the day's capacity-auction result (e.g. data/bids_2026-09-14.csv).

    One row per corridor × CET interval we *won*: ``capacity_mw`` held,
    ``cbc_price_eur_mwh`` paid for it and, optionally, the ``bid_limit_eur_mwh``
    the operator set for the energy leg, ``filled_mw`` actually executed and
    ``realized_eur`` the result the operator books for that hour.
    Returns ``{"capacity", "cbc", "limits", "filled", "realized"}`` keyed by corridor
    (``RO-UA``, ``MD-RO``, ``UA-MD-RO``) → delivery hour → value.
    Unlike the NTC table this is our position, not the market's offer.
    """
    import csv as _csv

    out: dict[str, dict[str, dict[int, float]]] = {
        "capacity": {},
        "cbc": {},
        "limits": {},
        "filled": {},
        "realized": {},
    }
    with open(path, newline="") as f:
        for row in _csv.DictReader(f):
            corridor = row["corridor"].strip().upper()
            hour = _hour_cet(row["hour_cet"]) - 1
            if hour == DAY_TOTAL:  # per-day figures only (e.g. the summary sheet's profit)
                realized = (row.get("realized_eur") or "").strip()
                if realized:
                    out["realized"].setdefault(corridor, {})[DAY_TOTAL] = float(realized)
                continue
            mw = float(row.get("capacity_mw") or 0)
            out["capacity"].setdefault(corridor, {})[hour] = (
                out["capacity"].get(corridor, {}).get(hour, 0.0) + mw
            )
            out["cbc"].setdefault(corridor, {})[hour] = float(row.get("cbc_price_eur_mwh") or 0)
            limit = (row.get("bid_limit_eur_mwh") or "").strip()
            if limit:
                out["limits"].setdefault(corridor, {})[hour] = float(limit)
            filled = (row.get("filled_mw") or "").strip()
            if not filled:  # "nominated 15 MW" in the note column is a fill report too
                m = re.search(
                    r"nominat\w*\s+(\d+(?:[.,]\d+)?)\s*MW", row.get("note") or "", re.IGNORECASE
                )
                filled = m.group(1).replace(",", ".") if m else ""
            if filled:
                out["filled"].setdefault(corridor, {})[hour] = float(filled)
            realized = (row.get("realized_eur") or "").strip()
            if realized:
                out["realized"].setdefault(corridor, {})[hour] = float(realized)
    return out
