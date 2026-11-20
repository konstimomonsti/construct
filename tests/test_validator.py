import copy
from decimal import Decimal
import io
import json
from pathlib import Path
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr

from analysis.adapter import canonical_hash, from_data, from_json, parse_number
from analysis.cli import main
from analysis.contracts import Finding, Target
from analysis.layer2 import run
from analysis.layer2.schema import RuleSpec, compile_regex, load_rules, rule_metadata
from analysis.runner import analyze
from analysis.units import convert, dimension, normalize_unit

ROOT = Path(__file__).resolve().parents[1]


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
                                 "reference_range": {"min": "1,1", "n": 1}}, gaeb_flags=flags,
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
    def test_all_five_groups_and_sixteen_registered_checks(self):
        self.assertEqual(len(load_rules()), 5)
        self.assertEqual(len(rule_metadata()), 16)
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
        input = input_for(line("s", "Estrich"), line("v", "Vinyl", "100", "kg"))
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
        self.assertIsNone(proposal.line.unit)
        self.assertLess(finding.suggested_fix.confidence, 1)
        self.assertEqual(proposal.after_line_id, "p")

    def test_prior_layer1_errors_downgrade_quantities(self):
        input = input_for(line("s", "Estrich"), line("v", "Vinyl", "50"))
        for line_id in ("s", "v"):
            findings = run(input, [prior_error(line_id)])
            finding = next(f for f in findings if f.rule_id.endswith("FLOOR_COVERING"))
            self.assertEqual(finding.severity, "info")
            self.assertIsNone(finding.suggested_fix)
        findings = run(input, [prior_error("s", severity="warning")])
        self.assertEqual(next(f for f in findings if f.rule_id.endswith("FLOOR_COVERING")).severity, "warning")

    def test_stable_finding_id_and_pure_repeated_runs(self):
        input = input_for(line("s", "Estrich"))
        before = input.model_dump_json()
        a, b = analyze(input), analyze(input)
        self.assertEqual(before, input.model_dump_json())
        self.assertEqual([f.id for f in a.findings], [f.id for f in b.findings])
        self.assertNotEqual(a.run_id, b.run_id)
        self.assertTrue(all(f.status == "open" for f in a.findings))
        self.assertEqual(a.summary["by_layer"], {"2": len(a.findings)})
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
        input = from_json(ROOT / "examples" / "analysis_input.json")
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
        input = input_for(line("s", "Estrich", distributions=[{"area_id": "a", "quantity": "60"}]))
        findings = selected(input, "FLOOR_COVERING")
        self.assertEqual(len(findings), 2)
        self.assertEqual({Decimal(f.evidence["trigger_quantity"]) for f in findings}, {Decimal(60), Decimal(40)})
        self.assertEqual(len({f.id for f in findings}), 2)

    def test_overallocated_or_missing_distribution_is_unreliable(self):
        for quantity in (None, "110"):
            input = input_for(line("s", "Estrich", distributions=[{"area_id": "a", "quantity": quantity}]))
            findings = selected(input, "FLOOR_COVERING")
            self.assertTrue(all(f.severity == "info" for f in findings))
            self.assertTrue(all(f.suggested_fix is None for f in findings))


class CliTests(unittest.TestCase):
    def call_cli(self, *args):
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = main(list(args))
        return code, stdout.getvalue(), stderr.getvalue()

    def test_cli_json_and_failure_threshold(self):
        code, output, error = self.call_cli(str(ROOT / "examples" / "items.json"), "--scope", "trade", "--fail-on", "warning")
        self.assertEqual(code, 1, error)
        report = json.loads(output)
        self.assertEqual(report["summary"]["total"], 8)
        self.assertEqual({f["rule_id"].split(".")[1] for f in report["findings"]},
                         {"FLOOR", "CONCRETE", "DRYWALL", "PAINT", "ROOF"})

    def test_cli_table_and_rule_registry(self):
        code, output, _ = self.call_cli(str(ROOT / "examples" / "analysis_input.json"), "--format", "table")
        self.assertEqual(code, 0)
        self.assertIn("office", output.lower())
        code, output, _ = self.call_cli("--list-rules")
        self.assertEqual(code, 0)
        self.assertEqual(len(json.loads(output)), 16)

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
        input = from_json(ROOT / "examples" / "analysis_input.json")
        finding = prior_error("wall")
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "prior.json"
            path.write_text(json.dumps({"input_hash": input.input_hash,
                                        "findings": [finding.model_dump(mode="json")]}), encoding="utf-8")
            code, output, error = self.call_cli(str(ROOT / "examples" / "analysis_input.json"), "--prior-findings", str(path))
            self.assertEqual(code, 0, error)
            self.assertEqual(json.loads(output)["summary"]["by_layer"]["1"], 1)
            path.write_text('{"input_hash": "wrong", "findings": []}', encoding="utf-8")
            code, _, error = self.call_cli(str(ROOT / "examples" / "analysis_input.json"), "--prior-findings", str(path))
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
                    main([str(ROOT / "examples" / "items.json"), "--tolerance", tolerance])
                self.assertEqual(caught.exception.code, 2)



if __name__ == "__main__":
    unittest.main()

