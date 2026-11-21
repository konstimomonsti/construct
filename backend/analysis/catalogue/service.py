"""Shared catalogue workflow for CLI and application callers."""

from __future__ import annotations

from collections import Counter
from dataclasses import asdict
from decimal import Decimal
import json
import os

from psycopg.types.json import Jsonb

from analysis import units

from . import fallback, store
from .rules import PIPE_FAMILIES, REFERENCE, VERSION, Product, assess, compatibility, description_key, extract, matching_name

SUPPLY_SCOPES = {"supplied", "installed", "separately_measured"}


def connect():
    import psycopg

    return psycopg.connect(os.environ.get("DATABASE_URL", ""), autocommit=True)


class Catalogue:
    """Owns transaction boundaries. Accepts an idle psycopg connection."""

    def __init__(self, connection, provider=None):
        self.conn = connection
        self.provider = provider

    def process(self, bom_id):
        bom_id = store.as_uuid(bom_id)
        conn = self.conn
        requests = {}
        resolutions = {}
        with conn.transaction():
            project_id = store.version(conn, bom_id)["project_id"]
            store.lock_project(conn, project_id)
            run_id = store.query(conn, """
                INSERT INTO catalogue_run (bom_version_id, rule_version) VALUES (%s, %s) RETURNING id
            """, (bom_id, VERSION)).fetchone()["id"]
            products = store.load_products(conn, project_id)
            for line_id, slot, candidate in extract(store.load_lines(conn, bom_id), products):
                entry = resolutions.get(candidate.fingerprint)
                if entry is None:
                    resolution_id = store.get_resolution(conn, project_id, candidate)
                    prior = store.current_decision(conn, resolution_id)
                    resolutions[candidate.fingerprint] = resolution_id, candidate, prior
                else:
                    resolution_id, _, prior = entry
                reused = bool(entry or (prior and (prior["state"] in ("accepted", "rejected") or prior["attempt_id"])))
                store.save_occurrence(conn, bom_id, run_id, line_id, slot, resolution_id, candidate, reused, VERSION)
                if self.provider and self._eligible(candidate):
                    requests.setdefault(resolution_id, (line_id, slot, candidate))
            store.clear_obsolete(conn, bom_id, run_id)
            for resolution_id, candidate, prior in resolutions.values():
                self._identify(project_id, resolution_id, candidate, products, prior, reserve=False)

        calls = 0
        for resolution_id, (line_id, slot, candidate) in requests.items():
            with conn.transaction():
                store.lock_project(conn, project_id)
                active = store.query(conn, """
                    SELECT 1 FROM catalogue_occurrence WHERE bom_line_id = %s AND slot = %s AND active
                    AND resolution_id = %s AND candidate = %s
                """, (line_id, slot, resolution_id, Jsonb(candidate.record()))).fetchone()
                if not active:
                    continue
                prior = store.current_decision(conn, resolution_id)
                if prior["state"] in {"accepted", "rejected"} or store.current_attempt(conn, resolution_id):
                    continue
                reservation = self._identify(project_id, resolution_id, candidate,
                                             store.load_products(conn, project_id), prior)
            if reservation:
                calls += 1
                if self._complete(project_id, *reservation) == "unavailable":
                    break
        result = self.report(bom_id)
        with conn.transaction():
            store.query(conn, """
                UPDATE catalogue_run SET finished_at = clock_timestamp(), summary = %s WHERE id = %s
            """, (Jsonb({**result["summary"], "provider_calls": calls}), run_id))
        result["run_id"] = str(run_id)
        result["summary"]["provider_calls"] = calls
        return result

    @staticmethod
    def _eligible(candidate):
        return (not candidate.issues and candidate.category in PIPE_FAMILIES
                and candidate.scope in SUPPLY_SCOPES | {"included_accessory"}
                and candidate.selection not in {"companion", "unreconciled_source"})

    def _identify(self, project_id, resolution_id, candidate, products, prior, *, retry=False, reserve=True):
        conn = self.conn
        product_by_id = {product.id: product for product in products}
        if prior and prior["state"] == "accepted":
            product = product_by_id.get(str(prior["product_id"]))
            if product and product.identity == prior["product_identity"]:
                store.sync_occurrences(conn, resolution_id, prior)
                return None
            prior = store.save_decision(
                conn, resolution_id, prior, outcome="unmatched", state="stale", method="rule",
                evidence={"reason": "Previously accepted catalogue identity changed", "rule_version": VERSION},
            )
        if prior and prior["state"] == "rejected" and not retry:
            store.sync_occurrences(conn, resolution_id, prior)
            return None

        exact, evidence = assess(candidate, products)
        attempt = store.current_attempt(conn, resolution_id)
        if candidate.issues:
            decision = store.save_decision(
                conn, resolution_id, prior, outcome="invalid_input", state="pending", method="rule",
                evidence={"issues": list(candidate.issues), "rule_version": VERSION},
            )
        elif len(exact) == 1:
            matched = next(item for item in evidence if item["id"] == exact[0].id)
            decision = store.save_decision(
                conn, resolution_id, prior, outcome="matched", state="accepted", method="rule", product=exact[0],
                evidence={"match": matched, "specification": candidate.specification, "rule_version": VERSION},
            )
        else:
            decision = self._attempt_decision(resolution_id, prior, attempt, products) if attempt else None
            if decision is None:
                decision = store.save_decision(
                    conn, resolution_id, prior, outcome="ambiguous" if len(exact) > 1 else "unmatched",
                    state="pending", method="rule", evidence={
                        "candidates": evidence[:12], "rule_version": VERSION,
                        "reason": "Multiple compatible products" if len(exact) > 1 else
                                  "No unique compatible product in the pipe pilot",
                    },
                )

        store.sync_occurrences(conn, resolution_id, decision)
        if not reserve or decision["state"] == "accepted" or not self._eligible(candidate):
            return None
        if self.provider is None or (attempt and (not retry or attempt["status"] == "running")):
            return None

        request = fallback.request_for(candidate, evidence)
        model = self.provider.model_id
        backend = fallback.provider_name(self.provider)
        lease_seconds = max(300, int(getattr(self.provider, "timeout", 120)) + 60)
        reservation = store.query(conn, """
            INSERT INTO catalogue_attempt
                (resolution_id, previous_attempt_id, request_fingerprint, request, model_id, lease_until)
            VALUES (%s, %s, %s, %s, %s, clock_timestamp() + %s * interval '1 second')
            ON CONFLICT (resolution_id, previous_attempt_id) DO NOTHING RETURNING id
        """, (resolution_id, attempt["id"] if attempt else None, request.cache_key(f"{backend}/{model}"),
              Jsonb({**asdict(request), "provider": backend}), model, lease_seconds)).fetchone()
        if reservation:
            if decision["state"] == "rejected":
                reopened = store.save_decision(
                    conn, resolution_id, decision, outcome="unmatched", state="pending", method="rule",
                    evidence={"reason": "Explicitly reopened for a new identification attempt", "rule_version": VERSION},
                    attempt_id=reservation["id"],
                )
                store.sync_occurrences(conn, resolution_id, reopened)
            return reservation["id"], resolution_id, request, candidate.specification
        return None

    def _complete(self, project_id, attempt_id, resolution_id, request, specification):
        conn = self.conn
        status, response, metadata, error = fallback.call(self.provider, request, specification)
        with conn.transaction():
            store.lock_project(conn, project_id)
            # Keep a late response even if another reader already marked this lease uncertain.
            attempt = store.query(conn, """
                UPDATE catalogue_attempt SET status = %s, response = %s, metadata = %s, validation_error = %s,
                    finished_at = clock_timestamp()
                WHERE id = %s AND response IS NULL RETURNING *
            """, (status, Jsonb(response), Jsonb(metadata), error, attempt_id)).fetchone()

        # The paid result has committed independently of material writes or decision application.
        with conn.transaction():
            store.lock_project(conn, project_id)
            latest = store.current_attempt(conn, resolution_id)
            prior = store.current_decision(conn, resolution_id)
            if attempt and latest["id"] == attempt_id and (not prior or prior["state"] == "pending"):
                products = store.load_products(conn, project_id)
                decision = self._attempt_decision(resolution_id, prior, attempt, products)
                store.sync_occurrences(conn, resolution_id, decision)
        return status

    def _attempt_decision(self, resolution_id, prior, attempt, products):
        if attempt["status"] == "running":
            return prior
        if prior and prior["method"] != "rule" and prior["attempt_id"] == attempt["id"]:
            if prior["product_id"] is None:
                return prior
            if any(product.id == str(prior["product_id"]) and product.identity == prior["product_identity"]
                   for product in products):
                return prior
        evidence = {"attempt_status": attempt["status"], "validation_error": attempt["validation_error"]}
        outcome, product = "unmatched", None
        if attempt["status"] == "valid":
            parsed = attempt["response"]["parsed"]
            evidence = {**evidence, "suggestion": parsed}
            if parsed["outcome"] == "existing_product":
                product = next((product for product in products if product.id == parsed["product_id"]), None)
                original = next(item for item in json.loads(attempt["request"]["prompt"])["catalogue_candidates"]
                                if item["id"] == parsed["product_id"])
                if product and product.identity == original.get("identity"):
                    outcome = "matched"
                else:
                    product = None
                    evidence["validation_error"] = "Suggested catalogue product changed after the request"
            elif parsed["outcome"] == "new_product":
                evidence["proposal"] = {"name": parsed["name"],
                                        "attributes": json.loads(attempt["request"]["prompt"])["attributes"],
                                        "missing_fields": ["supplier", "purchase_unit", "dated_price"]}
        return store.save_decision(self.conn, resolution_id, prior, outcome=outcome, state="pending", method="llm",
                                   evidence=evidence, attempt_id=attempt["id"], product=product)

    def review(self, bom_id, occurrence_id, action, reviewer, *, product_id=None, note="", expected_decision_id=None):
        if not reviewer.strip() or action not in {"accept", "reject", "correct"}:
            raise store.CatalogueError("Provide a reviewer and an accept, reject or correct action")
        conn = self.conn
        bom_id, occurrence_id = store.as_uuid(bom_id), store.as_uuid(occurrence_id)
        with conn.transaction():
            project_id = store.version(conn, bom_id)["project_id"]
            store.lock_project(conn, project_id)
            row = self._occurrence(bom_id, occurrence_id)
            prior = store.current_decision(conn, row["resolution_id"])
            self._check_review_version(prior, expected_decision_id)
            self._check_source(bom_id, project_id, row)
            spec = row["candidate"]["specification"]
            product = None
            if action != "reject":
                if spec["issues"] or spec["category"] not in PIPE_FAMILIES:
                    raise store.Conflict("Only a valid pipe specification can be accepted in this pilot")
                # Product creation across projects must serialize with rechecking the catalogue.
                conn.execute("SELECT pg_advisory_xact_lock(26641, 2)")
                products = store.load_products(conn, project_id)
                target = store.as_uuid(product_id) if product_id else prior["product_id"]
                if action == "correct" and not product_id:
                    raise store.CatalogueError("Correction requires a catalogue product ID")
                if target:
                    product = next((product for product in products if product.id == str(target)), None)
                    if product is None:
                        raise store.NotFound(f"Product {target} not found")
                    reasons = compatibility(spec, product, strict=not (spec["sku"] and spec["supplier"]))
                    if reasons:
                        raise store.Conflict("; ".join(reasons))
                    if not product_id and product.identity != prior["product_identity"]:
                        raise store.Conflict("The proposed product changed. Reprocess the BOM before review")
                else:
                    proposal = prior["evidence"].get("proposal")
                    if not proposal:
                        raise store.Conflict("Choose an existing product or approve a saved new-product proposal")
                    compatible = [item for item in products if not compatibility(spec, item)
                                  and description_key(spec["category"], item.name) == spec["description"]]
                    if len(compatible) > 1:
                        raise store.Conflict("Several compatible products exist. Choose one explicitly")
                    product = compatible[0] if compatible else self._create_product(spec, proposal, row["resolution_id"])

            decision = store.save_decision(
                conn, row["resolution_id"], prior, outcome="matched" if product else prior["outcome"],
                state="accepted" if product else "rejected", method="human", product=product,
                reviewer=reviewer.strip(), attempt_id=prior["attempt_id"],
                evidence={"note": note, "action": action, "attributes": spec["attributes"]},
            )
            store.sync_occurrences(conn, row["resolution_id"], decision)
        return self.report(bom_id)

    def _create_product(self, spec, proposal, resolution_id):
        conn = self.conn
        category = store.query(conn, """
            INSERT INTO product_category (name) VALUES (%s)
            ON CONFLICT (name) DO UPDATE SET name = excluded.name RETURNING id
        """, (spec["category"],)).fetchone()["id"]
        name = proposal["name"]
        product_id = store.query(conn, """
            INSERT INTO product (category_id, name, description, review_status)
            VALUES (%s, %s, %s, 'pending') RETURNING id
        """, (category, name, name)).fetchone()["id"]
        provenance = {"decision_source": "catalogue analytics", "resolution_id": str(resolution_id)}
        store.query(conn, """
            INSERT INTO catalogue_product_spec (product_id, category, attributes, provenance)
            VALUES (%s, %s, %s, %s)
        """, (product_id, spec["category"], Jsonb(spec["attributes"]), Jsonb(provenance)))
        return Product(str(product_id), spec["category"], name, name, None, None, None, spec["attributes"])

    def retry(self, bom_id, occurrence_id, expected_decision_id=None, expected_attempt_id=None):
        if self.provider is None:
            raise store.Conflict("Configure an identification provider before retrying")
        bom_id = store.as_uuid(bom_id)
        conn = self.conn
        with conn.transaction():
            project_id = store.version(conn, bom_id)["project_id"]
            store.lock_project(conn, project_id)
            row = self._occurrence(bom_id, store.as_uuid(occurrence_id))
            resolution_id = row["resolution_id"]
            decision = store.current_decision(conn, resolution_id)
            self._check_review_version(decision, expected_decision_id)
            attempt = store.current_attempt(conn, resolution_id)
            if not attempt or not expected_attempt_id or attempt["id"] != store.as_uuid(expected_attempt_id):
                raise store.Conflict("Select the latest saved attempt before retrying")
            if attempt["status"] == "running":
                raise store.Conflict("The current attempt is still running")
            match = self._check_source(bom_id, project_id, row)
            reservation = self._identify(project_id, resolution_id, match, store.load_products(conn, project_id),
                                         decision, retry=True)
        if reservation:
            self._complete(project_id, *reservation)
        return self.report(bom_id)

    def _check_source(self, bom_id, project_id, row):
        conn = self.conn
        candidates = extract(store.load_lines(conn, bom_id), store.load_products(conn, project_id))
        match = next((candidate for line_id, slot, candidate in candidates
                      if line_id == str(row["bom_line_id"]) and slot == row["slot"]), None)
        if match is None or match.record() != row["candidate"]:
            raise store.Conflict("The BOM context changed. Reprocess it before review")
        return match

    def approve_alias(self, bom_id, product_id, alias, reviewer, *, share=False):
        name = matching_name(alias)
        if not name or not reviewer.strip() or REFERENCE.search(alias):
            raise store.CatalogueError("Provide a reusable alias and a reviewer")
        product_id = store.as_uuid(product_id)
        with self.conn.transaction():
            project_id = store.version(self.conn, store.as_uuid(bom_id))["project_id"]
            store.lock_project(self.conn, project_id)
            if not store.query(self.conn, "SELECT id FROM product WHERE id = %s", (product_id,)).fetchone():
                raise store.NotFound("Catalogue product not found")
            scope = None if share else project_id
            store.query(self.conn, """
                INSERT INTO catalogue_product_alias (product_id, project_id, normalized_name, approved_by)
                VALUES (%s, %s, %s, %s) ON CONFLICT DO NOTHING
            """, (product_id, scope, name, reviewer.strip()))
        return {"product_id": str(product_id), "alias": name, "project_id": str(scope) if scope else None}

    def history(self, bom_id, occurrence_id):
        bom_id, occurrence_id = store.as_uuid(bom_id), store.as_uuid(occurrence_id)
        with self.conn.transaction():
            project_id = store.version(self.conn, bom_id)["project_id"]
            store.lock_project(self.conn, project_id)
            row = self._occurrence(bom_id, occurrence_id)
            resolution_id = row["resolution_id"]
            decisions = store.query(self.conn, """
                SELECT * FROM catalogue_decision WHERE resolution_id = %s ORDER BY created_at, id
            """, (resolution_id,)).fetchall()
            attempts = store.query(self.conn, """
                SELECT * FROM catalogue_attempt WHERE resolution_id = %s ORDER BY created_at, id
            """, (resolution_id,)).fetchall()
        superseded = {item["previous_decision_id"] for item in decisions}
        for decision in decisions:
            decision["superseded"] = decision["id"] in superseded
        return {"occurrence_id": str(occurrence_id), "decisions": decisions, "attempts": attempts}

    def _occurrence(self, bom_id, occurrence_id):
        row = store.query(self.conn, """
            SELECT * FROM catalogue_occurrence WHERE bom_version_id = %s AND id = %s AND active
        """, (bom_id, occurrence_id)).fetchone()
        if row is None:
            raise store.NotFound("Active catalogue occurrence not found")
        return row

    @staticmethod
    def _check_review_version(decision, expected):
        if decision is None or not expected or decision["id"] != store.as_uuid(expected):
            raise store.Conflict("The decision changed or was not supplied. Refresh the review")

    def report(self, bom_id):
        bom_id = store.as_uuid(bom_id)
        conn = self.conn
        with conn.transaction():
            project_id = store.version(conn, bom_id)["project_id"]
            store.lock_project(conn, project_id)
            products = {product.id: product for product in store.load_products(conn, project_id)}
            rows = store.query(conn, """
                SELECT o.*, d.outcome, d.state, d.method, d.product_id, d.product_identity, d.evidence, d.reviewer,
                       m.product_id AS linked_product_id, l.line_code, a.id AS attempt_id,
                       CASE WHEN a.status = 'running' AND a.lease_until <= clock_timestamp()
                            THEN 'uncertain' ELSE a.status END AS attempt_status
                FROM catalogue_occurrence o JOIN bom_line l ON l.id = o.bom_line_id
                LEFT JOIN catalogue_decision d ON d.id = o.decision_id
                LEFT JOIN material_item m ON m.id = o.material_item_id
                LEFT JOIN LATERAL (
                    SELECT a.id, a.status, a.lease_until FROM catalogue_attempt a
                    WHERE a.resolution_id = o.resolution_id AND NOT EXISTS (
                        SELECT FROM catalogue_attempt newer
                        WHERE newer.resolution_id = a.resolution_id AND newer.previous_attempt_id = a.id
                    )
                ) a ON true
                WHERE o.bom_version_id = %s AND o.active ORDER BY l.sort_order, l.id, o.slot
            """, (bom_id,)).fetchall()
            attempts = store.query(conn, """
                SELECT CASE WHEN status = 'running' AND lease_until <= clock_timestamp()
                       THEN 'uncertain' ELSE status END AS status, metadata
                FROM catalogue_attempt a WHERE EXISTS (
                    SELECT FROM catalogue_occurrence o WHERE o.bom_version_id = %s AND o.active
                        AND o.resolution_id = a.resolution_id
                )
            """, (bom_id,)).fetchall()
        groups, occurrences = {}, []
        for row in rows:
            product = products.get(str(row["product_id"]))
            candidate = row["candidate"]
            if row["state"] == "accepted" and (not product or product.identity != row["product_identity"]):
                row["state"] = "stale"
            occurrence = {key: str(row[key]) if row[key] is not None else None for key in (
                "id", "bom_line_id", "material_item_id", "linked_product_id", "decision_id", "product_id", "attempt_id",
            )}
            occurrence.update({key: row[key] for key in (
                "outcome", "state", "method", "evidence", "reviewer", "reused", "line_code", "attempt_status",
            )})
            occurrence.update(candidate)
            occurrences.append(occurrence)
            if row["state"] != "accepted" or product is None or candidate["scope"] not in (
                SUPPLY_SCOPES | {"included_accessory"}
            ):
                continue

            unit = candidate["unit"]
            group_unit = "m" if units.dimension(unit) == units.Dimension.LENGTH else unit
            key = product.id, candidate["quantity_basis"], group_unit
            group = groups.setdefault(key, {"product": product.brief(), "quantity_basis": key[1], "unit": group_unit,
                                            "selected_total": None, "unknown_selected": 0, "occurrences": []})
            selected = candidate["selection"] == "selected" and candidate["scope"] in SUPPLY_SCOPES
            quantity = candidate["quantity"]
            converted = units.convert(Decimal(quantity), unit, group_unit) if quantity is not None else None
            if selected:
                if converted is None:
                    group["unknown_selected"] += 1
                else:
                    group["selected_total"] = (group["selected_total"] or Decimal(0)) + converted
            group["occurrences"].append({**occurrence, "counts_in_selected": selected and converted is not None,
                                         "converted_quantity": str(converted) if converted is not None else None})
        for group in groups.values():
            if group["selected_total"] is not None:
                group["selected_total"] = str(group["selected_total"])
        by_state = Counter(item["state"] for item in occurrences)
        by_attempt_status = Counter(item["status"] for item in attempts)
        usage = Counter()
        for attempt in attempts:
            meta = attempt["metadata"]
            counts = meta.get("usage") or {}
            for key, value in {"input_tokens": meta.get("prompt_eval_count"),
                               "output_tokens": meta.get("eval_count"), **counts}.items():
                if isinstance(value, int):
                    usage[key] += value
        count = len(occurrences)
        return {"bom_version_id": str(bom_id), "occurrences": occurrences, "groups": list(groups.values()),
                "summary": {"occurrences": count, "by_state": dict(by_state), "groups": len(groups),
                            "rule_matches": sum(item["state"] == "accepted" and item["method"] == "rule"
                                                for item in occurrences),
                            "reused": sum(item["reused"] for item in occurrences),
                            "model_attempts": dict(by_attempt_status), "model_usage": dict(usage),
                            "review_queue": count - by_state["accepted"] - by_state["rejected"]}}
