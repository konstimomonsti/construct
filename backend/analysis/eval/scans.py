"""Make image-only PDFs from labelled, text-based evaluation fixtures."""

import argparse
import json
from io import BytesIO
from pathlib import Path

from pypdf import PdfReader
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen.canvas import Canvas

from tender_import.pdf import poppler


def rasterize(source: Path, output: Path) -> None:
    document = PdfReader(source)
    scan = Canvas(str(output), invariant=1)
    scan.setTitle(source.stem)
    scan.setKeywords("Scanned BOM fixture")
    for number, page in enumerate(document.pages, 1):
        image = poppler("pdftoppm", "-f", number, "-l", number, "-r", 275, "-singlefile", "-png", source)
        size = tuple(map(float, (page.mediabox.width, page.mediabox.height)))
        scan.setPageSize(size)
        scan.drawImage(ImageReader(BytesIO(image)), 0, 0, width=size[0], height=size[1])
        scan.showPage()
    scan.save()


def generate(source_dir: Path, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    for source in sorted(source_dir.glob("*.pdf")):
        if not (sidecar := source.with_suffix(".pdf.labels.json")).exists():
            continue
        rasterize(source, out / source.name)
        payload = json.loads(sidecar.read_text(encoding="utf-8"))
        for label in payload["labels"]:
            if label.get("match") == "line":
                target = label["target"]
                locator = target.setdefault("source_locator", {})
                page = locator.get("page", 1)
                locator.update(page=page, ocr_pages=[page])
        (out / sidecar.name).write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("out", type=Path)
    args = parser.parse_args()
    generate(args.source, args.out)
