#!/usr/bin/env bash
# Tender desk production control script. Run it from the repository on the VPS.
#
#   ./backend/deploy/deploy.sh init            create .env.prod (domain, login, generated database passwords)
#   ./backend/deploy/deploy.sh up              build images, run migrations, start db + backend + web (HTTPS) + backups
#   ./backend/deploy/deploy.sh seed            import data/tenders/ and build the Challenge A catalogue
#   ./backend/deploy/deploy.sh model           start Ollama and pull the configured Layer 3 model
#   ./backend/deploy/deploy.sh compose [ARGS...]   run Compose with the production configuration
#   ./backend/deploy/deploy.sh status          show containers and health
#   ./backend/deploy/deploy.sh logs [SERVICE]  follow logs (backend, web, db, backup, migrate)
#   ./backend/deploy/deploy.sh backup          write a database backup now
#   ./backend/deploy/deploy.sh restore FILE    replace the database with a backup (asks for confirmation)
#   ./backend/deploy/deploy.sh password        change the website login password
#   ./backend/deploy/deploy.sh update          git pull (when this is a git checkout) and redeploy
#   ./backend/deploy/deploy.sh down            stop everything (data volumes are kept)
#   ./backend/deploy/deploy.sh push USER@HOST [DIR]   copy this checkout to a server over SSH and run init + up there
#
# Settings live in .env.prod (override with ENV_FILE=...). Non-interactive init reads
# APP_DOMAIN, BASIC_AUTH_USER and BASIC_AUTH_PASSWORD from the environment.
set -euo pipefail

cd "$(dirname -- "${BASH_SOURCE[0]}")/../.."
ENV_FILE=${ENV_FILE:-.env.prod}
CADDY_IMAGE=caddy:2.10-alpine
SEED_PROJECT="Challenge A import review"
if [ -d backups ]; then
    export BACKUP_DIR=${BACKUP_DIR:-./backups}
else
    export BACKUP_DIR=${BACKUP_DIR:-./data/backups}
fi

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
compose() { docker compose --project-directory "$PWD" --env-file "$ENV_FILE" -f backend/deploy/compose.prod.yaml "$@"; }
need_env() { [ -f "$ENV_FILE" ] || die "$ENV_FILE not found. Run ./backend/deploy/deploy.sh init first."; }

env_get() { sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | tail -n1 | sed "s/^'\(.*\)'$/\1/"; }

env_set() {  # env_set KEY VALUE  (value stored single-quoted so $ in bcrypt hashes stays literal)
    local key=$1 value=$2 tmp
    case $value in *"'"*|*$'\n'*) die "$key cannot contain quotes or newlines." ;; esac
    tmp=$(mktemp "$ENV_FILE.XXXXXX")
    { grep -v "^$key=" "$ENV_FILE" 2>/dev/null || true; printf "%s='%s'\n" "$key" "$value"; } > "$tmp"
    chmod 600 "$tmp"
    mv "$tmp" "$ENV_FILE"
}

ask() {  # ask VAR "Prompt" [default] [secret]
    local var=$1 prompt=$2 default=${3:-} secret=${4:-} reply
    if [ -n "${!var:-}" ]; then return; fi
    if [ ! -t 0 ]; then
        [ -n "$default$secret" ] || die "$var is not set and there is no terminal to ask. Export $var and retry."
        printf -v "$var" '%s' "$default"; return
    fi
    if [ -n "$secret" ]; then
        read -r -s -p "$prompt: " reply; echo
    else
        read -r -p "$prompt${default:+ [$default]}: " reply
    fi
    printf -v "$var" '%s' "${reply:-$default}"
}

hash_password() {
    printf '%s\n' "$1" | docker run --rm -i "$CADDY_IMAGE" caddy hash-password 2>/dev/null | tail -n1
}

set_login() {
    local generated=""
    ask BASIC_AUTH_USER "Website login name" "$(env_get BASIC_AUTH_USER || true)"
    BASIC_AUTH_USER=${BASIC_AUTH_USER:-tender}
    ask BASIC_AUTH_PASSWORD "Website password (leave empty to generate one)" "" secret
    if [ -z "${BASIC_AUTH_PASSWORD:-}" ]; then
        BASIC_AUTH_PASSWORD=$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)
        generated=1
    fi
    [ "${#BASIC_AUTH_PASSWORD}" -ge 10 ] || die "Use a website password with at least 10 characters."
    say "Hashing the website password"
    local hash
    hash=$(hash_password "$BASIC_AUTH_PASSWORD")
    case $hash in '$2'*) ;; *) die "Could not hash the password with $CADDY_IMAGE (is Docker running?)." ;; esac
    env_set BASIC_AUTH_USER "$BASIC_AUTH_USER"
    env_set BASIC_AUTH_HASH "$hash"
    if [ -n "$generated" ]; then
        printf '\n  Website login: %s\n  Password:      %s\n  (shown once; store it in your password manager)\n\n' \
            "$BASIC_AUTH_USER" "$BASIC_AUTH_PASSWORD"
    fi
}

cmd_init() {
    command -v docker >/dev/null || die "Install Docker first: https://docs.docker.com/engine/install/"
    docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (docker compose ...)."
    command -v openssl >/dev/null || die "openssl is required to generate passwords."
    umask 077
    touch "$ENV_FILE"; chmod 600 "$ENV_FILE"

    for key in POSTGRES_PASSWORD POSTGRES_APP_PASSWORD; do
        [ -n "$(env_get "$key")" ] || env_set "$key" "$(openssl rand -hex 24)"
    done
    [ -n "$(env_get POSTGRES_DB)" ] || env_set POSTGRES_DB construction
    [ -n "$(env_get POSTGRES_USER)" ] || env_set POSTGRES_USER construction

    local current suggestion=""
    current=$(env_get APP_DOMAIN)
    if [ -z "$current" ] && [ -z "${APP_DOMAIN:-}" ] && [ -t 0 ]; then
        local ip
        ip=$(curl -fsS --max-time 4 https://api.ipify.org 2>/dev/null || true)
        [ -n "$ip" ] && suggestion="${ip//./-}.sslip.io"
        echo "Point a DNS A record at this server and enter that hostname."
        [ -n "$suggestion" ] && echo "No domain yet? $suggestion resolves to this server and gets a real HTTPS certificate."
    fi
    ask APP_DOMAIN "Public hostname" "${current:-$suggestion}"
    [ -n "${APP_DOMAIN:-}" ] || die "A hostname is required."
    case $APP_DOMAIN in *://*|*/*|*" "*) die "Enter only the hostname, for example tenders.example.com." ;; esac
    env_set APP_DOMAIN "$APP_DOMAIN"

    if [ -z "$(env_get BASIC_AUTH_HASH)" ] || [ -n "${BASIC_AUTH_PASSWORD:-}" ]; then
        set_login
    fi
    say "Wrote $ENV_FILE. Next: ./backend/deploy/deploy.sh up"
}

cmd_up() {
    need_env
    mkdir -p "$BACKUP_DIR"
    say "Building images"
    compose build backend web
    compose --profile tools build importer
    say "Starting database and applying migrations"
    compose up -d --wait db
    compose run --rm -T migrate
    say "Starting backend, web (HTTPS + frontend) and backups"
    compose up -d --wait --remove-orphans backend web backup
    local site
    site=$(env_get SITE_ADDRESS); site=${site:-$(env_get APP_DOMAIN)}
    case $site in :*|http://*) say "Running on $site" ;; *) say "Running on https://$site" ;; esac
}

cmd_seed() {
    need_env
    local samples="$PWD/data/tenders"
    [ -d "$samples" ] || die "data/tenders/ not found."
    compose --profile tools build importer
    say "Importing data/tenders/ into project \"$SEED_PROJECT\""
    compose run --rm -T -v "$samples:/data:ro" --entrypoint sh importer -c '
        failed=0
        for file in /data/*; do
            [ -f "$file" ] || continue
            printf "  %s ... " "${file##*/}"
            if python -m tender_import import --project "$1" "$file" > /tmp/out 2>&1; then
                echo ok
            else
                echo FAILED; sed "s/^/      /" /tmp/out | tail -n 5; failed=$((failed + 1))
            fi
        done
        [ "$failed" -eq 0 ] || echo "$failed file(s) failed to import"
    ' sh "$SEED_PROJECT"
    say "Building the material catalogue"
    compose run --rm -T importer challenge-catalogue --project "$SEED_PROJECT"
}

cmd_model() {
    need_env
    local model
    model=$(env_get ANALYSIS_L3_MODEL)
    model=${ANALYSIS_L3_MODEL:-${model:-qwen2.5:7b-instruct}}
    compose up -d ollama
    compose exec -T ollama ollama pull "$model"
}

cmd_backup() {
    need_env
    mkdir -p "$BACKUP_DIR"
    local file
    file="$BACKUP_DIR/manual-$(date -u +%Y%m%dT%H%M%SZ).dump"
    compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-acl' \
        > "$file.partial"
    mv "$file.partial" "$file"
    chmod 600 "$file"
    say "Saved $file ($(du -h "$file" | cut -f1))"
}

cmd_restore() {
    need_env
    local file=${1:-}
    [ -f "$file" ] || die "Usage: ./backend/deploy/deploy.sh restore FILE"
    compose exec -T db pg_restore --list < "$file" > /dev/null || die "$file is not a valid pg_dump archive."
    echo "This REPLACES all data in the live database with $file."
    local answer=${CONFIRM:-}
    [ -n "$answer" ] || read -r -p "Type 'restore' to continue: " answer
    [ "$answer" = restore ] || die "Cancelled."
    cmd_backup
    compose stop backend
    compose exec -T db sh -c '
        dropdb -U "$POSTGRES_USER" --force "$POSTGRES_DB" &&
        createdb -U "$POSTGRES_USER" --template=template0 "$POSTGRES_DB" &&
        pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --single-transaction --no-owner --no-acl' < "$file"
    compose run --rm -T migrate
    compose up -d --wait backend
    say "Restored $file"
}

cmd_push() {
    local target=${1:-} dir=${2:-tenderdesk}
    [ -n "$target" ] || die "Usage: ./backend/deploy/deploy.sh push USER@HOST [REMOTE_DIR]"
    command -v rsync >/dev/null || die "rsync is required."
    say "Copying to $target:$dir"
    rsync -az --delete --include '.env.example' \
        --exclude '.git/' --exclude '.env' --exclude '.env.*' --exclude 'backups/' \
        --exclude '/frontend/public/files/' \
        --exclude '__pycache__/' --exclude '.venv/' --exclude 'node_modules/' --exclude 'dist/' --exclude '.DS_Store' \
        ./ "$target:$dir/"
    say "Deploying on $target"
    ssh -t "$target" "cd '$dir' && ./backend/deploy/deploy.sh init && ./backend/deploy/deploy.sh up"
}

case "${1:-}" in
    init) cmd_init ;;
    up) cmd_up ;;
    seed) cmd_seed ;;
    model) cmd_model ;;
    compose) need_env; shift; compose "$@" ;;
    status) need_env; compose ps ;;
    logs) need_env; shift; compose logs -f --tail=200 "$@" ;;
    backup) cmd_backup ;;
    restore) shift; cmd_restore "$@" ;;
    password) need_env; BASIC_AUTH_PASSWORD=""; set_login; compose up -d --force-recreate web ;;
    update)
        need_env
        if [ -d .git ]; then git pull --ff-only; fi
        cmd_up ;;
    down) need_env; compose --profile llm --profile tools down ;;
    push) shift; cmd_push "$@" ;;
    *) sed -n '2,/^set -/p' "$0" | sed '/^set -/d; s/^# \{0,1\}//'; exit 2 ;;
esac
