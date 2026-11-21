<img src="assets/icon.svg" width="64" height="64" alt="">

# BillBuild

Feature List: 
- Dashboard with general overview
- Categorization by type, cost, dependencys of the items(what do the items require?, like chairs for a table)
- risk assesment, relationships between things/ Fancy mind map
- importing from different file typed -> edeting the list -> exporting to different file types, also the stuped construction one

Created in [T3 Code](https://t3.codes).

The database uses PostgreSQL 18 and Docker Compose locally and on a VPS. The [schema dashboard](schema-dashboard.html) shows the application and document-intake tables. The SQL migrations create the schema and its integrity checks.

## Web app

BillBuild at `/` provides the project and budget library. Edits in this workspace are stored in
the browser. The [HTTP API](docs/API.md) provides database-backed drafts, catalogue analytics, and
saved risk assessments.

On a saved draft, **Catalogue analytics** groups existing catalogue links by product, unit and
supply or installed scope, with source positions and included quantities. Seed the Challenge A
catalogue to see linked examples. The [general-purpose matching and LLM reuse plan](docs/CATALOGUE_ANALYTICS_IMPLEMENTATION.md)
describes future work.

**Risk assessment** runs deterministic completeness, consistency, arithmetic and pricing checks
(layer 1), dependency checks (layer 2), and optional AI review of text contradictions and dependency
findings (layer 3). Runs, evidence and reviewer decisions are saved. Editing a draft can make an
assessment outdated.

## Run the database

Run this from the checkout on a machine with Docker Engine or Docker Desktop, Docker Compose v2, and OpenSSL. The script creates `.env` with separate generated passwords, starts PostgreSQL, applies pending migrations, and grants the application role access.

```sh
./db/ops.sh up
docker compose ps
```

| Connection setting | Default |
| --- | --- |
| Host from this machine | `127.0.0.1` |
| Host from another Compose service | `db` |
| Port | `5432` |
| Database | `construction` |
| Application user | `construction_app` |
| Application password | `POSTGRES_APP_PASSWORD` in this deployment's `.env` |

The named `postgres_data` volume persists across container restarts and `docker compose down`. Keep the same Compose project name across deployments to retain the volume. Set `POSTGRES_PORT` in `.env` if the host port is in use. PostgreSQL reads `POSTGRES_USER`, `POSTGRES_DB`, and `POSTGRES_PASSWORD` when it initializes a fresh volume. Rotate the owner password in PostgreSQL and update `.env` together. To rotate the application password, update `POSTGRES_APP_PASSWORD` and rerun `./db/ops.sh up`.

The application user can read and write application rows. The owner account handles migrations, backups, and schema administration. Open an owner session through Docker when needed.

```sh
docker compose exec db sh -c 'psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

## Repository layout

| Path | What it is |
| --- | --- |
| `db/` | PostgreSQL schema, numbered migrations, runtime role, smoke test |
| `importer/` | Tender parsing (GAEB XML/90, PDF, DOCX, ZIP) and BOM draft creation, also usable as a CLI |
| `analysis/` | Plausibility checks: layer 1 (arithmetic, completeness, pricing) and layer 2 (GAEB dependencies) |
| `backend/` | JSON API over the database, importer and analysis, plus the built-in data tools at `/admin` ([API reference](docs/API.md)) |
| `frontend/` | The product UI. It is swappable: replace the folder and rebuild ([contract](frontend/README.md)) |
| `deploy/`, `compose.prod.yaml`, `deploy.sh` | Production stack: Caddy (HTTPS, login, frontend files) in front of the backend |

## Run BillBuild locally

Start the database and backend, build the frontend, then open [BillBuild](http://127.0.0.1:8080/).

```sh
./db/ops.sh up
(cd frontend && npm ci && npm run build)
docker compose --profile app up -d --build backend
```

Use the [HTTP API](docs/API.md) to upload tender documents, create and price saved drafts,
run analysis, and export a bill of quantities. The API stores uploaded originals and review decisions.

Open [Data tables](http://127.0.0.1:8080/admin/tables) to browse the live schema without editing. Search and sort rows, select visible columns, and follow relationships. Large structured values show a preview and binary files show their byte size.

The backend binds to localhost. Set `BACKEND_PORT` in `.env` to change its port. To build a new UI against it, see [frontend/README.md](frontend/README.md). To put it on a server, see [Deploy on a VPS](#deploy-on-a-vps).

## Deploy on a VPS

`compose.prod.yaml` runs PostgreSQL, schema migrations, the backend API, Caddy with BillBuild, and nightly backups. Caddy handles HTTPS and the site login. It is the only public service. Every page and API call requires the site login.

Requirements: a Linux VPS with Docker Engine and the Compose plugin, ports 80 and 443 open, and a DNS name that points at the server. With only an IP address, use `1-2-3-4.sslip.io` (the IP with dashes). It resolves to the server and gets a real certificate.

```sh
# In the extracted bundle or checked-out project directory on the VPS
./deploy.sh init     # asks for the hostname and website login; generates database passwords
./deploy.sh up       # builds, migrates and starts everything; prints the URL
./deploy.sh seed     # optional: imports the Challenge A files in Data/ and builds the catalogue
```

`init` writes all settings to `.env.prod` with mode 600. The website password is stored only as a bcrypt hash. Leave the password empty to generate one, which `init` prints once. Without a terminal, `init` reads `APP_DOMAIN`, `BASIC_AUTH_USER` and `BASIC_AUTH_PASSWORD` from the environment.

| Command | What it does |
| --- | --- |
| `./deploy.sh model` | Start the optional Ollama service and download the configured model |
| `./deploy.sh status` | Containers and health |
| `./deploy.sh logs [backend\|web\|db\|backup]` | Follow logs |
| `./deploy.sh backup` | Write `backups/manual-<time>.dump` now |
| `./deploy.sh restore backups/FILE.dump` | Back up the current data, then replace it with FILE (asks you to type `restore`) |
| `./deploy.sh password` | Change the website login |
| `./deploy.sh update` | `git pull --ff-only`, rebuild and restart; migrations run automatically |
| `./deploy.sh down` | Stop everything; data volumes stay |
| `./deploy.sh push user@host [dir]` | Copy this checkout over SSH (without `.git`, `.env*` and `backups/`) and run `init` and `up` there |

The `backup` service writes a `pg_dump` archive to `./backups` once a day and deletes archives older than `BACKUP_KEEP_DAYS` (14 by default). Archives contain the uploaded originals. Copy them off the server regularly, for example with `rsync user@your-vps:tenderdesk/backups/ ./vps-backups/`.

Optional `.env.prod` settings: `SITE_ADDRESS` overrides the Caddy address (for example `:80` for plain HTTP behind another proxy), `HTTP_PORT` and `HTTPS_PORT` change the published ports, `BACKUP_KEEP_DAYS` sets backup retention, and `FRONTEND_DIST` names the build output folder when `frontend/` has a `package.json` (default `dist`). After replacing `frontend/`, `./deploy.sh up` rebuilds only what changed. The app accepts requests only for `APP_DOMAIN`. Uploads are limited to 128 MiB.

### Enable layer 3

Production starts with layers 1–2 enabled. For local inference, add `ANALYSIS_L3_PROVIDER=ollama`
and optionally `ANALYSIS_L3_MODEL` to `.env.prod`, then run `./deploy.sh model` and
`./deploy.sh up`. The default model is `qwen2.5:7b-instruct`. Choose a model sized for the VPS.
Ollama and its model storage run inside Docker with no published port. For a separately hosted
Ollama instance, set `OLLAMA_HOST` and run `./deploy.sh up`.

For hosted inference, set `ANALYSIS_L3_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`, and optionally
`ANALYSIS_L3_MODEL`, then run `./deploy.sh up`. In this mode the provider receives the text needed
for each requested AI check. The UI keeps the two-layer run available and reports model failures
or skipped batches. Production defaults to four model calls per run and a 45-second per-call timeout.
Use `ANALYSIS_L3_MAX_CALLS` and `ANALYSIS_L3_TIMEOUT` to tune those limits. Responses are cached
in the Docker `analysis_cache` volume.

### Test the production configuration locally

Use a separate Compose project and settings file:

```sh
export ENV_FILE=.env.prodtest COMPOSE_PROJECT_NAME=tenderdesk-test
APP_DOMAIN=localhost BASIC_AUTH_USER=tester BASIC_AUTH_PASSWORD=choose-a-password ./deploy.sh init
printf "SITE_ADDRESS=':80'\nHTTP_PORT='8088'\nHTTPS_PORT='8443'\n" >> .env.prodtest
./deploy.sh up       # http://localhost:8088
```

For database administration on the VPS, use `docker compose --env-file .env.prod -f compose.prod.yaml exec db psql -U construction construction`.

## Back up and restore (development stack)

```sh
./db/ops.sh backup backups/construction.dump
./db/ops.sh restore backups/construction.dump construction_restored
```

The backup is a PostgreSQL custom-format archive. Use a new filename for each backup. Restore creates a new database and checks that the target name is available. It applies any pending migrations and grants access with the destination deployment's application credentials. To use the restored copy as the default, verify it, set `POSTGRES_DB` to its name in `.env`, rerun `./db/ops.sh up`, and update the application connection. Keep a copy of backups off the VPS.

## Migrations and smoke test

Add subsequent numbered SQL files under `db/migrations/` and register them in `db/migrate.sql`. The migration service applies new steps transactionally and skips versions already recorded in the database.

```sh
docker compose exec -T db sh -c 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < db/smoke.sql
```

The smoke test creates a tender with two room distributions and issues a consolidated quote. It checks that duplicate pricing and edits to issued inputs are rejected, then rolls back the sample rows.

## Continuous integration

`.github/workflows/ci.yml` runs four checks on pushes to `main`, on pull requests and on manual runs.

| Job | What it checks |
| --- | --- |
| Python tests | `backend/tests` and `analysis/tests` (with `PYTHONPATH=backend:importer:.`), then `importer/tests` |
| Database and API smoke test | On a fresh PostgreSQL 18 it applies `db/migrate.sql` twice (the second run must change nothing) and runs `db/smoke.sql`. It then starts the backend as `construction_app` and runs `.github/scripts/api-smoke.sh`, which uploads a public GAEB file, builds a draft, saves a price, rejects a stale save, runs the analysis and downloads every export format. |
| Frontend lint and build | `npm ci`, `npm run lint` and `npm run build` in `frontend/` |
| Docker images and deploy config | Builds the backend, web and importer images, validates both compose files and runs shellcheck on the shell scripts |
| Deploy to VPS | Runs after all four checks pass on a push to `main`. It deploys the tested revision when it is still the tip of `main`. |

To run the API smoke test locally, point it at a backend that uses a migrated database:

```sh
.github/scripts/api-smoke.sh http://localhost:8080
```

Outside Docker, PDF export needs the DejaVu fonts. If they are not in `/usr/share/fonts/truetype/dejavu`, set `PDF_FONT_DIR` to their folder.

### Automatic VPS deployment

Initialize the VPS once using the [VPS setup](#deploy-on-a-vps). The SSH user needs Docker Compose
and `rsync` and write access to the dedicated app directory. Install the CI deployment key's
public half in that user's `authorized_keys`. On a shared VPS with an existing reverse proxy,
set `SITE_ADDRESS=:80`, `HTTP_PUBLISH=127.0.0.1:18080`, and `HTTPS_PUBLISH=127.0.0.1:18443`
in `.env.prod`. Point the HTTPS proxy at `http://127.0.0.1:18080` and preserve the original
Host header. Set `APP_DOMAIN` to the public hostname.

In GitHub under **Settings → Secrets and variables → Actions**, configure these repository settings.

| Setting | Type | Value |
| --- | --- | --- |
| `VPS_HOST` | Variable | SSH hostname or IPv4 address reachable from the deploy runner |
| `VPS_USER` | Variable | SSH deployment account |
| `VPS_PATH` | Variable | Absolute app directory containing `.env.prod`, for example `/srv/tenderdesk` |
| `VPS_PORT` | Variable | SSH port. Defaults to `22`. |
| `VPS_RUNNER` | Variable | Optional label of a dedicated Linux runner with private SSH access. Defaults to `ubuntu-latest`. |
| `VPS_SSH_KEY` | Secret | Private key dedicated to this workflow |
| `VPS_KNOWN_HOSTS` | Secret | Verified SSH host key entry for `VPS_HOST`. Use the `[host]:port` form for a nondefault port. |

Verify the host key against a trusted server fingerprint before adding it to GitHub. The workflow
synchronizes the tested Git revision into the app directory and removes stale source files.
It preserves server env files, backups and Docker volumes. The deploy job runs `./deploy.sh up`
to build the images, apply migrations and wait for the services to become healthy.

If the VPS only accepts private SSH connections, use a deploy runner on the private network with
`gh`, `git`, `ssh`, `rsync` and `tar` installed. The four CI checks still use GitHub-hosted runners.
Set `VPS_HOST` after the other settings are ready to enable the deploy job.

## Import a tender ZIP or document

```sh
./db/ops.sh up
docker compose build importer
docker compose run --rm -T \
  -v "/absolute/path/to/dataset.zip:/input/dataset.zip:ro" \
  importer import /input/dataset.zip --project "Tender intake review"
```

Use `--project-id` to import into an existing project by its UUID. A ZIP can contain several tenders, bids, or overlapping exports. A review project keeps them together until an engineer chooses which documents belong to each BOM. Repeating an import in the same project reuses each file and completed extraction by checksum and parser version.

The importer records the ZIP and all member files in `source_file`. PostgreSQL checks the SHA-256 against the document record. `source_import` tracks results and review findings. `source_extract` contains the decoded evidence and candidate fields.

| Input | Extracted evidence and fields |
| --- | --- |
| GAEB XML | Complete ordered XML tree with namespaces, attributes, text, comments, and unknown vendor elements. Structured BOQ headings, quantities, units, descriptions, flags, and references. |
| GAEB 1990 | Exact record bytes, decoded text, known fixed-width fields, and unassigned byte ranges. Structured positions, bid prices, subtotals, and price breakdowns where the records supply them. Use `--legacy-encoding` to override automatic detection. |
| PDF | Page text, word coordinates, catalog and annotation data, embedded-file and image inventories, interactive form fields, and flattened form rows. The importer proposes tender rows, quantities, unit prices, totals, and headings for review. Pages without extractable text are flagged for OCR or visual review. |
| Word | Package part inventory and checksums, ordered XML for document and relationship parts, paragraphs, and item references with group and option hints. A reference list can have incomplete quantities or scope. |

The exact original is retained even when a field cannot be normalized or a parser fails. Inspect the findings and evidence with the IDs returned by the import command:

```sh
docker compose run --rm -T importer report DOCUMENT_UUID
docker compose run --rm -T importer records IMPORT_UUID --kind item_candidate --limit 10
docker compose run --rm -T importer original DOCUMENT_UUID > restored-upload.pdf
```

After reviewing the source, choose a document to create a draft BOM or copy submitted rates into `reference_price`. These are explicit steps because a companion PDF, GAEB file, or excerpt may describe the same work. Reference prices start without a BOM match. Draft scope retains the source locator for each item. Material and activity classification starts as pending review.

```sh
docker compose run --rm -T importer draft DOCUMENT_UUID --package-code FLOOR
docker compose run --rm -T importer prices BID_DOCUMENT_UUID --currency EUR
```

For a native run, install Python dependencies from `importer/requirements.txt` and Poppler utilities. Set libpq's `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, and `PGPASSWORD` using the deployment's application connection settings. Run `PYTHONPATH=importer python -m tender_import --help` from the checkout.

## Product catalogue

The shared catalogue has suppliers, product categories, supplier-specific products, and dated prices. For example, a `20 × 3 cm steel pipe` can belong to `Pipes`, have a supplier SKU, and be priced per metre. A BOM material item can optionally link to that product and keep its source description and unit.

An approved product requires a supplier, a purchase unit, and a dated price. An imported product starts pending review and can have missing fields. Add a dated price row when a rate changes. Each row carries its currency, and the amount is per product purchase unit. The query below lists the latest applicable EUR supplier quote for each approved product in `Pipes`.

```sql
SELECT p.name, p.description, s.name AS supplier, p.unit_code,
       rate.valid_from, rate.currency, rate.unit_price
FROM product p
JOIN supplier s ON s.id = p.supplier_id
JOIN product_category c ON c.id = p.category_id
JOIN LATERAL (
    SELECT valid_from, currency, unit_price
    FROM product_price
    WHERE product_id = p.id AND currency = 'EUR' AND price_basis = 'supplier_quote'
      AND valid_from <= CURRENT_DATE
    ORDER BY valid_from DESC
    LIMIT 1
) rate ON true
WHERE p.review_status = 'approved' AND c.name = 'Pipes'
ORDER BY p.name, s.name;
```

### Challenge A catalogue import

After importing the dataset into the project `Challenge A import review`, apply the migrations and run the catalogue import. Pass `--project "Your import project"` if you used a different project name. The importer reuses catalogue entries and source links when rerun.

```sh
./db/ops.sh up
docker compose build importer
docker compose run --rm -T importer challenge-catalogue
```

The import groups companion GAEB, Word, and PDF copies by tender position. It also merges exact full specifications with compatible tender units and keeps position-specific variants for review. New materials and equipment go into `product` as pending. The import records classified source positions in `catalogue_source_line`, including activities and headings. Each link carries the tender unit and any observed rate. Unclassified positions and their evidence remain in `source_extract` only.

The importer stores dated rates in `product_price` for supply-only positions whose PDF and D84 quantities, rates, and line amounts agree in offer AN24-0305 from 25 November 2024. These entries use the anonymized bidder `[FIRMA_110]` and price basis `tender_offer`. The paired conduit’s rate is per metre of the pair. Mixed work rates and other observed prices stay on their source positions. Missing suppliers, purchase units, and rates stay empty.

Use this query to inspect the catalogue, including entries that still need commercial details.

```sql
SELECT p.name, c.name AS category, s.name AS supplier, p.unit_code, p.review_status,
       d.filename, src.source_line_code, src.tender_unit
FROM product p
JOIN product_category c ON c.id = p.category_id
LEFT JOIN supplier s ON s.id = p.supplier_id
LEFT JOIN catalogue_source_line src ON src.product_id = p.id AND src.source_kind <> 'price'
LEFT JOIN source_document d ON d.id = src.source_document_id
ORDER BY c.name, p.name, d.filename, src.source_line_code;
```

## MVP research model

Use GPT-6 Luna (`gpt-6-luna`) to research unmatched materials and activities and prepare cited suggestions for human approval. The planned local integration uses [Sign in with ChatGPT](https://developers.openai.com/siwc/quickstart) with eligible plan usage. Verify Luna appears in the connected account’s model list and run a web search smoke test before enabling automated research. [Web search availability](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) depends on the model and account policy.

For VPS deployment, eligible ChatGPT Pro and Business users can link [subscription API credits](https://developers.openai.com/api/docs/guides/chatgpt-api-credits) to an API organization. Those credits cover Responses API calls and web search. The account connection and research worker are pending implementation.

## Quote workflow

Create a draft quote and its lines from one estimate. For tender-linked lines, use the tender quantities and units and provide the selling rates. On issue, the database checks quantities, alternative selection, inclusion in totals, and rounding. It saves the reconciled totals and locks the estimate and referenced BOM scope. Approval and issue are explicit transitions. Use `tax_rate` as a fraction, for example `0.19` for 19%. The default quote policy uses two decimal places for line amounts and rounds tax once per tax rate. Set `pricing_policy.amount_scale` or `pricing_policy.tax_rounding` (`rate_total` or `line`) when the quote format calls for a different convention.

The application will supply the upload and review screens, risk decisions, cost build-ups, and selling-price calculations from markup or margin. Database backups include uploaded originals and source evidence.

### Stored BOM catalogue analytics

Apply the database migrations, install the database extra with `pip install -e '.[db]'`, and create a draft using the importer. Use the runtime role to connect. The CLI accepts `DATABASE_URL` or standard libpq environment variables. Set `DATABASE_URL` to enable the **Stored BOM catalogue** panel in the local web app.

```sh
python -m analysis catalogue process BOM_VERSION_UUID
python -m analysis catalogue report BOM_VERSION_UUID --out catalogue.json
python -m analysis catalogue process BOM_VERSION_UUID --llm
python -m analysis catalogue review BOM_VERSION_UUID OCCURRENCE_UUID accept --decision-id DECISION_UUID --reviewer "Reviewer name"
python -m analysis catalogue review BOM_VERSION_UUID OCCURRENCE_UUID correct --product-id PRODUCT_UUID --decision-id DECISION_UUID --reviewer "Reviewer name"
python -m analysis catalogue history BOM_VERSION_UUID OCCURRENCE_UUID
python -m analysis catalogue retry BOM_VERSION_UUID OCCURRENCE_UUID --decision-id DECISION_UUID --attempt-id ATTEMPT_UUID
```

The pipe and cable conduit pilot matches technical specifications, approved aliases, and supplier-qualified SKUs. It captures references, conflicting attributes, and scope evidence for review. The model uses the existing `ANALYSIS_L3_PROVIDER` configuration only when explicitly enabled. Review decisions and saved responses are reusable within the project. An approved new identity becomes a pending product, with commercial fields completed through the existing catalogue workflow.

`approve-alias` takes a BOM version UUID, a product UUID, the alias, and `--reviewer`. Use `--share` to approve a project-independent alias across projects. Review and retry commands require the current decision ID from the report. A retry also requires the latest attempt ID so competing requests cannot both retry the same attempt.

Selected totals include supported quantity conversions and preserve paired bases. The report shows alternative, conditional, included, and companion occurrences with their selection status. Companion-only positions require reconciliation with primary scope before contributing to totals. The web panel uses the same service as the CLI. See [the implementation plan and verification commands](docs/CATALOGUE_ANALYTICS_IMPLEMENTATION.md).

## Analysis dependency checks

Layer 2 now checks 16 dependencies across screed/floor finishes, concrete, drywall, painting, and flat roofing. It uses the shared analysis models, rule registry, and runner alongside layer 1. Findings include source-related line IDs, quantity evidence, stable keys, and reviewable proposals; inputs are never modified.

```sh
python -m pip install -r requirements.txt
python -m analysis run Data/8209.003_Leistungsverzeichnis_leer.X83 --layers 1,2
python -m analysis.layer2 examples/items.json --scope trade --format table
```

The backend runs both layers on a stored BOM and keeps every run in `analysis_run` / `analysis_finding`. Accept or reject decisions carry over to later runs by finding key. See `POST /api/mvp/analyze`, `GET /api/mvp/analysis` and `POST /api/mvp/finding` in the [API reference](docs/API.md).

See [dependency checker setup and usage](docs/DEPENDENCY_VALIDATOR.md) for parsed JSON input, room/trade scoping, custom rules, and integration details. Importing raw GAEB files also requires the existing dependencies in `importer/requirements.txt`.
