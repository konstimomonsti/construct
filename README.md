<img src="frontend/public/billbuild-logo-transparent.png" width="72" height="72" alt="">

# BillBuild

**A shared workspace for construction estimating and tender review.**

BillBuild turns a bill of quantities (BoQ, or *Leistungsverzeichnis*) into an editable estimate. Estimators can review tender warnings, collect subcontractor and supplier quotes, build a priced offer, and keep the client’s award with the original tender.

## From tender to estimate

1. **X83 · Tender.** Import a BoQ into a project folder and keep its original file available for download. Review warnings and edit quantities, units, descriptions, and unit prices in the position table. Use the product, supplier, and subcontractor catalogues to check matches and review web price suggestions before applying them.
2. **Subcontractors.** Select positions and recipients, record an internal estimate, and prepare price-free X83, Excel, or PDF packages with email drafts (`.eml`). Mark requests as sent after sending them, import the returned X84 or Excel offers, and choose quotes to use.
3. **X84 · Our offer.** Review prices from selected subcontractor offers and the position table, apply the prices you want to keep, and export the priced GAEB X84.
4. **X86 · Award.** Attach the client’s award to the tender when it arrives.

Workspace lists, documents, and edits sync across browsers on the same deployment. **Priced Lists** shows priced work across projects. Use **Export → Request quotes from suppliers** to group positions by category and prepare one draft per supplier. **Requests** tracks supplier and subcontractor correspondence, replies, and due dates.

## Risk assessment

Uploading a list with positions queues a background assessment. Reports are tied to the assessed list revision, and the workspace indicates when edits make a report stale.

| Layer | What it looks for |
| --- | --- |
| 1. Position rules | Missing or negative quantities, unit conflicts, line and subtotal arithmetic, duplicate position codes, and concrete and precast specification checks |
| 2. Construction dependencies | Work that is missing or under-specified, such as formwork for in-situ concrete, edge insulation for screed, or shop drawings for precast elements |
| 3. Optional AI review | Contradictions, scope gaps, underspecified items, and written quantity requirements across positions |

The first two layers run by default. Layer 3 requires a configured Anthropic or Ollama provider. The workspace reports when AI coverage is partial. [AI provider setup](docs/OPERATIONS.md#enable-layer-3)

The **Warnings** panel groups findings by type and links to the affected positions. Open a warning to inspect its evidence, copy a German client clarification draft where available, or review findings one by one. **Fix all** previews applicable edits and marks the remaining open findings as reviewed on confirmation. Applied edits can be undone. Use the list’s **More actions** menu to export the Excel risk matrix, print the review, or save a corrected version. [Analysis architecture](docs/ANALYSIS_LAYERS.md) · [Evaluation and fixtures](docs/EVALUATION.md)

## Bid simulator

On an imported GAEB XML X83, compare standard rates, price-only optimization, and quantity-aware optimization using direct costs, rate limits, and award scenarios. Verified quantity shortfalls can prefill a scenario through **Simulate extra units**. For example, a specification requiring four chairs per table for ten tables needs 40 chairs. If the BoQ lists 20, the finding can supply a 20-chair increase to the simulator. Proposed rates stay in the simulation. [Bid pricing guide](docs/BID_PRICING.md)

## File formats

| Workflow | Formats |
| --- | --- |
| Import editable lists | GAEB DA XML, GAEB 90, Excel (.xlsx and legacy .xls), CSV, TSV, JSON, and supported tender PDFs and BillBuild PDF or Word exports |
| Attach source documents | PDF and Word (.docx), plus GAEB award files in the X86 stage |
| Export lists | GAEB DA XML X83 (3.2 or 2004), X84 (3.2), GAEB 90 D83/D84/D86, Excel, CSV, PDF, Word, and JSON |
| Import tender bundles | The [backend importer](docs/OPERATIONS.md#import-a-tender-zip-or-document) accepts ZIP bundles and keeps the original files and extraction evidence. |

## Run BillBuild locally

Use Docker with Compose v2, Node.js 22 with npm, and a shell with OpenSSL. On Windows, run the shell commands in Git Bash or WSL. From the repository root, start PostgreSQL, build the frontend, and start the API.

```sh
./db/ops.sh up
(cd frontend && npm ci && npm run build)
./db/ops.sh compose --profile app up -d --build backend
```

Open [BillBuild at localhost:8080](http://127.0.0.1:8080/). Try a bundled project, import one of the [demo X83 tenders](data/demo/README.md), or create a folder and upload your own tender. The backend container includes Poppler for PDF extraction. See the [frontend guide](frontend/README.md) for the Vite development server and test commands.

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
| [`db/`](db/) | PostgreSQL migrations, runtime role, and database scripts. The activity catalogue schema stores own and subcontractor prices, with optional [SIM40 demo data](db/seeds/sim40_catalogue.sql). |
| [`data/`](data/) | Tender samples, CLI examples, and parser fixtures |
| [`docs/`](docs/) | [HTTP API reference](docs/API.md), [operations guide](docs/OPERATIONS.md), and technical documentation |

Created in [T3 Code](https://t3.codes).
