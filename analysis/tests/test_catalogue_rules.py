from decimal import Decimal
import json
from pathlib import Path

from analysis.catalogue.rules import Product, SourceLine, assess, attributes, extract


def pipe(product_id, name, *, aliases=(), supplier=None, sku=None, unit="m"):
    return Product(product_id, "Pipes", name, name, supplier, sku, unit, attributes(name, "Pipes"), aliases)


def line(line_id, code, text, **overrides):
    values = {
        "id": line_id, "code": code, "section_id": "section", "text": text,
        "quantity": Decimal("10"), "unit": "m", "raw_unit": "lfm", "total_rule": "include",
        "alternative_for": None, "pricing_basis": "unit_rate", "locator": {"document_id": "document"},
    }
    return SourceLine(**(values | overrides))


def item(text, **kwargs):
    return extract([line("1", "1.1", text, **kwargs)])[0][2]


def test_exact_dimensions_alias_sku_and_ambiguity():
    product = pipe("p1", "PE-HD pipe 50 x 4.6 mm", aliases=("aqualine pe hd pipe 50 x 4.6 mm",),
                   supplier="Acme", sku="PE.50")
    other = pipe("p2", "PE-HD pipe 63 x 5.8 mm")
    candidate = item("Supply PE-HD pipe 50 × 4,6 mm")
    matches, evidence = assess(candidate, [product, other])
    assert [entry.id for entry in matches] == ["p1"]
    assert evidence[0]["rule"] == "technical_specification"
    assert set(evidence[1]["incompatibilities"]) == {"outside_mm differs", "wall_mm differs"}

    alias = item("Supply Aqualine PE-HD pipe 50 x 4.6 mm")
    assert assess(alias, [product])[1][0]["rule"] == "approved_name"
    assert assess(alias, [product])[0] == [product]

    sku = extract([line("1", "1.1", "Supply SKU PE.50; Supplier: Acme")], [product])[0][2]
    assert assess(sku, [product])[1][0]["rule"] == "supplier_sku"
    assert assess(sku, [product])[0] == [product]

    identical = pipe("p3", "PE-HD pipe 50 x 4.6 mm", supplier="Second supplier")
    assert len(assess(candidate, [product, identical])[0]) == 2
    assert assess(item("Supply PE-HD pipe"), [product, other])[0] == []
    assert assess(item("Supply PE100 pipe 50 x 4.6 mm"), [product])[0] == []


def test_fingerprints_inherit_attributes_without_inheriting_the_quantity():
    original = line("a", "01.10", "PE-HD Rohr 50 × 4,6 mm liefern")
    repeated = line("b", "1.20", "Supply HDPE pipe 50 x 4.6 mm", quantity=Decimal("600"), unit="cm")
    inherited = line("c", "1.30", "wie Position 1.10", quantity=Decimal("37"))
    changed = line("d", "1.40", "wie vor, jedoch 63 x 5.8 mm")
    result = {line_id: candidate for line_id, _, candidate in extract([original, repeated, inherited, changed])}
    assert result["a"].fingerprint == result["b"].fingerprint == result["c"].fingerprint
    assert result["c"].quantity == "37"
    assert result["c"].context["references"][0]["position"] == "01.10"
    assert result["d"].attributes["outside_mm"] == "63"
    assert result["d"].context["overrides"]["wall_mm"] == {"inherited": "4.6", "local": "5.8"}
    assert result["a"].fingerprint != result["d"].fingerprint


def test_context_failures_and_scope_are_visible():
    cyclic = extract([line("a", "1.1", "wie Position 1.2"), line("b", "1.2", "wie Position 1.1")])
    assert all("cyclic position reference" in candidate.issues for _, _, candidate in cyclic)
    assert item("wie Position 4.5").issues == ("missing or ambiguous position reference",)
    assert item("Rohr 50 x 4.6 mm verlegen").scope == "installation_only"
    assert item("PE-HD Rohr 50 x 4.6 mm bauseits").scope == "provided_by_others"
    assert not extract([line("a", "1.1", "PE-HD Rohr 50 x 4.6 mm demontieren")])
    assert item("Supply PE-HD pipe 50 x 4.6 mm", total_rule="conditional").selection == "conditional"
    assert item("Supply PE-HD pipe 50 x 4.6 mm", source_role="companion", duplicate=True).selection == "companion"
    assert item("Supply PE-HD pipe 50 x 4.6 mm paired").quantity_basis == "paired"

    section = {"section_id": "pipes", "title": "PE-HD pipes", "notes": None}
    assert item("Supply pipe 50 x 4.6 mm", section_notes=[section]).attributes["material"] == "PE-HD"


def test_multiple_components_do_not_receive_the_line_quantity():
    result = extract([line("a", "1.1", "Supply PE-HD pipe 50 x 4.6 mm including valve DN 50")])
    assert [candidate.category for _, _, candidate in result] == ["Pipes", "Valves and controls"]
    assert [candidate.scope for _, _, candidate in result] == ["supplied", "included_accessory"]
    assert all(candidate.quantity is None for _, _, candidate in result)
    assert result[1][2].attributes["dn"] == "50"
    assert result[0][2].attributes["dn"] is None

    text = "Supply PE-HD pipe 50 x 4.6 mm qty: 8 m and valve DN 50 qty: 2 pcs"
    measured = [candidate for _, _, candidate in extract([line("a", "1.1", text)])]
    assert [(item.quantity, item.unit) for item in measured] == [("8", "m"), ("2", "ea")]
    assert measured[0].fingerprint == result[0][2].fingerprint


def test_multiline_repeated_description_is_one_occurrence():
    result = extract([line("a", "1.1", "PE-HD Rohr\nPE-HD Rohr 50 x 4.6 mm liefern")])
    assert len(result) == 1
    assert result[0][2].attributes["outside_mm"] == "50"


def test_structured_refs_and_incidental_products():
    source = line("a", "1.1", "Supply PE-HD pipe 5 x 0.46 cm", source_id="I100")
    reference = line("b", "1.2", "wie vor", reference_ids=("I100",))
    positions = extract([source, reference])
    assert positions[0][2].fingerprint == positions[1][2].fingerprint
    assert positions[1][2].context["source_reference_ids"] == ["I100"]
    assert positions[1][2].attributes["outside_mm"] == "50"
    assert item("Supply meter\nSupply includes PE-HD pipe 50 x 4.6 mm", headline="Supply meter").scope == "unspecified"
    assert item("Supply PE-HD pipe 50 x 4.6 mm including clips").scope == "supplied"


def test_paired_conduit_does_not_match_single_conduit():
    name = "PE-HD cable conduit 50 x 4.6 mm"
    candidate = item("Supply " + name + " paired")
    category = "Cable conduits"

    def conduit(product_id, description):
        return Product(product_id, category, description, description, None, None, "m",
                       attributes(description, category))

    pair = conduit("pair", name + " paired")
    single = conduit("single", name)
    assert candidate.quantity_basis == "paired"
    assert assess(candidate, [pair, single])[0] == [pair]


def test_held_out_rule_precision_and_coverage():
    holdout = json.loads(Path(__file__).with_name("catalogue_holdout.json").read_text(encoding="utf-8"))
    products = [pipe(*entry) for entry in holdout["products"]]
    potential = emitted = correct = 0
    for case in holdout["cases"]:
        matches, _ = assess(item(case["text"]), products)
        prediction = matches[0].id if len(matches) == 1 else None
        potential += case["label"] is not None
        emitted += prediction is not None
        correct += prediction is not None and prediction == case["label"]
    print(f"Rule precision {correct}/{emitted}; coverage of labelled matches {correct}/{potential}")
    assert emitted > 0 and correct == emitted
    assert correct / potential >= 0.75
