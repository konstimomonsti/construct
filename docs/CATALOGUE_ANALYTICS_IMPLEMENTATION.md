# Catalogue analytics implementation plan

Date — 21 November 2026

Status — Proposed implementation. This document defines the next development work. The catalogue matching service and persistence described below remain to be implemented.

## Objective

Identify materials and products described in `bom_line`, match them to the existing catalogue using deterministic rules, and consult an LLM when a compatible match remains unresolved. Persist every LLM result and the resulting decision so subsequent occurrences reuse the record without another identification call.

The output is a traceable set of product requirements grouped by catalogue product. Each requirement retains its source BOM position, specification, quantity basis, matching evidence and review state.

This plan uses “inventory” to mean the existing materials/product catalogue. Stock availability and purchasing operations require their own data and workflow.

## Existing foundations

| Existing code or schema | Role in this implementation |
|---|---|
| `bom_line` | Original descriptions, quantities, units, source location and BOM version |
| `material_item` and its `product_id` | Accepted material requirements linked to products |
| `product`, `product_category`, `supplier` | Existing catalogue identities and categories |
| `product_price` | Dated commercial information attached to products |
| `material_group` | Existing hierarchy for material organization |
| `catalogue_source_line` | Source evidence from the Challenge A catalogue import |
| `importer/tender_import/challenge_catalogue.py` | Keyword, category and companion-document logic to review for reuse |
| `analysis/units.py` | Canonical units and supported conversions |
| `analysis/layer3/provider.py` | Existing provider abstraction to assess for reuse |

The current upload path parses documents and returns validation findings. It does not invoke a general catalogue matching service. The Challenge A importer contains dataset-specific filenames and overrides, which need to be isolated when extracting reusable matching logic.

Product identity approval currently requires commercial fields and a dated price through existing database constraints. A catalogue identification decision therefore needs its own status. A newly identified product can remain `pending` while its supplier, purchase unit or price is completed.

## Processing sequence

1. Read a BOM line with relevant section notes, resolved references and source evidence.
2. Identify candidate product elements and normalize their attributes.
3. Look up a reusable identification record for the same semantic specification.
4. For unresolved elements, apply deterministic catalogue matching rules.
5. Persist a rule match when one compatible product is uniquely identified.
6. Check stored LLM requests and resolutions before scheduling a fallback call.
7. Ask the LLM to resolve remaining candidates using source context and retrieved catalogue candidates.
8. Validate and persist the response, its evidence and its decision state.
9. Apply accepted links to material requirements and group them by product.

An existing pending suggestion is displayed for review on repeated analysis. Re-analysis alone never authorizes another model call for that same request.

## Candidate and matching contract

One BOM line may contain several product elements. Each candidate needs the following fields.

| Field | Meaning |
|---|---|
| Candidate ID and BOM line ID | Stable occurrence identity and parent position |
| Name and category | Normalized product description and controlled family |
| Attributes | Material, dimensions, grade, performance or other family-specific identifiers |
| Source evidence | Exact supporting text and document locator |
| Context evidence | Referenced positions or section text used to interpret the candidate |
| Scope relationship | Supplied, installed, included accessory, separately measured, alternative or provided by others |
| Quantity and unit | Explicit or supported derived requirement, with derivation and original values |
| Specification fingerprint | Versioned canonical identity used for reuse |
| Outcome | Matched, ambiguous, unmatched or invalid input |
| Review state | Pending, accepted, rejected, stale or superseded |
| Method | Rule, reused resolution, LLM or human |
| Product link | Existing or newly created catalogue product ID where applicable |
| Decision evidence | Rule ID, matched attributes, incompatibilities, rationale and confidence where available |

Keep candidate occurrence identity separate from product specification identity. Repeated specifications in different BOM positions need independent quantities and a shared product match.

Preserve unknown attributes explicitly. Missing dimensions must not behave as a wildcard that makes differently sized products equivalent. An unresolved product quantity can remain empty even when the product identity is accepted.

## Deterministic identification and matching

Start with a small set of product families and explicit rules that can be tested and explained.

1. Extract explicit product identifiers and supplier-qualified SKUs.
2. Resolve approved names and aliases to catalogue candidates.
3. Use category and technical attributes to narrow candidate products.
4. Apply mandatory compatibility checks, including material, dimensions, grade and unit basis where relevant.
5. Accept only a unique compatible result. Retain ambiguity when several supplier products satisfy a generic specification.

Rules must record their version, supporting text and compatibility decisions. A confident name match cannot override a conflicting technical attribute. An installation activity mentioning a pipe does not establish a separate pipe supply requirement without scope evidence.

For a description such as “PE-HD pipe 50 × 4.6 mm,” use the pipe family, PE-HD material, outside diameter and wall thickness. Products with different dimensions remain distinct. A line describing both pipes and valves produces separate candidates.

Resolve “wie vor” and explicit position references before computing product identity. Record inherited attributes and local overrides, including cycles, missing references and conflicting evidence.

## Durable reuse of LLM results

The database is the authoritative identification memory. A local response cache can supplement it.

Use two related records.

| Record | Purpose |
|---|---|
| Request/result record | Saves the exact request fingerprint, input context, candidate catalogue IDs, provider/model, prompt version, response, validation outcome, usage and timestamps |
| Reusable resolution record | Maps a canonical specification to a product or unresolved decision, with evidence, compatibility requirements, review state and provenance |

The request fingerprint identifies a particular model request. The specification fingerprint identifies a reusable product requirement across documents. Compute the specification fingerprint from canonical category, identity-bearing attributes, normalized specification text where needed, relevant inherited context and normalization version. Exclude position numbers, document hashes and total requested quantities when they do not affect product identity. Preserve pack size, paired-product basis and other quantities that define the product itself.

Accepted resolutions are checked before any new LLM call. Pending resolutions also suppress repeat calls and return their existing review task. Rejected, ambiguous and unresolved responses remain recorded so ordinary reruns do not repeatedly pay for the same failed identification.

A new prompt or model version alone does not invalidate an accepted resolution. Re-evaluate compatibility when the source specification or relevant product identity changes. Product price changes do not require product re-identification. For previously unresolved cases, a changed relevant catalogue candidate set can trigger deterministic rematching first. A new paid attempt requires an explicit retry policy or user action and retains its relationship to the earlier attempt.

General product aliases may be shared across projects after review. Source-specific text, inherited context and project-only decisions retain their project scope. Never promote a context-dependent phrase such as “same as above” into a global product alias.

## LLM fallback and catalogue enrichment

Send the unresolved element, required context, extracted attributes, failed rule reasons and a bounded set of catalogue candidates. Require structured output with one of three outcomes.

| Outcome | Persistence and next action |
|---|---|
| Existing product suggested | Store the proposed product ID, evidence and attribute comparison for review |
| New product proposed | Store a structured proposal with known attributes and missing fields; reuse the proposal on repeated occurrences |
| Insufficient evidence | Store the unresolved result and explanation; show it in the review queue |

Validate product IDs against the supplied candidates, quoted evidence against the source, and technical attributes against compatibility rules. Persist validation failures as attempt outcomes. LLM confidence is advisory and cannot bypass these checks.

Recommended initial policy is human approval of LLM suggestions. Store every result immediately, including pending ones. On approval of a new identity, check for an existing compatible product again, then atomically create or reuse a pending catalogue product and save the reusable mapping. Missing commercial fields remain empty. Commercial approval continues through the existing product constraints.

Reviewer corrections create a superseding decision and preserve the original response. Future matching uses the accepted correction.

## Persistence and concurrency

Proposed schema additions should cover the following responsibilities. Final table names can follow repository conventions.

- Product specifications and scoped aliases, with canonical attributes and provenance.
- Candidate occurrences linked to BOM lines and extraction versions.
- Matching runs and decisions, including links to existing `material_item` and `product` rows.
- LLM request attempts and durable responses.
- Reusable specification resolutions and review history.

Use database uniqueness constraints for occurrence identity and reusable resolution keys. Review existing migrations before allocating the next migration number.

Reserve each fallback request atomically with a unique key and a worker lease. Concurrent analyses reuse or wait for the same request. Persist a successful response before exposing it as completed, and use transactional writes for product creation and resolution acceptance. Repeat processing must reuse the material requirement occurrence rather than adding another quantity.

An external model call and a database transaction cannot generally commit atomically. If a worker loses the response after a successful provider call, mark the attempt as uncertain and reconcile it through provider request identifiers or idempotency support where available. Avoid automatic paid retries of uncertain attempts. This limits duplicate charges while making the remaining failure case visible.

Existing BOM versions remain readable with empty catalogue analytics results until processed. Successful decisions for other elements remain available when one element fails.

## Grouped product requirements

Group accepted occurrences by product ID and compatible quantity basis. Preserve the source positions and scope relationships inside each group.

Only aggregate quantities with compatible units and documented conversions. Keep unknown quantities and conversion requirements visible. A tender rate per metre of a paired conduit requires its own product basis. Optional and alternative requirements need separate selection state before entering selected totals. Components included within an assembly must retain that relationship to avoid counting the same requirement twice.

Companion exports of the same tender require source reconciliation before aggregation. Separate BOM positions that legitimately specify the same product remain separate requirements contributing to the total.

## Implementation milestones

| Order | Work package | Acceptance gate |
|---|---|---|
| 1 | Pilot examples and matching contract | Label representative pipes, including exact matches, aliases, conflicting dimensions, ambiguous supplier products, missing products and repeated descriptions |
| 2 | Input context and catalogue attributes | Preserve relevant references and scope flags; define mandatory pipe attributes and compatible units |
| 3 | Durable records and rule matcher | Save explained rule decisions and reuse accepted resolutions without invoking the provider |
| 4 | LLM fallback and proposal persistence | Save valid, invalid and unresolved responses; repeated identical requests produce zero additional provider calls |
| 5 | Review and product linking | Accept or correct suggestions, create pending products safely, and populate material product links idempotently |
| 6 | Grouping and application integration | Process a stored BOM through a shared service and expose traceable grouped requirements in the application |
| 7 | Evaluation and family expansion | Pass held-out examples before adding valves, insulation and other families |

Use one shared service for CLI and application callers. Reuse existing unit logic and compatible provider code. Assess provider behavior for catalogue matching independently of the bill-validation checks. Persisted processing must load the stored BOM and catalogue rather than depend on the current in-memory upload report.

## Verification and release criteria

- Correct product links on labelled examples, with precision and coverage reported separately.
- Conflicting dimensions or grades never accepted by a similarity-only rule.
- Several products within one BOM line retain distinct evidence and requirement records.
- An accepted LLM identification is reused across equivalent descriptions without a new call.
- Pending and unresolved identical requests return their saved outcome without a new call.
- Concurrent identical requests invoke the provider once during normal execution.
- Changed prices preserve identification reuse; changed specifications trigger compatibility review.
- Reviewer corrections supersede earlier suggestions and survive restarts.
- Reprocessing does not duplicate product records, material occurrences or grouped quantities.
- Source companions and alternative requirements do not inflate selected totals.
- Database migrations, rollback behavior and the stored-BOM entry point are verified against PostgreSQL.

Track rule precision, rule coverage, resolution reuse rate, provider calls and usage, LLM suggestion acceptance, unresolved coverage and grouping errors. Retain a held-out set that is independent of rule construction. The first release gate is a complete, reviewed pipe-family workflow with demonstrated persistence and zero repeat calls for saved identical identification requests.
