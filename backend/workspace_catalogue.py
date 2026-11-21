"""Catalogue matches and independent web-research jobs for uploaded workspace positions."""

from collections import defaultdict
from decimal import Decimal, InvalidOperation
import json
import logging
from pathlib import PurePath
import re
from threading import Thread
import time
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from analysis.units import normalize

LOG = logging.getLogger(__name__)
WIKI = "https://de.wikipedia.org"
USER_AGENT = "BillBuild/1.0 (https://github.com/konstimomonsti/construct)"
STOP_WORDS = set("und der die das für mit von auf aus bis den dem des nach oder zum zur "
                 "liefern herstellen einbauen einschl inkl einschließlich gemäß sowie st mm cm dn".split())


def catalogue_list(value):
    return (isinstance(value, dict) and value.get("userCreated") and
            isinstance(value.get("source"), dict) and value["source"].get("kind") not in {None, "blank"} and
            isinstance(value.get("positions"), list) and bool(value["positions"]))


def enqueue(connection, workspace, ids):
    if ids:
        connection.execute(
            """
            INSERT INTO workspace_catalogue_run (workspace, list_id)
            SELECT workspace, record_id FROM workspace_record
            WHERE workspace = %s AND collection = 'userLists' AND record_id = ANY(%s)
            AND value->'source'->>'kind' IN ('gaeb-xml', 'gaeb90', 'pdf', 'docx', 'csv', 'xlsx', 'json')
            AND CASE WHEN jsonb_typeof(value->'positions') = 'array'
                THEN jsonb_array_length(value->'positions') > 0 ELSE false END
            ON CONFLICT (workspace, list_id) DO NOTHING
            """, (workspace, list(ids)),
        )


def workspace_changed(connection, workspace, writes):
    lists = {key for collection, key, value in writes if collection == "userLists" and catalogue_list(value)}
    pdfs = {key for collection, key, value in writes if
            (collection == "userDocuments" and isinstance(value, dict) and str(value.get("name", "")).lower().endswith(".pdf")) or
            collection == "documentLinks"}
    enqueue(connection, workspace, lists)
    if pdfs:
        # A companion can be uploaded after the offer, so reconsider the affected list.
        connection.execute(
            """
            UPDATE workspace_catalogue_run r SET state = 'queued'
            FROM workspace_record d
            LEFT JOIN workspace_record l ON (l.workspace, l.collection, l.record_id) =
                (d.workspace, 'documentLinks', d.record_id)
            JOIN workspace_record b ON (b.workspace, b.collection, b.record_id) =
                (d.workspace, 'userLists', coalesce(l.value #>> '{}', d.value->>'listId'))
            WHERE r.workspace=d.workspace AND r.list_id=b.record_id AND r.workspace=%s
            AND d.collection='userDocuments' AND d.record_id=ANY(%s)
            AND lower(b.value->>'fileName') LIKE '%%.d84'
            AND lower(d.value->>'name')=regexp_replace(lower(b.value->>'fileName'), '\\.d84$', '.pdf')
            """, (workspace, list(pdfs)),
        )


def status(connection, workspace, list_id, start=False, retry=False):
    document = connection.execute(
        """SELECT 1 FROM workspace_record WHERE workspace=%s AND collection='userLists' AND record_id=%s
           AND value->'source'->>'kind' IN ('gaeb-xml', 'gaeb90', 'pdf', 'docx', 'csv', 'xlsx', 'json')
           AND CASE WHEN jsonb_typeof(value->'positions') = 'array'
               THEN jsonb_array_length(value->'positions') > 0 ELSE false END""",
        (workspace, list_id),
    ).fetchone()
    if not document:
        raise LookupError("Uploaded list not found.")
    with connection.transaction():
        if start:
            enqueue(connection, workspace, {list_id})
        if retry:
            connection.execute(
                "UPDATE workspace_catalogue_run SET state='queued' WHERE workspace=%s AND list_id=%s AND state='failed'",
                (workspace, list_id),
            )
            connection.execute(
                """UPDATE workspace_catalogue_position SET state='queued', lease_until=NULL
                   WHERE workspace=%s AND list_id=%s AND state='failed'""",
                (workspace, list_id),
            )
        run = connection.execute(
            "SELECT state FROM workspace_catalogue_run WHERE workspace=%s AND list_id=%s",
            (workspace, list_id),
        ).fetchone()
        rows = connection.execute(
            """SELECT position_id, state, input->'recovered' AS recovered, product, suggestion
               FROM workspace_catalogue_position WHERE workspace=%s AND list_id=%s""", (workspace, list_id),
        ).fetchall()
    return {"state": run["state"] if run else "unstarted", "positions": {row.pop("position_id"): row for row in rows}}


def code(value):
    return ".".join(part.lstrip("0") or "0" for part in str(value or "").strip(".").split("."))


def words(value):
    return " ".join(re.findall(r"\w+", str(value or "").casefold()))


def tender_unit(value):
    if not isinstance(value, str):
        return None
    return normalize(value.casefold())


def source_links(connection, sha):
    indexed = defaultdict(list)
    if sha:
        for row in connection.execute(
            """
            SELECT DISTINCT c.source_line_code, c.decision, p.id, p.name, pc.name AS category
            FROM source_document d JOIN catalogue_source_line c ON c.source_document_id=d.id
            LEFT JOIN product p ON c.product_id=p.id AND p.archived_at IS NULL
            LEFT JOIN product_category pc ON p.category_id=pc.id
            WHERE d.sha256=%s AND c.source_kind <> 'price' AND c.source_line_code IS NOT NULL
            """, (sha,),
        ):
            indexed[code(row["source_line_code"])].append(row)
    return indexed


def catalogue_names(connection):
    indexed = defaultdict(list)
    for row in connection.execute(
        """SELECT p.id, p.name, p.description, p.unit_code, pc.name AS category,
            array(SELECT DISTINCT c.tender_unit FROM catalogue_source_line c
                  WHERE c.product_id=p.id AND c.tender_unit IS NOT NULL) AS tender_units
           FROM product p JOIN product_category pc ON pc.id=p.category_id
           WHERE p.archived_at IS NULL"""
    ):
        indexed[words(row["name"])].append(row)
    return indexed


def workspace_documents(connection, workspace, list_id):
    return connection.execute(
        """
        SELECT d.record_id, d.value, encode(sha256(f.content), 'hex') AS sha
        FROM workspace_record d
        LEFT JOIN workspace_record l ON (l.workspace, l.collection, l.record_id)=
            (d.workspace, 'documentLinks', d.record_id)
        LEFT JOIN workspace_file f ON (f.workspace, f.file_id)=(d.workspace, d.record_id)
        WHERE d.workspace=%s AND d.collection='userDocuments'
          AND coalesce(l.value #>> '{}', d.value->>'listId')=%s
        ORDER BY d.record_id
        """, (workspace, list_id),
    ).fetchall()


def original_content(connection, workspace, original):
    if not original or not original["sha"]:
        return None
    data = connection.execute(
        "SELECT content FROM workspace_file WHERE workspace=%s AND file_id=%s",
        (workspace, original["record_id"]),
    ).fetchone()
    return bytes(data["content"]) if data else None


def offer_source_texts(data):
    if not data:
        return {}
    from tender_import.legacy import gaeb_1990
    return {
        code(record.payload["code"]): record.payload
        for record in gaeb_1990(data).records
        if record.kind == "item" and record.payload.get("code")
    }


def seeded_offer_hash(connection, filename, sha, data):
    if not data or connection.execute("SELECT 1 FROM source_document WHERE sha256=%s LIMIT 1", (sha,)).fetchone():
        return sha
    # GAEB 90 records are identical when a transfer converts CRLF to LF. Preserve the real original for export.
    records = data.replace(b"\r\n", b"\n")
    for row in connection.execute(
        """SELECT d.sha256, f.content FROM source_document d JOIN source_file f ON f.source_document_id=d.id
           WHERE lower(d.filename)=%s AND d.format='gaeb_1990' ORDER BY d.sha256""", (filename.casefold(),),
    ):
        if bytes(row["content"]).replace(b"\r\n", b"\n") == records:
            return row["sha256"]
    return sha


def companion_descriptions(connection, workspace, documents, filename, sha):
    """Use a linked same-name printout, or the seeded printout paired with the exact offer bytes."""
    companion_name = PurePath(filename).with_suffix(".pdf").name.casefold()
    attached = [d for d in documents if d["sha"] and str(d["value"].get("name")).casefold() == companion_name]
    result = []
    if len(attached) == 1:
        from tender_import.pdf import pdf
        data = connection.execute(
            "SELECT content FROM workspace_file WHERE workspace=%s AND file_id=%s",
            (workspace, attached[0]["record_id"]),
        ).fetchone()
        if data:
            try:
                result = [record.payload for record in pdf(bytes(data["content"])).records
                          if record.kind == "item_candidate"]
            except (OSError, ValueError, TimeoutError):
                LOG.warning("Could not read a companion offer PDF")
    elif not attached and sha:
        result = [row["payload"] for row in connection.execute(
            """
            SELECT e.payload FROM source_extract e WHERE e.kind='item_candidate' AND e.import_id=(
                SELECT i.id FROM source_document d JOIN source_document companion ON companion.project_id=d.project_id
                JOIN source_import i ON i.source_document_id=companion.id
                WHERE d.sha256=%s AND lower(companion.filename)=%s AND companion.format='pdf'
                ORDER BY i.imported_at DESC, i.id LIMIT 1
            )
            """, (sha, companion_name),
        )]
    descriptions = defaultdict(list)
    for record in result:
        if record.get("code") and record.get("short_description"):
            descriptions[code(record["code"])].append(record)
    return {key: rows[0] for key, rows in descriptions.items() if len(rows) == 1}


def compatible_companion(position, companion):
    if not companion or tender_unit(position.get("unit")) != tender_unit(companion.get("unit")):
        return False
    try:
        return Decimal(str(position.get("qty"))) == Decimal(str(companion.get("quantity")))
    except InvalidOperation:
        return False


def product_summary(row):
    return {"id": str(row["id"]), "name": row["name"], "category": row["category"]}


def clean_description(value):
    return str(value or "").strip() if value != "(ohne Kurztext)" else ""


def position_match(position, rows, names):
    products = {row["id"]: row for row in rows if row["id"]}
    if len(products) == 1 and all(row["id"] in products for row in rows):
        return "matched", product_summary(next(iter(products.values())))
    if rows and all(row["decision"] in {"activity", "heading"} for row in rows):
        return "activity", None
    unit = tender_unit(position.get("unit"))
    long_text = words(position.get("long"))
    title = words(position.get("short"))
    candidates = [
        row for row in names.get(title, [])
        if unit and unit in {tender_unit(value) for value in [row["unit_code"], *row["tender_units"]]}
        and (not long_text or long_text == title or long_text == words(row["description"]))
    ]
    if len(candidates) == 1:
        return "matched", product_summary(candidates[0])
    return ("queued" if title else "needs_description"), None


def classify(connection, workspace, list_id):
    value = connection.execute(
        "SELECT value FROM workspace_record WHERE workspace=%s AND collection='userLists' AND record_id=%s",
        (workspace, list_id),
    ).fetchone()["value"]
    documents = workspace_documents(connection, workspace, list_id)
    filename = str(value.get("fileName") or "")
    original = next((d for d in documents if d["value"].get("original") and d["value"].get("name") == filename), None)
    sha = original["sha"] if original else None
    is_offer = filename.lower().endswith(".d84")
    offer_bytes = original_content(connection, workspace, original) if is_offer else None
    if offer_bytes:
        sha = seeded_offer_hash(connection, filename, sha, offer_bytes)
    links = source_links(connection, sha)
    names = catalogue_names(connection)
    offer_texts = offer_source_texts(offer_bytes)
    descriptions = companion_descriptions(connection, workspace, documents, filename, sha) if is_offer else {}
    records = []
    for position in value["positions"]:
        if not isinstance(position, dict) or not isinstance(position.get("id"), str):
            continue
        key = code(position.get("oz"))
        short, long_text = (clean_description(position.get(field)) for field in ("short", "long"))
        source_text = offer_texts.get(key)
        if source_text:
            short, long_text = (clean_description(source_text.get(field))
                                for field in ("short_description", "long_description"))
        companion = descriptions.get(key)
        used_pdf = compatible_companion(position, companion) and (not short or not long_text)
        if used_pdf:
            short = short or companion["short_description"]
            long_text = long_text or companion.get("long_description") or short
        if not short and long_text:
            short = next((line.strip() for line in long_text.splitlines() if line.strip()), "")[:110]
        recovered = None
        if is_offer and (short, long_text) != (position.get("short") or "", position.get("long") or ""):
            recovered = {"short": short[:4000], "long": long_text[:12000], "source": "Companion offer PDF" if used_pdf else None}
        candidate = {**position, "short": short, "long": long_text}
        state, product = position_match(candidate, links.get(key, []), names)
        job = {"name": short[:400], "unit": str(position.get("unit") or "")[:30], "recovered": recovered}
        records.append((workspace, list_id, position["id"], state, Jsonb(job), Jsonb(product) if product else None))
    with connection.cursor() as cursor:
        cursor.executemany(
            """
            INSERT INTO workspace_catalogue_position (workspace,list_id,position_id,state,input,product)
            VALUES (%s,%s,%s,%s,%s,%s)
            ON CONFLICT (workspace,list_id,position_id) DO UPDATE SET state=excluded.state,
                input=excluded.input, product=excluded.product, suggestion=NULL, lease_until=NULL
            WHERE workspace_catalogue_position.input IS DISTINCT FROM excluded.input
               OR workspace_catalogue_position.product IS DISTINCT FROM excluded.product
            """, records,
        )
    connection.execute(
        "UPDATE workspace_catalogue_run SET state='ready' WHERE workspace=%s AND list_id=%s", (workspace, list_id),
    )


def keywords(name):
    name = re.sub(r"\[[^\]]*\]|\S+@\S+|https?://\S+", "", name)
    return [word for word in re.findall(r"[^\W\d_]{3,}", name.casefold()) if word not in STOP_WORDS][:8]


def wiki_json(path):
    request = Request(WIKI + path, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urlopen(request, timeout=8) as response:
        return json.loads(response.read(256 * 1024))


def research(name):
    """A job can refine its search once. Report only cited public evidence with title overlap."""
    terms = keywords(name)
    if not terms:
        return None
    queries = dict.fromkeys((" ".join(terms[:6]), max(terms, key=len)))
    for query in queries:
        pages = wiki_json("/w/rest.php/v1/search/page?" + urlencode({"q": query, "limit": 5}))["pages"]
        for page in pages:
            title_tokens = keywords(page["title"])
            if not any(term == token or (min(len(term), len(token)) >= 6 and
                       (term.startswith(token) or token.startswith(term))) for term in terms for token in title_tokens):
                continue
            article = quote(page["key"], safe="")
            summary = wiki_json(f"/api/rest_v1/page/summary/{article}")
            if summary.get("type") == "standard" and summary.get("extract"):
                extract = summary["extract"].split()
                note = " ".join(extract[:25]) + ("…" if len(extract) > 25 else "")
                return {"name": page["title"], "description": note,
                        "url": f"{WIKI}/wiki/{article}", "source": "Wikipedia"}
            break
    return None


def classify_next(connection):
    with connection.transaction():
        task = connection.execute(
            """SELECT workspace, list_id FROM workspace_catalogue_run WHERE state='queued'
               ORDER BY workspace, list_id LIMIT 1 FOR UPDATE SKIP LOCKED"""
        ).fetchone()
        if not task:
            return False
        try:
            with connection.transaction():
                classify(connection, task["workspace"], task["list_id"])
        except Exception:
            LOG.exception("Could not match an uploaded list to the catalogue")
            connection.execute(
                "UPDATE workspace_catalogue_run SET state='failed' WHERE workspace=%s AND list_id=%s",
                (task["workspace"], task["list_id"]),
            )
        return True


def research_next(connection):
    task = connection.execute(
        """
        WITH next AS (
            SELECT workspace, list_id, position_id FROM workspace_catalogue_position
            WHERE state='queued' OR (state='researching' AND lease_until < now())
            ORDER BY attempts, workspace, list_id, position_id LIMIT 1 FOR UPDATE SKIP LOCKED
        )
        UPDATE workspace_catalogue_position p SET state='researching',
            lease_until=now() + interval '45 seconds', attempts=p.attempts + 1
        FROM next WHERE (p.workspace,p.list_id,p.position_id)=(next.workspace,next.list_id,next.position_id)
        RETURNING p.workspace,p.list_id,p.position_id,p.input,p.attempts
        """
    ).fetchone()
    if not task:
        return False
    try:
        result = research(task["input"]["name"])
        state = "suggested" if result else "no_evidence"
    except (OSError, ValueError, KeyError, TypeError) as error:
        LOG.warning("Product web search failed (%s)", type(error).__name__)
        state, result = "failed", None
    connection.execute(
        """
        UPDATE workspace_catalogue_position SET state=%s, suggestion=%s, lease_until=NULL
        WHERE (workspace,list_id,position_id,attempts)=(%s,%s,%s,%s) AND state='researching'
        """, (state, Jsonb(result) if result else None, task["workspace"], task["list_id"], task["position_id"], task["attempts"]),
    )
    return True


def worker(operation):
    while True:
        try:
            with psycopg.connect("", autocommit=True, row_factory=dict_row,
                                 connect_timeout=4, options="-c statement_timeout=30000") as connection:
                while True:
                    if not operation(connection):
                        time.sleep(1)
        except psycopg.Error as error:
            LOG.warning("Catalogue worker waiting for the database (%s)", type(error).__name__)
            time.sleep(4)


def start_workers():
    Thread(target=worker, args=(classify_next,), name="workspace-catalogue", daemon=True).start()
    for _ in range(3):
        Thread(target=worker, args=(research_next,), name="product-research", daemon=True).start()
