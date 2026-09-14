"""Sovereignty layer: provenance, energy accounting, import-dependence.

Operational translation of the governing doctrine (constitutional runtime):

- **Record as provenance** — every agent run, nomination and settlement is
  filed in the claims register with its evidence level, so no figure travels
  without its sources (cf. Research Agenda: claims register + release criteria).
- **Energy-to-intelligence accounting** — each trade carries its physical
  chain (MWh moved, estimated carbon) reported *alongside* economics, never
  collapsed into a single opaque score (cf. Workstream 2).
- **Sovereignty, dependency and exit** — the home-zone balance shows whether
  flows build domestic position or deepen import dependence, and the provider
  interface keeps the data source substitutable (cf. concordance: sovereignty).
"""

from __future__ import annotations

import itertools
from datetime import UTC, datetime

from pydantic import BaseModel, Field

from energy_trading.models import Trade

# Default generation-mix carbon estimates (gCO2/kWh). Explicitly provisional:
# override with TSO/ENTSO-E published factors before compliance use.
CARBON_G_PER_KWH: dict[str, float] = {
    "UA": 80.0,  # nuclear + hydro dominated
    "RO": 180.0,  # hydro + nuclear + gas/coal
    "MD": 350.0,  # gas + import dependent
    "FR": 50.0,
    "DE-LU": 350.0,
    "NL": 350.0,
    "BE": 150.0,
    "ES": 180.0,
    "IT-N": 350.0,
    "CH": 30.0,
    "AT": 150.0,
    "DK1": 150.0,
    "NO2": 20.0,
    "GB": 250.0,
    "PL": 650.0,
}

EVIDENCE_SIMULATED = "simulated"
EVIDENCE_OPERATOR = "operator_provided"
EVIDENCE_TSO = "tso_validated"
EVIDENCE_PUBLISHED = "market_published"  # clearing price read from the exchange itself


class ClaimEntry(BaseModel):
    id: str
    timestamp: datetime = Field(default_factory=lambda: datetime.now(UTC))
    kind: str = Field(description="run | nomination | settlement | sovereignty")
    statement: str
    evidence_level: str = EVIDENCE_SIMULATED
    inputs_ref: str = ""
    status: str = "provisional"  # provisional | confirmed


class ClaimsRegister:
    """Append-only register: every public figure links to its evidence level."""

    def __init__(self) -> None:
        self._seq = itertools.count(1)
        self.entries: list[ClaimEntry] = []

    def file(
        self,
        kind: str,
        statement: str,
        evidence_level: str = EVIDENCE_SIMULATED,
        inputs_ref: str = "",
    ) -> ClaimEntry:
        entry = ClaimEntry(
            id=f"CLM-{next(self._seq):04d}",
            kind=kind,
            statement=statement,
            evidence_level=evidence_level,
            inputs_ref=inputs_ref,
        )
        self.entries.append(entry)
        return entry

    def restore(self, entries: list[dict]) -> int:
        """Reload persisted entries and continue numbering after the highest id."""
        self.entries = [ClaimEntry.model_validate(e) for e in entries]
        high = max((int(e.id.split("-")[-1]) for e in self.entries), default=0)
        self._seq = itertools.count(high + 1)
        return len(self.entries)

    def confirm(self, claim_id: str) -> ClaimEntry | None:
        for e in self.entries:
            if e.id == claim_id:
                e.status = "confirmed"
                return e
        return None

    def list(self, kind: str | None = None) -> list[ClaimEntry]:
        return [e for e in self.entries if kind is None or e.kind == kind]


def trade_energy_mwh(trade: Trade, hours: float = 1.0) -> float:
    """Physical energy moved by a 1-hour cross-border product (MWh)."""
    return round(trade.volume_mw * hours, 2)


def trade_carbon_t(trade: Trade) -> float:
    """Estimated CO2 attributed to the source-zone generation (tonnes)."""
    factor = CARBON_G_PER_KWH.get(trade.from_zone, 250.0)
    return round(trade_energy_mwh(trade) * factor / 1_000_000, 3)


def energy_report(trades: list[Trade]) -> dict:
    """Workstream-2 style ledger: energy, carbon and economics side by side."""
    lines = [
        {
            "trade_id": t.id,
            "border": t.interconnector_id,
            "flow": f"{t.from_zone}->{t.to_zone}",
            "mwh": trade_energy_mwh(t),
            "carbon_t": trade_carbon_t(t),
            "expected_pnl_eur": t.expected_pnl,
        }
        for t in trades
    ]
    return {
        "lines": lines,
        "total_mwh": round(sum(line["mwh"] for line in lines), 2),
        "total_carbon_t": round(sum(line["carbon_t"] for line in lines), 3),
        "total_expected_pnl_eur": round(sum(line["expected_pnl_eur"] for line in lines), 2),
        "carbon_defaults": "provisional estimates — override with TSO factors",
    }


def sovereignty_report(
    trades: list[Trade], home_zone: str, concentration_limit: float = 0.6
) -> dict:
    """Home-zone balance: exports vs imports, dependence, concentration.

    Flags when traded flows concentrate on one border beyond the limit
    (dependency risk) or when the home zone is a structural net importer
    across the booked portfolio.
    """
    home = home_zone.upper()
    exports = sum(t.volume_mw for t in trades if t.from_zone == home)
    imports = sum(t.volume_mw for t in trades if t.to_zone == home)
    external = sum(t.volume_mw for t in trades if t.from_zone != home and t.to_zone != home)
    total = exports + imports + external
    per_border: dict[str, float] = {}
    for t in trades:
        per_border[t.interconnector_id] = per_border.get(t.interconnector_id, 0.0) + t.volume_mw
    flags: list[str] = []
    if total > 0:
        for border, mw in per_border.items():
            if mw / total > concentration_limit:
                flags.append(
                    f"{border} concentrează {mw / total:.0%} din volum (limita {concentration_limit:.0%})"
                )
    if imports > exports and (imports - exports) > 0:
        flags.append(
            f"{home} este importator net: {imports - exports:.0f} MW import net în portofoliu"
        )
    return {
        "home_zone": home,
        "exports_mw": round(exports, 1),
        "imports_mw": round(imports, 1),
        "transit_mw": round(external, 1),
        "net_mw": round(exports - imports, 1),
        "import_dependence": round(imports / total, 3) if total else 0.0,
        "per_border_mw": {k: round(v, 1) for k, v in per_border.items()},
        "flags": flags,
    }
