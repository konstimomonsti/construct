"""Pure parts of the demo catalogue seed script (no database)."""

from decimal import Decimal

import seed_demo_catalogue as seed


def position(oz, short, long="", unit="m³", section="Betonarbeiten"):
    return {"oz": oz, "short": short, "long": long, "unit": unit, "path": [{"oz": "1", "label": section}]}


def test_price_is_deterministic_and_in_range():
    cases = [("Beton C25/30 liefern", "m³", "1.2.3"), ("Schalung Wand", "m²", "1.2.4"),
             ("Baustelleneinrichtung", "psch", "1.1.1"), ("Betonstahl BSt 500", "t", "1.2.9"),
             ("Unbekannt", "xyz", "9.9")]
    for name, unit, oz in cases:
        price = seed.demo_price(name, unit, oz)
        assert price == seed.demo_price(name, unit, oz)
        low, high = seed.price_range(name, unit)
        assert Decimal(low) * Decimal("0.88") <= price <= Decimal(high) * Decimal("1.12")
        assert price == price.quantize(Decimal("0.01"))
    assert seed.price_range("Baustelleneinrichtung", "psch") == (500, 25000)
    assert seed.price_range("Beton C25/30", "m³") == (95, 280)


def test_dedupe_by_name_and_unit():
    plan = seed.build_plan([
        position("1.1", "Beton C25/30"),
        position("1.2", "Beton  C25/30"),  # same tokens, same unit -> same product
        position("1.3", "Beton C25/30", unit="m²"),  # other unit -> own product
        position("1.4.", "Schalung", unit="m²"),
    ])
    assert [spec.sku for spec in plan.specs] == ["DEMO-1.1", "DEMO-1.3", "DEMO-1.4"]
    assert plan.positions == 4 and not plan.skipped


def test_description_keeps_the_printed_text_and_falls_back_to_the_name():
    assert seed.product_description("Beton", "Beton\nC25/30 XC1") == "Beton\nC25/30 XC1"
    assert seed.product_description("Beton", "Beton") == "Beton"
    assert seed.product_description("Beton", "") == "Beton"
    assert seed.product_description("Beton", "Anderer Text") == "Anderer Text"


def test_invalid_positions_are_skipped_and_category_falls_back():
    plan = seed.build_plan([
        position("2.1", "", unit="m"), position("2.2", "Rohr DN 100", unit=""),
        {"oz": "2.3", "short": "Rohr DN 150", "long": "", "unit": "m", "path": []},
    ])
    assert [oz for oz, _ in plan.skipped] == ["2.1", "2.2"]
    assert plan.specs[0].category == seed.FALLBACK_CATEGORY
