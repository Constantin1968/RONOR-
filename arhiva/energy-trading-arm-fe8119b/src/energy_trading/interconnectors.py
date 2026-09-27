"""Registry of European interconnectors used by the agent."""

from energy_trading.models import Coupling, Interconnector

# NTC/ATC values are representative defaults (MW); the agent overwrites them
# with live JAO/ENTSO-E nominations when available.
INTERCONNECTORS: list[Interconnector] = [
    Interconnector(
        id="FR-DE",
        from_zone="FR",
        to_zone="DE-LU",
        capacity_mw=2800,
        tariff_eur_mwh=0.35,
        loss_pct=0.4,
        coupling=Coupling.IMPLICIT,
        tso="RTE/Amprion",
    ),
    Interconnector(
        id="DE-NL",
        from_zone="DE-LU",
        to_zone="NL",
        capacity_mw=2600,
        tariff_eur_mwh=0.30,
        loss_pct=0.3,
        coupling=Coupling.IMPLICIT,
        tso="TenneT",
    ),
    Interconnector(
        id="BE-NL",
        from_zone="BE",
        to_zone="NL",
        capacity_mw=2400,
        tariff_eur_mwh=0.25,
        loss_pct=0.3,
        coupling=Coupling.IMPLICIT,
        tso="Elia/TenneT",
    ),
    Interconnector(
        id="FR-ES",
        from_zone="FR",
        to_zone="ES",
        capacity_mw=2800,
        tariff_eur_mwh=0.60,
        loss_pct=0.8,
        coupling=Coupling.IMPLICIT,
        tso="RTE/REE",
    ),
    Interconnector(
        id="DE-DK1",
        from_zone="DE-LU",
        to_zone="DK1",
        capacity_mw=2500,
        tariff_eur_mwh=0.30,
        loss_pct=0.5,
        coupling=Coupling.IMPLICIT,
        tso="TenneT/Energinet",
    ),
    Interconnector(
        id="DE-NO2-NORDLINK",
        from_zone="DE-LU",
        to_zone="NO2",
        capacity_mw=1400,
        tariff_eur_mwh=0.80,
        loss_pct=1.2,
        coupling=Coupling.IMPLICIT,
        tso="TenneT/Statnett",
    ),
    Interconnector(
        id="IFA2-GB-FR",
        from_zone="GB",
        to_zone="FR",
        capacity_mw=1014,
        tariff_eur_mwh=1.10,
        loss_pct=1.0,
        coupling=Coupling.EXPLICIT,
        tso="NG/RTE",
    ),
    Interconnector(
        id="GB-NL-BRITNED",
        from_zone="GB",
        to_zone="NL",
        capacity_mw=1000,
        tariff_eur_mwh=1.05,
        loss_pct=1.0,
        coupling=Coupling.EXPLICIT,
        tso="NG/TenneT",
    ),
    Interconnector(
        id="DE-PL",
        from_zone="DE-LU",
        to_zone="PL",
        capacity_mw=2000,
        tariff_eur_mwh=0.40,
        loss_pct=0.6,
        coupling=Coupling.IMPLICIT,
        tso="50Hertz/PSE",
    ),
    Interconnector(
        id="AT-IT-N",
        from_zone="AT",
        to_zone="IT-N",
        capacity_mw=1200,
        tariff_eur_mwh=0.90,
        loss_pct=0.7,
        coupling=Coupling.IMPLICIT,
        tso="APG/Terna",
    ),
    Interconnector(
        id="CH-IT-N",
        from_zone="CH",
        to_zone="IT-N",
        capacity_mw=1800,
        tariff_eur_mwh=1.20,
        loss_pct=0.9,
        coupling=Coupling.EXPLICIT,
        tso="Swissgrid/Terna",
    ),
    Interconnector(
        id="FR-IT",
        from_zone="FR",
        to_zone="IT-N",
        capacity_mw=2650,
        tariff_eur_mwh=0.55,
        loss_pct=0.7,
        coupling=Coupling.IMPLICIT,
        tso="RTE/Terna",
    ),
    # --- Eastern borders: RO / UA / MD (outside SDAC → explicit auctions) ---
    Interconnector(
        id="RO-UA",
        from_zone="RO",
        to_zone="UA",
        capacity_mw=600,
        tariff_eur_mwh=0.90,
        loss_pct=1.0,
        coupling=Coupling.EXPLICIT,
        tso="Transelectrica/Ukrenergo",
    ),
    Interconnector(
        id="UA-MD",
        from_zone="UA",
        to_zone="MD",
        capacity_mw=700,
        tariff_eur_mwh=0.80,
        loss_pct=1.0,
        coupling=Coupling.EXPLICIT,
        tso="Ukrenergo/Molselectrica",
    ),
    Interconnector(
        id="RO-MD",
        from_zone="RO",
        to_zone="MD",
        capacity_mw=500,
        tariff_eur_mwh=0.70,
        loss_pct=0.9,
        coupling=Coupling.EXPLICIT,
        tso="Transelectrica/Molselectrica",
    ),
    # --- Wheeling / transit paths via MD (combined tariff + losses) ---
    Interconnector(
        id="UA-MD-RO",
        from_zone="UA",
        to_zone="RO",
        capacity_mw=500,
        tariff_eur_mwh=1.90,
        loss_pct=1.9,
        coupling=Coupling.EXPLICIT,
        tso="Ukrenergo/Molselectrica/Transelectrica",
    ),
    Interconnector(
        id="RO-MD-UA",
        from_zone="RO",
        to_zone="UA",
        capacity_mw=500,
        tariff_eur_mwh=1.90,
        loss_pct=1.9,
        coupling=Coupling.EXPLICIT,
        tso="Transelectrica/Molselectrica/Ukrenergo",
    ),
    # --- Regional hub spokes: RO ↔ BG / RS / HU (SDAC-coupled, RO reference) ---
    Interconnector(
        id="RO-BG",
        from_zone="RO",
        to_zone="BG",
        capacity_mw=800,
        tariff_eur_mwh=0.40,
        loss_pct=0.6,
        coupling=Coupling.IMPLICIT,
        tso="Transelectrica/ESO",
    ),
    Interconnector(
        id="RO-RS",
        from_zone="RO",
        to_zone="RS",
        capacity_mw=600,
        tariff_eur_mwh=0.60,
        loss_pct=0.7,
        coupling=Coupling.EXPLICIT,
        tso="Transelectrica/EMS",
    ),
    Interconnector(
        id="RO-HU",
        from_zone="RO",
        to_zone="HU",
        capacity_mw=1000,
        tariff_eur_mwh=0.40,
        loss_pct=0.5,
        coupling=Coupling.IMPLICIT,
        tso="Transelectrica/MAVIR",
    ),
]

REGISTRY: dict[str, Interconnector] = {ic.id: ic for ic in INTERCONNECTORS}

# Directional aliases used in daily-ops notes ("UA/RO", "MD/UA" …).
# The engine evaluates both flow directions per border, so aliases map
# to the canonical physical border id.
BORDER_ALIASES: dict[str, str] = {
    "UA-RO": "RO-UA",
    "MD-UA": "UA-MD",
    "MD-RO": "RO-MD",
    "RO-UA-MD": "UA-MD-RO",
    "UA-RO-MD": "UA-MD-RO",
    "BG-RO": "RO-BG",
    "RS-RO": "RO-RS",
    "HU-RO": "RO-HU",
}

ZONES: list[str] = sorted(
    {*([ic.from_zone for ic in INTERCONNECTORS] + [ic.to_zone for ic in INTERCONNECTORS])}
)


def get_interconnector(border_id: str) -> Interconnector:
    canonical = BORDER_ALIASES.get(border_id.strip().upper().replace("/", "-"), border_id)
    try:
        return REGISTRY[canonical]
    except KeyError:
        raise ValueError(f"Unknown interconnector '{border_id}'. Known: {sorted(REGISTRY)}")


def normalize_border(border_id: str) -> str:
    """Map directional spellings (UA/RO, MD/UA, …) to the canonical border id."""
    key = border_id.strip().upper().replace("/", "-")
    return BORDER_ALIASES.get(key, key)


def corridor_ic(corridor: str) -> tuple[Interconnector | None, str, str]:
    """Interconnector + flow direction for a directional corridor key.

    ``RO-UA`` → (RO-UA border, RO, UA); ``MD-RO`` → (RO-MD border, MD, RO);
    ``UA-MD-RO`` → (that transit, UA, RO). Transit keys must match a registered id.
    """
    corridor = corridor.strip().upper()
    if corridor.count("-") >= 2:
        ic = REGISTRY.get(corridor)
        return (ic, ic.from_zone, ic.to_zone) if ic else (None, "", "")
    a, _, b = corridor.partition("-")
    for ic in INTERCONNECTORS:
        if ic.id.count("-") == 1 and {ic.from_zone, ic.to_zone} == {a, b}:
            return ic, a, b
    return None, a, b


def borders_for_zone(zone: str) -> list[Interconnector]:
    return [ic for ic in INTERCONNECTORS if ic.from_zone == zone or ic.to_zone == zone]
