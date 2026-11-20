"""Command-line entry point; JSON on stdout is always machine-readable."""

import argparse
from decimal import Decimal, InvalidOperation
import json
from pathlib import Path
import sys

from pydantic import ValidationError

from .adapter import from_json
from .contracts import Finding
from .layer2.schema import load_rules, rule_metadata
from .runner import analyze


def _tolerance(value: str) -> Decimal:
    try:
        number = Decimal(value)
        if number.is_finite() and 0 <= number < 1:
            return number
    except InvalidOperation:
        pass
    raise argparse.ArgumentTypeError("use a fraction >= 0 and < 1 (0.10 means 10%)")


def _table(result) -> str:
    rows = [[f.severity, f.rule_id, f.evidence.get("context", f.scope),
             f.evidence.get("dependency", f.title), f.evidence.get("variance", "-")]
            for f in result.findings]
    if not rows:
        return "No dependency findings.\n"
    headers = ["Severity", "Rule", "Scope", "Dependency", "Variance"]
    widths = [max(len(str(row[i])) for row in [headers, *rows]) for i in range(len(headers))]
    def row_text(row):
        return " | ".join(str(value).ljust(width) for value, width in zip(row, widths))
    return "\n".join([row_text(headers), "-+-".join("-" * w for w in widths),
                       *(row_text(row) for row in rows)]) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Check parsed BoQ JSON for missing construction dependencies.")
    parser.add_argument("input", nargs="?", help="AnalysisInput JSON or a JSON Item array")
    parser.add_argument("--output", "-o", type=Path, help="Write the report to this file; defaults to stdout")
    parser.add_argument("--format", choices=["json", "table"], default="json")
    parser.add_argument("--scope", choices=["auto", "document", "trade", "section", "area"], default="auto")
    parser.add_argument("--tolerance", default="0.10", type=_tolerance, help="Shortage fraction; 0.10 means 10%%")
    parser.add_argument("--rules", type=Path, help="Replace the bundled rules with a JSON ruleset")
    parser.add_argument("--prior-findings", type=Path, help="Layer 1 findings array or AnalysisResult JSON")
    parser.add_argument("--list-rules", action="store_true", help="Print rule metadata and exit")
    parser.add_argument("--fail-on", choices=["never", "warning", "error"], default="never",
                        help="Exit 1 if findings meet this severity; invalid input exits 2")
    args = parser.parse_args(argv)
    if not args.input and not args.list_rules:
        parser.error("input is required unless --list-rules is used")
    try:
        if args.output:
            protected = [Path(path).resolve() for path in
                         (args.input, args.rules, args.prior_findings) if path]
            if args.output.resolve() in protected:
                raise ValueError("Output must differ from input, rules, and prior-findings files")
        rules = load_rules(args.rules)
        if args.list_rules:
            output = json.dumps(rule_metadata(rules), indent=2, ensure_ascii=False) + "\n"
            result = None
        else:
            input = from_json(args.input)
            prior = []
            if args.prior_findings:
                data = json.loads(args.prior_findings.read_text(encoding="utf-8-sig"))
                if isinstance(data, dict):
                    if data.get("input_hash") != input.input_hash:
                        raise ValueError("Prior AnalysisResult input_hash does not match this input")
                    data = data["findings"]
                if not isinstance(data, list):
                    raise ValueError("Prior findings must be an array or an AnalysisResult")
                prior = [Finding.model_validate(finding) for finding in data]
            result = analyze(input, prior, rules=rules, scope=args.scope, tolerance=args.tolerance)
            output = _table(result) if args.format == "table" else result.model_dump_json(indent=2) + "\n"
        if args.output:
            args.output.write_text(output, encoding="utf-8")
        else:
            sys.stdout.write(output)
        if result and args.fail_on != "never":
            severities = {"error", "warning"} if args.fail_on == "warning" else {"error"}
            return int(any(finding.severity in severities for finding in result.findings))
        return 0
    except (OSError, ValueError, KeyError, TypeError, ValidationError) as error:
        print(f"gaeb-check: {error}", file=sys.stderr)
        return 2

