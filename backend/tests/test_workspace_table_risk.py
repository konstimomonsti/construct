"""Keep imported source values separate from display defaults during assessment."""

import pytest

import workspace_analysis


@pytest.mark.parametrize("format", ["csv", "xlsx", "json", "docx", "pdf"])
def test_imported_source_values_drive_quantities_units_and_amounts(monkeypatch, format):
    monkeypatch.setenv("ANALYSIS_L3_PROVIDER", "none")
    document = {"fileName": "risk-test", "source": {"kind": format}, "positions": [
        {"id": "p1", "oz": "01.10", "short": "Abdeckfolie für den Werkbereich verlegen", "qty": 1, "unit": "St",
         "sourceCells": {"code": "", "quantity": "", "unit": "", "unitPrice": "", "amount": "", "row": 2}},
        {"id": "p2", "oz": "01.20", "short": "Kies für den Traufstreifen liefern", "qty": 2, "unit": "m",
         "sourceCells": {"quantity": "2,00", "unit": "m", "unitPrice": "10 €", "amount": "32,50 EUR", "row": 5}},
        {"id": "p3", "oz": "01.30", "short": "Montage der Anschlussleitung", "qty": 1, "unit": "m",
         "sourceCells": {"quantity": "aus Aufmaß", "unit": "m", "unitPrice": "", "amount": "", "row": 6}},
        {"id": "p4", "oz": "01.40", "short": "Montage der Signalleitung", "qty": 0, "unit": "m",
         "sourceCells": {"quantity": "0", "unit": "m", "unitPrice": "10", "amount": "0", "row": 7}},
    ]}
    report = workspace_analysis.run(workspace_analysis._uploaded_input(document))
    assert not report["errors"]
    findings = {(entry["rule_id"], entry["target"]["line_id"]): entry for entry in report["findings"]}
    for key, row in {
        ("L1.QTY.MISSING", "p1"): 2, ("L1.UNIT.MISSING", "p1"): 2, ("L1.CODE.MISSING", "p1"): 2,
        ("L1.ARITH.LINE_AMOUNT", "p2"): 5, ("L1.QTY.MISSING", "p3"): 6,
        ("L1.QTY.ZERO", "p4"): 7,
    }.items():
        assert findings[key]["source_locator"] == {"row": row}
        assert findings[key]["suggested_fix"]
    assert findings["L1.QTY.MISSING", "p3"]["evidence"]["quantity_raw"] == "aus Aufmaß"
    assert findings["L1.ARITH.LINE_AMOUNT", "p2"]["evidence"]["stated_amount"] == "32.50"
    assert ("L1.QTY.MISSING", "p4") not in findings


def test_duplicate_codes_are_scoped_to_their_worksheet(monkeypatch):
    monkeypatch.setenv("ANALYSIS_L3_PROVIDER", "none")
    rows = []
    for index, sheet in enumerate(["Elektro", "Trockenbau", "Trockenbau"]):
        rows.append({"id": f"p{index}", "oz": "0010", "short": f"Position {index}", "qty": 10, "unit": "m",
                     "sourceCells": {"quantity": "10", "unit": "m", "row": index + 2, "sheet": sheet}})
    document = {"source": {"kind": "xlsx"}, "positions": rows}
    report = workspace_analysis.run(workspace_analysis._uploaded_input(document))
    duplicates = [entry for entry in report["findings"] if entry["rule_id"] == "L1.CODE.DUPLICATE"]
    assert [entry["target"]["line_id"] for entry in duplicates] == ["p2"]
    assert duplicates[0]["source_locator"]["sheet"] == "Trockenbau"
