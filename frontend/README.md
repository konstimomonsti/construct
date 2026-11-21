# BillBuild frontend

BillBuild is the React/Vite budget workspace at `/`. The same origin serves the
[HTTP API](../docs/API.md) and database administration tools.

Upload files while viewing a folder or subfolder, or choose a destination from the workspace.
An imported list keeps its original file in **Documents**. A PDF can be attached to an existing
list, and an unmatched PDF gets a list of its own. Use a document’s menu to move it between folders
while keeping its list link. Folders, lists, edits, links and uploaded files sync to the shared workspace (`/api/workspace/*`), so
everyone using the site sees the same data. Each browser keeps a local copy and syncs it every few seconds.

## Development

From the repo root, start PostgreSQL and the API:

```sh
./db/ops.sh up
./db/ops.sh compose --profile app up -d --build backend
cd frontend
npm ci
npm run dev
```

Open http://localhost:5173. Vite proxies `/api`, `/admin` and `/healthz` to the backend on port 8080.
For a static production build, run `npm run build` from this directory. The VPS build runs this
automatically. See the [deployment guide](../README.md#deploy-on-a-vps).

## Demo data and export tests

The original tender files live in [data/tenders](../data/tenders/). The dev and build
commands copy them into the generated `public/files/` directory for viewing and download.
To rebuild the committed list data in `public/data/`, run `npm run data` with Poppler installed.
Run `npm run layout` with PyMuPDF installed to refresh the PDF layout metadata.

Run `npm test` to check GAEB, PDF, CSV, XLSX, and DOCX exports. The PDF checks require Poppler.
The PDF layout measurements are in [docs/pdf-templates](docs/pdf-templates/).
