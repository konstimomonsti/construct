"""Contract risk/1: deterministic signal coverage, arithmetic and review behavior."""

from decimal import Decimal
from pathlib import Path

import pytest

from analysis import adapter
from analysis.contracts import AnalysisInput, Finding, Line, PriceInfo, Project, Section, SourceAmounts, Target
from analysis.risk import assess
from analysis.risk.score import score_for_points
from analysis.risk.signals import collect, matching_families
from analysis.runner import analyze


def line(id="l1", text="Eine eindeutig beschriebene Leistung", **fields):
    return Line(id=id, code=fields.pop("code", "01.0010"), sort_order=fields.pop("sort_order", 0),
                short_text=text, quantity=fields.pop("quantity", "10"), unit=fields.pop("unit", "ea"), **fields)


def finding(id="f1", line_id="l1", **fields):
    return Finding(id=id, rule_id=fields.pop("rule_id", "L1.TEST.RISK"), layer=fields.pop("layer", 1),
                   category=fields.pop("category", "text"), severity=fields.pop("severity", "warning"),
                   scope="line", target=fields.pop("target", Target(line_id=line_id)), title="Bitte prüfen", message="m", **fields)


# Every regular-expression family has both a positive and a close negative.
@pytest.mark.parametrize("family,positive,negative", [
    ("provisional", "Bedarfsposition für eine zusätzliche Tür", "Die Position ist eine Grundleistung"),
    ("daywork", "Stundenlohnarbeiten für Anpassungen", "Stundenlohnarbeiten sind nicht vorgesehen"),
    ("cost_plus", "Abrechnung nach tatsächlichem Aufwand", "Der Aufwand ist im Einheitspreis enthalten"),
    ("by_client", "Die Geräte werden bauseits beigestellt", "Der Auftragnehmer liefert die Geräte"),
    ("client_decides", "Ausführung nach Wahl des AG", "Ausführung nach Wahl des AN"),
    ("conditional", "Ggf. ist ein weiterer Anstrich erforderlich", "Drei Anstriche sind auszuführen"),
    ("approximate", "ca. 25 m Leitung", "Calciumsulfatestrich liefern"),
    ("ground", "Homogenbereich X1 mit Fels", "Felsenbirne pflanzen"),
    ("existing_fabric", "Rückbau im Bestand", "Bestandsdokumentation erstellen"),
    ("time_related", "Gerüst vorhalten, Abrechnung je Woche", "Gerüst herstellen und abbauen"),
])
def test_regex_positive_and_negative(family, positive, negative):
    assert family in matching_families(line(text=positive))
    assert family not in matching_families(line(text=negative))


@pytest.mark.parametrize(("family", "positive", "negative"), [
    ("separate_payment", "Mehrmengen werden zusätzlich vergütet.",
     "Mehrmengen werden nicht zusätzlich vergütet."),
    ("separate_payment", "Zusatzaufwand wird separat abgerechnet.",
     "Kein Zusatzaufwand wird separat abgerechnet."),
    ("separate_payment", "Zusätzliche Aushubarbeiten werden gesondert vergütet.",
     "Alle zusätzlichen Aushubarbeiten sind im Einheitspreis enthalten."),
    ("unresolved_site_condition", "Die Schadstoffbelastung ist noch offen.",
     "Die Schadstoffbelastung ist laut dem beigefügten Gutachten bekannt."),
    ("unresolved_site_condition", "Die Leistung richtet sich nach dem vorgefundenen Bestand.",
     "Die Leistung ist am vorhandenen Bestand gemäß Ausführungsplan vorzunehmen."),
    ("unresolved_site_condition", "Umfang von Hindernissen kann vor Baubeginn nicht abschließend beurteilt werden.",
     "Der Umfang von Hindernissen wurde vor Baubeginn in Anlage 4 bestimmt."),
    ("late_scope_decision", "Der Leistungsumfang wird erst nach Öffnung vor Ort bestimmt.",
     "Der Leistungsumfang ist in der freigegebenen Ausführungsplanung beschrieben."),
    ("late_scope_decision", "Ob Verstärkungen zusätzlich beauftragt werden müssen, entscheidet die Bauleitung nach der Bauteilöffnung.",
     "Die bereits beauftragten Verstärkungen sind nach Freigabe einzubauen."),
    ("late_scope_decision", "Die Menge wird erst nach Aufmaß festgelegt.",
     "Die Abrechnung erfolgt nach Aufmaß zu den ausgeschriebenen Einheitspreisen."),
    ("late_scope_decision", "Ausführung und Abrechnung erfolgen erst nach ausdrücklicher Rücksprache.",
     "Die Ausführung beginnt erst nach Freigabe des Sicherheitsplans."),
])
def test_explicit_scope_clauses_quote_the_source_and_reject_close_negatives(family, positive, negative):
    item = line(text="Beschriebene Bauleistung", long_text=positive)
    assert family in matching_families(item)
    [signal] = collect(AnalysisInput(lines=[item]), [])
    assert signal.kind == "scope_gap"
    quoted = signal.message.split("„", 1)[1].split("“", 1)[0]
    assert quoted and quoted in positive
    assert family not in matching_families(line(text=negative))


def test_explicit_clauses_share_the_stable_id_and_keep_their_own_section_cap():
    section = Section(id="s", title="Gründung", sort_order=0)
    ordinary = line("ordinary", "Homogenbereich A", code="1", section_id="s", price=PriceInfo(unit_price=500))
    affected = line("affected", "Homogenbereich B", code="2", section_id="s", sort_order=1,
                    long_text="Der Grundwasserstand ist noch offen. Mehrmengen werden zusätzlich vergütet.",
                    price=PriceInfo(unit_price=100))
    signals = assess(AnalysisInput(sections=[section], lines=[ordinary, affected]), []).change_order_signals
    assert len(signals) == 2
    assert (signals[1].id, signals[1].kind) == ("co_2_scope_gap", "scope_gap")
    assert "Grundwasserstand ist noch offen" in signals[1].message
    assert "Mehrmengen werden zusätzlich vergütet" in signals[1].message
    assert [signal.points for signal in signals] == [2.5, 2.5]


@pytest.mark.parametrize("text", ["Grundwasser", "Kampfmittelsondierung", "LAGA Z2", "Homogenbereiche", "Felsanteil"])
def test_ground_catalogue(text):
    assert "ground" in matching_families(line(text=text))


def test_hour_unit_and_negated_daywork():
    assert "daywork" in matching_families(line(unit="h"))
    for text in ("Keine Stundenlohnarbeiten", "Ohne Regiearbeiten", "Stundenlohnarbeiten sind nicht vorgesehen"):
        assert "daywork" not in matching_families(line(text=text, unit="h"))


def test_non_regex_signals_have_positive_and_negative_cases():
    assert "provisional" in matching_families(line(total_rule="conditional"))
    assert "provisional" not in matching_families(line())
    assert "thin_lump_sum" in matching_families(line(pricing_basis="lump_sum", quantity=1, unit="lump_sum"))
    assert "thin_lump_sum" not in matching_families(line(text="Ausführliche Beschreibung " * 20, pricing_basis="lump_sum"))
    assert "thin_lump_sum" not in matching_families(line(text="", pricing_basis="lump_sum"))
    assert "placeholder_quantity" in matching_families(line(quantity=1, unit="m²"))
    assert "placeholder_quantity" not in matching_families(line(quantity=1, unit="ea"))
    assert "placeholder_quantity" not in matching_families(line(quantity=1, unit="m²", pricing_basis="lump_sum"))
    assert "zero_qty_priced" in matching_families(line(quantity=0, source_amounts=SourceAmounts(unit_price=0)))
    assert "zero_qty_priced" not in matching_families(line(quantity=0))


def test_stable_signal_ids_group_scope_reasons_and_distinguish_bad_duplicate_codes():
    inp = AnalysisInput(lines=[line(text="Fels im Bestand vorhalten"), line("l2", "Fels", sort_order=1)])
    signals = collect(inp, [])
    assert len(signals) == 2 and len({s.id for s in signals}) == 2
    assert all(s.kind == "scope_gap" for s in signals)
    assert signals == collect(inp, [])
    unique = collect(AnalysisInput(lines=[line(text="Grundwasser")]), [])
    assert unique[0].id == "co_01.0010_scope_gap"
    assert "Zeitabhängige" in signals[0].message and "Bausubstanz" in signals[0].message


def test_missing_dependency_signal_only_for_a_real_open_missing_finding():
    inp = AnalysisInput(lines=[line()])
    gap = finding(rule_id="L2.FLOOR.SCREED_NEEDS_SKIRTING", layer=2, evidence={"reason": "missing"})
    [signal] = collect(inp, [gap])
    assert signal.kind == "missing_dependency" and signal.finding_ids == [gap.id]
    for change in ({"status": "rejected"}, {"evidence": {"reason": "quantity_not_assessable"}}):
        assert collect(inp, [gap.model_copy(update=change)]) == []


def test_no_prices_means_no_invented_money_and_all_section_points_reconcile():
    inp = AnalysisInput(project=Project(currency="EUR"), lines=[line()])
    report = assess(inp, [finding(severity="error"), finding("f2", evidence={"change_order": True})])
    assert not report.priced and report.money_at_stake is None
    assert report.points == {"f1": 8, "f2": 6}
    assert report.score == score_for_points(report.points.values(), report.scale)
    assert report.top_risks[0].amount is None
    assert sum(s.points for s in report.by_section) == sum(report.points.values())
    assert sum(report.by_category.values()) == sum(report.points.values())


def test_money_uses_decimal_current_price_and_counts_each_affected_line_once():
    inp = AnalysisInput(lines=[line(quantity=3, source_amounts=SourceAmounts(unit_price=100, line_amount=300),
                                    price=PriceInfo(unit_price=Decimal("0.10")))])
    report = assess(inp, [finding(), finding("f2", severity="error")])
    assert report.priced and report.money_at_stake == Decimal("0.08")
    assert report.top_risks[0].amount == Decimal("0.30")
    assert report.points["f1"] == float(Decimal("4.0003"))
    assert report.model_dump(mode="json")["money_at_stake"] == "0.08"
    override = assess(inp, [finding(evidence={"amount_at_stake": "15000"})])
    assert override.points["f1"] == 14 and override.money_at_stake == 2700


def test_wording_signals_keep_only_strongest_kind_per_section():
    inp = AnalysisInput(sections=[Section(id="s", title="Bauarbeiten", sort_order=0)], lines=[
        line("l1", "Grundwasser", section_id="s", code="1", quantity=1,
             price=PriceInfo(unit_price=100)),
        line("l2", "Fels", section_id="s", code="2", sort_order=1, quantity=1,
             price=PriceInfo(unit_price=1000)),
        line("l3", "Abrechnung nach Aufwand", section_id="s", code="3", sort_order=2, quantity=1,
             price=PriceInfo(unit_price=50)),
    ])
    report = assess(inp, [])
    assert [report.points[signal.id] for signal in report.change_order_signals] == [0, 2.5, 2.5]
    assert report.money_at_stake == 147
    assert report.top_risks[0].amount == 1000
    assert sum(report.points.values()) == report.by_section[0].points == 5


def test_rejected_resolved_stale_and_duplicate_findings_do_not_inflate_score():
    inp = AnalysisInput(lines=[line()])
    f = finding()
    ignored = [finding(str(i), status=status) for i, status in enumerate(("rejected", "accepted", "applied", "stale"))]
    report = assess(inp, [f, f, *ignored])
    assert report.points == {"f1": 4}
    assert report.open_counts == {"error": 0, "warning": 1, "info": 0}


def test_nachtrag_section_and_children_are_excluded_but_findings_are_not_modified():
    sections = [Section(id="s", title="Nachtrag", sort_order=0),
                Section(id="child", parent_id="s", title="Ergänzungen", sort_order=1)]
    inp = AnalysisInput(sections=sections, lines=[line(text="Grundwasser", section_id="child")])
    f = finding()
    assert assess(inp, [f]).points == {}
    assert f.status == "open" and len(inp.lines) == 1


def test_top_risks_cap_ties_and_score_shrinks_after_decisions():
    inp = AnalysisInput(lines=[line(str(i), code=f"01.{i:04}", sort_order=i) for i in range(15)])
    findings = [finding(f"f{i}", str(i)) for i in range(15)]
    report = assess(inp, findings)
    assert len(report.top_risks) == 10
    assert report.top_risks[0].line_id == "0"
    remaining = {id: value for id, value in report.points.items() if id not in {"f0", "f1", "f2"}}
    assert score_for_points(remaining.values(), report.scale) < report.score
    assert assess(inp, findings[3:]).score == score_for_points(remaining.values(), report.scale)
    assert score_for_points([40]) == 50 and score_for_points([120]) == 75


def test_related_lines_anchor_once_and_input_is_unchanged():
    inp = AnalysisInput(lines=[line(), line("l2", code="01.0020", sort_order=1)])
    before = inp.model_dump()
    f = finding(line_id=None, related_line_ids=["l2", "l1"])
    report = assess(inp, [f])
    assert len(report.top_risks) == 1 and report.top_risks[0].line_id == "l1"
    assert inp.model_dump() == before


def test_real_excavation_requirements_quote_the_approval_condition():
    path = Path(__file__).resolve().parents[3] / "data/tenders/501-24-01_GAEB-XML_sas.x83"
    report = analyze(adapter.from_file(path), layers=(1, 2))
    assert not report.errors
    positions = {signal.line_code for signal in report.risk.change_order_signals
                 if "Ausführung und Abrechnung erst nach ausdrücklicher Rücksprache" in signal.message}
    assert {"02.03.0019", "02.03.0020", "02.03.0021"} <= positions


def test_real_priced_stbalv_trench_and_unpriced_precast_fixture():
    root = Path(__file__).resolve().parents[3]
    priced = adapter.from_file(root / "data/tenders/StBALV23040.D86")
    report = analyze(priced, layers=(1, 2)).risk
    assert report.priced and report.money_at_stake is not None
    assert report.top_risks
    fixture = adapter.from_json(Path(__file__).parent / "fixtures/lv11_precast.json")
    unpriced = analyze(fixture, layers=(1, 2)).risk
    assert not unpriced.priced and unpriced.money_at_stake is None
    assert unpriced.top_risks


def test_overlapping_findings_and_derived_signals_do_not_double_charge_points():
    """Acceptance criteria P1.6: Overlapping signals and corroborations do not double-charge exposure."""
    inp = AnalysisInput(
        project=Project(currency="EUR"),
        lines=[line(quantity=10, source_amounts=SourceAmounts(unit_price=Decimal("10.00"), line_amount=Decimal("100.00")))],
    )
    # L2 missing dependency finding
    l2_finding = finding(
        id="l2_gap",
        rule_id="L2.FLOOR.SCREED_NEEDS_SKIRTING",
        layer=2,
        category="dependency",
        severity="warning",
        evidence={"reason": "missing", "amount_at_stake": "100.00"},
    )
    # L3 corroboration finding referencing the L2 finding
    l3_corroboration = finding(
        id="l3_confirm",
        rule_id="L3.CHECK.L2_CONFIRM",
        layer=3,
        category="dependency",
        severity="info",
        evidence={"reviews_finding_id": "l2_gap", "verdict": "really_missing"},
    )

    report = assess(inp, [l2_finding, l3_corroboration])
    # The L2 finding carries the points (4.0 base + uplift)
    assert report.points["l2_gap"] > 0
    # The derived change order signal overlaps with l2_gap -> base points are 0
    derived_signal = [s for s in report.change_order_signals if s.kind == "missing_dependency"][0]
    assert derived_signal.id in report.points
    assert report.points[derived_signal.id] == 0.0
    # The L3 corroboration overlaps with l2_gap -> base points are 0
    assert report.points["l3_confirm"] == 0.0
