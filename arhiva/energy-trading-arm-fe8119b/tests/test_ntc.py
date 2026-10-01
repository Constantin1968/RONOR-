from datetime import UTC, datetime

from energy_trading.arbitrage import find_opportunities
from energy_trading.market_data import Market, PricePoint
from energy_trading.ops_intake import load_ntc_csv


def _prices(hours=(18, 19)) -> list[PricePoint]:
    day = datetime(2026, 9, 12, tzinfo=UTC)
    out = []
    for h in hours:
        out += [
            PricePoint(
                zone="UA",
                delivery_start=day.replace(hour=h),
                market=Market.DAY_AHEAD,
                price_eur_mwh=70.0,
            ),
            PricePoint(
                zone="RO",
                delivery_start=day.replace(hour=h),
                market=Market.DAY_AHEAD,
                price_eur_mwh=97.0,
            ),
            PricePoint(
                zone="MD",
                delivery_start=day.replace(hour=h),
                market=Market.DAY_AHEAD,
                price_eur_mwh=104.0,
            ),
        ]
    return out


def test_hourly_availability_caps_per_hour():
    avail = {"UA-MD": {18: 50.0, 19: 600.0}}
    opps = find_opportunities(_prices(), min_net_spread=0.5, availability=avail)
    by_hour = {o.delivery_start.hour: o for o in opps if o.interconnector_id == "UA-MD"}
    assert by_hour[18].max_volume_mw == 50.0
    assert by_hour[19].max_volume_mw == 600.0


def test_hourly_availability_zero_blocks_direction():
    # MD-UA has 0 MW in the real table: no MD->UA opportunity may be sized
    avail = {"MD-UA": {h: 0.0 for h in range(24)}}
    opps = find_opportunities(_prices(hours=(10,)), min_net_spread=-100.0, availability=avail)
    md_ua = [o for o in opps if o.from_zone == "MD" and o.to_zone == "UA"]
    assert all(o.max_volume_mw == 0.0 for o in md_ua)


def test_load_ntc_csv_shapes():
    avail = load_ntc_csv("data/ntc_2026-09-12.csv")
    assert set(avail) == {"UA-RO", "RO-UA", "UA-MD", "MD-UA"}
    assert len(avail["UA-RO"]) == 24
    # CET hour 19 -> delivery hour 18, RO-UA value 549
    assert avail["RO-UA"][18] == 549.0
    # MD-UA mostly zero
    assert avail["MD-UA"][18] == 0.0
    assert avail["UA-MD"][16] == 220.0


def test_real_ntc_constrains_volumes():
    avail = load_ntc_csv("data/ntc_2026-09-12.csv")
    opps = find_opportunities(
        _prices(hours=tuple(range(24))), min_net_spread=0.5, availability=avail
    )
    ro_ua_19 = next(
        o for o in opps if o.interconnector_id == "RO-UA" and o.delivery_start.hour == 19
    )
    # UA cheaper than RO: winning leg at 19h is UA->RO, capped by UA-RO value 162
    assert ro_ua_19.from_zone == "UA"
    assert ro_ua_19.max_volume_mw == 162.0
    # Reversed economics: RO->UA leg capped by the RO-UA directional value 549
    day = datetime(2026, 9, 12, tzinfo=UTC)
    cheap_ro = [
        PricePoint(
            zone="UA",
            delivery_start=day.replace(hour=19),
            market=Market.DAY_AHEAD,
            price_eur_mwh=100.0,
        ),
        PricePoint(
            zone="RO",
            delivery_start=day.replace(hour=19),
            market=Market.DAY_AHEAD,
            price_eur_mwh=60.0,
        ),
    ]
    opps2 = find_opportunities(cheap_ro, min_net_spread=0.5, availability=avail)
    leg2 = next(o for o in opps2 if o.interconnector_id == "RO-UA")
    assert leg2.from_zone == "RO"
    assert leg2.max_volume_mw == 549.0
