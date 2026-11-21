"""HTTP routing tests that need no database: frontend serving, admin routes, host and origin checks.

Run from the repository root:
    PYTHONPATH=backend:backend/importer python -m pytest backend/tests
"""

import http.client
import importlib
import json
import sys
import threading
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer
from uuid import UUID

import pytest


@pytest.fixture()
def server(tmp_path, monkeypatch):
    site = tmp_path / "site"
    (site / "assets").mkdir(parents=True)
    (site / "index.html").write_text("<h1>app</h1>")
    (site / "assets" / "app-1a2b.js").write_text("console.log(1)")
    (site / ".env").write_text("SECRET=1")
    (tmp_path / "outside.txt").write_text("outside")
    monkeypatch.setenv("FRONTEND_DIR", str(site))
    monkeypatch.setenv("ALLOWED_ORIGINS", "http://localhost:5173")
    monkeypatch.setenv("PGCONNECT_TIMEOUT", "1")
    monkeypatch.setenv("PGHOST", "127.0.0.1")
    monkeypatch.setenv("PGPORT", "1")  # nothing listens: database calls fail fast
    sys.modules.pop("server", None)
    module = importlib.import_module("server")
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), module.BrowserHandler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield module, httpd.server_address[1]
    httpd.shutdown()


def request(port, method, path, body=None, headers=None):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    connection.request(method, path, body=body, headers={"Host": f"localhost:{port}", **(headers or {})})
    response = connection.getresponse()
    return response.status, dict(response.getheaders()), response.read()


def test_frontend_files_and_spa_fallback(server):
    _, port = server
    status, headers, body = request(port, "GET", "/")
    assert status == 200 and body == b"<h1>app</h1>"
    assert "connect-src 'self'" in headers["Content-Security-Policy"]
    assert headers["Cache-Control"] == "no-cache"

    status, headers, _ = request(port, "GET", "/assets/app-1a2b.js")
    assert status == 200 and headers["Content-Type"].startswith("text/javascript")
    assert "immutable" in headers["Cache-Control"]

    status, _, body = request(port, "GET", "/bom/123?tab=findings")
    assert status == 200 and body == b"<h1>app</h1>"
    assert request(port, "GET", "/missing.js")[0] == 404


@pytest.mark.parametrize("path", ["/../outside.txt", "/%2e%2e/outside.txt", "/..%2foutside.txt", "/.env",
                                  "/assets/../../outside.txt", "/%00"])
def test_frontend_never_leaves_its_folder(server, path):
    _, port = server
    status, _, body = request(port, "GET", path)
    assert b"outside" not in body and b"SECRET" not in body
    assert status in {200, 404}


def test_reserved_paths_are_not_frontend_routes(server):
    _, port = server
    assert request(port, "GET", "/api/unknown")[0] == 404
    assert request(port, "GET", "/admin/unknown")[0] == 404
    status, headers, _ = request(port, "GET", "/admin")
    assert status == 302 and headers["Location"] == "/admin/tables"
    status, headers, body = request(port, "GET", "/admin/tables")
    assert status == 200 and b"<html" in body.lower()
    assert "'unsafe-inline'" not in headers["Content-Security-Policy"]
    status, headers, _ = request(port, "GET", "/admin/schema")
    assert status == 200 and "'unsafe-inline'" in headers["Content-Security-Policy"]


def test_health_reports_database_down(server):
    _, port = server
    status, _, body = request(port, "GET", "/healthz")
    assert status == 503 and json.loads(body)["status"] == "database unavailable"


def test_host_and_origin_checks(server):
    _, port = server
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    connection.request("GET", "/", headers={"Host": "evil.example"})
    assert connection.getresponse().status == 403

    body = json.dumps({"name": "x"})
    blocked = request(port, "POST", "/api/mvp/project", body, {"Origin": "http://evil.example",
                                                               "Content-Type": "application/json"})
    assert blocked[0] == 403
    # Same origin and ALLOWED_ORIGINS pass the origin check and reach the (unavailable) database.
    for origin in (f"http://localhost:{port}", "http://localhost:5173"):
        status, _, _ = request(port, "POST", "/api/mvp/project", body, {"Origin": origin,
                                                                        "Content-Type": "application/json"})
        assert status == 422


def test_unknown_api_action_and_bad_input(server):
    _, port = server
    assert request(port, "GET", "/api/mvp/nope")[0] == 404
    status, _, body = request(port, "GET", "/api/mvp/analysis?id=not-a-uuid")
    assert status in {400, 422}



def test_workspace_sync_routes(server):
    _, port = server
    assert request(port, "GET", "/api/workspace/nope")[0] == 404
    assert request(port, "POST", "/api/workspace/nope", "{}", {"Content-Type": "application/json"})[0] == 404
    assert request(port, "POST", "/api/workspace/state", "not json", {"Content-Type": "application/json"})[0] == 400
    assert request(port, "GET", "/api/workspace/state?since=abc")[0] == 400
    blocked = request(port, "POST", "/api/workspace/state", "{}", {"Origin": "http://evil.example"})
    assert blocked[0] == 403
    # Valid requests reach the (unavailable) database.
    assert request(port, "GET", "/api/workspace/state")[0] == 503


def test_workspace_rejects_unknown_collections():
    import workspace

    for payload in ({}, {"changes": {"secrets": {}}}, {"changes": {"edits": {"set": [], "delete": []}}},
                    {"changes": {"edits": {"set": {"": 1}}}}):
        with pytest.raises(ValueError):
            workspace.apply(None, payload)
    with pytest.raises(ValueError):
        workspace.file_id("../etc/passwd")


def test_workspace_accepts_calendar_collection():
    import workspace

    assert "calendar" in workspace.COLLECTIONS
    # validation passes the collection and reaches the record id check (no database needed)
    with pytest.raises(ValueError, match="Invalid record id"):
        workspace.apply(None, {"changes": {"calendar": {"set": {"": {"title": "x"}}}}})


def test_json_values(server):
    module, _ = server
    assert module.json_value(datetime(2026, 1, 2, 3, 4, tzinfo=timezone.utc)) == "2026-01-02T03:04:00+00:00"
    assert module.json_value(UUID(int=1)) == "00000000-0000-0000-0000-000000000001"
