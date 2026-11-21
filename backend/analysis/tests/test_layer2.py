import copy
from decimal import Decimal
import io
import json
from pathlib import Path
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr

from analysis.layer2.adapter import canonical_hash, from_data, from_json, parse_number
from analysis.layer2.cli import main
from analysis.contracts import Finding, Target
from analysis.layer2 import run
from analysis.layer2.schema import RuleSpec, compile_regex, load_rules, rule_metadata
from analysis.layer2.report import analyze
from analysis.layer2.quantities import convert, dimension, normalize_unit

ROOT = Path(__file__).resolve().parents[3]


def line(id, text, quantity="100", unit="m²", **kwargs):
    return {"id": id, "code": id, "short_text": text, "quantity": quantity, "unit": unit, **kwargs}


def input_for(*lines, **kwargs):
    return from_data({"lines": list(lines), **kwargs})


def selected(input, suffix, **kwargs):
    return [finding for finding in run(input, [], **kwargs) if finding.rule_id.endswith(suffix)]


def prior_error(line_id, field="quantity", severity="error"):
    return Finding(id="prior-1", layer=1, rule_id="L1.QTY.MISSING", category="completeness",
                   severity=severity, scope="line", target=Target(line_id=line_id, field=field),
                   title="Invalid source", message="Layer 1 test error")


class AdapterTests(unittest.TestCase):
    def test_spec_item_array_and_no_mutation(self):
        payload = [{"oz": "01.0010", "short_text": "  Zementestrich\n  C25 ", "quantity": "1.234,50",
                    "unit": "m2", "trade_group": "Estrich"}]
        before = copy.deepcopy(payload)
        adapted = from_data(payload)
        self.assertEqual(payload, before)
        self.assertEqual(adapted.lines[0].quantity, Decimal("1234.50"))
        self.assertEqual(adapted.lines[0].quantity_raw, "1.234,50")
        self.assertEqual(adapted.lines[0].unit, "m²")
        self.assertEqual(adapted.lines[0].unit_raw, "m2")
        self.assertEqual(adapted.lines[0].short_text, "Zementestrich C25")
        self.assertEqual(adapted.lines[0].code_parts, ["01", "0010"])
        self.assertEqual(adapted.lines[0].id, from_data(payload).lines[0].id)

    def test_invalid_number_kept_as_none_and_raw_warning(self):
        adapted = input_for(line("a", "Estrich", "not a number"), line("b", "Vinyl", "NaN"))
        self.assertEqual(len(adapted.lines), 2)
        self.assertIsNone(adapted.lines[0].quantity)
        self.assertEqual(adapted.lines[0].quantity_raw, "not a number")
        self.assertEqual(len(adapted.import_warnings), 2)

    def test_pricing_distribution_and_flags(self):
        flags = {"Provis": "Yes", "AltItem": "0"}
        adapted = input_for(line("a", "Estrich", price={"unit_price": "1,25", "price_unit": "m2",
                                 "reference_range": {"min": "1,1", "median": "1,2", "max": "1,3", "n": 1}}, gaeb_flags=flags,
                                 distributions=[{"area_id": "a", "quantity": "4,000"}]))
        self.assertEqual(adapted.lines[0].price.unit_price, Decimal("1.25"))
        self.assertEqual(adapted.lines[0].distributions[0].quantity, Decimal("4.000"))
        self.assertEqual(adapted.lines[0].gaeb_flags, flags)

    def test_hash_ignores_claimed_hash_and_key_order(self):
        a = from_data({"lines": [line("a", "Estrich")], "input_hash": "not-trusted"})
        b = from_data({"input_hash": "other", "lines": [line("a", "Estrich")]})
        self.assertEqual(a.input_hash, b.input_hash)
        self.assertEqual(a.input_hash, canonical_hash(a))
        self.assertEqual(len(a.input_hash), 64)

    def test_duplicate_internal_ids_are_rejected_but_codes_are_retained(self):
        with self.assertRaises(ValueError):
            input_for(line("a", "Estrich"), line("a", "Vinyl"))
        a, b = line("a", "Estrich"), line("b", "Vinyl")
        b["code"] = a["code"]
        self.assertEqual(len(input_for(a, b).lines), 2)

    def test_decimal_and_unit_conversions(self):
        self.assertEqual(parse_number("1,234.56"), Decimal("1234.56"))
        self.assertEqual(parse_number("0.1"), Decimal("0.1"))
        self.assertIsNone(parse_number(True))
        self.assertIsNone(parse_number("Infinity"))
        self.assertEqual(normalize_unit("Stk."), "ea")
        self.assertEqual(dimension("unknown"), "unknown")
        self.assertEqual(convert(Decimal("10000"), "cm²", "m²"), Decimal(1))
        self.assertIsNone(convert(Decimal(1), "kg", "m²"))
        self.assertIsNone(convert(Decimal(1), "set", "ea"))
        self.assertIsNone(convert(Decimal(1), "m·week", "m²·day"))


class RuleTests(unittest.TestCase):
    def test_all_groups_and_registered_checks(self):
        self.assertEqual(len(load_rules()), 16)
        self.assertEqual(len(rule_metadata()), 50)
        self.assertEqual(run(input_for(), []), [])

    def test_all_five_groups_detect_missing_dependencies(self):
        for text, category in [("Zementestrich", "FLOOR"), ("Ortbeton", "CONCRETE"),
                               ("Metallständerwand GKB", "DRYWALL"), ("Dispersionsfarbe", "PAINT"),
                               ("Dachabdichtung EPDM", "ROOF")]:
            with self.subTest(category=category):
                findings = run(input_for(line("a", text)), [])
                self.assertTrue(findings)
                self.assertTrue(all(f.rule_id.startswith(f"L2.{category}.") for f in findings))

    def test_floor_finish_sums_different_coverings_once_per_line(self):
        input = input_for(line("s", "Zementestrich"), line("v", "PVC Vinyl", "40"),
                          line("t", "Teppichboden", "50"))
        self.assertEqual(selected(input, "FLOOR_COVERING"), [])

    def test_shortage_and_decimal_tolerance_boundary(self):
        input = input_for(line("s", "Estrich"), line("v", "Vinyl", "89.99"))
        finding = selected(input, "FLOOR_COVERING")[0]
        self.assertEqual(finding.evidence["reason"], "quantity_shortfall")
        self.assertEqual(Decimal(finding.evidence["shortfall_to_minimum"]), Decimal("0.01"))
        self.assertEqual(Decimal(finding.evidence["variance"]), Decimal("-10.01"))
        self.assertEqual(finding.suggested_fix.operations[0].line.quantity, Decimal("10.01"))
        self.assertEqual(selected(input, "FLOOR_COVERING", tolerance=Decimal("0.11")), [])

    def test_compatible_area_units(self):
        input = input_for(line("s", "Estrich", "2"), line("v", "Vinyl", "20000", "cm2"))
        self.assertEqual(selected(input, "FLOOR_COVERING"), [])

    def test_incompatible_units_never_summed(self):
        # A match measured in another dimension is skipped, not summed and not "not assessable".
        input = input_for(line("s", "Estrich"), line("v", "Grundierung", "100", "kg"))
        finding = selected(input, "PRIMER_AND_LEVELING")[0]
        self.assertEqual(finding.severity, "warning")
        self.assertEqual(finding.evidence["reason"], "missing")
        self.assertEqual(Decimal(finding.evidence["dependency_quantity"]), 0)
        self.assertEqual([item["line_id"] for item in finding.evidence["skipped_dependency_lines"]],
                         [input.lines[1].id])

    def test_lump_sum_match_still_not_assessable(self):
        input = input_for(line("s", "Estrich"), line("v", "Vinyl", "1", "psch"))
        finding = selected(input, "FLOOR_COVERING")[0]
        self.assertEqual(finding.severity, "info")
        self.assertEqual(finding.evidence["reason"], "quantity_not_assessable")
        self.assertIsNone(finding.suggested_fix)

    def test_missing_quantity_prevents_shortage_claim(self):
        input = input_for(line("s", "Estrich"), line("v", "Vinyl", None))
        self.assertEqual(selected(input, "FLOOR_COVERING")[0].severity, "info")

    def test_clean_layer_only_for_floor_slab(self):
        self.assertEqual(selected(input_for(line("w", "STB-Wand Ortbeton", "20", "m³")), "CLEAN_LAYER"), [])
        slab = input_for(line("s", "Bodenplatte Ortbeton", "20", "m³"))
        self.assertEqual(len(selected(slab, "CLEAN_LAYER")), 1)
        complete = input_for(line("s", "Bodenplatte Ortbeton", "20", "m³"), line("c", "PE-Folie"))
        self.assertEqual(selected(complete, "CLEAN_LAYER"), [])

    def test_dependencies_can_be_bundled_in_one_line(self):
        bundled = line("a", "Metallständerwand GKB inkl. Mineralwolle, Fugen Spachtelung, Kantenschutz")
        self.assertEqual(run(input_for(bundled), []), [])

    def test_case_long_text_and_tags(self):
        input = input_for(line("a", "Bauteil", long_text="DACHABDICHTUNG EPDM"),
                          line("b", "Material", tags=["Dampfsperre"]),
                          line("c", "WÄRMEDÄMMUNG EPS"), line("d", "Dachgully", "1", "ea"))
        self.assertEqual(run(input, []), [])

    def test_optional_alternative_and_zero_items_do_not_satisfy(self):
        for extra in [{"total_rule": "conditional"}, {"total_rule": "unit_price_only"},
                      {"alternative_for": "base"}, {"quantity": "0"}]:
            with self.subTest(extra=extra):
                dep = line("v", "Vinyl")
                dep.update(extra)
                self.assertEqual(selected(input_for(line("s", "Estrich"), dep), "FLOOR_COVERING")[0]
                                 .evidence["reason"], "missing")
        self.assertEqual(run(input_for(line("s", "Estrich", total_rule="conditional")), []), [])

    def test_boolean_proposal_does_not_invent_quantity(self):
        finding = selected(input_for(line("p", "Dispersionsfarbe")), "MASKING_AND_PROTECTION")[0]
        proposal = finding.suggested_fix.operations[0]
        self.assertIsNone(proposal.line.quantity)
        self.assertEqual(proposal.line.unit, "m²")  # SuggestedUnit: only the quantity is left to the reviewer
        self.assertIn("enter it before applying the fix", finding.suggested_fix.rationale)
        self.assertLess(finding.suggested_fix.confidence, 1)
        self.assertEqual(proposal.after_line_id, "p")

    def test_prior_layer1_errors_downgrade_quantities(self):
        input = input_for(line("s", "Estrich"), line("v", "Grundierung", "50"))
        for line_id in ("s", "v"):
            findings = run(input, [prior_error(line_id)])
            finding = next(f for f in findings if f.rule_id.endswith("PRIMER_AND_LEVELING"))
            self.assertEqual(finding.severity, "info")
            self.assertIsNone(finding.suggested_fix)
        findings = run(input, [prior_error("s", severity="warning")])
        self.assertEqual(next(f for f in findings if f.rule_id.endswith("PRIMER_AND_LEVELING")).severity, "warning")

    def test_stable_finding_id_and_pure_repeated_runs(self):
        input = input_for(line("s", "Estrich"))
        before = input.model_dump_json()
        a, b = analyze(input), analyze(input)
        self.assertEqual(before, input.model_dump_json())
        self.assertEqual([f.id for f in a.findings], [f.id for f in b.findings])
        self.assertNotEqual(a.run_id, b.run_id)
        self.assertTrue(all(f.status == "open" for f in a.findings))
        self.assertEqual(a.summary.by_layer, {"2": len(a.findings)})
        self.assertEqual(a.layers_run, [2])
        self.assertEqual(a.input_hash, input.input_hash)

    def test_decision_key_survives_version_change_with_same_target(self):
        a = input_for(line("s", "Estrich"), bom={"bom_version_id": "v1"})
        b = input_for(line("s", "Estrich"), bom={"bom_version_id": "v2"})
        self.assertEqual([f.id for f in run(a, [])], [f.id for f in run(b, [])])

    def test_custom_schema_slash_regex_and_dependency_tolerance(self):
        rule = RuleSpec.model_validate({"RuleID": "L2.TEST.BASE", "Category": "Custom trade",
            "TriggerRegex": "/primary/i", "Required_Dependencies": [{"DependencyName": "Finish",
            "Regex": "/(?i)secondary/", "CheckType": "QuantityMatch", "TolerancePct": "0.20"}]})
        input = input_for(line("a", "PRIMARY"), line("b", "secondary", "80"))
        self.assertEqual(run(input, [], rules=[rule], tolerance=Decimal(0)), [])
        self.assertTrue(compile_regex("/(?i)estrich/").search("ESTRICH"))
        with self.assertRaises(ValueError):
            compile_regex("[")
        for invalid in ("-0.01", "1", "NaN"):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                run(input, [], tolerance=Decimal(invalid))


class ScopeTests(unittest.TestCase):
    def test_document_vs_trade(self):
        input = from_data([
            {"oz": "01", "short_text": "Dispersionsfarbe", "quantity": "100", "unit": "m2", "trade_group": "Maler"},
            {"oz": "02", "short_text": "Grundierung", "quantity": "100", "unit": "m2", "trade_group": "Estrich"},
        ])
        self.assertEqual(selected(input, "SURFACE_PREPARATION_AND_PRIMER", scope="document"), [])
        finding = selected(input, "SURFACE_PREPARATION_AND_PRIMER", scope="trade")[0]
        self.assertEqual(finding.scope, "section")
        self.assertEqual(finding.target.section_id, input.lines[0].section_id)

    def test_trade_traverses_section_tree(self):
        input = input_for(line("s", "Estrich", section_id="one"),
                          line("v", "Vinyl", section_id="two"), sections=[
                              {"id": "root", "title": "Floors"},
                              {"id": "one", "parent_id": "root"}, {"id": "two", "parent_id": "root"}])
        self.assertEqual(selected(input, "FLOOR_COVERING", scope="trade"), [])
        self.assertEqual(len(selected(input, "FLOOR_COVERING", scope="section")), 1)

    def test_rooms_use_distributed_quantities(self):
        input = from_json(ROOT / "data" / "examples" / "analysis_input.json")
        findings = run(input, [])
        self.assertEqual(len(findings), 1)
        finding = findings[0]
        self.assertEqual(finding.target.area_id, "office-b")
        self.assertEqual(Decimal(finding.evidence["trigger_quantity"]), Decimal("60"))
        self.assertEqual(Decimal(finding.evidence["dependency_quantity"]), Decimal("40"))
        self.assertEqual(finding.suggested_fix.operations[0].distributions[0].quantity, Decimal("20"))

    def test_room_with_no_distribution_falls_back_to_document(self):
        input = input_for(line("a", "Estrich"), areas=[{"id": "a", "name": "Room"}])
        self.assertTrue(all(f.scope == "bom" for f in run(input, [])))

    def test_unallocated_dependency_does_not_satisfy_all_rooms(self):
        input = input_for(line("s", "Estrich", distributions=[{"area_id": "a", "quantity": "100"}]),
                          line("v", "Vinyl"), areas=[{"id": "a", "name": "Office"}])
        finding = selected(input, "FLOOR_COVERING")[0]
        self.assertEqual(finding.severity, "info")
        self.assertEqual(finding.evidence["unassigned_candidate_line_ids"], ["v"])
        self.assertIsNone(finding.suggested_fix)

    def test_partial_distribution_keeps_residual(self):
        input = input_for(line("s", "Estrich", distributions=[{"area_id": "a", "quantity": "60"}]),
                          areas=[{"id": "a", "name": "Office"}])
        findings = selected(input, "FLOOR_COVERING")
        self.assertEqual(len(findings), 2)
        self.assertEqual({Decimal(f.evidence["trigger_quantity"]) for f in findings}, {Decimal(60), Decimal(40)})
        self.assertEqual(len({f.id for f in findings}), 2)

    def test_orphan_allocation_does_not_produce_a_dependency_fix(self):
        input = input_for(line("s", "Estrich", distributions=[{"area_id": "missing", "quantity": "60"}]))
        self.assertEqual(selected(input, "FLOOR_COVERING"), [])

    def test_overallocated_or_missing_distribution_is_unreliable(self):
        for quantity in (None, "110"):
            input = input_for(line("s", "Estrich", distributions=[{"area_id": "a", "quantity": quantity}]),
                              areas=[{"id": "a", "name": "Office"}])
            findings = selected(input, "FLOOR_COVERING")
            self.assertTrue(findings)
            self.assertTrue(all(f.severity == "info" for f in findings))
            self.assertTrue(all(f.suggested_fix is None for f in findings))


class PipelineIntegrationTests(unittest.TestCase):
    def test_existing_runner_discovers_registered_layer2(self):
        from analysis.adapter import from_json as shared_from_json
        from analysis.runner import analyze as pipeline_analyze
        from analysis.registry import rules_for

        input = shared_from_json(ROOT / "data" / "examples" / "analysis_input.json")
        result = pipeline_analyze(input, layers=[1, 2])
        self.assertEqual(result.layers_run, [1, 2])
        self.assertEqual(result.errors, [])
        self.assertEqual(len(rules_for(2)), 50)
        dependency_findings = [finding for finding in result.findings if finding.layer == 2]
        self.assertEqual(len(dependency_findings), 1)
        self.assertEqual(dependency_findings[0].target.area_id, "office-b")

    def test_real_layer1_unit_error_downgrades_dependency(self):
        from analysis.runner import analyze as pipeline_analyze

        input = input_for(line("p", "Dispersionsfarbe", unit=None))
        result = pipeline_analyze(input, layers=[1, 2])
        self.assertEqual(result.errors, [])
        self.assertTrue(any(f.rule_id == "L1.UNIT.MISSING" for f in result.findings))
        quantity_finding = next(f for f in result.findings
                                if f.rule_id.endswith("SURFACE_PREPARATION_AND_PRIMER"))
        self.assertEqual(quantity_finding.severity, "info")
        self.assertIsNone(quantity_finding.suggested_fix)


class CliTests(unittest.TestCase):
    def call_cli(self, *args):
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = main(list(args))
        return code, stdout.getvalue(), stderr.getvalue()

    def test_cli_json_and_failure_threshold(self):
        code, output, error = self.call_cli(str(ROOT / "data" / "examples" / "items.json"), "--scope", "trade", "--fail-on", "warning")
        self.assertEqual(code, 1, error)
        report = json.loads(output)
        self.assertEqual(report["summary"]["total"], 8)
        self.assertEqual({f["rule_id"].split(".")[1] for f in report["findings"]},
                         {"FLOOR", "CONCRETE", "DRYWALL", "PAINT", "ROOF"})

    def test_cli_table_and_rule_registry(self):
        code, output, _ = self.call_cli(str(ROOT / "data" / "examples" / "analysis_input.json"), "--format", "table")
        self.assertEqual(code, 0)
        self.assertIn("office", output.lower())
        code, output, _ = self.call_cli("--list-rules")
        self.assertEqual(code, 0)
        self.assertEqual(len(json.loads(output)), 50)

    def test_invalid_input_is_clean_error(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "invalid.json"
            path.write_text('{"unexpected": []}', encoding="utf-8")
            code, output, error = self.call_cli(str(path))
        self.assertEqual(code, 2)
        self.assertEqual(output, "")
        self.assertIn("Expected an AnalysisInput", error)

    def test_malformed_nested_values_are_clean_errors(self):
        for patch in ({"unit": 2}, {"price": "broken"}, {"distributions": {}},
                      {"price": {"reference_range": "broken"}}):
            with self.subTest(patch=patch), tempfile.TemporaryDirectory() as temp:
                item = line("a", "Estrich")
                item.update(patch)
                path = Path(temp) / "malformed.json"
                path.write_text(json.dumps({"lines": [item]}), encoding="utf-8")
                code, output, error = self.call_cli(str(path))
                self.assertEqual(code, 2)
                self.assertEqual(output, "")
                self.assertTrue(error.startswith("gaeb-check:"))

    def test_cli_layer1_result_hash_validation(self):
        input = from_json(ROOT / "data" / "examples" / "analysis_input.json")
        finding = prior_error("wall")
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "prior.json"
            path.write_text(json.dumps({"input_hash": input.input_hash,
                                        "findings": [finding.model_dump(mode="json")]}), encoding="utf-8")
            code, output, error = self.call_cli(str(ROOT / "data" / "examples" / "analysis_input.json"), "--prior-findings", str(path))
            self.assertEqual(code, 0, error)
            self.assertEqual(json.loads(output)["summary"]["by_layer"]["1"], 1)
            path.write_text('{"input_hash": "wrong", "findings": []}', encoding="utf-8")
            code, _, error = self.call_cli(str(ROOT / "data" / "examples" / "analysis_input.json"), "--prior-findings", str(path))
            self.assertEqual(code, 2)
            self.assertIn("input_hash", error)

    def test_cli_rejects_overwriting_input(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "input.json"
            original = "[]"
            path.write_text(original, encoding="utf-8")
            code, _, error = self.call_cli(str(path), "-o", str(path))
            self.assertEqual(code, 2)
            self.assertIn("Output must differ", error)
            self.assertEqual(path.read_text(encoding="utf-8"), original)

    def test_cli_invalid_tolerance_is_usage_error(self):
        for tolerance in ("invalid", "-0.1", "1", "NaN"):
            with self.subTest(tolerance=tolerance):
                with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as caught:
                    main([str(ROOT / "data" / "examples" / "items.json"), "--tolerance", tolerance])
                self.assertEqual(caught.exception.code, 2)


class FalsePositiveTests(unittest.TestCase):
    """Texts taken from the GAEB files in data/tenders/ that used to raise dependency warnings."""

    def rules_hit(self, *lines):
        return {f.rule_id for f in run(input_for(*lines), [])}

    def test_material_in_long_text_is_not_a_trigger(self):
        coupling = line("k", "Flexible Rohrkupplung, zugfest, DN 100", "4", "St",
                        long_text="Dichtmanschette aus EPDM, Hersteller: '..........'")
        removal = line("d", "Demontage der bestehenden Rohrleitungen", "1", "psch",
                       long_text="Rohrleitungsstützen aus Beton werden bauseits entfernt.")
        precast = line("e", "Einlaufbauwerk, Fertigteil", "1", "St",
                       long_text="Bauwerk bestehend aus: Bodenplatte 3,00 x 1,20 m")
        self.assertEqual(self.rules_hit(coupling, removal, precast), set())

    def test_demolition_precast_and_temporary_items_are_excluded(self):
        for text in ["Bordstein Beton abbrechen TB10/25", "Rückbau Bordstein Beton zur Wiederverwendung",
                     "Bestehende Bachverrohrung DN 600 Beton ausbauen, entsorgen",
                     "Behelfsüberfahrt L 2-4m Stahlbeton herstellen", "Estrich entfernen und entsorgen",
                     "Kernbohrung Stahlbeton/Mauerwerk Durchm. 400 bis 500mm",
                     "Rohrkupplung mit EPDM-Dichtung", "Stahlbetonrohre DN 800 liefern und verlegen"]:
            with self.subTest(text=text):
                self.assertEqual(self.rules_hit(line("a", text, "10", "m")), set())

    def test_real_work_still_triggers(self):
        wall = self.rules_hit(line("w", "Stahlbetonwand C30/37, d = 25 cm", "20", "m³"))
        self.assertIn("L2.CONCRETE.STRUCTURE_NEEDS_FORMWORK", wall)
        self.assertIn("L2.CONCRETE.STRUCTURE_NEEDS_REINFORCEMENT_STEEL", wall)
        roof = self.rules_hit(line("r", "EPDM-Dachbahn verlegen", "300", "m²"))
        self.assertTrue(any(rule.startswith("L2.ROOF.") for rule in roof))

    def test_unreinforced_concrete_needs_no_reinforcement(self):
        found = self.rules_hit(line("f", "Streifenfundament C25/30 unbewehrt", "12", "m³"))
        self.assertIn("L2.CONCRETE.STRUCTURE_NEEDS_FORMWORK", found)
        self.assertNotIn("L2.CONCRETE.STRUCTURE_NEEDS_REINFORCEMENT_STEEL", found)

    def test_trigger_in_all_searches_long_text(self):
        spec = {"RuleID": "L2.TEST.ALL", "Category": "Test", "TriggerRegex": "primary", "TriggerIn": "all",
                "Required_Dependencies": [{"DependencyName": "Finish", "Regex": "finish", "CheckType": "Boolean"}]}
        item = line("a", "Bauteil", long_text="primary element")
        self.assertEqual(len(run(input_for(item), [], rules=[RuleSpec.model_validate(spec)])), 1)
        spec["TriggerIn"] = "short_text"
        self.assertEqual(run(input_for(item), [], rules=[RuleSpec.model_validate(spec)]), [])

    def test_invalid_exclude_regex_is_rejected(self):
        with self.assertRaises(ValueError):
            RuleSpec.model_validate({"RuleID": "L2.TEST.BAD", "Category": "Test", "TriggerRegex": "x",
                                     "ExcludeRegex": "(", "Required_Dependencies": [
                                         {"DependencyName": "Y", "Regex": "y", "CheckType": "Boolean"}]})

    def test_real_gaeb_files_raise_no_dependency_warnings(self):
        from analysis.adapter import from_file
        from analysis.runner import analyze as run_pipeline
        files = [p for p in sorted((ROOT / "data" / "tenders").glob("*"))
                 if p.suffix.lower()[:2] in {".x", ".d"} and p.suffix[2:].isdigit()]
        self.assertTrue(files)
        for path in files:
            with self.subTest(file=path.name):
                result = run_pipeline(from_file(path), [1, 2])
                warnings = [f.rule_id for f in result.findings if f.layer == 2 and f.severity == "warning"]
                self.assertEqual(warnings, [])


class EngineTweakTests(unittest.TestCase):
    """NEXT_FEATURES_IMPLEMENTATION_PLAN.md §2.4: per-dependency severity, dimension skipping, PDF item flags."""

    def test_info_dependency_is_info_but_keeps_its_proposal(self):
        findings = selected(input_for(line("s", "UP-Schuko-Steckdose", "10", "St")), "RCD_PROTECTION")
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].severity, "info")
        self.assertEqual(findings[0].evidence["dependency_severity"], "info")
        self.assertIsNotNone(findings[0].suggested_fix)
        meta = {item["rule_id"]: item for item in rule_metadata()}
        self.assertEqual(meta["L2.ELEC.INSTALLATION_NEEDS_RCD_PROTECTION"]["default_severity"], "info")
        self.assertEqual(meta["L2.ELEC.INSTALLATION_NEEDS_DEVICE_BOXES"]["default_severity"], "warning")

    def test_severity_must_be_warning_or_info(self):
        with self.assertRaises(ValueError):
            RuleSpec.model_validate({"RuleID": "L2.TEST.SEV", "Category": "Test", "TriggerRegex": "x",
                                     "Required_Dependencies": [{"DependencyName": "Y", "Regex": "y",
                                                                "CheckType": "Boolean", "Severity": "error"}]})

    def test_match_in_other_dimension_is_skipped_not_blocking(self):
        # LV_14: insulation shells in pieces next to pipe insulation in metres.
        input = input_for(line("p", "TW-Rohrleitung, Edelstahl 15x1", "100", "m"),
                          line("i", "Isolierung TW-Rohr DN 12", "100", "m"),
                          line("d", "Dämmschale DN 15", "4", "St"))
        self.assertEqual(selected(input, "PIPE_INSULATION"), [])
        short = input_for(line("p", "TW-Rohrleitung, Edelstahl 15x1", "100", "m"),
                          line("i", "Isolierung TW-Rohr DN 12", "50", "m"),
                          line("d", "Dämmschale DN 15", "4", "St"))
        finding = selected(short, "PIPE_INSULATION")[0]
        self.assertEqual(finding.severity, "warning")
        self.assertEqual(finding.evidence["reason"], "quantity_shortfall")
        self.assertEqual(Decimal(finding.evidence["dependency_quantity"]), 50)
        self.assertEqual([s["line_id"] for s in finding.evidence["skipped_dependency_lines"]], [short.lines[2].id])

    def test_triggers_all_in_other_dimension_give_no_comparison(self):
        input = input_for(line("t", "Treppenbelag Feinsteinzeug", "12", "St"))
        self.assertEqual(selected(input, "TILE.COVERING_NEEDS_PRIMER"), [])

    def test_pdf_optional_items_neither_trigger_nor_cover(self):
        optional = {"unit_price_only": "True", "provisional_included": "False", "alternative_item": "False"}
        firm = {"unit_price_only": "False", "provisional_included": "False", "alternative_item": "False"}
        trigger_only_optional = input_for(line("s", "Zementestrich CT-C25-F4", gaeb_flags=optional))
        self.assertEqual(run(trigger_only_optional, []), [])
        cover_only_optional = input_for(
            line("s", "Zementestrich CT-C25-F4", gaeb_flags=firm),
            line("r", "*** Bedarfsposition ohne GB", "40", "m", long_text="Randdämmstreifen", gaeb_flags=optional))
        self.assertEqual(len(selected(cover_only_optional, "EDGE_INSULATION")), 1)


class NewTradeTests(unittest.TestCase):
    """The ten groups added from NEXT_FEATURES_IMPLEMENTATION_PLAN.md §2.4, with texts from the LV_xx PDFs in data/tenders/."""

    def hits(self, *lines):
        return {f.rule_id: f for f in run(input_for(*lines), [])}

    def test_each_new_group_detects_its_gaps(self):
        cases = [
            (line("a", "UP-Schuko-Steckdose Standard", "215", "St"), "L2.ELEC.INSTALLATION_NEEDS_INSTALLATION_CABLE"),
            (line("a", "Einbauleuchte 3200 R300-1200", "98", "St"), "L2.ELEC.LIGHTING_NEEDS_EMERGENCY_LIGHTING"),
            (line("a", "Energiekabel NYCWY 4 x 50/25mm²", "80", "m"), "L2.ELEC.CABLING_NEEDS_CABLE_ROUTING"),
            (line("a", "Blitzschutz-Stahlband 20x2,5mm", "100", "m"), "L2.ELEC.LIGHTNING_PROTECTION_NEEDS_EARTHING"),
            (line("a", "Tiefspül-WC, 4,5/6 l, EN 997", "11", "St"), "L2.SANITARY.WC_NEEDS_WC_SEAT"),
            (line("a", "TW-Rohrleitung, Sanpress INOX 15x1", "130", "m"), "L2.SANITARY.POTABLE_WATER_NEEDS_PRESSURE_TEST"),
            (line("a", "Bodenfliesen,30x30cm, Feinsteinzeug", "63", "m²"), "L2.TILE.COVERING_NEEDS_PRIMER"),
            (line("a", "T 30 RS - Stahltürelement, 1010 x 2135 mm", "1", "St"), "L2.DOOR.STEEL_NEEDS_DOOR_CLOSER"),
            (line("a", "Sektionaltor mit elektr. Antrieb, ca. 4000 x 4000 mm", "2", "St"),
             "L2.DOOR.INDUSTRIAL_NEEDS_SAFETY_EDGE_OR_LIGHT_BARRIER"),
            (line("a", "Kunststofffenster, 2-flügelig, 1250 x 1500 mm", "8", "St"),
             "L2.WINDOW_NEEDS_INSTALLATION_JOINT_SEALING"),
        ]
        for item, rule_id in cases:
            with self.subTest(rule=rule_id):
                self.assertIn(rule_id, self.hits(item))

    def test_lv14_wc_group_is_complete(self):
        # 11 + 1 WCs against 11 + 1 seats, flush releases and frames: no finding (0% tolerance).
        found = self.hits(
            line("w1", "Tiefspül-WC, 4,5/6 l, EN 997, DIN-EN 38", "11", "St"),
            line("s1", "WC-Sitz mit Deckel", "11", "St"),
            line("f1", "Installationselement für Wand-WC 112 cm mit UP-Spk.", "11", "St"),
            line("p1", "Samba Betätigungsplatte für 2-Mengen-Spülung", "11", "St"),
            line("w2", "Tiefspül-WC, CE, EN 997 6 A/C, EN 38,", "1", "St"),
            line("s2", "WC-Sitz ohne Deckel", "1", "St"),
            line("f2", "Montageelement Wand-WC 112 cm mit UP-Spülkasten", "1", "St"),
            line("p2", "Automatikspülung für WC", "1", "St"))
        self.assertFalse([rule for rule in found if rule.startswith("L2.SANITARY.WC")])

    def test_one_missing_wc_seat_is_a_shortfall(self):
        found = self.hits(line("w", "Wand-WC Tiefspüler", "12", "St"), line("s", "WC-Sitz mit Deckel", "11", "St"))
        finding = found["L2.SANITARY.WC_NEEDS_WC_SEAT"]
        self.assertEqual(finding.evidence["reason"], "quantity_shortfall")
        self.assertEqual(finding.suggested_fix.operations[0].line.quantity, Decimal(1))

    def test_floor_standing_wc_needs_no_frame(self):
        found = self.hits(line("w", "Stand-WC Tiefspüler", "2", "St"))
        self.assertIn("L2.SANITARY.WC_NEEDS_WC_SEAT", found)
        self.assertNotIn("L2.SANITARY.WC_NEEDS_MOUNTING_FRAME", found)

    def test_wet_room_waterproofing_only_for_wet_rooms(self):
        self.assertNotIn("L2.TILE.COVERING_NEEDS_WET_ROOM_WATERPROOFING",
                         self.hits(line("t", "Wandfliesen WC,20/50cm, Dünnbett weiß", "104", "m²")))
        self.assertIn("L2.TILE.COVERING_NEEDS_WET_ROOM_WATERPROOFING",
                      self.hits(line("t", "Bodenfliesen Dusche, rutschhemmend R10", "12", "m²")))

    def test_lv19_gaps(self):
        # Doors "PZ-Vorgerichtet" with an OTS but no cylinder; a powered gate with safety edge but no power supply.
        door = line("d", "T 30 RS - Stahltürelement, 1010 x 2135 mm", "1", "St",
                    long_text="OTS mit Gleitschiene\nBodendichtung\nPZ-Vorgerichtet\nBeschlagsteile und Türgriffgarnituren")
        gate = line("g", "Sektionaltor mit elektr. Antrieb, ca. 4000 x 4000 mm", "2", "St",
                    long_text="E-Drehstrommotor, Lichtschranke, Schließkantensicherung")
        found = self.hits(door, gate)
        self.assertEqual(found["L2.DOOR.STEEL_NEEDS_LOCK_CYLINDER"].severity, "info")
        self.assertEqual(found["L2.DOOR.INDUSTRIAL_NEEDS_DRIVE_POWER_SUPPLY"].severity, "info")
        for rule in ("L2.DOOR.STEEL_NEEDS_DOOR_CLOSER", "L2.DOOR.STEEL_NEEDS_DOOR_HARDWARE",
                     "L2.DOOR.INDUSTRIAL_NEEDS_SAFETY_EDGE_OR_LIGHT_BARRIER"):
            self.assertNotIn(rule, found)

    def test_escape_route_in_another_long_text_is_not_emergency_lighting(self):
        found = self.hits(line("l", "Anbauleuchte Rund 1000", "32", "St"),
                          line("b", "Brandschott S90 - 800cm²", "10", "St",
                               long_text="Abschottung in Fluchtwegen und notwendigen Fluren"))
        self.assertIn("L2.ELEC.LIGHTING_NEEDS_EMERGENCY_LIGHTING", found)

    def test_outdoor_luminaires_need_no_emergency_lighting(self):
        found = self.hits(line("l", "Pollerleuchte 2255lm", "4", "St"))
        self.assertNotIn("L2.ELEC.LIGHTING_NEEDS_EMERGENCY_LIGHTING", found)

    def test_floating_screed_needs_no_primer(self):
        found = self.hits(line("s", "Zementestrich auf TSD/WD,CT, 65mm", "85", "m²"))
        self.assertNotIn("L2.FLOOR.SCREED_NEEDS_PRIMER_AND_LEVELING", found)
        self.assertIn("L2.FLOOR.SCREED_NEEDS_EDGE_INSULATION", found)

    def test_real_texts_that_are_not_triggers(self):
        for text, unit in [
            ("Messung Estrichfeuchte", "psch"), ("Aussparung,< 0,1m2,Estrich", "St"),
            ("Plattenbelag Beton 30x30x4cm durchgefärbt", "m²"),
            ("Thermische Steckdose für PE-Xa Rohr 20x2,3", "St"),
            ("Verstärkung für Einbauleuchten", "St"), ("Schutz Mastleuchte Bestand H 2m herstellen", "St"),
            ("Böschungspflaster Naturstein", "m²"),
            ("Isolierung TW-Rohr DN 12", "m"), ("WC-Trennw,Melamin,Vollspanpl.", "St"),
            ("Blitzschutz Fundamente und Ringerder", "m"), ("Innenfensterbank,MDF/HPL,30x195mm", "m"),
            ("Fensteröffnung anlegen,bis 2,0m2", "St"), ("Sockelleiste,Fliesen,H=10cm", "m"),
            ("Warnleuchte vorhalten", "St"), ("Zul.GKBI-Platten statt GKB,2lg", "m²"),
        ]:
            with self.subTest(text=text):
                self.assertEqual(self.hits(line("a", text, "10", unit)), {})

    def test_concrete_facing_shell_is_concrete_not_drywall(self):
        rules = set(self.hits(line("a", "Vorsatzschale Beton Stützwand Ost", "10", "m²")))
        self.assertIn("L2.CONCRETE.STRUCTURE_NEEDS_FORMWORK", rules)
        self.assertFalse([rule for rule in rules if rule.startswith("L2.DRYWALL.")])

    def test_painting_on_concrete_or_doors_is_painting_only(self):
        for text, unit in [("Dispersionsfarbe,Decken Beton,NAB3", "m²"), ("Lackierung Stahltüren", "St")]:
            with self.subTest(text=text):
                rules = set(self.hits(line("a", text, "10", unit)))
                self.assertTrue(rules)
                self.assertTrue(all(rule.startswith("L2.PAINT.") for rule in rules))

    def test_pulled_or_buried_cables_need_no_trays(self):
        for text in ("Kabel 0.6/1 kV einziehen NYY 3x1.5", "Erdverbindungskabel NYY 7 x 1,5 mm²"):
            with self.subTest(text=text):
                self.assertNotIn("L2.ELEC.CABLING_NEEDS_CABLE_ROUTING", self.hits(line("c", text, "50", "m")))


if __name__ == "__main__":
    unittest.main()

