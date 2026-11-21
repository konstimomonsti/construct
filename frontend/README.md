# BillBuild frontend

BillBuild is the React/Vite budget workspace at `/`. The same origin serves the
[HTTP API](../docs/API.md) and database administration tools.

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
