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
from . import PRECAST_PATH, SEED_PATH, catalogue, docio, gaeb_writer, ops, precast

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
    payload = {
        "schema": LABEL_SCHEMA, "file": file.name, "backend": backend, "suite": suite, "baseline": baseline,
        "seed": {"file": seed_path.name, "sha256": docio.file_hash(seed_path), "mutator_seed": seed},
        "mutation": {"id": plan.id, "type": plan.type, "description": plan.description, "params": plan.params,
                     "gap": bool(plan.label.get("gap")),
                     "control": bool(plan.label.get("control"))},
        "labels": labels,
    }
    Path(str(file) + ".labels.json").write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
                                                encoding="utf-8", newline="\n")


def _labels_for(plan: catalogue.Plan) -> list[dict]:
    return [{"id": f"{plan.id}/1", "mutation_type": plan.type, "description": plan.description, **plan.label}]


def generate(seed_path: Path = SEED_PATH, out_dir: Path = Path("eval_out"), *, seed: int = 1,
             backends: tuple[str, ...] = ("x83", "json"), per_type: int = 3, only: set[str] | None = None,
             demo: bool = True, include_precast: bool = False) -> dict:
    """Write the clean files, every mutated file with labels, and the demo file; read all of them back."""
    seed_path, out_dir = Path(seed_path), Path(out_dir)
    doc = docio.load(seed_path)
    plans = catalogue.plan_all(doc, seed, per_type, only)
    files = _write_suite(doc, plans, CLEAN_NAME, seed_path, out_dir, seed, backends)
    if demo:
        chosen = _building_demo_plans(plans)
        if chosen:
            # Reconcile ordinary changes first, then plant the deliberate arithmetic discrepancy.
            ordinary, bad_amount = chosen[:-1], chosen[-1]
            combined = catalogue.combine(doc, ordinary) + bad_amount.ops
            files.extend(_write_demo(doc, chosen, combined, DEMO_NAME, CLEAN_NAME, out_dir, seed_path, seed, backends))

    if include_precast:
        precast_doc = docio.load(PRECAST_PATH)
        precast_plans = precast.plans(precast_doc)
        clean_name = "precast_lv11_clean"
        files.extend(_write_suite(precast_doc, precast_plans, clean_name, PRECAST_PATH, out_dir, seed, backends))
        if demo:
            featured = {"PRECAST-STRENGTH", "PRECAST-LAYER-SUM", "PRECAST-UNIT", "PRECAST-PLACEHOLDER",
                        "PRECAST-MISSING-SPEC"}
            chosen = [plan for plan in precast_plans if plan.type in featured]
            combined = catalogue.combine(precast_doc, chosen)
            files.extend(_write_demo(precast_doc, chosen, combined, "precast_lv11_planted", clean_name,
                                     out_dir, PRECAST_PATH, seed, backends))

    for entry in files:
        path = (out_dir if "/" in entry["file"] else out_dir / "mutated") / entry["file"]
        entry["sha256"] = docio.file_hash(path)
    manifest = {"schema": MANIFEST_SCHEMA, "created": date.today().isoformat(), "seed_file": seed_path.name,
                "seed_sha256": docio.file_hash(seed_path), "mutator_seed": seed, "per_type": per_type,
                "backends": list(backends), "files": files}
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8", newline="\n")
    return manifest


def _write_suite(doc, plans, clean_name, seed_path, out_dir, seed, backends):
    mutated_dir = out_dir / "mutated"
    mutated_dir.mkdir(parents=True, exist_ok=True)
    files = []
    clean = catalogue.Plan(clean_name, "CTRL-CLEAN", "The unchanged seed", [],
                           catalogue.label(target={}, expect=[], match="none", control=True,
                                           note="The clean seed must give no findings at all."))
    clean_bytes: dict[str, bytes] = {}
    for backend in backends:
        data, _ = render(doc, [], backend)
        clean_bytes[backend] = data
        path = mutated_dir / f"{clean_name}{SUFFIX[backend]}"
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
                          baseline=f"{clean_name}{SUFFIX[backend]}", seed_path=seed_path, seed=seed, plan=plan,
                          labels=_labels_for(plan))
            files.append({"file": path.name, "type": plan.type, "backend": backend})

    return files


def _building_demo_plans(plans):
    chosen = []
    for prefix in ("L2-REMOVE-EDGE_INSULATION", "DUP-NEW-OZ", "QTY-ZERO"):
        match = next((p for p in plans if p.id == prefix or p.id.startswith(prefix + "-")), None)
        if match is None:
            return []
        chosen.append(match)
    occupied = {code for p in chosen for code in p.label.get("target", {}).get("line_codes", [])}
    amount = next((p for p in plans if p.type == "ARITH-LINE"
                   and not occupied.intersection(p.label["target"]["line_codes"])), None)
    return chosen + [amount] if amount else []


def _write_demo(doc, chosen, combined, name, clean_name, out_dir, seed_path, seed, backends):
    demo_dir = out_dir / "demo"
    demo_dir.mkdir(parents=True, exist_ok=True)
    plan = catalogue.Plan(name, "DEMO", "Combined planted demo cases", combined, {},
                          {"parts": [p.id for p in chosen]})
    labels = [{"id": f"{name}/{n}", "mutation_type": part.type, "description": part.description, **part.label}
              for n, part in enumerate(chosen, 1)]
    written = []
    for backend in backends:
        data, _ = render(doc, combined, backend)
        path = demo_dir / f"{name}{SUFFIX[backend]}"
        path.write_bytes(data)
        check_readback(path, backend, doc, combined)
        _write_labels(path, file=path, backend=backend, suite="demo",
                      baseline=f"../mutated/{clean_name}{SUFFIX[backend]}", seed_path=seed_path, seed=seed,
                      plan=plan, labels=labels)
        written.append({"file": f"demo/{path.name}", "type": "DEMO", "backend": backend})
    return written
