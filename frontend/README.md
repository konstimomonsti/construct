# BillBuild frontend

BillBuild is the React/Vite budget workspace at `/`. The database-backed Tender Desk at
`/tender-desk/` ships from `public/tender-desk/` in the same build. Both use the same origin in
production. Tender Desk calls the [HTTP API](../docs/API.md).

## Development

From the repo root, start PostgreSQL and the API:

```sh
./db/ops.sh up
docker compose --profile app up -d --build backend
cd frontend
npm ci
npm run dev
```

Open http://localhost:5173. Vite proxies `/api`, `/admin` and `/healthz` to the backend on port 8080.
For a static production build, run `npm run build` from this directory. The VPS build runs this
automatically. See the [deployment guide](../README.md#deploy-on-a-vps).
