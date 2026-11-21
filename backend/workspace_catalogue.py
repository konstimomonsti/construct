"""Catalogue matches and independent web-research jobs for uploaded workspace positions."""

from collections import defaultdict
from decimal import Decimal, InvalidOperation
import json
import logging
import os
from pathlib import PurePath
import re
from threading import Thread
import time
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

import psycopg
from lxml.etree import XMLSyntaxError
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from analysis.layer3.provider import ProviderError, ProviderUnavailable
from workspace_product_ai import adjudicate, catalogue_check, companion_check, configured_model, catalogue_provider
from workspace_product_companions import catalogue_matches, position_number
from workspace_product_match import ProductMatcher, clean_description, clipped_description, tender_unit
from workspace_product_references import PositionReferences

LOG = logging.getLogger(__name__)
WIKI = "https://de.wikipedia.org"
USER_AGENT = "BillBuild/1.0 (https://github.com/konstimomonsti/construct)"
STOP_WORDS = set("und der die das für mit von auf aus bis den dem des nach oder zum zur "
                 "liefern herstellen einbauen einschl inkl einschließlich gemäß sowie st mm cm dn".split())


def web_research_enabled():
    return os.environ.get("BILLBUILD_WEB_RESEARCH", "1") == "1"


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


SIBLING_KINDS = ("pdf", "gaeb90", "gaeb-xml", "docx")


def project_folders(connection, workspace, list_ids):
    if not list_ids:
        return set()
    rows = connection.execute(
        """SELECT coalesce(p.value->>'folderId', b.value->>'folderId') AS folder_id
           FROM workspace_record b LEFT JOIN workspace_record p
             ON (p.workspace, p.collection, p.record_id)=(b.workspace, 'listPatch', b.record_id)
           WHERE b.workspace=%s AND b.collection='userLists' AND b.record_id=ANY(%s)
             AND b.value->'source'->>'kind'=ANY(%s)""", (workspace, list(list_ids), list(SIBLING_KINDS)),
    )
    return {row["folder_id"] for row in rows if row["folder_id"]}


def requeue_project(connection, workspace, folders):
    if folders:
        connection.execute(
            """UPDATE workspace_catalogue_run r SET state='queued'
               FROM workspace_record b LEFT JOIN workspace_record p
                 ON (p.workspace, p.collection, p.record_id)=(b.workspace, 'listPatch', b.record_id)
               WHERE r.workspace=%s AND b.workspace=r.workspace AND b.collection='userLists'
                 AND b.record_id=r.list_id AND b.value->'source'->>'kind'=ANY(%s)
                 AND coalesce(p.value->>'folderId', b.value->>'folderId')=ANY(%s)""",
            (workspace, list(SIBLING_KINDS), list(folders)),
        )


def workspace_changed(connection, workspace, writes, old_folders=()):
    lists = {key for collection, key, value in writes if collection == "userLists" and catalogue_list(value)}
    pdfs = {key for collection, key, value in writes if
            (collection == "userDocuments" and isinstance(value, dict) and str(value.get("name", "")).lower().endswith(".pdf")) or
            collection == "documentLinks"}
    enqueue(connection, workspace, lists)
    if configured_model():
        changed = lists | {key for collection, key, _ in writes if collection == "listPatch"}
        requeue_project(connection, workspace, set(old_folders) | project_folders(connection, workspace, changed))
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
            """SELECT position_id, state, input->'recovered' AS recovered, product, suggestion,
                      input ? 'model_check' AS model_review
               FROM workspace_catalogue_position WHERE workspace=%s AND list_id=%s""", (workspace, list_id),
        ).fetchall()
    research = web_research_enabled()
    model = configured_model()
    for row in rows:
        if not research and not (model and row["model_review"]) and row["state"] in {"queued", "researching"}:
            row["state"] = "research_disabled"
    return {"state": run["state"] if run else "unstarted", "positions": {row.pop("position_id"): row for row in rows},
            "web_research": research}


def code(value):
    return ".".join(part.lstrip("0") or "0" for part in str(value or "").strip(".").split("."))


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


def catalogue_products(connection):
    return connection.execute(
        """SELECT p.id, p.name, p.description, p.unit_code, pc.name AS category,
            array(SELECT DISTINCT c.tender_unit FROM catalogue_source_line c
                  WHERE c.product_id=p.id AND c.tender_unit IS NOT NULL) AS tender_units
           FROM product p JOIN product_category pc ON pc.id=p.category_id
           WHERE p.archived_at IS NULL"""
    )


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


def legacy_source_texts(data):
    if not data:
        return {}
    from tender_import.legacy import gaeb_1990
    indexed = defaultdict(list)
    for record in gaeb_1990(data).records:
        if record.kind == "item" and record.payload.get("code"):
            indexed[code(record.payload["code"])].append(record.payload)
    return {key: items[0] for key, items in indexed.items() if len(items) == 1}


def xml_source_texts(data):
    if not data:
        return {}
    from tender_import.structured import gaeb_xml
    indexed = defaultdict(list)
    for record in gaeb_xml(data).records:
        if record.kind == "item" and (source_id := record.payload.get("source_id")):
            indexed[source_id].append(record.payload)
    return {source_id: items[0] for source_id, items in indexed.items() if len(items) == 1}


def restored_xml_description(position, visible, record):
    if not clipped_description(visible) or not compatible_companion(position, record):
        return visible
    full = clean_description(record.get("long_description"))
    if code(record["code"]) == code(position.get("oz")) and len(visible) < len(full) <= 12000:
        return full
    return visible


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


def position_match(position, rows, matcher):
    products = {row["id"]: row for row in rows if row["id"]}
    if len(products) == 1 and all(row["id"] in products for row in rows):
        return "matched", product_summary(next(iter(products.values())))
    if rows and all(row["decision"] in {"activity", "heading"} for row in rows):
        return "activity", None
    if product := matcher.match(position):
        return "matched", product_summary(product)
    title = clean_description(position.get("short"))
    return ("queued" if re.search(r"\w", title) else "needs_description"), None


def sibling_positions(connection, workspace, list_id):
    rows = connection.execute(
        """SELECT b.value->'positions' AS positions
           FROM workspace_record own
           LEFT JOIN workspace_record own_patch
             ON (own_patch.workspace, own_patch.collection, own_patch.record_id)=
                (own.workspace, 'listPatch', own.record_id)
           JOIN workspace_record b ON b.workspace=own.workspace AND b.collection='userLists'
             AND b.record_id<>own.record_id
           LEFT JOIN workspace_record p
             ON (p.workspace, p.collection, p.record_id)=(b.workspace, 'listPatch', b.record_id)
           WHERE own.workspace=%s AND own.collection='userLists' AND own.record_id=%s
             AND own.value->'source'->>'kind'=ANY(%s) AND b.value->'source'->>'kind'=ANY(%s)
             AND own_patch.value->>'trashedAt' IS NULL AND p.value->>'trashedAt' IS NULL
             AND coalesce(own_patch.value->>'folderId', own.value->>'folderId') =
                 coalesce(p.value->>'folderId', b.value->>'folderId')
             AND nullif(coalesce(b.value->>'folderId', p.value->>'folderId'), '') IS NOT NULL
             AND jsonb_typeof(b.value->'positions')='array'""",
        (workspace, list_id, list(SIBLING_KINDS), list(SIBLING_KINDS)),
    )
    return (row["positions"] for row in rows)


def classify(connection, workspace, list_id):
    value = connection.execute(
        "SELECT value FROM workspace_record WHERE workspace=%s AND collection='userLists' AND record_id=%s",
        (workspace, list_id),
    ).fetchone()["value"]
    documents = workspace_documents(connection, workspace, list_id)
    filename = str(value.get("fileName") or "")
    original = next((d for d in documents if d["value"].get("original") and d["value"].get("name") == filename), None)
    sha = original["sha"] if original else None
    extension = PurePath(filename).suffix.casefold()
    is_offer = extension == ".d84"
    legacy_bytes = original_content(connection, workspace, original) if extension in {".d83", ".d84", ".d86"} else None
    if is_offer and legacy_bytes:
        sha = seeded_offer_hash(connection, filename, sha, legacy_bytes)
    links = source_links(connection, sha)
    matcher = ProductMatcher(catalogue_products(connection))
    try:
        legacy_texts = legacy_source_texts(legacy_bytes)
    except ValueError:
        LOG.warning("Could not recover GAEB 90 descriptions from the original file")
        legacy_texts = {}
    xml_texts = {}
    if value.get("source", {}).get("kind") == "gaeb-xml" and any(
            isinstance(row, dict) and isinstance(row.get("srcRef"), str)
            and clipped_description(clean_description(row.get("long")))
            for row in value["positions"]):
        try:
            xml_texts = xml_source_texts(original_content(connection, workspace, original))
        except (ValueError, XMLSyntaxError):
            LOG.warning("Could not recover clipped descriptions from the original GAEB XML")
    descriptions = companion_descriptions(connection, workspace, documents, filename, sha) if is_offer else {}
    records = []
    prepared = []
    model = configured_model()
    references = PositionReferences()
    for position in value["positions"]:
        if not isinstance(position, dict) or not isinstance(position.get("id"), str):
            continue
        key = code(position.get("oz"))
        short, long_text = (clean_description(position.get(field)) for field in ("short", "long"))
        source_text = legacy_texts.get(key)
        if source_text:
            source_short = clean_description(source_text.get("short_description"))
            source_long = clean_description(source_text.get("long_description"))
            if is_offer or source_short or source_long:
                short, long_text = source_short, source_long
        if xml_texts and isinstance(source_id := position.get("srcRef"), str):
            long_text = restored_xml_description(position, long_text, xml_texts.get(source_id))
        companion = descriptions.get(key)
        # Some priced GAEB offers carry a blank bidder field instead of a description.
        has_short = bool(re.search(r"\w", short))
        has_long = bool(re.search(r"\w", long_text))
        used_pdf = compatible_companion(position, companion) and (not has_short or not has_long)
        if used_pdf:
            short = short if has_short else companion["short_description"]
            long_text = long_text if has_long else companion.get("long_description") or short
        if not short and long_text:
            short = next((line.strip() for line in long_text.splitlines() if line.strip()), "")[:110]
        recovered = None
        if is_offer and (short, long_text) != (position.get("short") or "", position.get("long") or ""):
            recovered = {"short": short[:4000], "long": long_text[:12000], "source": "Companion offer PDF" if used_pdf else None}
        candidate = {**position, "short": short, "long": long_text}
        resolved = references.resolve(candidate)
        state, product = position_match(resolved, links.get(key, []), matcher)
        job = {"name": short[:400], "unit": str(position.get("unit") or "")[:30], "recovered": recovered}
        prepared.append((candidate, resolved, state, product, job))
    companions = {}
    if model and any(state in {"queued", "needs_description"} for _, _, state, _, _ in prepared):
        companions = catalogue_matches([row[0] for row in prepared], sibling_positions(connection, workspace, list_id), matcher)
    for candidate, resolved, state, product, job in prepared:
        if model and state in {"queued", "needs_description"}:
            if evidence := companions.get(position_number(candidate)):
                job["model_check"] = companion_check(resolved, evidence)
            elif review_item := matcher.review_candidate(resolved):
                job["model_check"] = catalogue_check(resolved, review_item)
            if "model_check" in job:
                job["model_id"] = model
                state = "queued"
        records.append((workspace, list_id, candidate["id"], state, Jsonb(job), Jsonb(product) if product else None))
    with connection.cursor() as cursor:
        cursor.executemany(
            """
            INSERT INTO workspace_catalogue_position (workspace,list_id,position_id,state,input,product)
            VALUES (%s,%s,%s,%s,%s,%s)
            ON CONFLICT (workspace,list_id,position_id) DO UPDATE SET state=excluded.state,
                input=excluded.input, product=excluded.product, suggestion=NULL, lease_until=NULL
            WHERE workspace_catalogue_position.input IS DISTINCT FROM excluded.input
               OR (workspace_catalogue_position.product IS DISTINCT FROM excluded.product
                   AND (excluded.product IS NOT NULL OR NOT (excluded.input ? 'model_check')))
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
    web, model = web_research_enabled(), configured_model()
    task = connection.execute(
        """
        WITH next AS (
            SELECT workspace, list_id, position_id FROM workspace_catalogue_position
            WHERE (state='queued' OR (state='researching' AND lease_until < now()))
              AND (%s OR (%s AND input ? 'model_check'))
            ORDER BY (%s AND input ? 'model_check') DESC, attempts, workspace, list_id, position_id
            LIMIT 1 FOR UPDATE SKIP LOCKED
        )
        UPDATE workspace_catalogue_position p SET state='researching',
            lease_until=now() + CASE WHEN p.input ? 'model_check' THEN interval '90 seconds'
                                     ELSE interval '45 seconds' END, attempts=p.attempts + 1
        FROM next WHERE (p.workspace,p.list_id,p.position_id)=(next.workspace,next.list_id,next.position_id)
        RETURNING p.workspace,p.list_id,p.position_id,p.input,p.attempts
        """, (web, model is not None, model is not None),
    ).fetchone()
    if not task:
        return False
    result, product = None, None
    state = "no_evidence"
    try:
        if model and (check := task["input"].get("model_check")):
            proposed, = adjudicate(catalogue_provider(), [check], repair_quotes=True)
            if proposed and connection.execute(
                "SELECT 1 FROM product WHERE id=%s AND archived_at IS NULL", (proposed["id"],),
            ).fetchone():
                state, product = "matched", proposed
        if product is None and web and task["input"]["name"]:
            result = research(task["input"]["name"])
            state = "suggested" if result else "no_evidence"
    except (ProviderError, ProviderUnavailable, OSError, ValueError, KeyError, TypeError) as error:
        LOG.warning("Product research failed (%s)", type(error).__name__)
        state, result, product = "failed", None, None
    connection.execute(
        """
        UPDATE workspace_catalogue_position SET state=%s, suggestion=%s, product=%s, lease_until=NULL
        WHERE (workspace,list_id,position_id,attempts)=(%s,%s,%s,%s) AND state='researching'
        """, (state, Jsonb(result) if result else None, Jsonb(product) if product else None,
              task["workspace"], task["list_id"], task["position_id"], task["attempts"]),
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
    if web_research_enabled() or configured_model():
        for _ in range(3):
            Thread(target=worker, args=(research_next,), name="product-research", daemon=True).start()
