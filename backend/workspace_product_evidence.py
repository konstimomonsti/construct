"""Attach validated, source-linked product declarations to an assessment snapshot."""

from hashlib import sha256
import json

from analysis.contracts import ImportWarning, ProductDeclaration, ProductRequirement, ProjectProfile

SCHEMA = "billbuild.product-evidence.v1"
DOCUMENTS = """
    FROM workspace_record d
    LEFT JOIN workspace_record l ON (l.workspace, l.collection, l.record_id) =
         (d.workspace, 'documentLinks', d.record_id)
    WHERE d.workspace=%s AND d.collection='userDocuments' AND d.value->>'productEvidence'='true'
"""
LIST_ID = "coalesce(l.value #>> '{}', d.value->>'listId')"


def affected_lists(connection, workspace, document_ids):
    if not document_ids:
        return set()
    rows = connection.execute(
        f"SELECT DISTINCT {LIST_ID} AS list_id {DOCUMENTS} AND d.record_id=ANY(%s)",
        (workspace, list(document_ids)),
    )
    return {row["list_id"] for row in rows if row["list_id"]}


def add_to_snapshot(connection, workspace, list_id, snapshot):
    rows = connection.execute(
        f"""
        SELECT d.record_id, d.value->>'name' AS filename,
               (SELECT CASE WHEN octet_length(f.content) <= 1048576 THEN f.content END
                FROM workspace_file f WHERE f.workspace=d.workspace AND f.file_id=d.record_id) AS content
        {DOCUMENTS} AND {LIST_ID}=%s
        ORDER BY d.record_id
        """, (workspace, list_id),
    )
    identifiers = []
    profiles = [snapshot.project.profile] if snapshot.project.profile else []
    for attachment in rows:
        document_id = attachment["record_id"]
        identifiers.append(document_id)
        content = bytes(attachment["content"] or b"")
        locator = {"file_id": document_id, "filename": attachment["filename"]}
        try:
            package = json.loads(content)
            if not isinstance(package, dict) or package.get("schema") != SCHEMA:
                raise ValueError("Unsupported product evidence schema")
            declarations = package.get("declarations", [])
            requirements = package.get("product_requirements", [])
            if any(not isinstance(entries, list) or len(entries) > 1000 for entries in (declarations, requirements)):
                raise ValueError("Invalid product evidence collections")
            items = [ProductDeclaration.model_validate(item) for item in declarations]
            rules = [ProductRequirement.model_validate(item) for item in requirements]
            profile = package.get("project_profile")
            if profile is not None:
                profiles.append(ProjectProfile.model_validate(profile))
        except (ValueError, TypeError, UnicodeError, RecursionError):
            snapshot.import_warnings.append(ImportWarning(
                code="PRODUCT_EVIDENCE_UNREADABLE", message="Review the attached product evidence file.", locator=locator,
            ))
            continue
        provenance = {"attachment_id": document_id, "attachment_sha256": sha256(content).hexdigest()}
        snapshot.declarations.extend(item.model_copy(update=provenance) for item in items)
        snapshot.product_requirements.extend(rule.model_copy(update=provenance) for rule in rules)
    if profiles and all(profile == profiles[0] for profile in profiles):
        snapshot.project.profile = profiles[0]
    elif profiles:
        standards = {identifier for profile in profiles for identifier in profile.standard_editions}
        snapshot.project.profile = ProjectProfile(standard_editions=dict.fromkeys(standards, "unresolved"))
        snapshot.import_warnings.append(ImportWarning(code="PROJECT_PROFILE_CONFLICT",
                                                       message="Resolve the project profiles before selecting a DIN edition."))
    return identifiers
