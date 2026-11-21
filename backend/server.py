import json
from datetime import date, datetime
import mimetypes
import os
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

import psycopg
from psycopg import sql
from psycopg.rows import dict_row
from tender_import.common import MAX_FILE_BYTES
from tender_import.store import original

import analysis_api
import catalogues
import mvp
import workspace
import workspace_catalogue
from exports import export


ROOT = Path(__file__).parent
# Hostnames the browser may use to reach this server. A production deployment adds its public domain.
ALLOWED_HOSTS = {"127.0.0.1", "::1", "localhost"} | {
    host.strip().lower() for host in os.environ.get("ALLOWED_HOSTS", "").split(",") if host.strip()
}
PORT = int(os.environ.get("PORT", "8080"))
# Extra browser origins allowed to POST, e.g. a frontend dev server that proxies /api with changeOrigin.
ALLOWED_ORIGINS = {origin.strip().rstrip("/") for origin in os.environ.get("ALLOWED_ORIGINS", "").split(",")
                   if origin.strip()}
# Built-in data tools. The product UI lives in frontend/ and is served by the web container (or below).
ADMIN = {
    "/admin/tables": (ROOT / "admin" / "index.html", "text/html; charset=utf-8"),
    "/admin/app.js": (ROOT / "admin" / "app.js", "text/javascript; charset=utf-8"),
    "/admin/styles.css": (ROOT / "admin" / "styles.css", "text/css; charset=utf-8"),
    # Copied next to server.py in the image; in a checkout it lives at the repository root.
    "/admin/schema": (next((path for path in (ROOT / "schema-dashboard.html", ROOT.parent / "schema-dashboard.html")
                            if path.is_file()), ROOT / "schema-dashboard.html"), "text/html; charset=utf-8"),
}
# Optional: serve a built frontend from this process (development). Production serves it from Caddy.
FRONTEND_DIR = Path(os.environ["FRONTEND_DIR"]).resolve() if os.environ.get("FRONTEND_DIR") else None
STRICT_CSP = "default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'"
INLINE_CSP = ("default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; "
              "frame-ancestors 'none'; base-uri 'none'")
# Keep in sync with deploy/Caddyfile so a frontend behaves the same in development and production.
FRONTEND_CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
                "font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; "
                "frame-src 'self' blob:; "
                "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("font/woff2", ".woff2")
FRIENDLY_LABELS = {
    "activity_group": "name",
    "activity_item": "name",
    "bom_section": "title",
    "bom_version": "title",
    "estimate": "scenario_name",
    "material_group": "name",
    "material_item": "name",
    "product": "name",
    "product_category": "name",
    "project": "name",
    "project_area": "name",
    "quote": "quote_number",
    "source_document": "filename",
    "supplier": "name",
    "subcontractor": "name",
}
PREVIEW_LENGTH = 480
RECORD_LENGTH = 48_000


def json_value(value):
    """Timestamps as ISO 8601; UUIDs, decimals and anything else as strings."""
    return value.isoformat() if isinstance(value, (datetime, date)) else str(value)


def table_name(name):
    return sql.Identifier("public", name)


def schema(connection):
    columns = connection.execute(
        """
        SELECT c.table_name, c.column_name AS name, c.data_type AS type, c.is_nullable = 'YES' AS nullable
        FROM information_schema.columns c
        JOIN information_schema.tables t USING (table_schema, table_name)
        WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        ORDER BY c.table_name, c.ordinal_position
        """
    )
    tables = {}
    for column in columns:
        name = column.pop("table_name")
        table = tables.setdefault(name, {"name": name, "columns": [], "primary_key": [], "relations": []})
        table["columns"].append(column)

    keys = connection.execute(
        """
        SELECT t.relname AS table_name, k.contype AS kind, k.conname AS name, target.relname AS target,
               array_agg(a.attname::text ORDER BY part.ordinality) AS columns,
               array_agg(ta.attname::text ORDER BY part.ordinality) FILTER (WHERE ta.attname IS NOT NULL)
                   AS target_columns
        FROM pg_constraint k
        JOIN pg_class t ON t.oid = k.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        CROSS JOIN LATERAL unnest(k.conkey) WITH ORDINALITY AS part(attnum, ordinality)
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = part.attnum
        LEFT JOIN pg_class target ON target.oid = k.confrelid
        LEFT JOIN pg_namespace tn ON tn.oid = target.relnamespace
        LEFT JOIN pg_attribute ta ON ta.attrelid = target.oid AND ta.attnum = k.confkey[part.ordinality]
        WHERE n.nspname = 'public' AND k.contype IN ('p', 'f')
          AND (k.contype = 'p' OR tn.nspname = 'public')
        GROUP BY t.relname, k.contype, k.conname, target.relname
        ORDER BY t.relname, k.conname
        """
    )
    for key in keys:
        name = key.pop("table_name")
        if name not in tables:
            continue
        if key.pop("kind") == "p":
            tables[name]["primary_key"] = key["columns"]
        elif key["target"] in tables:
            tables[name]["relations"].append(key)
    return tables


def table_index(connection, tables):
    if not tables:
        return {"tables": []}
    statements = [
        sql.SQL("SELECT {} AS name, count(*) AS row_count FROM {}").format(sql.Literal(name), table_name(name))
        for name in tables
    ]
    for entry in connection.execute(sql.SQL(" UNION ALL ").join(statements)):
        tables[entry["name"]]["row_count"] = entry["row_count"]
    return {"tables": list(tables.values())}


def filters(params, columns):
    selected = json.loads(params.get("where", "{}"))
    if not isinstance(selected, dict) or len(selected) > 10 or any(
        name not in columns or columns[name] == "bytea" or not isinstance(value, (str, type(None)))
        for name, value in selected.items()
    ):
        raise ValueError("Invalid column filter")
    conditions, values = [], []
    for name, value in selected.items():
        if value is None:
            conditions.append(sql.SQL("{} IS NULL").format(sql.Identifier(name)))
        else:
            conditions.append(sql.SQL("{}::text = %s").format(sql.Identifier(name)))
            values.append(value)
    return selected, conditions, values


def projection(columns, primary_key, limit):
    expressions = []
    for name, kind in columns.items():
        identifier = sql.Identifier(name)
        if kind == "bytea":
            expression = sql.SQL("octet_length({})::text").format(identifier)
        elif name in primary_key:
            expression = sql.SQL("{}::text").format(identifier)
        else:
            value = sql.SQL("{}::text").format(identifier)
            if limit == RECORD_LENGTH and kind == "jsonb":
                value = sql.SQL("jsonb_pretty({})").format(identifier)
            expression = sql.SQL("left({}, {})").format(value, sql.Literal(limit + 1))
        expressions.append(sql.SQL("{} AS {}").format(expression, identifier))
    return sql.SQL(", ").join(expressions)


def format_rows(records, primary_key, limit):
    result = []
    for row in records:
        clipped = [key for key, value in row.items() if value is not None and key not in primary_key
                   and len(value) > limit]
        for key in clipped:
            row[key] = row[key][:limit]
        result.append({"values": row, "clipped": clipped})
    return result


def label_fields(table, tables):
    fields = {}
    for ref in table["relations"]:
        target = ref["target"]
        field = FRIENDLY_LABELS.get(target)
        column_types = {col["name"]: col["type"] for col in tables[target]["columns"]}
        if ref["target_columns"] == ["id"] and field in column_types and column_types["id"] == "uuid":
            fields[ref["columns"][0]] = (target, field)
    return fields


def related_labels(connection, fields, rows):
    labels = {}
    for column, (target, field) in fields.items():
        ids = list({row["values"][column] for row in rows if row["values"][column] is not None})
        if ids:
            query = sql.SQL("SELECT id::text, {}::text AS label FROM {} WHERE id = ANY(%s::uuid[])").format(
                sql.Identifier(field), table_name(target)
            )
            labels[column] = {row["id"]: row["label"] for row in connection.execute(query, (ids,))}
    return labels


def rows_for(connection, table, tables, params, single=False):
    columns = {col["name"]: col["type"] for col in table["columns"]}
    primary_key = table["primary_key"]
    fields = label_fields(table, tables)
    label_values = {
        column: sql.SQL("(SELECT label_row.{}::text FROM {} AS label_row WHERE label_row.id = table_row.{})").format(
            sql.Identifier(field), table_name(target), sql.Identifier(column)
        )
        for column, (target, field) in fields.items()
    }
    selected, conditions, parameters = filters(params, columns)
    if single and (not primary_key or set(selected) != set(primary_key)):
        raise ValueError("A full primary key is required to open a record")

    if not single:
        search = params.get("q", "").strip()
        if len(search) > 200:
            raise ValueError("Search up to 200 characters")
        if search:
            # Scalar fields include identifiers and tender codes. Large JSON
            # evidence is inspected in the record panel.
            expressions = [
                sql.SQL("strpos(lower({}::text), lower(%s)) > 0").format(sql.Identifier(name))
                for name, kind in columns.items() if kind not in {"bytea", "json", "jsonb"}
            ]
            expressions.extend(
                sql.SQL("strpos(lower({}), lower(%s)) > 0").format(value)
                for value in label_values.values()
            )
            if expressions:
                conditions.append(sql.SQL("({})").format(sql.SQL(" OR ").join(expressions)))
                parameters.extend([search] * len(expressions))
            else:
                conditions.append(sql.SQL("false"))

    where = sql.SQL(" WHERE ") + sql.SQL(" AND ").join(conditions) if conditions else sql.SQL("")
    table_id = sql.SQL("{} AS table_row").format(table_name(table["name"]))
    if single:
        query = sql.SQL("SELECT {} FROM {}{} LIMIT 1").format(
            projection(columns, primary_key, RECORD_LENGTH), table_id, where
        )
        rows = format_rows(connection.execute(query, parameters), primary_key, RECORD_LENGTH)
        return {"rows": rows, "labels": related_labels(connection, fields, rows)}

    preferred = {"product": "name", "product_category": "name", "source_document": "filename", "supplier": "name",
                 "product_price": "valid_from", "bom_line": "sort_order", "quote_line": "sort_order"}
    sort = params.get("sort") or preferred.get(table["name"]) or next(iter(primary_key or columns))
    direction = params.get("direction", "asc")
    if sort not in columns or direction not in {"asc", "desc"}:
        raise ValueError("Invalid sort column or direction")
    order_column = label_values.get(sort, sql.Identifier(sort))
    if columns[sort] == "bytea":
        order_column = sql.SQL("octet_length({})").format(order_column)
    order = sql.SQL("{} {} NULLS LAST").format(order_column, sql.SQL(direction.upper()))
    tie_breakers = [sql.Identifier(column) for column in primary_key if column != sort]
    if tie_breakers:
        order += sql.SQL(", ") + sql.SQL(", ").join(tie_breakers)
    size = int(params.get("size", 25))
    if size not in {25, 50, 100}:
        raise ValueError("Use a page size of 25, 50, or 100")
    total = connection.execute(
        sql.SQL("SELECT count(*) AS total FROM {}{}").format(table_id, where), parameters
    ).fetchone()["total"]
    pages = max(1, (total + size - 1) // size)
    page = min(max(1, int(params.get("page", 1))), pages)
    query = sql.SQL("SELECT {} FROM {}{} ORDER BY {} LIMIT %s OFFSET %s").format(
        projection(columns, primary_key, PREVIEW_LENGTH), table_id, where, order
    )
    records = connection.execute(query, [*parameters, size, (page - 1) * size])
    rows = format_rows(records, primary_key, PREVIEW_LENGTH)
    return {
        "rows": rows, "labels": related_labels(connection, fields, rows),
        "page": page, "pages": pages, "size": size, "total": total, "sort": sort, "direction": direction,
    }


class BrowserHandler(BaseHTTPRequestHandler):
    def log_request(self, code="-", size="-"):
        if self.path == "/healthz":
            return
        self.log_message("%s %s %s", self.command, self.path.partition("?")[0], code)

    def send(self, status, content, content_type, filename=None, csp=STRICT_CSP, cache="no-store"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", cache)
        if filename:
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", csp)
        self.end_headers()
        self.wfile.write(content)

    def json(self, status, payload):
        self.send(status, json.dumps(payload, ensure_ascii=False, default=json_value).encode("utf-8"),
                  "application/json; charset=utf-8")

    def local_request(self):
        try:
            host = urlsplit("//" + self.headers.get("Host", "")).hostname
        except ValueError:
            host = None
        if host not in ALLOWED_HOSTS:
            self.json(HTTPStatus.FORBIDDEN, {"error": "This hostname is not allowed. Add it to ALLOWED_HOSTS."})
            return False
        return True

    def do_GET(self):
        if not self.local_request():
            return
        request = urlsplit(self.path)
        if request.path == "/healthz":
            self.health()
            return
        if request.path in {"/admin", "/admin/"}:
            self.redirect("/admin/tables")
            return
        if request.path in ADMIN:
            file, content_type = ADMIN[request.path]
            csp = INLINE_CSP if request.path == "/admin/schema" else STRICT_CSP
            self.send(HTTPStatus.OK, file.read_bytes(), content_type, csp=csp)
            return
        if request.path.startswith("/api/mvp/"):
            self.mvp_request(request, write=False)
            return
        if request.path.startswith("/api/workspace/"):
            self.workspace_request(request, write=False)
            return
        if request.path.startswith("/api/catalogues/"):
            self.catalogue_request(request, write=False)
            return
        if request.path not in {"/api/tables", "/api/rows", "/api/record"}:
            if request.path.startswith(("/api/", "/admin/")) or not self.frontend(request.path):
                self.json(HTTPStatus.NOT_FOUND, {"error": "Page not found"})
            return
        try:
            params = {key: value[-1] for key, value in parse_qs(
                request.query, keep_blank_values=True, max_num_fields=12
            ).items()}
            with psycopg.connect("", row_factory=dict_row, connect_timeout=3,
                                 options="-c statement_timeout=10000") as connection:
                connection.read_only = True
                tables = schema(connection)
                if request.path == "/api/tables":
                    response = table_index(connection, tables)
                elif params.get("table") not in tables:
                    self.json(HTTPStatus.NOT_FOUND, {"error": "Table not found"})
                    return
                else:
                    response = rows_for(connection, tables[params["table"]], tables, params,
                                        single=request.path == "/api/record")
            self.json(HTTPStatus.OK, response)
        except (ValueError, TypeError) as error:
            self.json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
        except psycopg.Error as error:
            self.log_error("Database request failed (%s)", type(error).__name__)
            self.json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "Could not read from PostgreSQL. Try refreshing."})
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self):
        if not self.local_request():
            return
        origin = self.headers.get("Origin")
        host = self.headers.get("Host", "")
        if origin and origin.rstrip("/") not in {f"http://{host}", f"https://{host}"} | ALLOWED_ORIGINS:
            self.json(HTTPStatus.FORBIDDEN, {"error": "Open the workspace directly to upload or edit files."})
            return
        request = urlsplit(self.path)
        if request.path.startswith("/api/workspace/"):
            self.workspace_request(request, write=True)
            return
        if request.path.startswith("/api/catalogues/"):
            self.catalogue_request(request, write=True)
            return
        self.mvp_request(request, write=True)

    def catalogue_request(self, request, write):
        kind = request.path.removeprefix("/api/catalogues/")
        if kind not in (catalogues.COMPANIES if write else catalogues.KINDS):
            self.json(HTTPStatus.NOT_FOUND, {"error": "Catalogue not found."})
            return
        try:
            if write:
                length = int(self.headers.get("Content-Length", 0))
                if not 0 < length <= 4096:
                    self.json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "The request is empty or too large."})
                    return
                payload = json.loads(self.rfile.read(length))
                if not isinstance(payload, dict):
                    raise ValueError("Enter a valid company record.")
            else:
                params = {key: values[-1] for key, values in parse_qs(request.query, max_num_fields=5).items()}
            with psycopg.connect("", row_factory=dict_row, connect_timeout=3,
                                 options="-c statement_timeout=10000") as connection:
                if write:
                    result = catalogues.save_company(connection, kind, payload)
                else:
                    connection.read_only = True
                    result = catalogues.listing(connection, kind, params)
            self.json(HTTPStatus.OK, result)
        except (ValueError, TypeError) as error:
            self.json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
        except LookupError as error:
            self.json(HTTPStatus.NOT_FOUND, {"error": str(error)})
        except psycopg.errors.UniqueViolation:
            self.json(HTTPStatus.CONFLICT, {"error": "A company with this name already exists in this catalogue."})
        except psycopg.Error as error:
            self.log_error("Catalogue request failed (%s)", type(error).__name__)
            self.json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "The catalogue is temporarily unavailable."})
        except (BrokenPipeError, ConnectionResetError):
            pass

    def redirect(self, location):
        self.send_response(HTTPStatus.FOUND)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def frontend(self, path):
        """Serve FRONTEND_DIR, falling back to index.html for client-side routes. False when not found."""
        if FRONTEND_DIR is None:
            if path == "/":
                self.json(HTTPStatus.OK, {"service": "tender desk api", "frontend": "not served by this process",
                                          "admin": "/admin/tables", "docs": "docs/API.md"})
                return True
            return False
        path = unquote(path)
        if "\x00" in path:
            return False
        target = (FRONTEND_DIR / path.lstrip("/")).resolve()
        if not target.is_relative_to(FRONTEND_DIR) or any(part.startswith(".") for part in target.relative_to(FRONTEND_DIR).parts):
            return False
        if target.is_dir():
            target = target / "index.html"
        if not target.is_file():
            # Unknown paths without a file extension are client-side routes of a single-page app.
            if Path(path).suffix:
                return False
            target = FRONTEND_DIR / "index.html"
            if not target.is_file():
                return False
        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type.endswith(("javascript", "json", "+xml", "+json")):
            content_type += "; charset=utf-8"
        # Hashed build assets (e.g. assets/index-3f9a1c.js) never change; everything else revalidates.
        cache = "public, max-age=31536000, immutable" if "/assets/" in path else "no-cache"
        self.send(HTTPStatus.OK, target.read_bytes(), content_type, csp=FRONTEND_CSP, cache=cache)
        return True

    def health(self):
        try:
            with psycopg.connect("", connect_timeout=3) as connection:
                connection.execute("SELECT 1")
            self.json(HTTPStatus.OK, {"status": "ok"})
        except psycopg.Error:
            self.json(HTTPStatus.SERVICE_UNAVAILABLE, {"status": "database unavailable"})

    def remote_user(self):
        """Login name set by the reverse proxy after basic auth (see deploy/Caddyfile)."""
        user = (self.headers.get("X-Remote-User") or "").strip()
        return user[:120] or None

    def workspace_request(self, request, write):
        """Shared workspace sync: GET/POST state, GET/POST file, POST file-delete."""
        path = request.path.removeprefix("/api/workspace/")
        operations = {"state", "file", "file-delete", "catalogue"} if write else {"state", "file", "catalogue"}
        if path not in operations:
            self.json(HTTPStatus.NOT_FOUND, {"error": "Action not found"})
            return
        try:
            params = {key: value[-1] for key, value in parse_qs(request.query, max_num_fields=4).items()}
            content = None
            if write:
                limit = {"file": MAX_FILE_BYTES, "catalogue": 1024}.get(path, workspace.MAX_STATE_BYTES)
                length = int(self.headers.get("Content-Length", 0))
                if not 0 < length <= limit:
                    self.json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "The request is empty or too large."})
                    return
                content = self.rfile.read(length)
            since = int(params["since"]) if "since" in params else None
            payload = {}
            if write and path != "file":
                payload = json.loads(content)
                if not isinstance(payload, dict):
                    raise ValueError("Invalid request body.")
            with psycopg.connect("", autocommit=True, row_factory=dict_row, connect_timeout=3,
                                 options="-c statement_timeout=30000") as connection:
                if path == "state" and write:
                    response = workspace.apply(connection, payload)
                elif path == "state":
                    response = workspace.state(connection, since)
                elif path == "file" and write:
                    content_type = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
                    response = workspace.save_file(connection, params.get("id"), content_type, content)
                elif path == "file":
                    content_type, body = workspace.load_file(connection, params.get("id"))
                    self.send(HTTPStatus.OK, body, content_type, cache="private, max-age=31536000, immutable")
                    return
                elif path == "catalogue":
                    response = workspace_catalogue.status(connection, workspace.WORKSPACE,
                                                          workspace.record_id(params.get("id")), start=write,
                                                          retry=write and payload.get("retry") is True)
                else:
                    response = workspace.delete_files(connection, payload)
            self.json(HTTPStatus.OK, response)
        except LookupError as error:
            self.json(HTTPStatus.NOT_FOUND, {"error": str(error)})
        except (ValueError, TypeError) as error:
            self.json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
        except psycopg.Error as error:
            self.log_error("Workspace sync failed (%s)", type(error).__name__)
            self.json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "The shared workspace is unavailable. Try again."})
        except (BrokenPipeError, ConnectionResetError):
            pass

    def mvp_request(self, request, write):
        path = request.path.removeprefix("/api/mvp/")
        operations = ({"project", "upload", "draft", "save", "analyze", "finding"} if write
                      else {"workspace", "bom", "export", "original", "rules", "analysis", "catalogue"})
        if not request.path.startswith("/api/mvp/") or path not in operations:
            self.json(HTTPStatus.NOT_FOUND, {"error": "Action not found"})
            return
        filename = None
        try:
            params = {key: value[-1] for key, value in parse_qs(request.query, max_num_fields=8).items()}
            content = None
            payload = {}
            if write:
                limit = MAX_FILE_BYTES if path == "upload" else 16 * 1024 * 1024
                length = int(self.headers.get("Content-Length", 0))
                if not 0 < length <= limit:
                    self.json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "The request is empty or too large."})
                    return
                content = self.rfile.read(length)
                if path != "upload":
                    payload = json.loads(content)
                    if not isinstance(payload, dict):
                        raise ValueError("Invalid request body.")
            with psycopg.connect("", autocommit=write, row_factory=dict_row, connect_timeout=3,
                                 options="-c statement_timeout=30000") as connection:
                if not write:
                    connection.read_only = True
                    connection.isolation_level = psycopg.IsolationLevel.REPEATABLE_READ
                if path == "workspace":
                    project_id = mvp.identifier(params["project"]) if "project" in params else None
                    response = mvp.workspace(connection, project_id)
                elif path == "project":
                    response = mvp.create_project(connection, payload)
                elif path == "upload":
                    response = mvp.upload(connection, mvp.identifier(params.get("project")), params.get("filename", ""), content)
                elif path == "draft":
                    response = mvp.make_draft(connection, payload)
                elif path == "save":
                    response = mvp.save(connection, payload)
                elif path == "rules":
                    response = analysis_api.rules()
                elif path == "analysis":
                    response = analysis_api.latest(connection, mvp.identifier(params.get("id")))
                elif path == "catalogue":
                    response = mvp.catalogue_analytics(connection, mvp.identifier(params.get("id")))
                elif path == "analyze":
                    response = analysis_api.run(connection, mvp.identifier(payload.get("id")), payload)
                elif path == "finding":
                    response = analysis_api.decide(connection, payload, self.remote_user())
                elif path == "original":
                    source_id = mvp.identifier(params.get("id"))
                    entry = connection.execute("SELECT filename FROM source_document WHERE id=%s", (source_id,)).fetchone()
                    if not entry:
                        raise ValueError("The original file was not found.")
                    suffix = Path(entry["filename"]).suffix.lstrip(".")
                    filename = f"original-{str(source_id)[:8]}" + (f".{suffix}" if suffix.isalnum() and suffix.isascii() else "")
                    connection.row_factory = psycopg.rows.tuple_row
                    content_type, response = "application/octet-stream", original(connection, source_id)
                else:
                    response = mvp.load_bom(connection, mvp.identifier(params.get("id")))
            if path == "export":
                filename, content_type, response = export(response, params.get("format"))
            if filename:
                self.send(HTTPStatus.OK, response, content_type, filename)
            else:
                self.json(HTTPStatus.OK, response)
        except mvp.Conflict as error:
            self.json(HTTPStatus.CONFLICT, {"error": str(error)})
        except (ValueError, TypeError) as error:
            self.json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
        except psycopg.Error as error:
            self.log_error("Workspace database request failed (%s)", type(error).__name__)
            message = "This draft is locked by an issued quote." if error.sqlstate == "23514" else "The database could not complete this action."
            self.json(HTTPStatus.UNPROCESSABLE_ENTITY, {"error": message})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as error:
            self.log_error("Workspace action failed (%s)", type(error).__name__)
            self.json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "This action could not be completed."})


if __name__ == "__main__":
    workspace_catalogue.start_workers()
    ThreadingHTTPServer.daemon_threads = True
    ThreadingHTTPServer(("0.0.0.0", PORT), BrowserHandler).serve_forever()
