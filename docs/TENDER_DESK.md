# Tender Desk frontend

The database-backed editor lives at `frontend/public/tender-desk/` and ships with VaultBudget.
It uses the [same-origin HTTP API](API.md) for file import, draft editing, export, catalogue
analytics and risk review. It is built into the Caddy image alongside the React app.

1. Create or pick a project. Upload a tender or use **Review original** on a bundled VaultBudget
   list to import its source into the selected project.
2. Open a bill and edit its positions. The editor displays source quantities, rates and linked
   catalogue products.
3. Save before opening **Catalogue analytics**, running a **Risk assessment**, or exporting.
4. Inspect findings and evidence. Accept, reject or reopen a finding to record a review decision.
   A decision leaves the source bill untouched.

The browser sends the site's Basic Auth login with relative API and admin URLs. Keep scripts
in bundled assets and asset requests on the same origin. Caddy reserves `/api/*`, `/admin/*`
and `/healthz` for the backend.
