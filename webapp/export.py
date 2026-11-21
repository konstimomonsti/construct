"""Bidder questions as a Word document. Needs python-docx (pinned in webapp/requirements.txt)."""

from __future__ import annotations

from datetime import date
from io import BytesIO
from typing import Any

from docx import Document
from docx.shared import Pt, RGBColor

from analysis.contracts import AnalysisInput


def questions_docx_bytes(analysis_input: AnalysisInput, filename: str, questions: list[dict[str, Any]]) -> bytes:
    doc = Document()
    doc.styles["Normal"].font.name = "Calibri"
    doc.styles["Normal"].font.size = Pt(11)

    doc.add_heading("Bieterfragen", level=0)
    meta = [("Projekt", analysis_input.project.name), ("Leistungsverzeichnis", analysis_input.bom.title),
            ("Datei", filename), ("Datum", date.today().strftime("%d.%m.%Y"))]
    for label, value in meta:
        if value:
            paragraph = doc.add_paragraph()
            paragraph.add_run(f"{label}: ").bold = True
            paragraph.add_run(str(value))
    doc.add_paragraph("Zur Erstellung unseres Angebots bitten wir um Klärung der folgenden Punkte.")

    if not questions:
        doc.add_paragraph("Es ergeben sich keine Rückfragen.")
    current: object = object()
    number = 0
    for question in questions:
        if question.get("section") != current:
            current = question.get("section")
            doc.add_heading(str(current or "Allgemein"), level=2)
        number += 1
        paragraph = doc.add_paragraph()
        paragraph.add_run(f"{number}. ").bold = True
        paragraph.add_run(question["text"])

    note = doc.add_paragraph()
    run = note.add_run("Entwurf, erstellt mit Construct BoQ check. Bitte vor dem Versand prüfen.")
    run.italic = True
    run.font.size = Pt(9)
    run.font.color.rgb = RGBColor(0x64, 0x6D, 0x7E)

    buffer = BytesIO()
    doc.save(buffer)
    return buffer.getvalue()
