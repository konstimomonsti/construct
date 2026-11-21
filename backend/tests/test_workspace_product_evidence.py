"""Exercise a saved declaration through the normal workspace assessment worker."""

from hashlib import sha256
import json
import os
from pathlib import Path
from uuid import uuid4

import psycopg
from psycopg.rows import dict_row
import pytest

import workspace
import workspace_analysis

EXAMPLES = Path(__file__).resolve().parents[2] / "data" / "examples"
MATERIAL = "L1.PRODUCT.DIN_MATERIAL"


@pytest.mark.parametrize("bytes_first", [True, False])
@pytest.mark.skipif(not os.environ.get("CATALOGUE_TEST_DSN"), reason="Requires a disposable migrated PostgreSQL database")
def test_worker_rechecks_product_evidence_after_attach_replace_and_unlink(monkeypatch, bytes_first):
    monkeypatch.setenv("ANALYSIS_L3_PROVIDER", "none")
    identifier = uuid4().hex
    list_ids = [f"list-{identifier}-{i}" for i in (1, 2)]
    evidence_id = f"evidence-{identifier}"
    bom_file = EXAMPLES / "drainage-variant-bom.json"
    evidence = EXAMPLES / "drainage-variant-evidence.json"
    content = evidence.read_bytes()

    with psycopg.connect(os.environ["CATALOGUE_TEST_DSN"], autocommit=True, row_factory=dict_row) as connection:
        with connection.transaction(force_rollback=True):
            def apply(**changes):
                workspace.apply(connection, {"changes": changes})

            def get_report(list_id):
                for _ in range(20):
                    status = workspace_analysis.status(connection, workspace.WORKSPACE, list_id)
                    if status["state"] == "ready":
                        return status["report"]
                    assert status["state"] == "queued"
                    assert workspace_analysis.assess_next(connection)
                pytest.fail("Assessment did not finish")

            def material(report):
                return next((f for f in report["findings"] if f["rule_id"] == MATERIAL), None)

            for list_id in list_ids:
                document = {**json.loads(bom_file.read_text()), "fileName": bom_file.name, "source": {"kind": "json"}}
                apply(
                    userLists={"set": {list_id: document}},
                    userDocuments={"set": {f"bom-{list_id}": {"original": True, "name": bom_file.name, "listId": list_id}}},
                )
            missing = material(get_report(list_ids[0]))
            assert missing["evidence"]["outcome"] == "insufficient_evidence"
            if bytes_first:
                workspace.save_file(connection, evidence_id, "application/json", content)
            apply(userDocuments={"set": {evidence_id: {"name": evidence.name, "listId": list_ids[0], "productEvidence": True}}})
            if not bytes_first:
                unreadable = get_report(list_ids[0])
                assert any(f["evidence"].get("code") == "PRODUCT_EVIDENCE_UNREADABLE" for f in unreadable["findings"])
                workspace.save_file(connection, evidence_id, "application/json", content)
            report = get_report(list_ids[0])
            finding = material(report)
            assert report["product_evidence_files"] == [evidence_id]
            assert finding["evidence"]["outcome"] == "conflict"
            assert finding["id"] != missing["id"]
            assert finding["evidence"]["declarations"][0]["attachment_sha256"] == sha256(content).hexdigest()
            assert finding["evidence"]["declarations"][0]["attachment_id"] == evidence_id
            assert finding["suggested_fix"]["rationale"]
            diameter = next(f for f in report["findings"] if f["rule_id"] == "L1.PRODUCT.DECLARED_PROPERTY")
            assert diameter["evidence"]["requirement"]["attachment_sha256"] == sha256(content).hexdigest()

            apply(documentLinks={"set": {evidence_id: list_ids[1]}})
            assert get_report(list_ids[0])["product_evidence_files"] == []
            assert material(get_report(list_ids[1]))["evidence"]["outcome"] == "conflict"

            corrected = json.loads(content)
            corrected["declarations"][0]["properties"]["material"]["value"] = "PVC-U"
            workspace.save_file(connection, evidence_id, "application/json", json.dumps(corrected).encode())
            assert material(get_report(list_ids[1])) is None

            apply(userDocuments={"delete": [evidence_id]})
            report = get_report(list_ids[1])
            assert report["product_evidence_files"] == []
            assert material(report)["evidence"]["outcome"] == "insufficient_evidence"


@pytest.mark.skipif(not os.environ.get("CATALOGUE_TEST_DSN"), reason="Requires a disposable migrated PostgreSQL database")
def test_evidence_update_during_analysis_discards_the_stale_report(monkeypatch):
    key = f"test-{uuid4().hex}"
    monkeypatch.setattr(workspace, "WORKSPACE", key)
    monkeypatch.setenv("ANALYSIS_L3_PROVIDER", "none")
    bom = EXAMPLES / "drainage-variant-bom.json"
    package = EXAMPLES / "drainage-variant-evidence.json"
    document = {**json.loads(bom.read_text()), "fileName": bom.name, "source": {"kind": "json"}}
    with (
        psycopg.connect(os.environ["CATALOGUE_TEST_DSN"], autocommit=True, row_factory=dict_row) as worker,
        psycopg.connect(os.environ["CATALOGUE_TEST_DSN"], autocommit=True, row_factory=dict_row,
                        options="-c lock_timeout=1500") as writer,
    ):
        writer.execute("INSERT INTO workspace_sync (workspace) VALUES (%s)", (key,))
        try:
            workspace.save_file(writer, "evidence", "application/json", package.read_bytes())
            workspace.apply(writer, {"changes": {
                "userLists": {"set": {"bom": document}},
                "userDocuments": {"set": {
                    "original": {"name": bom.name, "listId": "bom", "original": True},
                    "evidence": {"name": package.name, "listId": "bom", "productEvidence": True},
                }},
            }})
            run = workspace_analysis.run

            def replace_after_read(*args, **kwargs):
                report = run(*args, **kwargs)
                assert any(f["rule_id"] == MATERIAL for f in report["findings"])
                corrected = json.loads(package.read_bytes())
                corrected["declarations"][0]["properties"]["material"]["value"] = "PVC-U"
                workspace.save_file(writer, "evidence", "application/json", json.dumps(corrected).encode())
                return report

            with monkeypatch.context() as patch:
                patch.setattr(workspace_analysis, "run", replace_after_read)
                assert workspace_analysis.assess_next(worker)
            assert workspace_analysis.status(worker, key, "bom") == {"state": "queued", "report": None}
            assert workspace_analysis.assess_next(worker)
            report = workspace_analysis.status(worker, key, "bom")["report"]
            assert all(f["rule_id"] != MATERIAL for f in report["findings"])
        finally:
            writer.execute("DELETE FROM workspace_sync WHERE workspace=%s", (key,))


@pytest.mark.skipif(not os.environ.get("CATALOGUE_TEST_DSN"), reason="Requires a disposable migrated PostgreSQL database")
def test_worker_resolves_conflicting_requirements_across_independent_attachments(monkeypatch):
    monkeypatch.setenv("ANALYSIS_L3_PROVIDER", "none")
    monkeypatch.setattr(workspace, "WORKSPACE", f"test-{uuid4().hex}")
    bom = EXAMPLES / "drainage-variant-bom.json"
    document = {**json.loads(bom.read_text()), "fileName": bom.name, "source": {"kind": "json"}}
    lower = json.loads((EXAMPLES / "drainage-variant-evidence.json").read_bytes())
    requirement, = lower["product_requirements"]
    requirement["comparison"] = "at_least"
    upper = {"schema": lower["schema"], "product_requirements": [
        {**requirement, "comparison": "at_most", "required": {"value": "15", "unit": "cm"},
         "document": "Synthetic installation schedule", "locator": "Schedule row 9"},
    ]}
    packages = {key: json.dumps(value).encode() for key, value in (("lower", lower), ("upper", upper))}

    with psycopg.connect(os.environ["CATALOGUE_TEST_DSN"], autocommit=True, row_factory=dict_row) as connection:
        with connection.transaction(force_rollback=True):
            connection.execute("INSERT INTO workspace_sync (workspace) VALUES (%s)", (workspace.WORKSPACE,))
            for key, data in packages.items():
                workspace.save_file(connection, key, "application/json", data)
            workspace.apply(connection, {"changes": {
                "userLists": {"set": {"bom": document}},
                "userDocuments": {"set": {
                    "original": {"name": bom.name, "listId": "bom", "original": True},
                    **{key: {"name": f"{key}.json", "listId": "bom", "productEvidence": True} for key in packages},
                }},
            }})

            assert workspace_analysis.assess_next(connection)
            report = workspace_analysis.status(connection, workspace.WORKSPACE, "bom")["report"]
            conflict, = [f for f in report["findings"] if f["rule_id"] == "L1.PRODUCT.REQUIREMENT_CONFLICT"]
            cited = {item["attachment_id"]: item["attachment_sha256"] for item in conflict["evidence"]["requirements"]}
            assert cited == {key: sha256(data).hexdigest() for key, data in packages.items()}
            assert all(f["rule_id"] != "L1.PRODUCT.DECLARED_PROPERTY" for f in report["findings"])

            workspace.apply(connection, {"changes": {"userDocuments": {"delete": ["upper"]}}})
            assert workspace_analysis.assess_next(connection)
            report = workspace_analysis.status(connection, workspace.WORKSPACE, "bom")["report"]
            assert all(f["rule_id"] != "L1.PRODUCT.REQUIREMENT_CONFLICT" for f in report["findings"])
            property_finding, = [f for f in report["findings"] if f["rule_id"] == "L1.PRODUCT.DECLARED_PROPERTY"]
            assert property_finding["evidence"]["outcome"] == "conflict"
