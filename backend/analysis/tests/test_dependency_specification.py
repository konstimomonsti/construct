from pathlib import Path

from analysis.adapter import from_bytes, from_data
from analysis.layer3.checks.l2_confirm import reviewable
from analysis.runner import analyze

INSTALLATION = "L2.ELEC.INSTALLATION_NEEDS_INSTALLATION_CABLE"
ROUTING = "L2.ELEC.CABLING_NEEDS_CABLE_ROUTING"
TERMINATION = "L2.ELEC.CABLING_NEEDS_CABLE_TERMINATION"
BOXES = "L2.ELEC.INSTALLATION_NEEDS_DEVICE_BOXES"
CABLE = {"id": "cable", "code": "01.0020", "short_text": "NYM-J 3 x 1,5 mm²",
         "long_text": "Kabeltyp: NYM-J 5 x 2,5 mm².", "quantity": 20, "unit": "m", "source_locator": {"page": 2}}


def _report(*lines, socket_detail=""):
    snapshot = from_data({"lines": [
        {"id": "socket", "code": "01.0010", "short_text": "Schutzkontaktsteckdose",
         "long_text": socket_detail, "quantity": 3, "unit": "St"}, *lines,
    ]})
    result = analyze(snapshot, [1, 2])
    assert not result.errors
    return result


def test_conflicted_cable_cites_both_values_and_holds_dependent_patches():
    result = _report(CABLE)
    findings = {item.rule_id: item for item in result.findings}
    anchor = findings["L1.TEXT.VALUE_CONFLICT"]
    for rule in (INSTALLATION, ROUTING, TERMINATION):
        review = findings[rule]
        assert review.severity == "info"
        assert review.evidence["reason"] == "specification_not_assessable"
        assert review.source_locator == {"page": 2}
        conflict, = review.evidence["specification_conflicts"]
        assert conflict["finding_id"] == anchor.id
        assert conflict["short_quote"] == "NYM-J 3 x 1,5 mm²"
        assert conflict["long_quote"] == "NYM-J 5 x 2,5 mm²"
        assert review.suggested_fix and not review.suggested_fix.operations
        assert not reviewable(review)
        assert not any(review.id in question.finding_ids for question in result.questions)
    assert findings[BOXES].evidence["reason"] == "missing"


def test_independent_coverage_and_a_resolved_spec_restore_normal_handling():
    other = {**CABLE, "id": "another", "code": "01.0030",
             "long_text": "Kabeltyp: NYM-J 3 x 1,5 mm². Inkl. Kabelrinne und Kabelanschluss."}
    assert not {INSTALLATION, ROUTING, TERMINATION} & {f.rule_id for f in _report(CABLE, other).findings}
    clean = {**CABLE, "long_text": "Kabeltyp: NYM-J 3 x 1,5 mm²."}
    findings = {f.rule_id: f for f in _report(clean).findings}
    assert INSTALLATION not in findings
    assert findings[ROUTING].evidence["reason"] == "missing"
    assert findings[ROUTING].suggested_fix.operations


def test_explicit_reference_does_not_certify_a_conflicted_target():
    result = _report(CABLE, socket_detail="Installationsleitung ist in Pos. 01.0020 enthalten.")
    review, = [finding for finding in result.findings if finding.rule_id == INSTALLATION]
    assert review.evidence["reason"] == "specification_not_assessable"
    assert review.evidence["scope_statements"][0]["verified_reference"] is False


def test_original_roadworks_cable_can_anchor_the_dependent_review():
    source = Path(__file__).resolve().parents[3] / "data/tenders/StBALV23040.D86"
    original = from_bytes(source.name, source.read_bytes())
    line = next(item for item in original.lines if item.code == "09.01.0009")
    row = {"id": line.id, "code": line.code, "short_text": line.short_text, "long_text": line.long_text,
           "quantity": line.quantity, "unit": line.unit, "source_locator": line.source_locator}
    assert INSTALLATION not in {finding.rule_id for finding in _report(row).findings}
    assert "7 x 1,5" in row["long_text"]
    row["long_text"] = row["long_text"].replace("7 x 1,5", "5 x 1,5", 1)
    review, = [finding for finding in _report(row).findings if finding.rule_id == INSTALLATION]
    assert review.evidence["reason"] == "specification_not_assessable"
    assert review.source_locator["record"] == 4276


def test_a_clean_cable_in_another_room_does_not_clear_the_conflict():
    rooms = ({"id": "a", "name": "Room A"}, {"id": "b", "name": "Room B"})
    lines = []
    for room in rooms:
        room_id = room["id"]
        lines += [
            {"id": f"socket-{room_id}", "code": f"socket-{room_id}", "short_text": "Schutzkontaktsteckdose",
             "quantity": 3, "unit": "St", "distributions": [{"area_id": room_id, "quantity": 3}]},
            {**CABLE, "id": f"cable-{room_id}", "code": f"cable-{room_id}",
             "long_text": CABLE["long_text"] if room_id == "a" else CABLE["short_text"],
             "distributions": [{"area_id": room_id, "quantity": 20}]},
        ]
    result = analyze(from_data({"areas": list(rooms), "lines": lines}), [1, 2])
    assert not result.errors
    review, = [finding for finding in result.findings if finding.rule_id == INSTALLATION]
    assert review.target.area_id == "a"
    assert review.evidence["reason"] == "specification_not_assessable"
    assert review.evidence["dependency_line_ids"] == ["cable-a"]
