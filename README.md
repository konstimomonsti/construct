<img src="frontend/public/billbuild-logo-transparent.png" width="72" height="72" alt="">

# BillBuild

**A shared workspace for construction estimating and tender review.**

BillBuild turns a bill of quantities (BoQ, or *Leistungsverzeichnis*) into an editable estimate. Estimators can keep the original tender alongside the working list, review missing or inconsistent items, and see how quantity and price changes affect the project budget before exporting the result.

## From tender to estimate

1. **Bring in the tender.** Import a GAEB file or spreadsheet into a project folder. Keep the original available for download and attach supporting documents, such as the PDF printout that accompanies a priced GAEB offer.
2. **Build the estimate.** Edit quantities, units, descriptions, and unit prices in the position table. Organize positions by trade or category, set budget caps, and track totals in **Active Budgets**. Workspace lists, documents, and edits sync across browsers connected to the same deployment.
3. **Review the work.** Newly uploaded lists with positions are checked in the background. Findings show up on the affected rows, where reviewers can inspect the evidence, filter by severity or rule, and mark findings as reviewed.
4. **Check catalogue matches.** Maintain product, supplier, and subcontractor catalogues. Inspect linked products and the source of a price, and review catalogue or research suggestions against the original description.
5. **Export the result.** Download the original tender, export selected positions, or share the updated list in a format the recipient can use.

For example, an estimator can open a concrete package, review a warning about missing formwork, add or adjust the relevant position, and see the revised package total before sending out the estimate.

## Risk assessment

Every uploaded list is checked in three layers before anyone prices it:

| Layer | What it looks for |
| --- | --- |
| 1. Position rules | Missing or negative quantities, unit and arithmetic errors, duplicates, DIN 1045-2 concrete grades and exposure classes, precast layer sums, and placeholders or conflicting values in the text |
| 2. Construction dependencies | Work that is missing or under-specified, such as formwork for in-situ concrete, edge insulation for screed, or shop drawings for precast elements |
| 3. AI review (Claude) | Contradictions between short and long text, scope gaps across positions, underspecified items, and implausible quantities |

Layers 1 and 2 are deterministic and run without an AI provider. From the findings BillBuild builds:

- **A risk score** (0–100) with the top risks, risk by section and category, change-order (*Nachtrag*) signals and, for priced tenders, the money at stake.
- **Clarification questions** (*Bieterfragen*) in formal German, grouped across positions, ready to send to the client.
- **An Excel risk matrix** and a printable report.

A reviewer accepts or dismisses every finding with a reason, and the score updates as they go. BillBuild never changes the list on its own.

On planted-error tests (244 mutated tenders), layers 1 and 2 catch every planted error outside three known gaps (reworded duplicates, typos, open "nach Aufwand" quantities), with no false alarms on 46 clean controls. See the [analysis architecture](docs/ANALYSIS_LAYERS.md), [risk score](docs/RISK.md), [evaluation](docs/EVALUATION.md) and [AI provider setup](docs/OPERATIONS.md#enable-layer-3).

### Subcontractor requests

From the Export menu, pick positions and subcontractors, set an internal budget, and export a price-free request (X83, Excel or PDF) with a ready email draft (`.eml`) per subcontractor. The budget never leaves BillBuild.

### Supplier requests

**Request quotes from suppliers** (Export menu) gives every position a category, with AI for the unknown ones and German keyword matching when no API key is set. It groups the positions so each supplier gets one email for all of its categories. The **Requests** page (`/requests`) lists contacts with request and answer counts, average response time, due reminders and a contact log. Subcontractor packages log to the same history.

### Bid simulator

On an imported GAEB X83 list, the **Bid simulator** compares standard rates, price-only optimization and quantity-aware optimization. It uses direct costs, rate limits, award scenarios and quantity shortfalls found by the risk assessment, and it shows the worst-case awarded profit and suggested unit-rate changes. Results are simulations and never change the saved quote.

## File formats

| Workflow | Formats |
| --- | --- |
| Import editable lists | GAEB DA XML, GAEB 90, Excel (.xlsx and legacy .xls), CSV, TSV, JSON, and tender PDFs (read on the server; needs Poppler) |
| Attach source documents | PDF and Word (.docx). Supported documents can also supply positions or fill in missing descriptions. |
| Export lists | GAEB DA XML X83, GAEB 90 D83/D84/D86, Excel, CSV, PDF, Word, and JSON |
| Import tender bundles | The [backend importer](docs/OPERATIONS.md#import-a-tender-zip-or-document) accepts ZIP bundles and keeps the original files and extraction evidence. |

## Run BillBuild locally

Use Docker with Compose v2, Node.js 22 with npm, and OpenSSL. From the repository root:

```sh
./db/ops.sh up
(cd frontend && npm ci && npm run build)
./db/ops.sh compose --profile app up -d --build backend
```

Open [BillBuild at localhost:8080](http://127.0.0.1:8080/). Start with a bundled project or create a folder and import your own tender. See the [frontend guide](frontend/README.md) for the Vite development server and export tests.

## Deploy on a VPS

From the checkout on your server, initialize the hostname and site login, then start the stack.

```sh
./backend/deploy/deploy.sh init
./backend/deploy/deploy.sh up
```

The production stack runs BillBuild, its API, PostgreSQL, and scheduled database backups. Caddy handles HTTPS and site login. The [operations guide](docs/OPERATIONS.md#deploy-on-a-vps) covers server setup, CI deployment, backup and restore, and optional sample catalogue seeding.

## Repository layout

| Folder | Contents |
| --- | --- |
| [`frontend/`](frontend/) | React and Vite workspace, export tests, and demo tooling |
| [`backend/`](backend/) | Python HTTP API, admin tools, importer, risk analysis, and deployment configuration |
| [`db/`](db/) | PostgreSQL migrations, runtime role, and database scripts |
| [`data/`](data/) | Tender samples, CLI examples, and parser fixtures |
| [`docs/`](docs/) | [HTTP API reference](docs/API.md), [operations guide](docs/OPERATIONS.md), and technical documentation |

Created in [T3 Code](https://t3.codes).
