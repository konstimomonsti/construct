"""Minimal web UI: upload a BoQ (GAEB, PDF, Word), run the analysis layers, show the report.

Runs without the database: the file is parsed in memory with the importer's parsers and passed
straight to the analysis runner. Analyses stay in a small memory cache (the last 8). The only
thing written to disk is the reviewer's decisions on findings (``webapp/decisions.py``).
"""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
from hashlib import sha256
import os
from pathlib import Path
import sys
import threading
import traceback
from typing import Literal

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT / "importer") not in sys.path:
    sys.path.insert(0, str(ROOT / "importer"))

from analysis import adapter  # noqa: E402
from analysis.contracts import AnalysisInput, Finding, SourceDocument, Status  # noqa: E402
from analysis.questions import is_tender, questions_as_dicts  # noqa: E402
from analysis.runner import analyze  # noqa: E402
from webapp import decisions as decision_lib, risk_fallback  # noqa: E402

DATA_DIR = ROOT / "Data"
STATIC_DIR = Path(__file__).resolve().parent / "static"
MAX_BYTES = 50 * 1024 * 1024
SUPPORTED = {"gaeb_xml": "GAEB XML", "gaeb_1990": "GAEB 90", "pdf": "PDF", "docx": "Word"}

app = FastAPI(title="Construct BoQ check")
app.add_middleware(GZipMiddleware, minimum_size=1024)  # analysis responses shrink about 8x

# The risk model behind the Summary tab. Replace with analysis.risk.assess when it exists; it must
# take (AnalysisInput, findings with their decision status) and return the dict the UI reads.
RISK_MODEL = risk_fallback.assess

DECISIONS_DIR = Path(os.environ.get("CONSTRUCT_DECISIONS_DIR") or Path(__file__).resolve().parent / "var" / "decisions")
decision_store: decision_lib.DecisionStore = decision_lib.JsonDecisionStore(DECISIONS_DIR)

CACHE_SIZE = 8


def detect(name: str, data: bytes) -> str:
    from tender_import.common import detect_format
    return detect_format(name, data)


def parse(document_format: str, data: bytes):
    # Imported per format so a missing optional dependency (pypdf, poppler) only breaks that format.
    if document_format == "gaeb_xml":
        from tender_import.structured import gaeb_xml
        return gaeb_xml(data)
    if document_format == "gaeb_1990":
        from tender_import.legacy import gaeb_1990
        return gaeb_1990(data)
    if document_format == "pdf":
        from tender_import.pdf import pdf
        return pdf(data)
    if document_format == "docx":
        from tender_import.structured import docx
        return docx(data)
    raise HTTPException(415, f"Unsupported file type. Upload one of: {', '.join(SUPPORTED.values())}.")


def parse_layers(raw: str) -> list[int]:
    try:
        layers = sorted({int(part) for part in raw.split(",") if part.strip()})
    except ValueError:
        raise HTTPException(400, "layers must be a comma-separated list such as 1,2") from None
    if not layers or any(layer not in (1, 2, 3) for layer in layers):
        raise HTTPException(400, "layers must be chosen from 1, 2 and 3")
    return layers


@dataclass
class Analysis:
    """One analysed BoQ kept in memory so decisions can re-score it without re-running the layers."""

    doc_key: str
    filename: str
    input: AnalysisInput
    result: object  # AnalysisResult; findings keep status "open", decisions are applied on read


_cache: OrderedDict[str, Analysis] = OrderedDict()
_cache_lock = threading.Lock()


def remember(analysis: Analysis) -> Analysis:
    with _cache_lock:
        _cache[analysis.doc_key] = analysis
        _cache.move_to_end(analysis.doc_key)
        while len(_cache) > CACHE_SIZE:
            _cache.popitem(last=False)
    return analysis


def recall(doc_key: str) -> Analysis:
    try:
        decision_lib.split_doc_key(doc_key)
    except decision_lib.InvalidDocKey as exc:
        raise HTTPException(400, str(exc)) from exc
    with _cache_lock:
        analysis = _cache.get(doc_key)
        if analysis is not None:
            _cache.move_to_end(doc_key)
    if analysis is None:
        raise HTTPException(404, "This analysis is no longer in memory. Analyse the file again; "
                                 "saved decisions are kept and will be applied.")
    return analysis


def with_decisions(analysis: Analysis, saved: dict[str, dict]) -> list[Finding]:
    """The findings with the reviewer's decision as their status (accepted / rejected)."""
    return [f.model_copy(update={"status": saved[f.id]["status"]}) if f.id in saved else f
            for f in analysis.result.findings]


def score_risk(analysis: Analysis, findings: list[Finding]) -> dict | None:
    try:
        return RISK_MODEL(analysis.input, findings)
    except Exception:  # a scoring bug must not take the report down
        traceback.print_exc()
        return None


def boq_payload(analysis: Analysis) -> dict:
    saved = decision_store.get_all(analysis.doc_key)
    findings = with_decisions(analysis, saved)
    known = {f.id for f in findings}
    result = analysis.result.model_copy(update={"findings": findings})
    return {
        "doc_key": analysis.doc_key,
        "input": analysis.input.model_dump(mode="json"),
        "result": result.model_dump(mode="json"),
        "risk": score_risk(analysis, findings),
        "decisions": {fid: d for fid, d in saved.items() if fid in known},
        # Saved decisions with no matching finding now (other layers selected, rules changed).
        "orphaned_decisions": [{"finding_id": fid, **d} for fid, d in saved.items() if fid not in known],
        "tender": is_tender(analysis.input),
    }


def run_analysis(filename: str, data: bytes, layers: list[int]) -> dict:
    if not data:
        raise HTTPException(400, "The file is empty.")
    document_format = detect(filename, data)
    if document_format not in SUPPORTED:
        raise HTTPException(415, f"Unsupported file type. Upload one of: {', '.join(SUPPORTED.values())}.")
    try:
        result = parse(document_format, data)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(422, f"Could not read the {SUPPORTED[document_format]} file: {exc}") from exc

    digest = sha256(data).hexdigest()
    document = SourceDocument(id=digest, filename=filename, format=document_format)
    indexes = sorted({r.payload.get("boq_index") for r in result.records if r.kind == "boq_header"} - {None})
    boqs = []
    for boq_index in indexes if len(indexes) > 1 else [None]:
        try:
            analysis_input = adapter.from_import(result, document=document, boq_index=boq_index)
            analysis_result = analyze(analysis_input, layers)
        except Exception as exc:
            traceback.print_exc()
            raise HTTPException(500, f"Analysis failed: {type(exc).__name__}: {exc}") from exc
        doc_key = decision_lib.make_doc_key(digest, boq_index)
        analysis = remember(Analysis(doc_key, filename, analysis_input, analysis_result))
        boqs.append({"boq_index": boq_index, **boq_payload(analysis)})
    return {
        "filename": filename,
        "format": document_format,
        "format_label": SUPPORTED[document_format],
        "size": len(data),
        "needs_review": bool(getattr(result, "needs_review", False)),
        "boqs": boqs,
    }


def sample_files() -> dict[str, Path]:
    if not DATA_DIR.is_dir():
        return {}
    return {
        path.name: path for path in sorted(DATA_DIR.iterdir(), key=lambda p: p.name.lower())
        if path.is_file() and detect(path.name, b"") in SUPPORTED
    }


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/samples")
def list_samples():
    return [
        {"name": name, "size": path.stat().st_size, "format": SUPPORTED[detect(name, b"")]}
        for name, path in sample_files().items()
    ]


@app.get("/api/samples/analyze")
def analyze_sample(name: str, layers: str = "1,2"):
    path = sample_files().get(name)
    if path is None:
        raise HTTPException(404, "No such sample file in Data/.")
    return run_analysis(name, path.read_bytes(), parse_layers(layers))


@app.post("/api/analyze")
def analyze_upload(file: UploadFile = File(...), layers: str = Form("1,2")):
    data = file.file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise HTTPException(413, f"The file is larger than {MAX_BYTES // (1024 * 1024)} MB.")
    return run_analysis(Path(file.filename or "upload").name, data, parse_layers(layers))


# ---------------------------------------------------------------- decisions


class DecisionIn(BaseModel):
    status: Literal["accepted", "rejected", "open"]  # contracts.Status; "open" undoes a decision
    reason: str | None = Field(default=None, max_length=decision_lib.MAX_TEXT)
    note: str | None = Field(default=None, max_length=decision_lib.MAX_TEXT)


class BulkDecisionIn(DecisionIn):
    finding_ids: list[str] | None = Field(default=None, max_length=5000)
    rule_id: str | None = None  # every finding of this rule, e.g. to dismiss a noisy rule at once


def _decision_for(finding: Finding, body: DecisionIn) -> dict | None:
    if body.status == Status.OPEN.value:
        return None
    return decision_lib.make_decision(body.status, body.reason, body.note, rule_id=finding.rule_id,
                                      line_code=finding.target.line_code, title=finding.title)


def _rescored(analysis: Analysis) -> dict | None:
    return score_risk(analysis, with_decisions(analysis, decision_store.get_all(analysis.doc_key)))


@app.put("/api/decisions/{doc_key}/{finding_id}")
def put_decision(doc_key: str, finding_id: str, body: DecisionIn):
    analysis = recall(doc_key)
    finding = next((f for f in analysis.result.findings if f.id == finding_id), None)
    if finding is None:
        raise HTTPException(404, "No such finding in this analysis.")
    decision = _decision_for(finding, body)
    decision_store.put(doc_key, finding_id, decision)
    return {"finding_id": finding_id, "status": decision["status"] if decision else Status.OPEN.value,
            "decision": decision, "risk": _rescored(analysis)}


@app.post("/api/decisions/{doc_key}/bulk")
def bulk_decisions(doc_key: str, body: BulkDecisionIn):
    analysis = recall(doc_key)
    if not body.finding_ids and not body.rule_id:
        raise HTTPException(400, "Send finding_ids or a rule_id.")
    wanted = set(body.finding_ids or [])
    saved = decision_store.get_all(doc_key)
    targets = [f for f in analysis.result.findings if f.id in wanted]
    if body.rule_id is not None:
        # By rule: accept/dismiss only what is still open, and restore only what was decided, so a
        # bulk dismissal never overrides a finding the reviewer already accepted.
        decided = lambda f: f.id in saved  # noqa: E731
        targets += [f for f in analysis.result.findings
                    if f.rule_id == body.rule_id and f.id not in wanted
                    and decided(f) == (body.status == Status.OPEN.value)]
    known_rule = body.rule_id is not None and any(f.rule_id == body.rule_id for f in analysis.result.findings)
    if not targets and not known_rule:
        raise HTTPException(404, "No matching findings in this analysis.")
    changes = {f.id: _decision_for(f, body) for f in targets}
    decision_store.put_many(doc_key, changes)
    return {"changed": len(changes), "decisions": changes,  # a None value means back to open
            "risk": _rescored(analysis)}


# ---------------------------------------------------------------- bidder questions


def _questions(doc_key: str):
    analysis = recall(doc_key)
    findings = with_decisions(analysis, decision_store.get_all(doc_key))
    return analysis, questions_as_dicts(analysis.input, findings)


# The .docx route comes first: '{doc_key}' would otherwise swallow the '.docx' suffix.
@app.get("/api/questions/{doc_key}.docx")
def questions_docx(doc_key: str):
    analysis, questions = _questions(doc_key)
    if not is_tender(analysis.input):
        raise HTTPException(409, "Bidder questions are only generated for tenders (GAEB phase 83).")
    try:
        from webapp.export import questions_docx_bytes
    except ImportError as exc:  # python-docx is not installed
        raise HTTPException(501, "The .docx export needs python-docx (pip install -r webapp/requirements.txt).") from exc
    stem = "".join(c if c.isalnum() or c in "-_" else "_" for c in Path(analysis.filename).stem) or "BoQ"
    return Response(
        questions_docx_bytes(analysis.input, analysis.filename, questions),
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f'attachment; filename="Bieterfragen_{stem}.docx"'},
    )


@app.get("/api/questions/{doc_key}")
def get_questions(doc_key: str):
    analysis, questions = _questions(doc_key)
    tender = is_tender(analysis.input)
    return {"doc_key": doc_key, "applicable": tender, "phase": analysis.input.project.gaeb_phase,
            "questions": questions,
            "note": None if tender else
            "Bidder questions are only generated for tenders (GAEB phase 83). This file is a bid or award."}
