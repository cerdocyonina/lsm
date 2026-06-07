#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# LSM Node deploy script
# Run as a regular user (not root). Uses sudo inline for the few steps that
# need it: writing systemd units, reloading the daemon, enabling services.
#
# Usage: bash lsmnode/deploy.sh
# Re-run to update config or reinstall units.
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
SERVICE="lsmnode"
UPDATE_SERVICE="lsmnode-update"

REPO_USER="$(whoami)"
REPO_GROUP="$(id -gn)"

echo "=== LSM Node deployment ==="
echo "Repo:    $REPO_DIR"
echo "User:    $REPO_USER"
echo ""

# ---------------------------------------------------------------------------
# 1. Ensure bun is installed
# ---------------------------------------------------------------------------
if ! command -v bun &>/dev/null; then
  echo ">>> Installing bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

BUN="$(command -v bun)"
echo ">>> bun: $BUN ($($BUN --version))"
echo ""

# ---------------------------------------------------------------------------
# 2. Collect configuration
# ---------------------------------------------------------------------------
get_existing() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] && grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"' || true
}

# Prompt for a plain-text value. Shows current value as default.
ask() {
  local key="$1" label="$2" default="${3:-}" existing val
  existing="$(get_existing "$key")"
  local effective_default="${existing:-$default}"

  if [[ -n "$effective_default" ]]; then
    read -rp "${label} [${effective_default}]: " val
    echo "${val:-$effective_default}"
  else
    read -rp "${label}: " val
    echo "$val"
  fi
}

# Prompt for a secret. Never echoes or displays the value.
ask_secret() {
  local key="$1" label="$2" existing val
  existing="$(get_existing "$key")"

  if [[ -n "$existing" ]]; then
    read -rsp "${label} (press Enter to keep existing): " val; echo "" >&2
    echo "${val:-$existing}"
  else
    read -rsp "${label}: " val; echo "" >&2
    echo "$val"
  fi
}

echo "Configure the node (press Enter to accept the current/default value):"
echo ""

PORT="$(ask PORT "Listening port" "9000")"

echo ""
echo "--- Shared secret (must match the secret set in LSM for this node) ---"
SHARED_SECRET="$(ask_secret SHARED_SECRET "Shared secret")"
if [[ -z "$SHARED_SECRET" ]]; then
  echo "error: shared secret is required" >&2; exit 1
fi

echo ""
echo "--- 3x-UI connection ---"
XUI_HOST="$(ask XUI_HOST "Host URL (e.g. https://1.2.3.4:2053)")"
XUI_USER="$(ask XUI_USER "Username")"
XUI_PASSWORD="$(ask_secret XUI_PASSWORD "Password")"

if [[ -z "$XUI_HOST" || -z "$XUI_USER" || -z "$XUI_PASSWORD" ]]; then
  echo "error: 3x-UI host, username, and password are all required" >&2; exit 1
fi

echo ""

# ---------------------------------------------------------------------------
# 3. Write .env (owned by current user, no sudo needed)
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
# 4. Install dependencies
# ---------------------------------------------------------------------------
echo ">>> installing dependencies..."
cd "$REPO_DIR"
"$BUN" install --frozen-lockfile
echo ""

# ---------------------------------------------------------------------------
# 5. Detect default git branch
# ---------------------------------------------------------------------------
DEFAULT_BRANCH="$(git -C "$REPO_DIR" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|.*/||' || echo "master")"
echo ">>> git default branch: $DEFAULT_BRANCH"

# ---------------------------------------------------------------------------
# 6. Systemd service (runs as current user)
# ---------------------------------------------------------------------------
sudo tee "/etc/systemd/system/${SERVICE}.service" > /dev/null <<EOF
[Unit]
Description=LSM Node
After=network.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=$REPO_USER
Group=$REPO_GROUP
WorkingDirectory=$REPO_DIR
ExecStart=$BUN run $SCRIPT_DIR/src/index.ts
EnvironmentFile=$ENV_FILE
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# ---------------------------------------------------------------------------
# 7. Update service + timer (also runs as current user)
#    Restarts the service via a targeted passwordless sudoers rule below.
# ---------------------------------------------------------------------------
sudo tee "/etc/systemd/system/${UPDATE_SERVICE}.service" > /dev/null <<EOF
[Unit]
Description=LSM Node updater
After=network.target

[Service]
Type=oneshot
User=$REPO_USER
Group=$REPO_GROUP
WorkingDirectory=$REPO_DIR
ExecStart=/bin/bash -c 'git pull --rebase origin $DEFAULT_BRANCH && $BUN install --frozen-lockfile && sudo systemctl restart $SERVICE'
StandardOutput=journal
StandardError=journal
EOF

sudo tee "/etc/systemd/system/${UPDATE_SERVICE}.timer" > /dev/null <<EOF
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
# 8. Allow current user to restart the service without a password prompt
#    (scoped to exactly this one command — minimal privilege)
# ---------------------------------------------------------------------------
echo "$REPO_USER ALL=(ALL) NOPASSWD: /bin/systemctl restart $SERVICE" \
  | sudo tee "/etc/sudoers.d/$SERVICE" > /dev/null
sudo chmod 440 "/etc/sudoers.d/$SERVICE"
echo ">>> added sudoers rule for 'systemctl restart $SERVICE'"

# ---------------------------------------------------------------------------
# 9. Enable and start
# ---------------------------------------------------------------------------
sudo systemctl daemon-reload
sudo systemctl enable --now "$SERVICE"
sudo systemctl enable --now "${UPDATE_SERVICE}.timer"

echo ""
echo "=== Deployment complete ==="
echo ""
sudo systemctl status "$SERVICE" --no-pager -l
echo ""
echo "Update timer:"
systemctl list-timers "${UPDATE_SERVICE}.timer" --no-pager
