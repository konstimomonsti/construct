# BillBuild: guide for every agent and teammate

Read this file and your own `tasks/0X-*.md` file. You don't need to read anything else unless your task file
lists it. `STATUS.md` tracks who is doing what.

## 1. What we are building (hackathon MVP)

BillBuild is a shared workspace for German construction tenders. A contractor uploads a client's bill of
quantities (Leistungsverzeichnis, LV), which can be GAEB X83/D83/D84/D86, PDF, Word, Excel or CSV. BillBuild
then finds what is wrong or risky **before** the contractor prices and submits an offer:

1. **Find errors** in three layers. Layer 1 is deterministic rules (quantities, units, sums, DIN 1045-2,
   text defects). Layer 2 is dependency rules (screed needs edge insulation, precast needs shop drawings).
   Layer 3 uses Claude through the Anthropic API for what needs reading comprehension: contradictions,
   cross-item scope gaps, underspecified text and implausible quantities.
2. **Rank the risk.** It produces a risk score with top risks, risk by section and category, and change-order
   (Nachtrag) signals.
3. **Have a person review every finding.** They accept or dismiss it with a reason. **Nothing is changed
   automatically.**
4. **Export.** It produces client clarification questions in German (Bieterfragen) and an Excel risk matrix,
   and the report can be printed.
5. **Prove it works.** We plant known errors in tenders and measure recall and precision per rule.

The demo runs on the **VPS** (`backend/deploy/compose.prod.yaml`, which auto-deploys on push to `main`).
Layer 3 **must work live** with `ANALYSIS_L3_PROVIDER=anthropic`.

The reference trade for the new precast and DIN checks is `data/tenders/LV_11_Stahlbetonfertigeile_Sandwichsockel.pdf`.
Biel's spec is [docs/lv_hybrid_validation_implementation_guide.md](docs/lv_hybrid_validation_implementation_guide.md).
**We implement it inside the existing `backend/analysis` layers, not as a separate `lv-validator/`
project, and with Anthropic instead of Gemini.** Its checks map onto our rule IDs in §5.3.

## 2. Stack and layout

| Path | What | Stack |
|---|---|---|
| `frontend/` | React workspace UI (lists, editing, findings on rows, exports) | React 19, Vite 8, TypeScript 7, Tailwind 4, zustand, exceljs, pdf-lib |
| `backend/server.py` | HTTP API (plain `http.server`, no framework) + upload-assessment worker | Python 3.11+ (CI 3.12), psycopg 3 |
| `backend/analysis/` | Analysis package: `contracts.py`, `adapter.py`, `runner.py`, `layer1/`, `layer2/`, `layer3/` | Pydantic v2, `Decimal` |
| `backend/importer/tender_import/` | GAEB/PDF/Word importer into Postgres | lxml, Poppler `pdftotext` |
| `db/migrations/` | PostgreSQL 18 schema, numbered SQL files registered in `db/migrate.sql` | |
| `data/tenders/` | Real (anonymized) tender files. **Never send them to an external API except through layer 3.** | |
| `docs/` | API reference (`API.md`), analysis docs (`ANALYSIS_*.md`, `DEPENDENCY_VALIDATOR.md`) | |

How an upload flows through the system:

```
browser parses the file (frontend/src/lib/parse-list-file.ts)
  -> POST /api/workspace/state (list + original file synced)
  -> backend/workspace_analysis.py queues an assessment, and its worker runs analysis.runner.analyze(layers 1,2[,3])
  -> report stored in workspace_assessment.report
  -> GET /api/workspace/analysis?id=<list_id>  ->  frontend/src/lib/risk-assessment.ts  ->  findings on rows (ListPage)
```

## 3. Commands

PowerShell uses `;` as the `PYTHONPATH` separator and bash uses `:`.

```powershell
# Python setup (once)
python -m pip install -r backend/requirements.txt -r backend/importer/requirements.txt pytest "psycopg[binary]" python-docx==1.2.0 reportlab==4.5.1 "anthropic>=2.12,<3"
# Analysis tests (fast, no DB). Run before every commit that touches backend/analysis
$env:PYTHONPATH="backend;backend/importer"; python -m pytest -q backend/analysis/tests
# All backend tests (CI runs these too)
$env:PYTHONPATH="backend;backend/importer"; python -m pytest -q backend/tests backend/analysis/tests
# Run the analysis on a file or AnalysisInput JSON
$env:PYTHONPATH="backend;backend/importer"; python -m analysis run backend/analysis/tests/fixtures/lv11_precast.json --layers 1,2
$env:PYTHONPATH="backend;backend/importer"; python -m analysis rules
# Frontend
cd frontend; npm ci; npm run lint; npm run build; npm test
# Full local stack (Docker): DB + backend on http://127.0.0.1:8080, then `npm run dev` proxies /api to it
./db/ops.sh up; ./db/ops.sh compose --profile app up -d --build backend
```

- **Poppler, not xpdf.** On Windows, Git Bash's `pdftotext` is xpdf 4.00, and PDF import breaks with it
  without any error. Use Poppler (MiKTeX ships it) or run from PowerShell. Check with `pdftotext -v`.
- `python -m analysis run` accepts GAEB XML / GAEB 90 files or an `AnalysisInput` JSON. PDFs are not accepted
  yet (task 06 fixes that).
- The fixture `backend/analysis/tests/fixtures/lv11_precast.json` is LV_11 (9 positions) as an
  `AnalysisInput`. Today it yields **0 findings**. Tasks 01 and 02 make it light up.

## 4. Conventions

- **Scope discipline.** Change only the files your task allows. If you need a change elsewhere, write it under
  "Blockers / requests" in your task file and in your `STATUS.md` notes, and work around it.
- **Python:** type hints, Pydantic v2, `Decimal` for money and quantities (never float in contracts), pure
  functions where possible. Register rules with `@rule(...)` from `analysis/registry.py` and build findings with
  `ctx.finding(...)`. Look at an existing module in the same layer and copy its style.
- **Rule IDs:** `L<layer>.<CATEGORY>.<NAME>`, uppercase. Severity is `error` / `warning` / `info`. Layer 3
  findings are never `error`.
- **German** is for user-facing tender text and Bieterfragen (formal "Sie"). **English** is for code, comments,
  docs and UI labels, unless the UI around it is German.
- **Tests:** every new rule gets a positive and a negative test. No test may call a real LLM. Use
  `FakeProvider` from `analysis/layer3/provider.py`. Mark live tests `@pytest.mark.integration` and skip
  them unless `ANTHROPIC_API_KEY` is set.
- **Frontend:** follow the existing component style in `frontend/src/components`, run `npm run lint` and
  `npm run build` before committing, and use German number formatting (`lib/format.ts`).
- **No new heavy dependencies** without writing them in your task notes. Already available: `python-docx`,
  `reportlab`, `anthropic` (backend Docker image) and `exceljs` (frontend).
- `.gitignore` ignores `*.json` and `*.csv` except `backend/analysis/**/*.json` and `data/examples/*.json`.
  Put JSON fixtures under `backend/analysis/`. For frontend fixtures, use `.ts` files.
- **Don't over-engineer.** Make the smallest change that meets the acceptance criteria. Don't refactor code you
  don't own.

### Git workflow

1. `git checkout main; git pull; git checkout -b feat/task-0X`.
2. Commit in small steps. Write messages as full sentences (for example "Add DIN 1045-2 exposure class checks").
3. Before pushing: `git fetch origin; git merge origin/main`, then run your task's tests.
4. `git push -u origin feat/task-0X` and open a PR to `main` (`gh pr create`, or the GitHub web UI).
   **Never push to `main` directly.** It auto-deploys to the VPS. The lead merges.
5. **STATUS.md:** edit **only your own row**. Conflicts in that file are expected and the lead resolves them.

## 5. Shared interface contracts

These are fixed for wave 1. If you need to change one, ask the lead first.

### 5.1 Analysis input and output (existing, `backend/analysis/contracts.py`, SCHEMA_VERSION 0.1 → 0.2 by task 03)

- `AnalysisInput`: `project`, `bom`, `sections[]`, `lines[]` (`id`, `code` = OZ, `short_text`, `long_text`,
  `quantity` Decimal, `quantity_raw`, `unit` canonical (`ea`, `m`, `m²`, `m³`, `t`, `kg`, `h`, `lump_sum`, …),
  `unit_raw`, `pricing_basis`, `total_rule`, `price`, `source_amounts`, `source_locator`).
- `Finding`: `id` (stable, `finding_key(rule_id, target, discriminator)`), `layer`, `rule_id`, `category`,
  `severity`, `scope` (`line|section|area|bom`), `target` (`line_id`, `line_code`, `section_id`, `field`),
  `related_line_ids`, `title`, `message`, `evidence` (free dict), `suggested_fix` (`Fix`), `origin`
  (`rule|llm`), `model`, `status`.
- A layer is a package exposing `run(input, prior_findings, errors) -> list[Finding]`. A crashing rule goes to
  `errors` and never stops the others.

### 5.2 Evidence keys every rule may set (new convention, wave 1)

| Key | Type | Meaning | Consumers |
|---|---|---|---|
| `evidence.bieterfrage_de` | `str` | A ready formal German clarification question, starting with `Zu Pos. {oz}: …` | task 03 (questions) |
| `evidence.din` | `{"grade": "C35/45", "exposure": ["XC2","XF2"], "required_min": "C25/30"}` | DIN 1045-2 facts | 03, 04 |
| `evidence.extracted` | `dict` | Fields layer 3 extracted from the text (for example the precast `PrecastElementItem` fields from Biel's spec §3) | 04 (drawer), 05 |
| `evidence.amount_at_stake` | decimal string | Money affected, when known | 03 |
| `evidence.change_order` | `true` | The finding signals likely change-order (Nachtrag) exposure | 03 |

Map Biel's severities: `HIGH` → `error` (`warning` in layer 3), `MEDIUM` → `warning`, `INFO` → `info`.

### 5.3 Reserved rule-ID namespaces (no two tasks create the same IDs)

| Task | Owns these rule IDs | Biel's spec equivalent |
|---|---|---|
| 01 | `L1.DIN.*`, `L1.PRECAST.*`, `L1.UNIT.TRADE_MISMATCH`, `L1.TEXT.VALUE_CONFLICT`, `L1.TEXT.SPEC_PLACEHOLDER`, `L1.TEXT.UNCLEAR_DIMENSION`, `L1.TEXT.REFERENCE_UNRESOLVED`, `L1.TEXT.SPEC_ATTRIBUTE_MISSING`, `L2.PRECAST.*` (+ any new `L2.<TRADE>.*` group) | `DIN_001`, `DIN_NOTE_*`, `MATH_001`, `DEP_003`, `VOB_001` |
| 02 | `L3.PRECAST.*`, `L3.SCOPE.*`, `L3.OPT.*`, `L3.TEXT.UNDERSPECIFIED`, `L3.QTY.IMPLAUSIBLE` | Step 2 extraction, `DEP_001`, `DEP_002`, `LLM_SCOPE_01..03`, `LLM_OPT_01` |
| 03 | no rules. Change-order wording signals (Stundenlohn, nach Aufwand, bauseits, nach Angabe des AG, ggf., ca., Zulage, ground risk, …) and quantity signals live in `AnalysisResult.risk.change_order_signals`, not in findings | Step 5 data |

### 5.4 Contract v0.2: `AnalysisResult.risk` and `AnalysisResult.questions` (task 03 implements, task 04 consumes)

`analysis.runner.analyze()` adds both fields. They therefore appear in every report:
`GET /api/workspace/analysis?id=` → `{"state": "ready", "report": {…AnalysisResult…, "used_source", "source_notice"}}`
and `GET /api/mvp/analysis`. Older reports have no `risk`/`questions`, and the frontend must handle that.
Decimals are strings.

```jsonc
"risk": {
  "version": "risk/1",
  "score": 62,                       // 0..100 = round(100 * S / (S + scale)), S = sum of points of OPEN items
  "level": "high",                   // low <25, medium <50, high <75, critical >=75
  "scale": 40,                       // constant used above, so the UI can re-score after decisions
  "priced": false,                   // true if any line has a unit price
  "currency": "EUR",
  "money_at_stake": null,            // decimal string, sum of amounts tied to open items, null if not priced
  "points": {"f_ab12…": 8, "co_3.2.70_rebar": 5},   // finding id or signal id -> points
  "open_counts": {"error": 3, "warning": 7, "info": 12},
  "top_risks": [                     // max 10, sorted by points desc
    {"line_id": "lv11-3.2.20", "line_code": "3.2.20", "short_text": "FS 01: FT-Sockel…",
     "points": 14, "amount": null, "reasons": ["Concrete grade below DIN 1045-2 minimum", "Missing height"],
     "item_ids": ["f_ab12…", "f_cd34…"]}
  ],
  "by_section": [{"section_id": "s-3.2", "code": "3.2", "title": "Stahlbetonfertigteile", "points": 40, "open": 9}],
  "by_category": {"din": 12, "dependency": 10, "text": 4},
  "change_order_signals": [          // Nachtrag exposure, dismissable like findings
    {"id": "co_3.2.70_rebar", "kind": "scope_gap|provisional|hourly_work|by_client|vague_quantity|missing_dependency|zero_qty_priced",
     "line_id": "lv11-3.2.70", "line_code": "3.2.70", "title": "Rebar scope unclear",
     "message": "…", "points": 5, "finding_ids": ["f_…"]}
  ]
},
"questions": [                       // Bieterfragen, German, grouped across positions
  {"id": "q_1a2b…", "topic": "Fehlende Angaben", "text_de": "Zu Pos. 3.2.20 – 3.2.60: …",
   "line_codes": ["3.2.20","3.2.30","3.2.40","3.2.50","3.2.60"], "finding_ids": ["f_…"], "rule_id": "L3.PRECAST.MISSING_SPEC"}
]
```

Default points per finding are `error` 8, `warning` 4 and `info` 1, multiplied by 1.5 if
`evidence.change_order` is set. When the tender is priced, add `min(10, amount_at_stake / 1000)`. Task 03 may
tune these weights. **The field names, the score formula and the meaning of `points` are fixed.** A question comes from `evidence.bieterfrage_de` first, then a
per-rule template in `analysis/questions.py`. Otherwise there is no question. Price, arithmetic and bidder-input
rules produce no questions.

### 5.5 Reviewer decisions (task 04, frontend only, synced through the workspace)

Decisions are stored in the list patch: `listPatch[listId].findingDecisions: Record<itemId, Decision>`, where
`itemId` is a finding id or a change-order signal id:

```ts
type Decision = { status: 'accepted' | 'dismissed'; reason?: 'not_an_error' | 'covered_elsewhere' | 'by_client' | 'will_ask_client' | 'other'; note?: string; at: string }
```

Keep writing the legacy `reviewedFindings` array (ids with any decision) so older code keeps working.
**The live score** is `risk.score` recomputed client-side by dropping `points` of decided items.

### 5.6 Server-side PDF/XLS parsing (task 06)

`POST /api/workspace/parse?filename=<name>` takes the raw file bytes as the body and returns the list JSON that
`parseListJson` in `frontend/src/lib/parse-list-file.ts` already reads:

```json
{"title": "LV 11 …", "currency": "EUR", "positions": [{"id": "p1", "oz": "3.2.20", "short": "…", "long": "…",
  "qty": 1, "unit": "St", "up": null, "lumpSum": false, "path": [{"oz": "3", "label": "Betonarbeiten"}, {"oz": "3.2", "label": "Stahlbetonfertigteile"}]}],
 "tree": [], "warnings": ["…"]}
```

### 5.7 Layer 3 configuration (task 02 owns, VPS env in `.env.prod`)

`ANALYSIS_L3_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`, `ANALYSIS_L3_MODEL` (default `claude-haiku-5-5`),
`ANALYSIS_L3_AUDIT_MODEL` (new, default `claude-sonnet-5-5`, for whole-LV audits), `ANALYSIS_L3_MAX_CALLS`,
`ANALYSIS_L3_TIMEOUT`. Responses are cached on disk (`ANALYSIS_L3_CACHE`), so a re-run of the demo costs nothing.

### 5.8 Evaluation labels (task 05)

Mutated files carry `<name>.labels.json` with schema `construct-eval-labels/1`. Each label has a target
(`line_codes`, `trigger_codes`), `expect` (rule-id fnmatch patterns), `match`
(`line|section|dependency|bom`), `also_acceptable` and `gap`. Labels key on OZ codes, never on line ids
(ids depend on the file hash).
