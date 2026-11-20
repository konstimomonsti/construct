<img src="assets/icon.svg" width="64" height="64" alt="">

# ConstructionHackathon

Feature List: 
- Dashboard with general overview
- Categorization by type, cost, dependencys of the items(what do the items require?, like chairs for a table)
- risk assesment, relationships between things/ Fancy mind map
- importing from different file typed -> edeting the list -> exporting to different file types, also the stuped construction one

Created in [T3 Code](https://t3.codes).

The database uses PostgreSQL 18 and Docker Compose locally and on a VPS. The [schema dashboard](schema-dashboard.html) shows the application and document-intake tables. The SQL migrations create the schema and its integrity checks.

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

## Deploy on a VPS

Place the checkout on the VPS and run `./db/ops.sh up` there. Start with the VPS's own `.env` so local and remote installations have independent credentials. An application in the same Compose project can use `db:5432`; an application running directly on the VPS can use `127.0.0.1:5432`. The host port binds to loopback. For remote administration, forward it over SSH.

```sh
ssh -N -L 127.0.0.1:15432:127.0.0.1:5432 user@your-vps
```

With the tunnel open, a client on your machine can use `127.0.0.1:15432` and the VPS database credentials.

## Back up and restore

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

The import groups companion GAEB, Word, and PDF copies by tender position. It also merges exact full specifications with compatible tender units and keeps position-specific variants for review. New materials and equipment go into `product` as pending. The import records source positions in `catalogue_source_line`, including activities, headings, and lines whose product identity is ambiguous. Each link carries the tender unit and any observed rate. The original descriptions and prices are also available in `source_extract`.

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

## Analysis dependency checks

Layer 2 now checks 16 dependencies across screed/floor finishes, concrete, drywall, painting, and flat roofing. It uses the shared analysis models, rule registry, and runner alongside layer 1. Findings include source-related line IDs, quantity evidence, stable keys, and reviewable proposals; inputs are never modified.

```sh
python -m pip install -r requirements.txt
python -m analysis run Data/8209.003_Leistungsverzeichnis_leer.X83 --layers 1,2
python -m analysis.layer2 examples/items.json --scope trade --format table
```

See [dependency checker setup and usage](docs/DEPENDENCY_VALIDATOR.md) for parsed JSON input, room/trade scoping, custom rules, and integration details. Importing raw GAEB files also requires the existing dependencies in `importer/requirements.txt`.
