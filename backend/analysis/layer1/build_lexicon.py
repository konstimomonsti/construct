"""Build the domain lexicon used by the typo checks (`lexicon_de.txt`).

    python -m analysis.layer1.build_lexicon data/tenders data/fixtures

Every GAEB and PDF tender under the given folders is read. A word enters the lexicon when it appears in at
least 3 different *projects*: counting files would let a typo repeated inside one tender look like a word.
Files of the same project count once: the trade PDFs LV_00..LV_23 of one building, files in the same
fixtures folder, the same [PROJEKT_nnn] placeholder, and files that share almost all their words (the
same tender exported as X83, D86 and PDF under different names). PDFs need Poppler's pdftotext.
"""

from __future__ import annotations

import argparse
from collections import Counter
from hashlib import sha256
from pathlib import Path
import re
import sys

from .spelling import ANONYMISED, LEXICON_PATH, MIN_PART_LENGTH, MIN_PROJECTS, WORD, parts

SAME_TENDER_OVERLAP = 0.85   # share of the smaller file's words found in the other file
MIN_SHARED_WORDS = 100       # tiny files (a priced D84 with 12 words) are not compared
GAEB_SUFFIXES = {".x81", ".x82", ".x83", ".x84", ".x85", ".x86", ".x89", ".d81", ".d83", ".d84", ".d86", ".p86"}


def project_key(path: Path, root: Path) -> str:
    relative = path.relative_to(root)
    folders = relative.parts[:-1]
    if folders:  # fixtures/dbinfrago/10_massivbruecke/..., fixtures/bvbs/...
        depth = 2 if folders[0] in ("dbinfrago", "gaeb.de") and len(folders) > 1 else 1
        return f"{root.name}/{'/'.join(folders[:depth])}"
    name = path.stem
    placeholder = re.search(r"\[PROJEKT_\d+\]", name)
    if placeholder:
        return f"{root.name}/{placeholder.group(0)}"
    if re.match(r"LV_\d+", name):
        return f"{root.name}/LV"
    return f"{root.name}/{re.sub(r'(?i)[_ -]leer$', '', name).lower()}"


def read_texts(path: Path) -> list[str]:
    from .. import adapter
    if path.suffix.lower() in GAEB_SUFFIXES:
        data = adapter.from_file(path)
    elif path.suffix.lower() == ".pdf":
        adapter._importer_on_path()
        from tender_import.pdf import pdf as parse_pdf
        from ..contracts import SourceDocument
        raw = path.read_bytes()
        document = SourceDocument(id=sha256(raw).hexdigest(), filename=path.name, format="pdf")
        data = adapter.from_import(parse_pdf(raw), document=document)
    else:
        return []
    texts = [section.title or "" for section in data.sections]
    for line in data.lines:
        texts += [line.short_text or "", line.long_text or ""]
    return texts


def words_of(text: str) -> set[str]:
    text = ANONYMISED.sub(" ", text)
    found = set()
    for match in WORD.finditer(text):
        for part in parts(match.group(0)):
            if len(part) >= MIN_PART_LENGTH and not part.isupper():
                found.add(part.lower())
    return found


def same_tender(a: set[str], b: set[str]) -> bool:
    """The same tender exported twice (X83 and PDF, filled and blank) shares almost its whole vocabulary."""
    smaller = min(len(a), len(b))
    return smaller >= MIN_SHARED_WORDS and len(a & b) / smaller >= SAME_TENDER_OVERLAP


def build(folders: list[Path], verbose: bool = False) -> tuple[Counter, set[str]]:
    files: list[tuple[str, str, set[str]]] = []  # (project key from the name, file name, words)
    for root in folders:
        for path in sorted(root.rglob("*")):
            if path.suffix.lower() not in GAEB_SUFFIXES | {".pdf"}:
                continue
            try:
                texts = read_texts(path)
            except Exception as exc:  # noqa: BLE001 - one unreadable file must not stop the build
                print(f"skip {path.name}: {type(exc).__name__}: {str(exc)[:80]}", file=sys.stderr)
                continue
            files.append((project_key(path, root), path.name, set().union(*map(words_of, texts)) if texts else set()))

    # Group by name first, then merge groups that are the same tender under another file name.
    parent = {key: key for key, _, _ in files}

    def find(key: str) -> str:
        while parent[key] != key:
            parent[key] = parent[parent[key]]
            key = parent[key]
        return key

    for i, (key_a, _, words_a) in enumerate(files):
        for key_b, _, words_b in files[i + 1:]:
            if find(key_a) != find(key_b) and same_tender(words_a, words_b):
                parent[find(key_b)] = find(key_a)
    projects: dict[str, set[str]] = {}
    for key, name, words in files:
        projects.setdefault(find(key), set()).update(words)
        if verbose:
            print(f"{find(key)}: {name}", file=sys.stderr)
    counts = Counter(word for bag in projects.values() for word in bag)
    return counts, set(projects)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("folders", nargs="+", type=Path)
    parser.add_argument("--out", type=Path, default=LEXICON_PATH)
    parser.add_argument("--min-projects", type=int, default=MIN_PROJECTS)
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)
    counts, projects = build(args.folders, args.verbose)
    words = sorted((w, n) for w, n in counts.items() if n >= args.min_projects)
    header = (f"# Domain lexicon for the layer 1 typo checks: {len(words)} words used in at least "
              f"{args.min_projects} of {len(projects)} projects.\n"
              f"# Generated by backend/analysis/layer1/build_lexicon.py. Format: word<TAB>projects.\n")
    args.out.write_text(header + "".join(f"{w}\t{n}\n" for w, n in words), encoding="utf-8")
    print(f"{len(words)} words from {len(projects)} projects -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
