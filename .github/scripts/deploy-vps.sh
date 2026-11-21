#!/usr/bin/env bash
set -euo pipefail

: "${VPS_HOST:?Set the VPS_HOST Actions variable}"
: "${VPS_USER:?Set the VPS_USER Actions variable}"
: "${VPS_PATH:?Set the VPS_PATH Actions variable}"
: "${VPS_SSH_KEY:?Set the VPS_SSH_KEY Actions secret}"
: "${VPS_KNOWN_HOSTS:?Set the VPS_KNOWN_HOSTS Actions secret}"
VPS_PORT=${VPS_PORT:-22}

if ! [[ $VPS_HOST =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ && $VPS_USER =~ ^[A-Za-z0-9_][A-Za-z0-9_-]*$ ]]; then
    echo "Use a DNS name or IPv4 address and a valid SSH username." >&2
    exit 1
fi
if ! [[ $VPS_PORT =~ ^[1-9][0-9]{0,4}$ ]] || (( VPS_PORT > 65535 )); then
    echo "VPS_PORT must be between 1 and 65535." >&2
    exit 1
fi
if ! [[ $VPS_PATH =~ ^(/[A-Za-z0-9._-]+)+$ ]] || [[ $VPS_PATH/ == *'/../'* || $VPS_PATH/ == *'/./'* ]]; then
    echo "VPS_PATH must be an absolute application directory without spaces or traversal." >&2
    exit 1
fi

umask 077
work=$(mktemp -d /tmp/construct-ci.XXXXXX)
trap 'rm -rf -- "$work"' EXIT
printf '%s\n' "$VPS_SSH_KEY" > "$work/key"
printf '%s\n' "$VPS_KNOWN_HOSTS" > "$work/known_hosts"
unset VPS_SSH_KEY VPS_KNOWN_HOSTS
cat > "$work/ssh_config" <<EOF
Host construct-vps
    HostName $VPS_HOST
    User $VPS_USER
    Port $VPS_PORT
    IdentityFile $work/key
    UserKnownHostsFile $work/known_hosts
    GlobalKnownHostsFile /dev/null
    StrictHostKeyChecking yes
    IdentitiesOnly yes
    BatchMode yes
    ConnectTimeout 15
    ServerAliveInterval 15
    ServerAliveCountMax 3
EOF

# Abort before touching any files if the target has not been initialized.
ssh -F "$work/ssh_config" construct-vps bash -s -- "$VPS_PATH" <<'REMOTE'
set -euo pipefail
cd -- "$1"
if [[ ! -s .env.prod ]]; then
    echo "Run ./deploy.sh init once in the VPS deployment directory." >&2
    exit 1
fi
command -v rsync >/dev/null
docker compose version >/dev/null
REMOTE

# Checkout contains the commit whose checks passed. Export tracked files only.
mkdir -m 755 "$work/release"
git archive HEAD | tar -xpf - -C "$work/release"
rsync -rlt --executability --delay-updates --delete-delay \
    --exclude='/.git' --exclude='/.env' --exclude='/.env.*' --exclude='/backups/' \
    -e "ssh -F $work/ssh_config" "$work/release/" "construct-vps:$VPS_PATH/"

ssh -F "$work/ssh_config" construct-vps bash -s -- "$VPS_PATH" <<'REMOTE'
set -euo pipefail
cd -- "$1"
ENV_FILE=.env.prod ./deploy.sh up
ENV_FILE=.env.prod ./deploy.sh status
REMOTE
