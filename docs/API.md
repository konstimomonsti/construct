# BillBuild HTTP API

The backend (`backend/server.py`) exposes a same-origin JSON API under `/api`.
Use relative URLs such as `/api/mvp/workspace` for browser requests.

| Environment | Who serves the frontend | Who serves `/api`, `/admin`, `/healthz` |
| --- | --- | --- |
| Production (`backend/deploy/compose.prod.yaml`) | Caddy in the `web` container (`/srv`) | Caddy proxies to `backend:8080` |
| Dev stack (`backend/deploy/compose.yaml`, `--profile app`) | the backend, from `FRONTEND_DIR` | the backend, on `127.0.0.1:8080` |
| Frontend dev server (Vite etc.) | the dev server | the dev server proxies `/api` and `/admin` to `127.0.0.1:8080` |

## Conventions

- **IDs** are UUID strings. **Timestamps** are ISO 8601 with a timezone. **Decimals** (quantities,
  prices) are strings such as `"12.500"`, so they never lose precision. Send decimals back as
  strings: `"12.5"` and `"12,5"` are both accepted.
- **Errors** return a non-2xx status with `{"error": "Human readable message"}`. Show the message
  as it is.
  - `400`: invalid input.
  - `403`: hostname or origin not allowed.
  - `404`: unknown route.
  - `409`: edit conflict.
  - `413`: body too large.
  - `422`: the database refused the change.
  - `503`: database down.
- **Writes** are `POST` with a JSON body (`Content-Type: application/json`). Uploads are the one
  exception: they send the raw file bytes.
- **Origin check:** a POST that carries an `Origin` header must match the request `Host`, or be
  listed in `ALLOWED_ORIGINS`. Browsers do this automatically on the same origin.
- **Host check:** the `Host` must be `localhost`, `127.0.0.1` or `::1`, or be listed in
  `ALLOWED_HOSTS` (production sets this to `APP_DOMAIN`).
- **Auth:** production puts the whole site behind one HTTP basic-auth login at Caddy. The browser
  handles the prompt and resends credentials on every same-origin `fetch`, so the frontend needs
  no login code. The backend receives the login name as `X-Remote-User`.

## Shared BillBuild workspace

The BillBuild frontend syncs its folders, lists, edits and uploaded files here, so every browser sees
the same workspace. There is one workspace and no access control: everyone with the site login can
see and change everything. State is stored as records in collections (`userFolders`, `userLists`,
`userDocuments`, `documentLinks`, `documentFolders`, `folderPatch`, `listPatch`, `edits`, `stats`).

### `GET /api/workspace/state?since=<revision>`

Returns `{"revision": 12, "collections": {"userFolders": {"<id>": {...}}, ...}}`. When `since`
equals the current revision, the response is only `{"revision": 12, "unchanged": true}`.

### `POST /api/workspace/state`

Body: `{"changes": {"<collection>": {"set": {"<id>": <value>}, "delete": ["<id>"]}}}`. The changes
are applied atomically as one new revision and the full state is returned. Changes to different
records never conflict. When two browsers change the same record, the later write wins.

### `GET|POST /api/workspace/file?id=<id>`

Stores or returns an uploaded file. POST sends the raw bytes with `Content-Type: application/pdf` or
`application/octet-stream`. `POST /api/workspace/file-delete` with `{"ids": [...]}` removes files.

## Workspace

### `GET /api/mvp/workspace?project=<id>`

`project` is optional. Without it, the server picks the default project.

```json
{
  "projects": [{"id": "…", "name": "Challenge A import review"}],
  "project":  {"id": "…", "name": "Challenge A import review"},
  "drafts": [{"id": "…", "title": "…", "review_status": "draft", "version_no": 1, "edit_revision": 3,
              "filename": "LV.x83", "source_id": "…", "lines": 214, "priced": 37}],
  "documents": [{"id": "…", "filename": "LV.x83", "format": "gaeb_xml", "exchange_phase": "83",
                 "status": "parsed", "counts": {"items": 214}, "warnings": 0, "boq_indexes": [1]}]
}
```

`documents` lists the imported source files. `drafts` lists the BOMs, which are the editable bills
of quantities built from those files.

### `POST /api/mvp/project`

Request: `{"name": "New project"}`. Response: `{"id": "…", "name": "New project"}`.

## Import

### `POST /api/mvp/upload?project=<id>&filename=<name>`

The body is the raw file bytes, up to 128 MiB. Do not use multipart. Accepted formats: PDF, Word
`.docx`, GAEB XML (`.x8x`), legacy GAEB 90 (`.d8x`), and ZIP files of those.

```json
{"document_id": "…", "status": "parsed", "filename": "LV.x83", "format": "gaeb_xml",
 "counts": {"items": 214, "sections": 12}, "issues": [{"severity": "warning", "message": "…"}]}
```

The file is stored even when parsing fails. In that case `status` reports the failure.

### `POST /api/mvp/draft`

Builds a BOM draft from an imported document. Request: `{"document_id": "…", "boq_index": 1}`.
`boq_index` is optional and selects one of the document's `boq_indexes`.

Response: `{"bom_version_id": "…", "version": 1, "items": 214, "status": "draft"}`. When the draft
already existed, the response is `{"bom_version_id": "…", "version": 1, "cached": true}`.

## Review and edit a BOM

### `GET /api/mvp/bom?id=<bom_version_id>`

```json
{
  "version":  {"id": "…", "title": "…", "edit_revision": 3, "currency": "EUR", "locked": false,
               "project_name": "…", "source_id": "…", "filename": "LV.x83", "format": "gaeb_xml",
               "exchange_phase": "83"},
  "sections": [{"id": "…", "parent_section_id": null, "display_code": "01", "title": "Erdarbeiten",
                "sort_order": 1}],
  "lines": [{"id": "…", "section_id": "…", "section": "Erdarbeiten", "section_code": "01",
             "line_code": "01.0010", "short_description": "…", "long_description": "…",
             "quantity": "120.000", "unit_code": "m3", "draft_unit_price": null,
             "pricing_basis": "unit_rate", "total_rule": "include",
             "source_quantity": "120.000", "source_unit_price": null,
             "catalogue_id": null, "catalogue_name": null, "catalogue_category": null,
             "catalogue_decision": null, "sort_order": 10}]
}
```

`version` and `lines` hold every column of `bom_version` and `bom_line`. The fields above are the
ones a UI needs.

- A line's amount is `quantity × draft_unit_price`, rounded to cents.
- A `lump_sum` line uses a quantity of 1.
- A `unit_price_only` line has no amount.
- Only `include` lines count toward the total. `conditional` lines, such as optional or alternative
  positions, are shown but not summed.

### `POST /api/mvp/save`

Saves the changed lines in one transaction. Include only the fields that changed.

```json
{"id": "<bom_version_id>", "revision": 3,
 "lines": [{"id": "<line id>", "draft_unit_price": "42.50"},
           {"id": "<line id>", "quantity": "10", "short_description": "Aushub"}]}
```

- Editable fields:
  - `line_code`, `short_description`, `long_description`, `unit_code`.
  - `quantity`, `draft_unit_price` (decimal string or `null`).
  - `pricing_basis` (`unit_rate` | `lump_sum`).
  - `total_rule` (`include` | `conditional` | `unit_price_only`).
- `revision` must equal the `version.edit_revision` you loaded. Otherwise the server returns
  **409**, which means someone else saved first: reload the BOM.
- The response is the same as `GET /api/mvp/bom`, with the new `edit_revision`.
- If an issued quote has locked the BOM, the server returns **422**.

## Export

### `GET /api/mvp/export?id=<bom_version_id>&format=<format>`

Returns a file download with `Content-Disposition: attachment`. The available formats:

- `pdf` and `docx`: priced documents.
- `x83`: GAEB XML 3.2. `x83-31`: GAEB XML 3.1.
- `x82`: cost estimate.
- `d83`, `d84`, `d86`: GAEB 90.
- `zip`: a bundle containing the PDF and Word exports.

A plain `<a href>` works for the download. With `fetch`, read the response as a blob.

### `GET /api/mvp/original?id=<source_document_id>`

Downloads the original uploaded file.

## Catalogue analytics

### `GET /api/mvp/catalogue?id=<bom_version_id>`

Returns the total and linked position counts in `positions` and `matched_positions`. Each entry
in `groups` contains a product ID, name, category, unit, scope, source position IDs and codes,
and the sum of included measurable quantities as `included_quantity`. Conditional,
unit-price-only and lump-sum positions are counted separately from the quantity total.
Unquantified included positions are reported in `unquantified_included`. Groups use existing
catalogue links and keep different units and scopes separate.

## Analysis (plausibility checks)

These endpoints run the `backend/analysis/` pipeline on a stored BOM:

- Layer 1: arithmetic, completeness, pricing and consistency checks.
- Layer 2: GAEB dependency rules, such as concrete that needs formwork.
- Layer 3: AI review of short- and long-text contradictions and layer 2 findings. Configure Ollama
  or Anthropic as described in the [deployment guide](OPERATIONS.md#enable-layer-3).

Every run is stored. Each finding has a stable `id` (its finding key). An accept or reject decision
carries over to later runs of the same BOM.

### `GET /api/mvp/rules`

Returns the rule catalogue, for legends and filters.

```json
{"default_layers": [1, 2], "layer3_provider": "none",
 "rules": [{"rule_id": "L1.ARITH.LINE_AMOUNT", "layer": 1, "category": "arithmetic", "severity": "error",
            "title": "Line amount is wrong", "description": "…"}]}
```

### `POST /api/mvp/analyze`

Request: `{"id": "<bom_version_id>", "layers": [1, 2]}`. `layers` is optional and defaults to
`[1, 2]`. The response is the same as `GET /api/mvp/analysis`.

### `GET /api/mvp/analysis?id=<bom_version_id>`

Returns the latest run and its findings. Before the first analysis, it returns
`{"run": null, "findings": [], "outdated": false}`.

```json
{
  "run": {"id": "…", "schema_version": "0.1", "input_hash": "…", "layers_run": [1, 2],
          "created_at": "2026-11-21T00:41:59.824508+00:00",
          "summary": {"total": 6, "errors": [], "by_severity": {"warning": 2, "info": 4},
                      "by_layer": {"1": 4, "2": 2}, "by_category": {"text": 4, "dependency": 2},
                      "by_rule": {"L1.TEXT.OR_EQUIVALENT": 4}}},
  "outdated": false,
  "findings": [{
    "id": "f_18163d72b01b7c7ece72b571", "layer": 2, "rule_id": "L2.CONCRETE.STRUCTURE_NEEDS_FORMWORK",
    "category": "dependency", "severity": "warning", "scope": "bom",
    "title": "Missing formwork", "message": "…", "suggested_fix": "…",
    "target": {"line_id": null, "line_code": null, "section_id": null, "area_id": null, "field": null},
    "related_line_ids": ["…"], "evidence": {}, "source_locator": null, "origin": "rule", "model": null,
    "status": "open", "decided_by": null, "decided_at": null
  }]
}
```

- `findings` are sorted by severity: `error`, then `warning`, then `info`.
- To place a finding on a row, use `target.line_id` and `related_line_ids`, which match `lines[].id`
  from `GET /api/mvp/bom`.
- `outdated: true` means the BOM changed since the run, so offer to re-run.
- `summary.errors` lists rules that crashed and layers that are not available. They are reported,
  not fatal.

### `POST /api/mvp/finding`

Records a decision. Request: `{"run_id": "…", "finding_key": "<finding id>", "status": "accepted"}`.
`status` is one of `accepted`, `rejected` or `open` (open undoes a decision).

```json
{"finding_key": "f_…", "status": "accepted", "decided_by": "tender", "decided_at": "2026-11-21T00:42:05+00:00"}
```

## Data tools and health

- `GET /admin/tables`: a browser for every table, with search, sort and filters (HTML). It is
  backed by these read-only JSON endpoints:
  - `GET /api/tables`
  - `GET /api/rows?table=…&page=…&size=25|50|100&sort=…&direction=asc|desc&q=…&where={…}`
  - `GET /api/record?table=…&where={…}`
- `GET /admin/schema`: the schema dashboard.
- `GET /healthz`: returns `{"status": "ok"}`, or **503** `{"status": "database unavailable"}`.

### `POST /api/workspace/parse?filename=<name>`

Preview an uploaded tender PDF, Word `.docx` document, or legacy Excel `.xls` workbook. Send the original bytes as the request body, with the same 128 MiB maximum as the workspace file route. PDF extraction uses Poppler. `POPPLER_BIN` can identify the folder with the Poppler tools.

The response includes `title`, `currency`, editable `positions`, the section `tree`, and `warnings`. Each position has a source-derived ID, position number (`oz`), description, quantity, unit, and the available unit price. Multiple spreadsheet sheets with readable positions get their own sections. A PDF or Word file with no identifiable positions can still be attached as a source document. The preview does not save the file or create a list. Use the workspace file and state routes to persist the import.

### Workspace bid simulator

`GET /api/workspace/bid-pricing?id=<list_id>` returns the original X83's included
positions, their stable workspace IDs and original quantities, the tender currency,
the snapshot `input_hash`, and detected line-level shortfalls. A matching stored
assessment is reused. Dismissed findings and AI reviews that identify other coverage
or exclude the work are left out of the suggested changes.

`POST /api/workspace/bid-pricing?id=<list_id>` takes
`{"input_hash": "<hash from GET>", "assumptions": {...}}` and returns the three
strategy comparisons and their proposed unit rates. Use the
[bid pricing input format](BID_PRICING.md#supply-assumptions) and up to 12 joint
market and quantity scenarios. The endpoint reads the workspace and original
upload. Assumptions and simulated rates stay outside the saved quote.
