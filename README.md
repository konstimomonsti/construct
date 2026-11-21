<img src="frontend/public/billbuild-logo.png" width="72" height="72" alt="">

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

| Check | What it looks for |
| --- | --- |
| Position and pricing checks | Missing quantities or units, inconsistent values, arithmetic issues, and pricing anomalies |
| Construction dependencies | Work that may be missing or under-specified, such as formwork for in-situ concrete or primer for flooring |
| Optional AI review | Contradictions in descriptions and context that may confirm or qualify a dependency finding |

The first two layers run without an AI provider. Findings give the reviewer evidence and suggested next steps. Reviewers decide which edits to make. See the [analysis architecture](docs/ANALYSIS_LAYERS.md) and [AI provider setup](docs/OPERATIONS.md#enable-layer-3).

## File formats

| Workflow | Formats |
| --- | --- |
| Import editable lists | GAEB DA XML, GAEB 90, Excel (.xlsx), CSV, TSV, and JSON |
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
