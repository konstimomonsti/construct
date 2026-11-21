from io import BytesIO
from pathlib import PurePosixPath
from zipfile import ZipFile

from .common import PARSER_VERSION, Result, checked_entries, detect_format, read_member, zip_metadata
from .legacy import gaeb_1990
from .pdf import pdf
from .spreadsheet import excel
from .structured import docx, gaeb_xml


def ingest(connection, project_id, name, content, *, legacy_encoding=None, depth=0):
    from .store import find_import, save_result, store_upload, summarize

    document_format = detect_format(name, content)
    parser_version = PARSER_VERSION
    if legacy_encoding is not None and document_format in {"gaeb_1990", "zip"}:
        parser_version = f"{PARSER_VERSION}+{legacy_encoding}"
    document_id, checksum = store_upload(connection, project_id, name, content, document_format)
    existing = find_import(connection, document_id, parser_version)
    if existing and existing[1] != "failed" and not existing[2].get("failed_members", 0):
        cached = summarize(existing[0], document_id, checksum, name, existing[1], existing[2])
        if document_format == "zip":
            cached["members"] = existing[2].get("members", [])
        return {**cached, "cached": True}

    failed = False
    if document_format == "zip" and depth <= 1:
        result = import_archive(connection, project_id, content, legacy_encoding, depth)
        failed = result.metadata.get("failed_archive", False)
    else:
        try:
            result = parse_document(document_format, content, legacy_encoding)
        except Exception as exc:
            # Parsing is isolated from persistence. Database errors must remain visible to the caller.
            failed = True
            result = Result(document_format)
            result.warn("parse_failed", {"part": "document"}, f"{type(exc).__name__}: {exc}")
    summary = save_result(connection, document_id, checksum, name, result, parser_version, failed=failed)
    if document_format == "zip":
        summary["members"] = result.metadata.get("members", [])
    return summary


def parse_document(document_format, data, legacy_encoding=None):
    if document_format == "gaeb_xml":
        return gaeb_xml(data)
    if document_format == "gaeb_1990":
        return gaeb_1990(data, encoding_override=legacy_encoding)
    if document_format == "pdf":
        return pdf(data)
    if document_format in {"xls", "xlsx", "csv"}:
        return excel(data, document_format)
    if document_format == "docx":
        return docx(data)
    raise ValueError(f"Unsupported file type or nesting limit: {document_format}")


def import_archive(connection, project_id, content, legacy_encoding, depth):
    result = Result("zip")
    try:
        archive = ZipFile(BytesIO(content))
    except Exception as exc:
        result.warn("archive_open_failed", {"part": "archive"}, str(exc))
        result.metadata["failed_archive"] = True
        return result

    with archive:
        try:
            entries = checked_entries(archive)
        except ValueError as exc:
            result.warn("archive_limits", {"part": "archive"}, str(exc))
            result.metadata["failed_archive"] = True
            return result
        summaries = []
        failed = 0
        for number, entry in enumerate(entries, 1):
            locator = {"entry": number, "path": entry.filename}
            if entry.is_dir():
                result.add("archive_member", locator, **zip_metadata(entry))
                continue
            try:
                data = read_member(archive, entry)
            except Exception as exc:
                result.add("archive_member", locator, **zip_metadata(entry), error=str(exc))
                result.warn("archive_member_failed", locator, str(exc))
                failed += 1
                continue
            summary = ingest(connection, project_id, PurePosixPath(entry.filename).name, data,
                             legacy_encoding=legacy_encoding, depth=depth + 1)
            result.add("archive_member", locator, **zip_metadata(entry, data),
                       document_id=summary["document_id"], import_id=summary["import_id"], status=summary["status"])
            summaries.append({"path": entry.filename, **summary})
            if summary["status"] == "failed" or summary.get("failed_members", 0):
                failed += 1
        review_members = sum(member["status"] == "review" for member in summaries)
        result.needs_review |= review_members > 0
        result.metadata.update(members=summaries, failed_members=failed, review_members=review_members)
        if failed:
            result.warn("archive_members_need_retry", {"part": "archive"}, f"{failed} member imports failed")
    return result
