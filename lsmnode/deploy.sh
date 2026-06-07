#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# LSM Node deploy script
# Run once on a fresh server to install lsmnode as a systemd service with
# automatic updates via a systemd timer.
#
# Usage: sudo bash lsmnode/deploy.sh
# Re-run to update config or reinstall units.
# ---------------------------------------------------------------------------

if [[ $EUID -ne 0 ]]; then
  echo "error: must be run as root (sudo $0)" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
SERVICE="lsmnode"
UPDATE_SERVICE="lsmnode-update"

echo "=== LSM Node deployment ==="
echo "Repo:    $REPO_DIR"
echo "Env:     $ENV_FILE"
echo ""

# ---------------------------------------------------------------------------
# 1. Ensure bun is installed
# ---------------------------------------------------------------------------
if ! command -v bun &>/dev/null; then
  echo ">>> Installing bun..."
  curl -fsSL https://bun.sh/install | bash
  # The installer puts bun at /root/.bun/bin/bun for root installs
  export PATH="/root/.bun/bin:$PATH"
fi

BUN="$(command -v bun)"
echo ">>> bun: $BUN ($($BUN --version))"
echo ""

# ---------------------------------------------------------------------------
# 2. Collect configuration (re-use existing .env values as defaults)
# ---------------------------------------------------------------------------
get_existing() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] && grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"' || true
}

prompt() {
  local key="$1" label="$2" secret="${3:-no}" existing default_hint
  existing="$(get_existing "$key")"
  [[ -n "$existing" ]] && default_hint=" [keep: ${secret:+***}${secret:-$existing}]" || default_hint=""

  if [[ "$secret" == "yes" ]]; then
    read -rsp "${label}${default_hint}: " val; echo ""
  else
    read -rp "${label}${default_hint}: " val
  fi

  echo "${val:-$existing}"
}

PORT="$(prompt PORT "Port" no)"
PORT="${PORT:-9000}"

SHARED_SECRET="$(prompt SHARED_SECRET "Shared secret" yes)"
if [[ -z "$SHARED_SECRET" ]]; then
  echo "error: shared secret is required" >&2; exit 1
fi

XUI_HOST="$(prompt XUI_HOST "3x-UI host (e.g. https://1.2.3.4:2053)" no)"
XUI_USER="$(prompt XUI_USER "3x-UI username" no)"
XUI_PASSWORD="$(prompt XUI_PASSWORD "3x-UI password" yes)"

if [[ -z "$XUI_HOST" || -z "$XUI_USER" || -z "$XUI_PASSWORD" ]]; then
  echo "error: XUI_HOST, XUI_USER and XUI_PASSWORD are all required" >&2; exit 1
fi

echo ""

# ---------------------------------------------------------------------------
# 3. Write .env
# ---------------------------------------------------------------------------
cat > "$ENV_FILE" <<EOF
PORT=$PORT
SHARED_SECRET=$SHARED_SECRET
XUI_HOST=$XUI_HOST
XUI_USER=$XUI_USER
XUI_PASSWORD=$XUI_PASSWORD
EOF
chmod 600 "$ENV_FILE"
echo ">>> wrote $ENV_FILE"

# ---------------------------------------------------------------------------
# 4. Install dependencies (root package.json owns bun.lock and shared deps)
# ---------------------------------------------------------------------------
echo ">>> installing dependencies..."
cd "$REPO_DIR"
"$BUN" install --frozen-lockfile
echo ""

# ---------------------------------------------------------------------------
# 5. Detect default git branch for the update service
# ---------------------------------------------------------------------------
DEFAULT_BRANCH="$(git -C "$REPO_DIR" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|.*/||' || echo "master")"
echo ">>> git default branch: $DEFAULT_BRANCH"

# ---------------------------------------------------------------------------
# 6. Systemd service unit
# ---------------------------------------------------------------------------
cat > "/etc/systemd/system/${SERVICE}.service" <<EOF
[Unit]
Description=LSM Node
After=network.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=$REPO_DIR
ExecStart=$BUN run $SCRIPT_DIR/src/index.ts
EnvironmentFile=$ENV_FILE
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# ---------------------------------------------------------------------------
# 7. Update service + timer (runs every 6 hours)
# ---------------------------------------------------------------------------
cat > "/etc/systemd/system/${UPDATE_SERVICE}.service" <<EOF
[Unit]
Description=LSM Node updater
After=network.target

[Service]
Type=oneshot
WorkingDirectory=$REPO_DIR
ExecStart=/bin/bash -c 'git pull --rebase origin $DEFAULT_BRANCH && $BUN install --frozen-lockfile && systemctl restart $SERVICE'
StandardOutput=journal
StandardError=journal
EOF

cat > "/etc/systemd/system/${UPDATE_SERVICE}.timer" <<EOF
[Unit]
Description=LSM Node auto-update (every 6 hours)

[Timer]
OnCalendar=*-*-* 00/6:00:00
RandomizedDelaySec=120
Persistent=true

[Install]
WantedBy=timers.target
EOF

echo ">>> installed systemd units"

# ---------------------------------------------------------------------------
# 8. Enable and start
# ---------------------------------------------------------------------------
systemctl daemon-reload
systemctl enable --now "$SERVICE"
systemctl enable --now "${UPDATE_SERVICE}.timer"

echo ""
echo "=== Deployment complete ==="
echo ""
systemctl status "$SERVICE" --no-pager -l
echo ""
echo "Update timer:"
systemctl list-timers "${UPDATE_SERVICE}.timer" --no-pager
