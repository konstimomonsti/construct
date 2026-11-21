"""Command line entry point.

    python -m analysis input  Data/file.X83 [--out input.json]
    python -m analysis run    Data/file.X83 [--layers 1,2] [--out result.json]
    python -m analysis run    fixture.json
    python -m analysis rules
"""

import argparse
import json
from pathlib import Path
import sys

from . import adapter
from .catalogue import cli as catalogue_cli
from .registry import all_rules
from .runner import DEFAULT_LAYERS, analyze


def load(path: str, boq_index: int | None):
    if Path(path).suffix.lower() == ".json":
        return adapter.from_json(path)
    return adapter.from_file(path, boq_index=boq_index)


def emit(text: str, out: str | None) -> None:
    if out:
        Path(out).write_text(text, encoding="utf-8")
    else:
        sys.stdout.reconfigure(encoding="utf-8")
        print(text)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python -m analysis")
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("input", "run"):
        command = commands.add_parser(name)
        command.add_argument("path", help="GAEB X8x/D8x file or AnalysisInput JSON")
        command.add_argument("--boq-index", type=int)
        command.add_argument("--out")
        if name == "run":
            command.add_argument("--layers", default=",".join(map(str, DEFAULT_LAYERS)))
    commands.add_parser("rules")
    catalogue_cli.add_command(commands)
    args = parser.parse_args(argv)

    if args.command == "catalogue":
        return catalogue_cli.dispatch(args, emit, parser)

    if args.command == "rules":
        import importlib
        for layer in (1, 2, 3):
            try:
                importlib.import_module(f"analysis.layer{layer}")
            except ModuleNotFoundError:
                pass
        emit(json.dumps([info.as_dict() for info in all_rules()], indent=2, ensure_ascii=False), None)
        return 0

    analysis_input = load(args.path, args.boq_index)
    if args.command == "input":
        emit(analysis_input.model_dump_json(indent=2), args.out)
        return 0
    layers = [int(part) for part in args.layers.split(",") if part.strip()]
    result = analyze(analysis_input, layers)
    emit(result.model_dump_json(indent=2), args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
