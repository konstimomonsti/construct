"""Task 02 layer 3 checks on the LV_11 precast fixture. No network: answers come from FakeProvider."""

from decimal import Decimal
import json
from pathlib import Path
import re
import time

import pytest

from analysis import adapter, layer3
from analysis.contracts import AnalysisInput, Finding, Line, Section, Target
from analysis.layer2.adapter import from_data
from analysis.layer3 import prompts
from analysis.layer3.common import Session
from analysis.layer3.provider import FakeProvider, LLMRequest, OllamaProvider, ProviderError, ResponseCache
from analysis.layer3.schema import PRECAST_SCHEMA, QUANTITY_SCHEMA, SCOPE_SCHEMA, UNDERSPECIFIED_SCHEMA
from analysis.registry import rules_for
from analysis.runner import analyze

FIXTURE = Path(__file__).parent / "fixtures" / "lv11_precast.json"
MISSING = "L3.PRECAST.MISSING_SPEC"
REBAR = "L3.SCOPE.REBAR_AMBIGUOUS"
SHOP = "L3.SCOPE.SHOP_DRAWINGS_OVERLAP"
EMBEDDED = "L3.SCOPE.EMBEDDED_UNALLOCATED"
BUNDLED = "L3.OPT.BUNDLED_FORMWORK"
UNDER = "L3.TEXT.UNDERSPECIFIED"
QTY = "L3.QTY.IMPLAUSIBLE"
CONTRA = "L3.TEXT.SHORT_LONG_CONTRADICTION"
SANDWICH_CODES = ["3.2.20", "3.2.30", "3.2.40", "3.2.50", "3.2.60"]


def lv11() -> AnalysisInput:
    return AnalysisInput.model_validate_json(FIXTURE.read_text(encoding="utf-8")).with_hash()


def payload(request):
    return json.loads(request.prompt.split("\n\n", 1)[1])


def _num(pattern, text):
    match = re.search(pattern, text, re.IGNORECASE)
    return float(match.group(1).replace(",", ".")) if match else None


def extract_like_a_model(item):
    """What a well-behaved extraction model returns for one LV_11-style item."""
    text = f"{item['short_text'] or ''}\n{item['long_text'] or ''}"
    low = text.lower()
    if "sandwich" in low or "ft-sockel" in low:
        kind = "sandwich_plinth"
    elif "werkstatt" in low:
        kind = "shop_drawings"
    elif "betonstahl" in low:
        kind = "rebar"
    elif "aussparung" in low:
        kind = "opening_surcharge"
    elif "halfen" in low:
        kind = "embedded_part"
    else:
        kind = "other"
    code = re.match(r"(FS \d+)", item["short_text"] or "")
    grade = re.search(r"C\d+/\d+", text)
    ral = re.search(r"RAL \d{4}", text)
    assigned = re.findall(r"FS \d+", item["long_text"] or "") if kind == "embedded_part" else []
    purpose = "not_applicable"
    if kind == "rebar":
        purpose = "factory_reinforcement" if "werkseitig" in low else "unspecified"
    return {
        "line_ref": item["ref"], "item_type": kind, "element_code": code.group(1) if code else None,
        "length_m": _num(r"l(?:änge)?\s*[=:]\s*(?:ca\.\s*)?(\d+(?:,\d+)?)\s*m", text),
        "height_m": _num(r"h(?:öhe)?\s*[=:]\s*(\d+(?:,\d+)?)\s*m", text),
        "layers": {"facing_shell_cm": _num(r"Vorsatzschale:\s*(\d+)", text),
                   "insulation_cm": _num(r"Dämmschicht:.*?d=\s*(\d+)", text), "insulation_material": None,
                   "structural_shell_cm": _num(r"Tragschale:\s*(\d+)", text),
                   "total_thickness_cm": _num(r"d=(\d+)cm gesamt", text)} if kind == "sandwich_plinth" else None,
        "concrete_grade": grade.group(0) if grade else None,
        "exposure_classes": re.findall(r"\b(XC\d|XF\d|WA)\b", text),
        "surface_inside": "SB2" if "innen: Sichtbeton SB2" in text else None,
        "surface_outside": "SB2" if "außen: Sichtbeton SB2" in text else None,
        "is_through_colored": "durchgefärbt" in low, "color_pigment_ral": ral.group(0) if ral else None,
        "includes_transport_and_mounting": "montage" in low,
        "includes_anchor_engineering": "planung der sandwichplattenanker" in low,
        "axis_location": None, "has_redacted_or_unclear_text": "[" in text, "unclear_text_evidence": None,
        "rebar_purpose": purpose, "assigned_element_codes": assigned,
    }


def audit_like_a_model(request):
    """What a well-behaved audit model returns: every cross-item problem the item data shows."""
    data = payload(request)["items"]
    elements = [i["code"] for i in data if i.get("item_type") == "sandwich_plinth"]
    findings = []
    for item in data:
        kind, code = item.get("item_type"), item["code"]
        if kind == "rebar" and item.get("rebar_purpose", "unspecified") == "unspecified" and elements:
            findings.append({"check": "REBAR_AMBIGUOUS", "line_code": code, "related_codes": elements,
                             "message": f"Rebar {code} is tendered separately from the precast elements.",
                             "bieterfrage_de": f"Zu Pos. {code}: Handelt es sich um die Bewehrung der Fertigteile "
                                               f"oder um Anschlussbewehrung auf der Baustelle?",
                             "confidence": 0.9})
        if kind == "shop_drawings" and any(i.get("includes_anchor_engineering") for i in data):
            findings.append({"check": "SHOP_DRAWINGS_OVERLAP", "line_code": code, "related_codes": elements,
                             "message": "Shop drawings overlap the anchor design in the elements.",
                             "bieterfrage_de": f"Zu Pos. {code}: Ist die Ankerplanung hier oder in den "
                                               f"Elementpositionen zu kalkulieren?", "confidence": 0.8})
        if kind == "embedded_part" and not item.get("assigned_element_codes"):
            findings.append({"check": "EMBEDDED_UNALLOCATED", "line_code": code, "related_codes": elements,
                             "message": "Halfen parts are not assigned to elements.",
                             "bieterfrage_de": "Bitte ordnen Sie die Einbauteile den Elementen zu.",
                             "confidence": 0.8})
    return {"findings": findings}


def fake_model(request, *, extract=extract_like_a_model, audit=audit_like_a_model, under=None, qty=None):
    if request.prompt_version == prompts.PRECAST_VERSION:
        return {"items": [extract(item) for item in payload(request)["items"]]}
    if request.prompt_version == prompts.SCOPE_VERSION:
        return audit(request)
    if request.prompt_version == prompts.UNDERSPECIFIED_VERSION and under:
        return under(request)
    if request.prompt_version == prompts.QUANTITY_VERSION and qty:
        return qty(request)
    return {"findings": [], "reviews": []}


def run3(analysis_input, provider, prior=None, **kwargs):
    errors = []
    findings = layer3.run(analysis_input, prior or [], errors, provider=provider,
                          cache=kwargs.pop("cache", ResponseCache(None)), **kwargs)
    return findings, errors


def by_rule(findings, rule_id):
    return [finding for finding in findings if finding.rule_id == rule_id]


def complete_coverage(errors):
    return len(errors) == 1 and re.fullmatch(r"layer 3 coverage: (\d+)/\1 batches", errors[0]) is not None


def versions(provider):
    return [request.prompt_version for request in provider.requests]


# --------------------------------------------------------------------------- registration and schemas


def test_task02_rules_registered_and_never_error():
    infos = {info.rule_id: info for info in rules_for(3)}
    assert {MISSING, REBAR, SHOP, EMBEDDED, BUNDLED, UNDER, QTY} <= set(infos)
    assert all(info.severity in ("warning", "info") for info in infos.values())


@pytest.mark.parametrize("schema", [PRECAST_SCHEMA, SCOPE_SCHEMA, UNDERSPECIFIED_SCHEMA, QUANTITY_SCHEMA])
def test_new_schemas_are_strict(schema):
    item = next(iter(schema["properties"].values()))["items"]
    assert item["additionalProperties"] is False
    assert set(item["required"]) == set(item["properties"])


# --------------------------------------------------------------------------- acceptance: LV_11


def test_lv11_missing_spec_on_all_sandwich_elements():
    findings, errors = run3(lv11(), FakeProvider(fake_model))
    assert complete_coverage(errors)
    missing = {f.target.line_code: f for f in by_rule(findings, MISSING)}
    assert sorted(missing) == SANDWICH_CODES
    finding = missing["3.2.20"]
    assert finding.severity == "warning" and finding.layer == 3 and finding.origin == "llm"
    assert finding.evidence["missing_fields"] == ["height_m", "color_pigment_ral"]
    assert finding.evidence["spec_checks"] == ["DEP_001", "DEP_002"]
    extracted = finding.evidence["extracted"]
    assert extracted["item_type"] == "sandwich_plinth" and extracted["oz"] == "3.2.20"
    assert extracted["length_m"] == 6.35 and extracted["concrete_grade"] == "C35/45"
    assert extracted["layers"]["total_thickness_cm"] == 30 and extracted["is_through_colored"] is True
    question = finding.evidence["bieterfrage_de"]
    assert question.startswith("Zu Pos. 3.2.20 (FS 01): ")
    assert "Elementhöhe" in question and "RAL-Farbton" in question
    assert finding.evidence["prompt_version"] == prompts.PRECAST_VERSION


def test_lv11_rebar_scope_ambiguous_on_3_2_70_with_audit_model():
    extraction, auditor = FakeProvider(fake_model, model_id="fake-haiku"), FakeProvider(fake_model, model_id="fake-sonnet")
    findings, errors = run3(lv11(), extraction, audit_provider=auditor)
    assert complete_coverage(errors)
    assert versions(auditor) == [prompts.SCOPE_VERSION]  # one audit call for the one precast section
    assert prompts.SCOPE_VERSION not in versions(extraction)
    rebar = by_rule(findings, REBAR)
    assert [f.target.line_code for f in rebar] == ["3.2.70"]
    finding = rebar[0]
    assert finding.model == "fake-sonnet" and finding.severity == "warning"
    assert finding.evidence["change_order"] is True
    assert finding.evidence["bieterfrage_de"].startswith("Zu Pos. 3.2.70: ")
    assert finding.evidence["related_codes"] == SANDWICH_CODES
    # the audit got the extracted JSON, not the raw long texts
    sent = payload(auditor.requests[0])["items"]
    assert all("long_text" not in item for item in sent)
    assert {item["code"]: item["item_type"] for item in sent}["3.2.70"] == "rebar"


def test_lv11_other_scope_findings_with_unconfirmed_section_geometry():
    findings, _ = run3(lv11(), FakeProvider(fake_model))
    assert [f.target.line_code for f in by_rule(findings, SHOP)] == ["3.2.10"]
    embedded = by_rule(findings, EMBEDDED)
    assert [f.target.line_code for f in embedded] == ["3.2.90"]
    assert embedded[0].evidence["bieterfrage_de"].startswith("Zu Pos. 3.2.90: ")  # prefixed in code
    assert by_rule(findings, BUNDLED) == []


def test_bundling_requires_matching_height_layers_surfaces_and_colour():
    bill = lv11()
    bill.lines = [
        line.model_copy(update={"long_text": f"{line.long_text}\nHöhe: 0,60 m. Farbton RAL 7032."})
        if line.code in SANDWICH_CODES else line
        for line in bill.lines
    ]
    findings, _ = run3(bill.with_hash(), FakeProvider(fake_model))
    bundled = by_rule(findings, BUNDLED)
    assert len(bundled) == 1 and bundled[0].severity == "info" and bundled[0].scope == "section"
    assert bundled[0].evidence["total_bundled_precast_length_m"] == "20.67"
    assert bundled[0].evidence["line_codes"] == SANDWICH_CODES


# --------------------------------------------------------------------------- negatives and anti-hallucination


def complete_precast_input():
    return from_data({
        "sections": [{"id": "s1", "code": "1", "title": "Stahlbetonfertigteile", "sort_order": 0}],
        "lines": [
            {"id": "a", "code": "1.10", "section_id": "s1", "short_text": "FS 01: FT-Sockel, Sandwichelement, l=6,35m",
             "long_text": "FT-Sockel als Sandwichelement, d=30cm gesamt. Außenflächen aus durchgefärbtem Beton, "
                          "Farbton RAL 7016. Beton: C35/45, XC2. Höhe: 0,80 m. Länge: 6,35 m.",
             "quantity": "1", "unit": "St"},
            {"id": "b", "code": "1.20", "section_id": "s1", "short_text": "Betonstahl B500",
             "long_text": "Betonstahl B500 als werkseitige Bewehrung der Fertigteile liefern und einbauen.",
             "quantity": "0.7", "unit": "t"},
        ],
    })


def test_complete_element_and_explicit_rebar_give_no_findings():
    provider = FakeProvider(fake_model)
    findings, errors = run3(complete_precast_input(), provider)
    assert complete_coverage(errors)
    assert by_rule(findings, MISSING) == [] and by_rule(findings, REBAR) == []
    # rebar purpose stated, no shop drawings, no embedded parts: the audit is not even sent
    assert prompts.SCOPE_VERSION not in versions(provider)


def test_extracted_values_not_in_the_text_are_ignored():
    def inventing(item):
        data = extract_like_a_model(item)
        if data["item_type"] == "sandwich_plinth":
            data.update(height_m=2.5, color_pigment_ral="RAL 9010", concrete_grade="C50/60")
        return data

    findings, _ = run3(lv11(), FakeProvider(lambda r: fake_model(r, extract=inventing)))
    finding = {f.target.line_code: f for f in by_rule(findings, MISSING)}["3.2.30"]
    assert finding.evidence["missing_fields"] == ["height_m", "concrete_grade", "color_pigment_ral"]
    assert finding.evidence["extracted"]["height_m"] is None


def test_explicit_dimensions_override_unsupported_model_values():
    def wrong_units(item):
        data = extract_like_a_model(item)
        if data["item_type"] == "sandwich_plinth":
            data.update(height_m=80, length_m=635, layers={"total_thickness_cm": 3},
                        color_pigment_ral=None)
        return data

    bill = complete_precast_input()
    line = bill.lines[0]
    bill.lines[0] = line.model_copy(update={
        "long_text": line.long_text.replace("d=30cm gesamt", "Gesamtdicke: 300 mm").replace("Höhe: 0,80 m.", "80 cm hoch."),
    })
    findings, errors = run3(bill.with_hash(), FakeProvider(lambda r: fake_model(r, extract=wrong_units)))
    assert complete_coverage(errors)
    finding, = by_rule(findings, MISSING)
    assert finding.evidence["missing_fields"] == ["color_pigment_ral"]
    measured = finding.evidence["extracted"]
    assert (measured["height_m"], measured["length_m"], measured["layers"]["total_thickness_cm"]) == (0.8, 6.35, 30)


@pytest.mark.parametrize("backend", ["x83", "json"])
def test_compact_ollama_precast_seed_and_planted_faults(tmp_path, monkeypatch, backend):
    from analysis.eval.mutate import generate

    generate(out_dir=tmp_path, only={"__precast_only__"}, include_precast=True, demo=False, backends=(backend,))
    provider = OllamaProvider()
    def answer(request):
        if request.prompt_version == "l3-precast-local-v1":
            batch = payload(request)["items"]
            schema = request.schema["properties"]["items"]
            assert schema["maxItems"] == len(batch) <= 4
            assert set(schema["items"]["required"]) == {
                "line_ref", "item_type", "rebar_purpose", "color_pigment_ral",
            }
            return {"items": [
                {"line_ref": item["ref"], "item_type": "embedded_part" if item["code"] == "3.2.90" else "other",
                 "rebar_purpose": "unspecified", "color_pigment_ral": "Sichtbeton"}
                for item in batch
            ]}
        if request.prompt_version == "l3-precast-local-rebar-v1":
            assert "rebar_scope_quote" in request.schema["properties"]["items"]["items"]["required"]
            return {"items": [
                {"line_ref": item["ref"], "item_type": "rebar", "rebar_purpose": "factory_reinforcement",
                 "rebar_scope_quote": "werkseitige Bewehrung" if item["code"] == "3.2.70" else "invented purpose"}
                for item in payload(request)["items"]
            ]}
        if request.prompt_version == "l3-scope-local-v1":
            data = payload(request)
            roles = {item["code"]: item.get("rebar_purpose") for item in data["items"]}
            assert roles["3.2.70"] == "site_connection"
            assert roles["3.2.75"] == "unspecified"
            return {"findings": [candidate["ref"] for candidate in data["candidates"]]}
        return {"findings": [], "reviews": []}
    monkeypatch.setattr(provider, "complete_json", answer)
    monkeypatch.setattr(layer3, "provider_from_env", lambda: provider)
    monkeypatch.setattr(layer3, "audit_provider_from_env", lambda provider: provider)
    monkeypatch.setenv("ANALYSIS_L3_CACHE", "off")

    extension = "X83" if backend == "x83" else "json"

    def run_file(name):
        path = tmp_path / "mutated" / f"{name}.{extension}"
        result = analyze(adapter.from_file(path) if backend == "x83" else adapter.from_json(path), [1, 2, 3])
        assert complete_coverage(result.errors)
        return result.findings

    assert run_file("precast_lv11_clean") == []
    missing, = by_rule(run_file("PRECAST-MISSING-SPEC"), MISSING)
    assert missing.target.line_code == "3.2.40"
    assert missing.evidence["missing_fields"] == ["height_m", "color_pigment_ral"]
    assert "Elementhöhe" in missing.evidence["bieterfrage_de"]
    rebar, = by_rule(run_file("PRECAST-REBAR-SCOPE"), REBAR)
    assert rebar.target.line_code == "3.2.75"
    assert rebar.evidence["related_codes"] == SANDWICH_CODES
    assert "Anschlussbewehrung" in rebar.evidence["bieterfrage_de"]


def test_compact_provider_retries_only_omitted_positions(monkeypatch):
    snapshot = complete_precast_input()
    snapshot.lines[1] = snapshot.lines[1].model_copy(update={
        "short_text": "Werkstattzeichnungen", "long_text": "Montagepläne für die Fertigteile erstellen.",
    })
    provider = OllamaProvider()
    calls = []

    def respond(request):
        if request.prompt_version != "l3-precast-local-v1":
            return {"findings": [], "reviews": []}
        batch = payload(request)["items"]
        calls.append([item["code"] for item in batch])
        return {"items": [{"line_ref": item["ref"], "item_type": "other", "rebar_purpose": "unspecified",
                           "color_pigment_ral": None}
                          for item in (batch[:1] if len(calls) == 1 else batch)]}

    monkeypatch.setattr(provider, "complete_json", respond)
    _, errors = run3(snapshot, provider)
    assert complete_coverage(errors)
    assert calls == [["1.10", "1.20"], ["1.20"]]



def test_model_omitting_a_position_reports_partial_coverage():
    def incomplete(request):
        if request.prompt_version == prompts.PRECAST_VERSION:
            return {"items": [extract_like_a_model(item) for item in payload(request)["items"] if item["code"] != "1.20"]}
        return fake_model(request)

    findings, errors = run3(complete_precast_input(), FakeProvider(incomplete))
    assert not by_rule(findings, MISSING)
    assert errors == ["L3.PRECAST.EXTRACTION: no valid extraction for 1.20", "layer 3 coverage: 3/3 batches"]


def test_audit_answers_that_break_the_preconditions_are_dropped():
    def bad_audit(request):
        return {"findings": [
            {"check": "REBAR_AMBIGUOUS", "line_code": "3.2.20", "related_codes": [], "message": "m",
             "bieterfrage_de": "Zu Pos. 3.2.20: ?", "confidence": 0.9},     # not a rebar item
            {"check": "EMBEDDED_UNALLOCATED", "line_code": "9.9.99", "related_codes": [], "message": "m",
             "bieterfrage_de": "Zu Pos. 9.9.99: ?", "confidence": 0.9},     # unknown OZ
        ]}

    findings, errors = run3(lv11(), FakeProvider(lambda r: fake_model(r, audit=bad_audit)))
    assert complete_coverage(errors)
    assert by_rule(findings, REBAR) == [] and by_rule(findings, EMBEDDED) == []


def test_no_precast_section_means_no_extraction_or_audit():
    analysis_input = from_data({"lines": [
        {"id": "a", "code": "01", "short_text": "Schacht DN 1000", "long_text": "Schacht aus Betonfertigteilen.",
         "quantity": "2", "unit": "St"},
    ]})
    provider = FakeProvider(fake_model)
    run3(analysis_input, provider)
    assert prompts.PRECAST_VERSION not in versions(provider)
    assert prompts.SCOPE_VERSION not in versions(provider)


# --------------------------------------------------------------------------- failures, cache, budget


def lv11_with_l1_finding() -> AnalysisInput:
    data = json.loads(FIXTURE.read_text(encoding="utf-8"))
    data["lines"][7]["quantity"] = None  # 3.2.80 -> L1.QTY.MISSING
    return AnalysisInput.model_validate(data).with_hash()


@pytest.mark.parametrize("failure", [ProviderError("Anthropic request timed out"), "this is not JSON"])
def test_timeout_or_invalid_json_goes_to_errors_and_layers_1_2_still_report(monkeypatch, failure):
    def failing(request):
        if request.prompt_version == prompts.PRECAST_VERSION:
            return failure
        return fake_model(request)

    monkeypatch.setattr(layer3, "provider_from_env", lambda: FakeProvider(failing))
    monkeypatch.setenv("ANALYSIS_L3_CACHE", "off")
    result = analyze(lv11_with_l1_finding(), [1, 2, 3])
    assert result.layers_run == [1, 2, 3]
    assert any(f.rule_id == "L1.QTY.MISSING" for f in result.findings)
    assert not any(f.rule_id in (MISSING, REBAR) for f in result.findings)
    assert any(e.startswith("L3.PRECAST.EXTRACTION: ") for e in result.errors)


def test_second_identical_run_is_served_from_cache(tmp_path):
    first = FakeProvider(fake_model)
    findings_1, _ = run3(lv11(), first, cache=ResponseCache(tmp_path))
    assert first.requests

    second = FakeProvider(lambda request: RuntimeError("must not be called"))
    findings_2, errors = run3(lv11(), second, cache=ResponseCache(tmp_path))
    assert second.requests == []  # 0 API calls
    assert complete_coverage(errors)
    assert sorted(f.id for f in findings_2) == sorted(f.id for f in findings_1)
    assert by_rule(findings_2, MISSING) and by_rule(findings_2, REBAR)


def test_lv11_fits_the_default_budget_and_batches_run_concurrently(monkeypatch):
    monkeypatch.setenv("ANALYSIS_L3_MAX_BATCH_LINES", "2")  # 5 extraction batches, sent concurrently
    provider = FakeProvider(fake_model)
    findings, errors = run3(lv11(), provider)
    assert complete_coverage(errors)
    assert versions(provider).count(prompts.PRECAST_VERSION) == 5
    assert len(provider.requests) <= layer3.DEFAULT_MAX_CALLS == 12
    assert sorted(f.target.line_code for f in by_rule(findings, MISSING)) == SANDWICH_CODES


def test_call_budget_reports_skipped_extraction_batches(monkeypatch):
    monkeypatch.setenv("ANALYSIS_L3_MAX_BATCH_LINES", "2")
    provider = FakeProvider(fake_model)
    findings, errors = run3(lv11(), provider, max_calls=3)
    assert len(provider.requests) == 3
    assert "L3.PRECAST.EXTRACTION: 2 batch(es) not checked (call budget of 3 reached)" in errors


def test_twenty_small_sections_share_quantity_and_text_batches():
    sections = [Section(id=f"s{i}", code=f"{i:02}", title=f"Abschnitt {i}", sort_order=i)
                for i in range(20)]
    lines = [Line(id=f"l{i}_{j}", code=f"{i:02}.{j:04}", section_id=f"s{i}", sort_order=i * 2 + j,
                  short_text=f"Leistung {i} {j}", quantity=10, unit="ea", unit_raw="St")
             for i in range(20) for j in range(2)]
    provider = FakeProvider(fake_model)
    _, errors = run3(AnalysisInput(sections=sections, lines=lines), provider, max_calls=100)
    quantity = [request for request in provider.requests if request.prompt_version == prompts.QUANTITY_VERSION]
    underspecified = [request for request in provider.requests
                      if request.prompt_version == prompts.UNDERSPECIFIED_VERSION]
    assert len(quantity) <= 3 and len(underspecified) <= 2
    assert sum(len(payload(request)["items"]) for request in quantity) == 40
    assert all("section" in item for request in quantity for item in payload(request)["items"])
    assert all(len(request.prompt) <= 12_000 for request in quantity + underspecified)
    assert len({item["ref"] for item in payload(quantity[0])["items"]}) == len(payload(quantity[0])["items"])
    assert errors == [f"layer 3 coverage: {len(provider.requests)}/{len(provider.requests)} batches"]


def test_coverage_line_reports_exact_skipped_rule_counts():
    provider = FakeProvider(lambda request: {"findings": []})
    session = Session(provider=provider, cache=ResponseCache(None), errors=[], max_calls=1)
    requests = [LLMRequest("s", f"p{i}", {"type": "object"}, "v") for i in range(3)]
    session.ask_many(QTY, requests)
    session.report()
    assert session.errors == [f"{QTY}: 2 batch(es) not checked (call budget of 1 reached)",
                              f"layer 3 coverage: 1/3 batches; skipped: {QTY}×2"]


def test_time_budget_stops_calls_and_is_reported():
    provider = FakeProvider(lambda request: {"findings": []})
    session = Session(provider=provider, cache=ResponseCache(None), errors=[], deadline=1.0,
                      started=time.monotonic() - 5)
    request = LLMRequest("s", "p", {"type": "object"}, "v")
    assert session.ask_many("L3.X", [request, request]) == [None, None]
    session.report()
    assert provider.requests == []
    assert session.errors == ["L3.X: 2 batch(es) not checked (time budget of 1 s reached)",
                              "layer 3 coverage: 0/2 batches; skipped: L3.X×2"]


def test_serial_batches_respect_deadline_after_each_request(monkeypatch):
    monotonic = iter([0, 2])
    monkeypatch.setattr("analysis.layer3.common.time.monotonic", lambda: next(monotonic))
    provider = FakeProvider(lambda request: {"findings": []})
    session = Session(provider, ResponseCache(None), [], started=0, deadline=1, concurrency=1)
    first = LLMRequest("s", "first", {"type": "object"}, "v")
    second = LLMRequest("s", "second", {"type": "object"}, "v")
    assert session.ask_many("L3.X", [first, second]) == [{"findings": []}, None]
    session.report()
    assert provider.requests == [first]
    assert session.errors == ["L3.X: 1 batch(es) not checked (time budget of 1 s reached)",
                              "layer 3 coverage: 1/2 batches; skipped: L3.X×1"]


def test_contradiction_check_skips_lines_with_l1_value_conflict():
    analysis_input = lv11()
    conflict = analysis_input.lines[1]  # 3.2.20
    prior = [Finding(id="vc", layer=1, rule_id="L1.TEXT.VALUE_CONFLICT", category="text", severity="warning",
                     scope="line", target=Target(line_id=conflict.id), title="t", message="m")]
    provider = FakeProvider(fake_model)
    run3(analysis_input, provider, prior=prior)
    sent = [item["code"] for request in provider.requests if request.prompt_version == prompts.CONTRADICTION_VERSION
            for item in payload(request)["items"]]
    assert sent and "3.2.20" not in sent and "3.2.30" in sent


# --------------------------------------------------------------------------- underspecified text


def test_underspecified_only_short_texts_with_verified_quote():
    def under(request):
        items = payload(request)["items"]
        refs = {item["code"]: item["ref"] for item in items}
        return {"findings": [
            {"line_ref": refs["3.2.80"], "missing_property": "dimension", "quote": "Aussparungen für [FIRMA_095]",
             "question_de": "Welche Höhe haben die Aussparungen?", "confidence": 0.95},
            {"line_ref": refs["3.2.80"], "missing_property": "material", "quote": "Höhe bis 2,50m",
             "question_de": "?", "confidence": 0.9},                         # quote not in the text
        ]}

    provider = FakeProvider(lambda r: fake_model(r, under=under))
    findings, errors = run3(lv11(), provider)
    sent = [item["code"] for request in provider.requests
            if request.prompt_version == prompts.UNDERSPECIFIED_VERSION for item in payload(request)["items"]]
    assert sent == ["3.2.80"]  # the only long text under 60 characters
    found = by_rule(findings, UNDER)
    assert [(f.target.line_code, f.evidence["missing_property"]) for f in found] == [("3.2.80", "dimension")]
    assert found[0].evidence["confidence"] == 0.6
    assert found[0].evidence["bieterfrage_de"].startswith("Zu Pos. 3.2.80: ")


@pytest.mark.parametrize("heading,detail,property_name,quote", [
    ("Stahltür T30, RAL 9010", "", "fire_rating", "Stahltür"),
    ("Stahltür T30, RAL 9010", "", "colour", "Stahltür"),
    ("Abdeckung montieren", "Material: Edelstahl.", "material", "Abdeckung"),
    ("Fundament aus Beton C30/37", "", "strength_class", "Fundament"),
    ("Fundament einbauen", "Expositionsklasse: XC4.", "exposure_class", "Fundament"),
    ("Türblatt einbauen", "Zarge aus Stahl.", "material", "Zarge"),
])
def test_underspecified_drops_claims_contradicted_by_a_value_for_the_quoted_part(heading, detail, property_name, quote):
    snapshot = from_data({"lines": [{"id": "one", "code": "01.0010", "short_text": heading,
                                   "long_text": detail, "quantity": "1", "unit": "St"}]})
    response = {"findings": [{"line_ref": "#1", "missing_property": property_name, "quote": quote,
                              "question_de": "Welche Vorgabe gilt?", "confidence": 0.9}]}
    provider = FakeProvider(lambda request: fake_model(request, under=lambda _: response))
    findings, _ = run3(snapshot, provider)
    assert [r for r in provider.requests if r.prompt_version == prompts.UNDERSPECIFIED_VERSION]
    assert not by_rule(findings, UNDER)


@pytest.mark.parametrize("heading,detail,property_name,quote", [
    ("Stahltür mit Zarge T30", "", "fire_rating", "Stahltür"),
    ("Stahltür, Zarge T30", "", "fire_rating", "Stahltür"),
    ("Stahltür optional T30 oder T60", "", "fire_rating", "Stahltür"),
    ("Stahltür ohne Feuerwiderstand T30", "", "fire_rating", "Stahltür"),
    ("Stahltür T30", "Feuerwiderstand: noch offen.", "fire_rating", "Stahltür"),
    ("Abdeckung mit Griff aus Stahl", "", "material", "Abdeckung"),
    ("Abdeckung montieren", "Griff: Material: Edelstahl.", "material", "Abdeckung"),
    ("Betonfundament, Bettung C30/37", "", "strength_class", "Betonfundament"),
    ("Betonbord TB10/25 grau Fundament Rückenstütze C20/25", "", "strength_class", "Betonbord"),
    ("Betonbord TB10/25 grau", "Festigkeitsklasse: Fundament C20/25.", "strength_class", "Betonbord"),
    ("Rohr DN 160", "", "dimension", "Rohr"),
])
def test_underspecified_keeps_unclear_requirements_and_other_components(heading, detail, property_name, quote):
    snapshot = from_data({"lines": [{"id": "one", "code": "01.0010", "short_text": heading,
                                   "long_text": detail, "quantity": "1", "unit": "St",
                                   "source_locator": {"row": 2}}]})
    response = {"findings": [{"line_ref": "#1", "missing_property": property_name, "quote": quote,
                              "question_de": "Welche Vorgabe gilt?", "confidence": 0.9}]}
    provider = FakeProvider(lambda request: fake_model(request, under=lambda _: response))
    findings, _ = run3(snapshot, provider)
    item, = by_rule(findings, UNDER)
    assert item.evidence["missing_property"] == property_name
    assert item.source_locator == {"row": 2}
    assert item.evidence["bieterfrage_de"].startswith("Zu Pos. 01.0010")


def test_underspecified_keeps_component_questions_beside_an_existing_fire_door_finding():
    snapshot = from_data({"lines": [{"id": "door", "code": "01.0010", "short_text": "Brandschutztür aus Stahl",
                                   "long_text": "Zarge und Beschläge inklusive.", "quantity": "1", "unit": "St"}]})
    prior = analyze(snapshot, [1]).findings
    response = {"findings": [
        {"line_ref": "#1", "missing_property": "fire_rating", "quote": "Brandschutztür",
         "question_de": "Welcher Feuerwiderstand ist für die Tür gefordert?", "confidence": 0.75},
        {"line_ref": "#1", "missing_property": "fire_rating", "quote": "Zarge",
         "question_de": "Welcher Feuerwiderstand ist für die Zarge gefordert?", "confidence": 0.75},
    ]}
    provider = FakeProvider(lambda request: fake_model(request, under=lambda _: response))
    findings, _ = run3(snapshot, provider, prior)
    item, = by_rule(findings, UNDER)
    assert item.evidence["quote"] == "Zarge"


def test_underspecified_nothing_reported_when_model_finds_nothing():
    findings, _ = run3(lv11(), FakeProvider(fake_model))
    assert by_rule(findings, UNDER) == []


# --------------------------------------------------------------------------- implausible quantity


def test_implausible_quantity_per_section():
    def qty(request):
        refs = {item["code"]: item["ref"] for item in payload(request)["items"]}
        return {"findings": [
            {"line_ref": refs["3.2.90"], "comparison_ref": refs["3.2.60"],
             "reason": "15 rails for 5 elements is high.", "expected": "5 St",
             "confidence": 0.9},
            {"line_ref": refs["3.2.60"], "reason": "This is one thousand pieces.",
             "expected": "1.000 St (one thousand single labour items)", "confidence": 0.9},
            {"line_ref": refs["3.2.30"], "reason": "This quantity differs from its siblings.",
             "expected": "St", "confidence": 0.9},
            {"line_ref": refs["3.2.70"], "reason": "0.7 t seems small.", "expected": "10 t", "confidence": 0.9},
            {"line_ref": "#99", "reason": "r", "expected": "", "confidence": 0.9},  # unknown ref
        ]}

    provider = FakeProvider(lambda r: fake_model(r, qty=qty))
    snapshot = lv11()
    next(item for item in snapshot.lines if item.code == "3.2.60").quantity = Decimal("5")
    findings, _ = run3(snapshot, provider)
    quantity_requests = [r for r in provider.requests if r.prompt_version == prompts.QUANTITY_VERSION]
    assert len(quantity_requests) == 1  # one call for the section
    sent = {item["code"]: item for item in payload(quantity_requests[0])["items"]}
    assert all("long_text" not in item for item in sent.values())
    assert sent["3.2.60"]["quantity"] == "5"
    assert sent["3.2.70"]["quantity"] == "0.7"
    found = by_rule(findings, QTY)
    assert [f.target.line_code for f in found] == ["3.2.90"]
    assert found[0].target.field == "quantity" and found[0].severity == "warning"
    assert "takeoff" in found[0].suggested_fix.rationale
    assert found[0].evidence["comparison"]["line_code"] == "3.2.60"


def test_single_line_sections_are_not_sent_for_quantities():
    analysis_input = from_data({"lines": [{"id": "a", "code": "01", "short_text": "Baustelle einrichten",
                                           "long_text": "Baustelle einrichten.", "quantity": "50", "unit": "psch"}]})
    provider = FakeProvider(fake_model)
    run3(analysis_input, provider)
    assert prompts.QUANTITY_VERSION not in versions(provider)


# --------------------------------------------------------------------------- eval harness


def test_task02_eval_runs_offline(monkeypatch):
    from analysis.layer3.eval import evaluate
    monkeypatch.setenv("ANALYSIS_L3_CACHE", "off")
    result = evaluate(FakeProvider(fake_model))
    task02 = result["task02"]
    assert all(e.startswith("layer 3 coverage: ") for e in result["errors"])
    assert task02["precision"] == 1.0
    lv11_row = next(row for row in task02["cases"] if row["id"] == "lv11_reference")
    assert lv11_row["missed"] == [] and lv11_row["false_positives"] == []
    assert task02["per_rule"]["L3.PRECAST.MISSING_SPEC"]["tp"] == 5


# --------------------------------------------------------------------------- upload worker


def test_worker_keeps_layer_1_2_findings_when_layer_3_crashes(monkeypatch):
    pytest.importorskip("psycopg")
    import workspace_analysis

    real_analyze = workspace_analysis.analyze

    def analyze_with_broken_layer3(snapshot, layers):
        if 3 in layers:
            raise RuntimeError("boom")
        return real_analyze(snapshot, layers)

    monkeypatch.setenv("ANALYSIS_L3_PROVIDER", "anthropic")
    monkeypatch.setattr(workspace_analysis, "analyze", analyze_with_broken_layer3)
    payload_ = {"layers": [1, 2, 3], "snapshot": {"sections": [], "lines": [
        {"id": "a", "code": "01", "short_text": "Rohr DN 150", "long_text": "Rohr verlegen.", "quantity": None,
         "unit": "m"}]}}
    report = workspace_analysis.run(payload_)
    assert report["layers_run"] == [1, 2]
    assert any(f["rule_id"] == "L1.QTY.MISSING" for f in report["findings"])
    assert "layer 3: failed unexpectedly; findings are from layers 1 and 2 only" in report["errors"]
