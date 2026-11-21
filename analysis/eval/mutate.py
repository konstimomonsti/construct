"""Write the mutated files and their labels, and read every one back.

    python -m analysis.eval mutate --seed 1 [--backend x83|json|both] [--per-type 3] [--out eval_out]

Reproducible: the same seed document, `--seed` and `--per-type` give byte-identical files. One mutation per
file (except the demo file, which plants three on purpose). The read-back check is mandatory: every file is
parsed again with the real importer (X83) or the adapter (JSON), and the result must equal the seed with
exactly the planned operations applied. Nothing else may differ except plain arithmetic that follows from the
planted change (a line amount after a quantity change, the subtotals above it).
"""

from __future__ import annotations

import json
from datetime import date
from decimal import Decimal
from pathlib import Path


from .. import adapter
from . import SEED_PATH, catalogue, docio, gaeb_writer, ops

LABEL_SCHEMA = "construct-eval-labels/1"
MANIFEST_SCHEMA = "construct-eval-manifest/1"
CLEAN_NAME = "building_hall_clean"
DEMO_NAME = "building_hall_planted"
SUFFIX = {"x83": ".X83", "json": ".json"}


class ReadbackError(AssertionError):
    pass


# --------------------------------------------------------------------------- backends


def _as_input(doc: dict):
    """The adapter's view of a document dict (the JSON backend, and the expected result for the X83 backend)."""
    return adapter.from_data(json.loads(docio.dumps(doc), parse_float=Decimal))


def render(seed_doc: dict, plan_ops: list[dict], backend: str) -> tuple[bytes, dict]:
    """The bytes of the mutated file and the document it should contain."""
    expected = ops.apply_to_doc(seed_doc, plan_ops)
    if backend == "json":
        return docio.dumps(expected).encode("utf-8"), expected
    tree = gaeb_writer.build_tree(seed_doc)
    ops.apply_to_tree(tree, plan_ops)
    return gaeb_writer.serialize(tree), expected


def read_back(path: Path, backend: str):
    return adapter.from_file(path) if backend == "x83" else adapter.from_json(path)


def check_readback(path: Path, backend: str, seed_doc: dict, plan_ops: list[dict], *, whitespace_only: bool = False,
                   clean_bytes: bytes | None = None) -> set[tuple]:
    """Raise ReadbackError unless the file holds the seed plus exactly the planted change. Returns the changes."""
    seed_canon = ops.canon_from_input(_as_input(seed_doc))
    expected_canon = ops.canon_from_input(_as_input(ops.apply_to_doc(seed_doc, plan_ops)))
    planted_ops = [op for op in plan_ops if not op.get("derived")]
    planted = ops.diff(seed_canon, ops.canon_from_input(_as_input(ops.apply_to_doc(seed_doc, planted_ops))))

    found = read_back(path, backend)
    if found.import_warnings:
        raise ReadbackError(f"{path.name}: the importer reported {[w.code for w in found.import_warnings]}")
    actual = ops.canon_from_input(found)
    changes = ops.diff(seed_canon, actual)
    if ops.diff(expected_canon, actual):
        raise ReadbackError(f"{path.name}: differs from the planned result: {sorted(ops.diff(expected_canon, actual))}")
    if whitespace_only:
        if changes:
            raise ReadbackError(f"{path.name}: a whitespace change must not alter the parsed document: {sorted(changes)}")
        if clean_bytes is not None and path.read_bytes() == clean_bytes:
            raise ReadbackError(f"{path.name}: the file is identical to the clean seed")
        return changes
    if not planted and plan_ops:
        raise ReadbackError(f"{path.name}: the planted change has no effect on the parsed document")
    missing = planted - changes
    if missing:
        raise ReadbackError(f"{path.name}: the planted change did not land: {sorted(missing)}")
    stray = {change for change in changes - planted if not ops.is_derived(change)}
    if stray:
        raise ReadbackError(f"{path.name}: unplanned changes: {sorted(stray)}")
    return changes


# --------------------------------------------------------------------------- generation


def _write_labels(path: Path, *, file: Path, backend: str, suite: str, baseline: str, seed_path: Path, seed: int,
                  plan: catalogue.Plan, labels: list[dict]) -> None:
    mutation_type = catalogue.TYPES_BY_NAME.get(plan.type)
    payload = {
        "schema": LABEL_SCHEMA, "file": file.name, "backend": backend, "suite": suite, "baseline": baseline,
        "seed": {"file": seed_path.name, "sha256": docio.file_hash(seed_path), "mutator_seed": seed},
        "mutation": {"id": plan.id, "type": plan.type, "description": plan.description, "params": plan.params,
                     "gap": bool(mutation_type and mutation_type.gap),
                     "control": bool(mutation_type and mutation_type.control)},
        "labels": labels,
    }
    Path(str(file) + ".labels.json").write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
                                                encoding="utf-8", newline="\n")


def _labels_for(plan: catalogue.Plan) -> list[dict]:
    return [{"id": f"{plan.id}/1", "mutation_type": plan.type, "description": plan.description, **plan.label}]


def generate(seed_path: Path = SEED_PATH, out_dir: Path = Path("eval_out"), *, seed: int = 1,
             backends: tuple[str, ...] = ("x83", "json"), per_type: int = 3, only: set[str] | None = None,
             demo: bool = True) -> dict:
    """Write the clean files, every mutated file with labels, and the demo file; read all of them back."""
    seed_path, out_dir = Path(seed_path), Path(out_dir)
    doc = docio.load(seed_path)
    mutated_dir, demo_dir = out_dir / "mutated", out_dir / "demo"
    mutated_dir.mkdir(parents=True, exist_ok=True)
    plans = catalogue.plan_all(doc, seed, per_type, only)
    files: list[dict] = []

    clean = catalogue.Plan(CLEAN_NAME, "CTRL-CLEAN", "The unchanged seed", [],
                           catalogue.label(target={}, expect=[], match="none", control=True,
                                           note="The clean seed must give no findings at all."))
    clean_bytes: dict[str, bytes] = {}
    for backend in backends:
        data, _ = render(doc, [], backend)
        clean_bytes[backend] = data
        path = mutated_dir / f"{CLEAN_NAME}{SUFFIX[backend]}"
        path.write_bytes(data)
        check_readback(path, backend, doc, [])
        _write_labels(path, file=path, backend=backend, suite="catalogue", baseline=path.name, seed_path=seed_path,
                      seed=seed, plan=clean, labels=_labels_for(clean))
        files.append({"file": path.name, "type": clean.type, "backend": backend})

    for plan in plans:
        for backend in backends:
            data, _ = render(doc, plan.ops, backend)
            path = mutated_dir / f"{plan.id}{SUFFIX[backend]}"
            path.write_bytes(data)
            check_readback(path, backend, doc, plan.ops, whitespace_only=plan.whitespace_only,
                           clean_bytes=clean_bytes[backend])
            _write_labels(path, file=path, backend=backend, suite="catalogue",
                          baseline=f"{CLEAN_NAME}{SUFFIX[backend]}", seed_path=seed_path, seed=seed, plan=plan,
                          labels=_labels_for(plan))
            files.append({"file": path.name, "type": plan.type, "backend": backend})

    if demo:
        files.extend(_write_demo(doc, plans, demo_dir, seed_path, seed, backends, clean_bytes))

    manifest = {"schema": MANIFEST_SCHEMA, "created": date.today().isoformat(), "seed_file": seed_path.name,
                "seed_sha256": docio.file_hash(seed_path), "mutator_seed": seed, "per_type": per_type,
                "backends": list(backends), "files": files}
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8", newline="\n")
    return manifest


def _write_demo(doc: dict, plans: list[catalogue.Plan], demo_dir: Path, seed_path: Path, seed: int,
                backends: tuple[str, ...], clean_bytes: dict[str, bytes]) -> list[dict]:
    """The file for the demo: missing edge insulation, a duplicate and a quantity 0, in one X83."""
    wanted = ["L2-REMOVE-EDGE_INSULATION", "DUP-NEW-OZ", "QTY-ZERO"]
    chosen: list[catalogue.Plan] = []
    for prefix in wanted:
        match = next((p for p in plans if p.id == prefix or p.id.startswith(prefix + "-")), None)
        if match is not None:
            chosen.append(match)
    if len(chosen) < len(wanted):
        return []
    demo_dir.mkdir(parents=True, exist_ok=True)
    combined = catalogue.combine(doc, chosen)
    plan = catalogue.Plan(DEMO_NAME, "DEMO", "Missing edge insulation, a duplicate and a quantity 0", combined,
                          {}, {"parts": [p.id for p in chosen]})
    labels = [{"id": f"{DEMO_NAME}/{n}", "mutation_type": part.type, "description": part.description, **part.label}
              for n, part in enumerate(chosen, 1)]
    written = []
    for backend in backends:
        data, _ = render(doc, combined, backend)
        path = demo_dir / f"{DEMO_NAME}{SUFFIX[backend]}"
        path.write_bytes(data)
        check_readback(path, backend, doc, combined, clean_bytes=clean_bytes[backend])
        _write_labels(path, file=path, backend=backend, suite="demo",
                      baseline=f"../mutated/{CLEAN_NAME}{SUFFIX[backend]}", seed_path=seed_path, seed=seed,
                      plan=plan, labels=labels)
        written.append({"file": f"demo/{path.name}", "type": "DEMO", "backend": backend})
    return written
