#!/bin/sh
set -eu

caller_dir=$PWD
project_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir"
umask 077

usage() {
    printf 'Usage: %s up | backup FILE | restore FILE NEW_DATABASE\n' "$0" >&2
    exit 2
}

host_path() {
    case "$1" in
        /*) printf '%s\n' "$1" ;;
        *) printf '%s/%s\n' "$caller_dir" "$1" ;;
    esac
}

ensure_password() {
    key=$1
    if grep -Eq "^${key}=.+$" .env; then
        return
    fi
    temp_env=$(mktemp .env.XXXXXX)
    trap 'rm -f "$temp_env"' EXIT
    sed "/^${key}=/d" .env > "$temp_env"
    password=$(openssl rand -hex 24)
    printf '%s=%s\n' "$key" "$password" >> "$temp_env"
    mv "$temp_env" .env
    trap - EXIT
}

case "${1:-}" in
    up)
        [ "$#" -eq 1 ] || usage
        if [ ! -e .env ]; then
            cp .env.example .env
        fi
        chmod 600 .env
        ensure_password POSTGRES_PASSWORD
        ensure_password POSTGRES_APP_PASSWORD
        docker compose up -d --wait db
        docker compose run --rm -T migrate
        ;;
    backup)
        [ "$#" -eq 2 ] || usage
        archive=$(host_path "$2")
        if [ -e "$archive" ] || [ -L "$archive" ]; then
            printf 'Backup path already exists: %s\n' "$archive" >&2
            exit 1
        fi
        mkdir -p "$(dirname -- "$archive")"
        temporary_archive=$(mktemp "$archive.XXXXXX")
        trap 'rm -f "$temporary_archive"' EXIT
        docker compose exec -T db sh -c '
            pg_dump --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --format=custom --no-owner --no-acl
        ' > "$temporary_archive"
        if ! ln "$temporary_archive" "$archive"; then
            printf 'Could not save backup to %s. Choose a new filename.\n' "$archive" >&2
            exit 1
        fi
        printf 'Saved PostgreSQL backup to %s\n' "$archive"
        ;;
    restore)
        [ "$#" -eq 3 ] || usage
        archive=$(host_path "$2")
        target=$3
        case "$target" in
            ''|[!a-z_]*|*[!a-z0-9_]*) usage ;;
        esac
        [ "${#target}" -le 63 ] || usage
        docker compose exec -T db pg_restore --list < "$archive" > /dev/null
        docker compose exec -T db sh -c '
            createdb --username="$POSTGRES_USER" --template=template0 "$1"
        ' sh "$target"
        docker compose exec -T db sh -c '
            pg_restore --username="$POSTGRES_USER" --dbname="$1" --single-transaction --no-owner --no-acl
        ' sh "$target" < "$archive"
        docker compose run --rm -T -e "PGDATABASE=$target" migrate
        printf 'Restored PostgreSQL database %s\n' "$target"
        ;;
    *) usage ;;
esac
