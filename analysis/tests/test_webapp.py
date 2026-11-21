"""Web UI API: analysis response, decisions, bulk decisions, questions, export, store."""

import io
import json
import threading
import zipfile

import pytest

pytest.importorskip("httpx")
pytest.importorskip("multipart")
from fastapi.testclient import TestClient  # noqa: E402

from analysis.tests import sample_boq  # noqa: E402
from webapp import app as webapp  # noqa: E402
from webapp import decisions as decision_lib  # noqa: E402
from webapp import risk_fallback  # noqa: E402


@pytest.fixture()
def client(tmp_path, monkeypatch):
    """A client whose decision store is a temp dir and whose analysis cache is empty."""
    monkeypatch.setattr(webapp, "decision_store", decision_lib.JsonDecisionStore(tmp_path / "decisions"))
    monkeypatch.setattr(webapp, "_cache", webapp.OrderedDict())
    return TestClient(webapp.app)


def analyze(client, data=None, name="tender.X83"):
    res = client.post("/api/analyze", files={"file": (name, data or sample_boq.tender_xml())})
    assert res.status_code == 200, res.text
    return res.json()["boqs"][0]


def by_rule(boq, rule_id):
    return next(f for f in boq["result"]["findings"] if f["rule_id"] == rule_id)


# ---------------------------------------------------------------- analysis response

def test_response_carries_doc_key_risk_and_decision_fields(client):
    boq = analyze(client)
    sha, index = boq["doc_key"].split(":")
    assert len(sha) == 64 and index == "0"
    assert boq["decisions"] == {} and boq["orphaned_decisions"] == [] and boq["tender"] is True
    risk = boq["risk"]
    assert risk["priced"] is False and 0 <= risk["score"] <= 100
    assert risk["counts"]["findings"] == len(boq["result"]["findings"])
    assert {"lines", "by_section", "by_category", "signals"} <= risk.keys()
    assert all(f["status"] == "open" for f in boq["result"]["findings"])
    # The provisional item is the one change-order signal the fallback knows today.
    assert [s["rule_id"] for s in risk["signals"]] == ["L1.STRUCT.PROVISIONAL_ITEM"]


def test_priced_bid_is_ranked_by_money(client):
    boq = analyze(client, sample_boq.bid_xml(), "bid.X84")
    risk = boq["risk"]
    assert risk["priced"] is True and risk["net_total"] == pytest.approx(2600.0)
    assert risk["money_at_stake"] > 0
    evs = [r["ev"] for r in risk["lines"]]
    assert evs == sorted(evs, reverse=True)


def test_only_top_50_positions_are_sent(client, monkeypatch):
    monkeypatch.setattr(risk_fallback, "TOP_LINES", 2)
    boq = analyze(client, sample_boq.bid_xml(), "bid.X84")
    assert len(boq["risk"]["lines"]) <= 2
    assert risk_fallback.TOP_LINES == 2 and risk_fallback.assess.__module__ == "webapp.risk_fallback"


def test_large_responses_are_gzipped(client):
    res = client.post("/api/analyze", files={"file": ("t.X83", sample_boq.tender_xml())},
                      headers={"Accept-Encoding": "gzip"})
    assert res.headers["content-encoding"] == "gzip"


def test_cache_keeps_the_last_eight_analyses(client, monkeypatch):
    first = analyze(client)["doc_key"]
    for n in range(8):
        analyze(client, sample_boq.tender_xml().replace(b"Testprojekt", f"P{n}".encode()))
    assert len(webapp._cache) == 8 and first not in webapp._cache
    res = client.put(f"/api/decisions/{first}/x", json={"status": "rejected"})
    assert res.status_code == 404 and "Analyse the file again" in res.json()["detail"]


# ---------------------------------------------------------------- decisions

def test_put_decision_returns_decision_and_rescored_risk(client):
    boq = analyze(client)
    f = by_rule(boq, "L1.QTY.MISSING")
    res = client.put(f"/api/decisions/{boq['doc_key']}/{f['id']}",
                     json={"status": "rejected", "reason": "false_alarm", "note": "Menge steht im Vorwort"})
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "rejected" and body["decision"]["reason"] == "false_alarm"
    assert body["decision"]["rule_id"] == "L1.QTY.MISSING" and body["decision"]["line_code"] == "01.0010"
    risk = body["risk"]
    assert risk["counts"]["dismissed"] == 1 and risk["counts"]["reviewed"] == 1
    assert risk["counts"]["open"]["error"] == boq["risk"]["counts"]["open"]["error"] - 1
    assert risk["score"] <= boq["risk"]["score"]  # a dismissed finding no longer counts


def test_accept_keeps_the_finding_in_the_score(client):
    boq = analyze(client)
    f = by_rule(boq, "L1.QTY.MISSING")
    body = client.put(f"/api/decisions/{boq['doc_key']}/{f['id']}", json={"status": "accepted"}).json()
    assert body["status"] == "accepted" and body["risk"]["score"] == boq["risk"]["score"]
    assert body["risk"]["counts"]["accepted"] == 1 and body["risk"]["counts"]["open"]["error"] == 0


def test_reopen_removes_the_decision(client):
    boq = analyze(client)
    url = f"/api/decisions/{boq['doc_key']}/{by_rule(boq, 'L1.QTY.MISSING')['id']}"
    client.put(url, json={"status": "rejected"})
    body = client.put(url, json={"status": "open"}).json()
    assert body["decision"] is None and body["status"] == "open" and body["risk"]["counts"]["reviewed"] == 0
    assert analyze(client)["decisions"] == {}


def test_decisions_persist_and_apply_after_reanalysis(client):
    boq = analyze(client)
    f = by_rule(boq, "L1.DUP.SUSPECTED")
    client.put(f"/api/decisions/{boq['doc_key']}/{f['id']}", json={"status": "rejected", "reason": "known_accepted"})
    again = analyze(client)  # same file, same finding ids
    assert again["doc_key"] == boq["doc_key"]
    assert by_rule(again, "L1.DUP.SUSPECTED")["status"] == "rejected"
    assert again["decisions"][f["id"]]["reason"] == "known_accepted"
    assert again["risk"]["counts"]["dismissed"] == 1


def test_decision_with_no_matching_finding_is_orphaned_not_lost(client, tmp_path):
    boq = analyze(client)
    f = by_rule(boq, "L1.QTY.MISSING")
    client.put(f"/api/decisions/{boq['doc_key']}/{f['id']}", json={"status": "rejected", "reason": "other"})
    # Same document analysed with layer 2 only: the layer 1 finding no longer exists.
    res = client.post("/api/analyze", data={"layers": "2"}, files={"file": ("tender.X83", sample_boq.tender_xml())})
    again = res.json()["boqs"][0]
    assert again["decisions"] == {}
    assert [d["finding_id"] for d in again["orphaned_decisions"]] == [f["id"]]
    assert again["orphaned_decisions"][0]["rule_id"] == "L1.QTY.MISSING"
    # Still on disk, so the decision returns with layer 1.
    assert analyze(client)["decisions"][f["id"]]["status"] == "rejected"


def test_bad_requests(client):
    boq = analyze(client)
    key = boq["doc_key"]
    assert client.put(f"/api/decisions/{key}/nope", json={"status": "rejected"}).status_code == 404
    assert client.put(f"/api/decisions/not-a-key/x", json={"status": "rejected"}).status_code == 400
    f = by_rule(boq, "L1.QTY.MISSING")
    assert client.put(f"/api/decisions/{key}/{f['id']}", json={"status": "applied"}).status_code == 422
    assert client.post(f"/api/decisions/{key}/bulk", json={"status": "rejected"}).status_code == 400
    assert client.post(f"/api/decisions/{key}/bulk", json={"status": "rejected", "rule_id": "L9.NOPE"}).status_code == 404


def test_path_traversal_in_doc_key_is_rejected(client):
    res = client.put("/api/decisions/..%2F..%2Fevil:0/x", json={"status": "rejected"})
    assert res.status_code in (400, 404)
    assert not list((webapp.DECISIONS_DIR.parent).glob("evil*")) if webapp.DECISIONS_DIR.exists() else True


def test_bulk_dismiss_by_rule_only_touches_open_findings(client):
    boq = analyze(client)
    key = boq["doc_key"]
    l2 = [f for f in boq["result"]["findings"] if f["rule_id"].startswith("L2.FLOOR.SCREED")]
    assert len(l2) >= 2
    one = l2[0]
    client.put(f"/api/decisions/{key}/{one['id']}", json={"status": "accepted"})
    res = client.post(f"/api/decisions/{key}/bulk", json={"status": "rejected", "reason": "covered_elsewhere",
                                                          "rule_id": one["rule_id"]})
    # Only the rule's open findings change; the accepted one is not overridden (nothing left to do).
    assert res.status_code == 200 and res.json()["changed"] == 0
    assert client.get(f"/api/questions/{key}").status_code == 200
    ids = [f["id"] for f in l2[1:]]
    res = client.post(f"/api/decisions/{key}/bulk", json={"status": "rejected", "finding_ids": ids,
                                                          "reason": "covered_elsewhere"}).json()
    assert res["changed"] == len(ids) and res["risk"]["counts"]["dismissed"] == len(ids)
    restored = client.post(f"/api/decisions/{key}/bulk", json={"status": "open", "finding_ids": ids}).json()
    assert restored["risk"]["counts"]["dismissed"] == 0 and all(v is None for v in restored["decisions"].values())


def test_bulk_by_rule_dismisses_every_open_finding_of_the_rule(client):
    boq = analyze(client)
    rule = "L2.FLOOR.SCREED_NEEDS_SKIRTING"
    res = client.post(f"/api/decisions/{boq['doc_key']}/bulk",
                      json={"status": "rejected", "rule_id": rule, "reason": "not_relevant"}).json()
    assert res["changed"] == sum(1 for f in boq["result"]["findings"] if f["rule_id"] == rule) >= 1


# ---------------------------------------------------------------- questions

def test_questions_endpoint_and_dismissal(client):
    boq = analyze(client)
    key = boq["doc_key"]
    body = client.get(f"/api/questions/{key}").json()
    assert body["applicable"] is True
    rules = {q["rule_id"] for q in body["questions"]}
    assert {"L1.QTY.MISSING", "L1.DUP.SUSPECTED", "L1.STRUCT.PROVISIONAL_ITEM"} <= rules
    f = by_rule(boq, "L1.QTY.MISSING")
    client.put(f"/api/decisions/{key}/{f['id']}", json={"status": "rejected"})
    after = client.get(f"/api/questions/{key}").json()
    assert "L1.QTY.MISSING" not in {q["rule_id"] for q in after["questions"]}


def test_questions_are_not_generated_for_a_bid(client):
    boq = analyze(client, sample_boq.bid_xml(), "bid.X84")
    body = client.get(f"/api/questions/{boq['doc_key']}").json()
    assert body["applicable"] is False and body["questions"] == [] and "tenders" in body["note"]
    assert client.get(f"/api/questions/{boq['doc_key']}.docx").status_code == 409


def test_questions_docx_export(client):
    pytest.importorskip("docx")
    boq = analyze(client)
    res = client.get(f"/api/questions/{boq['doc_key']}.docx")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("application/vnd.openxmlformats-officedocument")
    assert "Bieterfragen_tender.docx" in res.headers["content-disposition"]
    with zipfile.ZipFile(io.BytesIO(res.content)) as z:
        xml = z.read("word/document.xml").decode("utf-8")
    assert "Bieterfragen" in xml and "keine Menge angegeben" in xml


def test_questions_for_unknown_analysis_is_404(client):
    assert client.get(f"/api/questions/{'0' * 64}:0").status_code == 404


# ---------------------------------------------------------------- store

def test_store_round_trip_and_atomic_files(tmp_path):
    store = decision_lib.JsonDecisionStore(tmp_path)
    key = "a" * 64 + ":0"
    other = "a" * 64 + ":1"
    store.put(key, "f1", decision_lib.make_decision("rejected", "other", "note", rule_id="R"))
    store.put(other, "f2", decision_lib.make_decision("accepted"))
    assert store.get_all(key)["f1"]["note"] == "note" and set(store.get_all(other)) == {"f2"}
    assert [p.name for p in tmp_path.iterdir()] == ["a" * 64 + ".json"]  # one file per document, no temp files left
    store.put(key, "f1", None)
    store.put(other, "f2", None)
    assert store.get_all(key) == {} and list(tmp_path.iterdir()) == []


def test_store_survives_a_damaged_file_and_concurrent_writes(tmp_path):
    store = decision_lib.JsonDecisionStore(tmp_path)
    key = "b" * 64 + ":0"
    (tmp_path / ("b" * 64 + ".json")).write_text("{ not json", encoding="utf-8")
    assert store.get_all(key) == {}  # does not raise
    threads = [threading.Thread(target=store.put, args=(key, f"f{n}", decision_lib.make_decision("rejected")))
               for n in range(20)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert len(store.get_all(key)) == 20
    json.loads((tmp_path / ("b" * 64 + ".json")).read_text(encoding="utf-8"))


def test_store_rejects_invalid_keys_and_statuses(tmp_path):
    store = decision_lib.JsonDecisionStore(tmp_path)
    with pytest.raises(decision_lib.InvalidDocKey):
        store.get_all("../../etc/passwd:0")
    with pytest.raises(ValueError):
        decision_lib.make_decision("applied")


def test_index_page_serves(client):
    res = client.get("/")
    assert res.status_code == 200 and "Bidder questions" in res.text
