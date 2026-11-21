# Public web container: Caddy (HTTPS + password + proxy) with the frontend baked in.
# Build context is the repository root. frontend/ is swappable:
#   - with a package.json: `npm ci && npm run build`, then FRONTEND_DIST (default dist) is served;
#   - without one: the folder is served as-is (plain HTML/CSS/JS).
FROM node:22-alpine AS frontend
ARG FRONTEND_DIST=dist
WORKDIR /src
COPY frontend/ ./
RUN set -eu; \
    if [ -f package.json ]; then \
        if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; \
        elif [ -f pnpm-lock.yaml ]; then corepack enable && pnpm install --frozen-lockfile; \
        elif [ -f yarn.lock ]; then corepack enable && yarn install --frozen-lockfile; \
        else npm install --no-audit --no-fund; fi; \
        npm run build; \
        [ -f "$FRONTEND_DIST/index.html" ] || { echo "frontend build did not produce $FRONTEND_DIST/index.html (set FRONTEND_DIST)" >&2; exit 1; }; \
        mv "$FRONTEND_DIST" /out; \
    else \
        [ -f index.html ] || { echo "frontend/ needs an index.html or a package.json" >&2; exit 1; }; \
        mkdir /out && cp -R . /out/ && rm -f /out/README.md /out/Dockerfile*; \
    fi

FROM caddy:2.10-alpine
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=frontend /out /srv
