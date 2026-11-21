"""Command-line entry points for stored catalogue analytics."""

import json

from analysis.layer3.provider import ProviderError, provider_from_env


def add_command(commands):
    catalogue = commands.add_parser("catalogue", help="Identify and review products in a stored BOM")
    actions = catalogue.add_subparsers(dest="catalogue_action", required=True)
    for name in ("process", "report", "review", "retry", "approve-alias", "history"):
        command = actions.add_parser(name)
        command.add_argument("bom_id", help="Stored bom_version UUID")
        command.add_argument("--out")
        if name in ("review", "retry", "history"):
            command.add_argument("occurrence_id")
        if name == "process":
            command.add_argument("--llm", action="store_true", help="Allow first-time identification calls")
        if name in ("review", "retry"):
            command.add_argument("--decision-id", required=True, help="Current decision ID from the report")
        if name == "review":
            command.add_argument("action", choices=("accept", "reject", "correct"))
            command.add_argument("--reviewer", required=True)
            command.add_argument("--product-id")
            command.add_argument("--note", default="")
        elif name == "retry":
            command.add_argument("--attempt-id", required=True, help="Latest saved attempt ID from the report")
        elif name == "approve-alias":
            command.add_argument("product_id")
            command.add_argument("alias")
            command.add_argument("--reviewer", required=True)
            command.add_argument("--share", action="store_true", help="Approve the alias across projects")


def dispatch(args, emit, parser):
    try:
        import psycopg
    except ImportError:
        parser.error("Install the database extra with pip install -e '.[db]'")
    from .service import Catalogue, connect
    from .store import CatalogueError

    name = args.catalogue_action
    try:
        provider = provider_from_env() if name == "retry" or getattr(args, "llm", False) else None
        with connect() as connection:
            service = Catalogue(connection, provider)
            if name == "process":
                result = service.process(args.bom_id)
            elif name == "review":
                result = service.review(args.bom_id, args.occurrence_id, args.action, args.reviewer,
                                        product_id=args.product_id, note=args.note,
                                        expected_decision_id=args.decision_id)
            elif name == "retry":
                result = service.retry(args.bom_id, args.occurrence_id, args.decision_id, args.attempt_id)
            elif name == "approve-alias":
                result = service.approve_alias(args.bom_id, args.product_id, args.alias, args.reviewer, share=args.share)
            elif name == "history":
                result = service.history(args.bom_id, args.occurrence_id)
            else:
                result = service.report(args.bom_id)
    except (CatalogueError, ProviderError, psycopg.OperationalError) as exc:
        parser.error(str(exc))
    emit(json.dumps(result, ensure_ascii=False, indent=2, default=str), args.out)
    return 0
