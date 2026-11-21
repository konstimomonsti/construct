"""Minimal web UI: upload a BoQ (GAEB, PDF, Word), run the analysis layers, show the report.

Runs without the database: the file is parsed in memory with the importer's parsers and passed
straight to the analysis runner. Nothing is stored.
"""

from __future__ import annotations

from hashlib import sha256
from pathlib import Path
import sys
import traceback

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT / "importer") not in sys.path:
    sys.path.insert(0, str(ROOT / "importer"))

from analysis import adapter  # noqa: E402
from analysis.contracts import SourceDocument  # noqa: E402
from analysis.runner import analyze  # noqa: E402

DATA_DIR = ROOT / "Data"
STATIC_DIR = Path(__file__).resolve().parent / "static"
MAX_BYTES = 50 * 1024 * 1024
SUPPORTED = {"gaeb_xml": "GAEB XML", "gaeb_1990": "GAEB 90", "pdf": "PDF", "docx": "Word"}

app = FastAPI(title="Construct BoQ check")


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

    document = SourceDocument(id=sha256(data).hexdigest(), filename=filename, format=document_format)
    indexes = sorted({r.payload.get("boq_index") for r in result.records if r.kind == "boq_header"} - {None})
    boqs = []
    for boq_index in indexes if len(indexes) > 1 else [None]:
        try:
            analysis_input = adapter.from_import(result, document=document, boq_index=boq_index)
            analysis_result = analyze(analysis_input, layers)
        except Exception as exc:
            traceback.print_exc()
            raise HTTPException(500, f"Analysis failed: {type(exc).__name__}: {exc}") from exc
        boqs.append({
            "boq_index": boq_index,
            "input": analysis_input.model_dump(mode="json"),
            "result": analysis_result.model_dump(mode="json"),
        })
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
