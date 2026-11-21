"""python -m analysis.eval COMMAND

    mutate          plant errors in the seed, write mutated files and labels to eval_out/
    run             analyse every labelled file (layers 1,2 by default) and store the findings
    fp              analyse only the controls and the clean seed; every finding is a false alarm
    label-template  print a CSV skeleton to label the findings of any file by hand
    report          the results tables: recall per mutation type, precision per rule, gaps
"""

from __future__ import annotations

import argparse
from pathlib import Path
import sys

from . import DEFAULT_OUT, SEED_PATH


def _layers(text: str) -> list[int]:
    try:
        values = {int(part) for part in text.split(",")}
    except ValueError as exc:
        raise argparse.ArgumentTypeError("Choose layers 1, 2 or 3") from exc
    if not values <= {1, 2, 3}:
        raise argparse.ArgumentTypeError("Choose layers 1, 2 or 3")
    return sorted(values)


def _echo(text: str) -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    print(text, end="" if text.endswith("\n") else "\n")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m analysis.eval", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)

    mutate = commands.add_parser("mutate", help="write mutated files and labels")
    mutate.add_argument("--seed-file", default=str(SEED_PATH), help="the clean seed document (JSON)")
    mutate.add_argument("--seed", type=int, default=1, help="random seed for choosing targets (default 1)")
    mutate.add_argument("--backend", choices=["x83", "json", "both"], default="both")
    mutate.add_argument("--per-type", type=int, default=3, help="instances of each line-level type (default 3)")
    mutate.add_argument("--only", help="comma-separated mutation types or prefixes, e.g. QTY,L2-REMOVE")
    mutate.add_argument("--no-demo", action="store_true", help="skip the planted demo files")
    mutate.add_argument("--out", default=str(DEFAULT_OUT))

    run = commands.add_parser("run", help="analyse the labelled files")
    run.add_argument("--layers", type=_layers, default=[1, 2], help="e.g. 1,2 or 1,2,3 (3 needs a model)")
    run.add_argument("--out", default=str(DEFAULT_OUT))

    fp = commands.add_parser("fp", help="false alarms on the controls and the clean seed")
    fp.add_argument("--layers", type=_layers, default=[1, 2])
    fp.add_argument("--out", default=str(DEFAULT_OUT))

    template = commands.add_parser("label-template", help="CSV skeleton for labelling the findings of a file")
    template.add_argument("path", help="GAEB file or AnalysisInput JSON")
    template.add_argument("--layers", type=_layers, default=[1, 2])
    template.add_argument("--per-finding", action="store_true", help="one row per finding instead of per rule")
    template.add_argument("--out", help="write to this file instead of printing")

    report = commands.add_parser("report", help="print the results tables")
    report.add_argument("--out", default=str(DEFAULT_OUT))
    report.add_argument("--backend", choices=["x83", "json"], help="only the files of one backend")
    report.add_argument("--format", choices=["md"], default="md", help="render the report in Markdown")
    report.add_argument("--write", help="also write the report to this file")
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    out = Path(getattr(args, "out", None) or DEFAULT_OUT) if args.command != "label-template" else None

    if args.command == "mutate":
        from .mutate import generate
        backends = ("x83", "json") if args.backend == "both" else (args.backend,)
        only = {part.strip() for part in args.only.split(",")} if args.only else None
        manifest = generate(Path(args.seed_file), out, seed=args.seed, backends=backends, per_type=args.per_type,
                            only=only, demo=not args.no_demo,
                            include_precast=Path(args.seed_file).resolve() == SEED_PATH and only is None)
        types = sorted({entry["type"] for entry in manifest["files"]})
        _echo(f"Wrote {len(manifest['files'])} files ({', '.join(backends)}) to {out}/ "
              f"(seed {args.seed}, {len(types)} mutation types). Every file was read back and checked.")
        return 0

    if args.command == "run":
        from .harness import run_all
        written = run_all(out, args.layers, progress=None)
        _echo(f"Analysed {len(written)} files with layers {','.join(map(str, args.layers))}; results in {out}/results/")
        return 0

    if args.command == "fp":
        from .harness import evaluate, run_all
        run_all(out, args.layers, only_controls=True)
        evaluation = evaluate(out, controls_only=True)
        _echo(f"Controls and clean seed: {len([o for o in evaluation.outcomes])} files checked, "
              f"{len(evaluation.false_alarms)} false alarms.")
        for file, finding in evaluation.false_alarms:
            _echo(f"  {file}: {finding['rule_id']} on {finding['line_code'] or finding['section_code'] or 'the BoQ'} "
                  f"- {finding['title']}")
        return 1 if evaluation.false_alarms else 0

    if args.command == "label-template":
        from .labels import template_csv, template_rows
        text = template_csv(template_rows(Path(args.path), args.layers, args.per_finding))
        if args.out:
            Path(args.out).write_text(text, encoding="utf-8", newline="\n")
            _echo(f"Wrote {args.out}")
        else:
            _echo(text)
        return 0

    if args.command == "report":
        import json
        from .harness import evaluate
        from .report import format_report, write_report
        evaluation = evaluate(out, backend=args.backend)
        manifest = out / "manifest.json"
        info = ""
        if manifest.exists():
            data = json.loads(manifest.read_text(encoding="utf-8"))
            info = f"Seed `{data['seed_file']}`, mutator seed {data['mutator_seed']}."
        text = format_report(evaluation, seed_info=info)
        _echo(text)
        if args.write:
            write_report(text, args.write)
        return 0
    return 2
