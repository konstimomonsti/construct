import argparse
import json
from pathlib import Path
import sys
from uuid import UUID

import psycopg

from .challenge_catalogue import import_challenge_catalogue
from .common import MAX_FILE_BYTES
from .draft import copy_prices, create_draft
from .ingest import ingest
from .store import original, project_key, records, report


def arguments():
    parser = argparse.ArgumentParser(description="Preserve tender uploads and extract their source data into PostgreSQL")
    commands = parser.add_subparsers(dest="command", required=True)
    import_cmd = commands.add_parser("import", help="Import a ZIP or one source document")
    import_cmd.add_argument("source", type=Path)
    project = import_cmd.add_mutually_exclusive_group(required=True)
    project.add_argument("--project-id", type=UUID)
    project.add_argument("--project", help="Use or create a named import project")
    import_cmd.add_argument("--legacy-encoding", choices=("cp850", "cp1252", "cp437", "iso8859_1"))
    report_cmd = commands.add_parser("report", help="Show the latest import summary and review issues")
    report_cmd.add_argument("document_id", type=UUID)
    records_cmd = commands.add_parser("records", help="Read extracted evidence and candidate rows")
    records_cmd.add_argument("import_id", type=UUID)
    records_cmd.add_argument("--kind")
    records_cmd.add_argument("--limit", type=int, default=50)
    records_cmd.add_argument("--after", type=int, default=0)
    original_cmd = commands.add_parser("original", help="Write the exact original file to a new path, or to stdout")
    original_cmd.add_argument("document_id", type=UUID)
    original_cmd.add_argument("--output", type=Path)
    draft_cmd = commands.add_parser("draft", help="Create a draft BOM from one explicitly selected scope source")
    draft_cmd.add_argument("document_id", type=UUID)
    draft_cmd.add_argument("--package-code", required=True)
    draft_cmd.add_argument("--title")
    draft_cmd.add_argument("--boq-index", type=int)
    draft_cmd.add_argument("--phase", choices=("tender", "award"))
    price_cmd = commands.add_parser("prices", help="Copy selling rates from one document into reference-price staging")
    price_cmd.add_argument("document_id", type=UUID)
    price_cmd.add_argument("--currency")
    catalogue_cmd = commands.add_parser("challenge-catalogue", help="Load Challenge A materials for catalogue review")
    catalogue_cmd.add_argument("--project", default="Challenge A import review")
    return parser.parse_args()


def display(data):
    print(json.dumps(data, indent=2, ensure_ascii=False))


def main():
    args = arguments()
    try:
        with psycopg.connect("", autocommit=True) as connection:
            if args.command == "import":
                size = args.source.stat().st_size
                if size > MAX_FILE_BYTES:
                    raise ValueError(f"Upload exceeds the {MAX_FILE_BYTES // (1024 * 1024)} MiB limit")
                content = args.source.read_bytes()
                key = project_key(connection, args.project, args.project_id)
                summary = ingest(connection, key, args.source.name, content, legacy_encoding=args.legacy_encoding)
                display({"project_id": str(key), **summary})
                return int(summary["status"] == "failed" or bool(summary.get("failed_members", 0)))
            if args.command == "report":
                display(report(connection, args.document_id))
            elif args.command == "records":
                if not 1 <= args.limit <= 1000 or args.after < 0:
                    raise ValueError("Use --limit from 1 to 1000 and a non-negative --after")
                display(records(connection, args.import_id, args.kind, args.limit, args.after))
            elif args.command == "original":
                data = original(connection, args.document_id)
                if args.output is None:
                    sys.stdout.buffer.write(data)
                else:
                    with args.output.open("xb") as destination:
                        destination.write(data)
            elif args.command == "draft":
                display(create_draft(connection, args.document_id, args.package_code, args.title, args.boq_index, args.phase))
            elif args.command == "prices":
                display(copy_prices(connection, args.document_id, args.currency))
            elif args.command == "challenge-catalogue":
                display(import_challenge_catalogue(connection, args.project))
    except (ValueError, OSError, psycopg.Error) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
