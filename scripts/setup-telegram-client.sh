#!/usr/bin/env bash
# setup-telegram-client.sh — install recense serve + Telegram reference client as launchd services.
#
# What this script does:
#   1. Builds the Telegram reference client (npm run build:client) and verifies the dist exists.
#   2. ADDITIVELY writes client config vars to ~/.config/recense/sleep.env (chmod 600),
#      preserving all existing lines (API keys, DB path, sleep-pass config, etc.).
#   3. Renders + validates both launchd plists (serve + client) and bootstraps each agent.
#   4. Prints required next steps, rollback instructions, and the watcher-retire command (D-07).
#
# Idempotent: safe to re-run. Re-running after npm run build:client updates the client JS path.
# The serve plist is also rendered and re-loaded so serve picks up any env-file changes.
#
# Prerequisite: run scripts/setup-dogfood.sh first to create the env file with
#   RECENSE_NODE_BIN and RECENSE_DB. This script is additive on top of that.
#
# DO NOT run as root — this installs user-space LaunchAgents under ~/Library/LaunchAgents/.
# Secrets are written to the env file ONLY — never echoed to stdout or any log.

set -euo pipefail

# ── Resolve paths ────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Dist paths
DIST_ADAPTER="$PROJECT_ROOT/dist/src/adapter"
RECENSE_JS="$DIST_ADAPTER/recense.js"
CLIENT_JS="$PROJECT_ROOT/clients/telegram/dist/index.js"

# Env file — the SAME file used by the sleep pass (additive only; no second file)
ENV_FILE="${RECENSE_SLEEP_ENV:-$HOME/.config/recense/sleep.env}"

# Committed wrapper paths
SERVE_WRAPPER="$SCRIPT_DIR/serve-launchd.sh"
CLIENT_WRAPPER="$SCRIPT_DIR/telegram-client-launchd.sh"

# launchd plist locations
LAUNCHAGENTS_DIR="$HOME/Library/LaunchAgents"
SERVE_PLIST_TEMPLATE="$SCRIPT_DIR/com.recense.serve.plist.template"
SERVE_PLIST_DST="$LAUNCHAGENTS_DIR/com.recense.serve.plist"
SERVE_PLIST_LABEL="com.recense.serve"
CLIENT_PLIST_TEMPLATE="$SCRIPT_DIR/com.recense.telegram-client.plist.template"
CLIENT_PLIST_DST="$LAUNCHAGENTS_DIR/com.recense.telegram-client.plist"
CLIENT_PLIST_LABEL="com.recense.telegram-client"

# ── Step 1: Build Telegram reference client ───────────────────────────────────
echo ""
echo "==> [1/4] Building Telegram reference client (npm run build:client)..."
cd "$PROJECT_ROOT"
npm run build:client
echo "    Build complete."
echo ""

if [[ ! -f "$CLIENT_JS" ]]; then
    echo "ERROR: Expected compiled client missing: $CLIENT_JS" >&2
    echo "       Check clients/telegram/tsconfig.json and re-run 'npm run build:client'." >&2
    exit 1
fi
echo "    Client dist present: $CLIENT_JS"

# Verify recense.js is present (produced by npm run build via setup-dogfood.sh).
if [[ ! -f "$RECENSE_JS" ]]; then
    echo "ERROR: recense.js not found at $RECENSE_JS" >&2
    echo "       Run 'npm run build' first (or re-run scripts/setup-dogfood.sh)." >&2
    exit 1
fi
echo "    Brain dispatcher present: $RECENSE_JS"
echo ""

# ── Step 2: ADDITIVELY update env file ────────────────────────────────────────
echo "==> [2/4] Updating env file (additive — preserves all existing keys)..."
mkdir -p "$(dirname "$ENV_FILE")"

# Build base content: preserve all existing lines, strip the two keys we always replace.
if [[ -f "$ENV_FILE" ]]; then
    BASE_CONTENT="$(grep -Ev '^(RECENSE_DIST_JS|RECENSE_TELEGRAM_CLIENT_JS)=' "$ENV_FILE" || true)"
else
    BASE_CONTENT="# recense env — GITIGNORED, chmod 600. Do NOT commit.
# Updated by setup-telegram-client.sh; re-run safely to update paths."
fi

# Always-update keys (paths can change after a rebuild)
APPEND_CONTENT="RECENSE_DIST_JS=${RECENSE_JS}
RECENSE_TELEGRAM_CLIENT_JS=${CLIENT_JS}"

# Add client secrets only if not already present (idempotent; preserves real values on re-run)
if ! grep -q '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" 2>/dev/null; then
    APPEND_CONTENT="${APPEND_CONTENT}
TELEGRAM_BOT_TOKEN=REPLACE_WITH_BOT_TOKEN_FROM_BOTFATHER"
fi
if ! grep -q '^RECENSE_SERVE_URL=' "$ENV_FILE" 2>/dev/null; then
    APPEND_CONTENT="${APPEND_CONTENT}
RECENSE_SERVE_URL=http://127.0.0.1:7701"
fi
if ! grep -q '^RECENSE_CLIENT_ALLOWLIST=' "$ENV_FILE" 2>/dev/null; then
    APPEND_CONTENT="${APPEND_CONTENT}
RECENSE_CLIENT_ALLOWLIST=REPLACE_WITH_YOUR_TELEGRAM_USER_ID"
fi
if ! grep -q '^RECENSE_SERVE_TOKEN=' "$ENV_FILE" 2>/dev/null; then
    APPEND_CONTENT="${APPEND_CONTENT}
RECENSE_SERVE_TOKEN=REPLACE_WITH_ENGINE_TOKEN"
fi

# Atomic write with restrictive perms (umask 077 → 600). Secrets go to the file ONLY
# — never echoed to stdout. mv makes the write atomic (T-13-14 mitigation).
TMPFILE="$(mktemp "$(dirname "$ENV_FILE")/telegram-client.env.XXXXXX")"
(
    umask 077
    printf '%s\n%s\n' "$BASE_CONTENT" "$APPEND_CONTENT" > "$TMPFILE"
)
mv "$TMPFILE" "$ENV_FILE"
chmod 600 "$ENV_FILE"
echo "    Env file updated: $ENV_FILE (chmod 600)"
echo "    RECENSE_DIST_JS=$RECENSE_JS"
echo "    RECENSE_TELEGRAM_CLIENT_JS=$CLIENT_JS"
echo ""

# ── Step 3: Install launchd agents (serve + client) ───────────────────────────
echo "==> [3/4] Installing launchd agents (serve + client)..."
mkdir -p "$LAUNCHAGENTS_DIR"
LAUNCHD_DOMAIN="gui/$(id -u)"

install_agent() {
    local label="$1" template="$2" dst="$3" wrapper="$4"
    # Render plist: substitute wrapper path + env-file path
    sed \
        -e "s|__WRAPPER__|$wrapper|g" \
        -e "s|__ENV_FILE__|$ENV_FILE|g" \
        "$template" > "$dst"
    echo "    Plist written: $dst"
    # Validate the rendered plist XML before loading
    if ! plutil -lint "$dst" > /dev/null 2>&1; then
        echo "ERROR: plutil -lint failed on rendered plist. Details:" >&2
        plutil -lint "$dst" >&2
        exit 1
    fi
    echo "    plutil -lint: OK ($label)"
    # Load via the modern per-user domain API (launchctl load is deprecated on current macOS).
    launchctl bootout "$LAUNCHD_DOMAIN/$label" 2>/dev/null || true
    # Clear any stale disabled override left by a prior launchctl bootout/disable.
    launchctl enable "$LAUNCHD_DOMAIN/$label" 2>/dev/null || true
    if launchctl bootstrap "$LAUNCHD_DOMAIN" "$dst" 2>/dev/null; then
        echo "    Loaded: $label"
        echo "    Verify: launchctl print $LAUNCHD_DOMAIN/$label | grep state"
    else
        echo "    Could not load from this context (need a GUI login session — not SSH/sandbox)." >&2
        echo "    Run manually: launchctl bootstrap $LAUNCHD_DOMAIN $dst" >&2
    fi
    echo ""
}

install_agent "$SERVE_PLIST_LABEL"  "$SERVE_PLIST_TEMPLATE"  "$SERVE_PLIST_DST"  "$SERVE_WRAPPER"
install_agent "$CLIENT_PLIST_LABEL" "$CLIENT_PLIST_TEMPLATE" "$CLIENT_PLIST_DST" "$CLIENT_WRAPPER"

# ── Step 4: Reminders + rollback ──────────────────────────────────────────────
echo "==> [4/4] Required next steps before the client can answer queries:"
echo ""
echo "    Fill in the placeholder secrets in $ENV_FILE:"
echo "    (Edit the file directly — values are never echoed here)"
echo ""
echo "    TELEGRAM_BOT_TOKEN — from @BotFather → /newbot (or your existing bot token)"
echo ""
echo "    RECENSE_CLIENT_ALLOWLIST — your numeric Telegram user ID (from @userinfobot)."
echo "    Example: RECENSE_CLIENT_ALLOWLIST=123456789"
echo ""
echo "    RECENSE_SERVE_TOKEN — copy from the engine env file:"
echo "      grep '^RECENSE_SERVE_TOKEN=' $ENV_FILE"
echo "    If not yet present, generate and set one, then re-run recense serve."
echo ""
echo "    RECENSE_SERVE_URL — defaults to http://127.0.0.1:7701; update only if you"
echo "    changed the serve port via RECENSE_SERVE_PORT."
echo ""
echo "    --- Retire the old watcher (D-07) ---"
echo "    The watcher source is deleted; the script no longer exists."
echo "    Remove the stale launchd entry so it does not appear as a failed service:"
echo "      launchctl bootout $LAUNCHD_DOMAIN/com.recense.watcher"
echo "      rm -f $HOME/Library/LaunchAgents/com.recense.watcher.plist"
echo "    Do NOT re-bootstrap com.recense.watcher — the wrapper script is gone."
echo ""
echo "    ROLLBACK:"
echo "      launchctl bootout $LAUNCHD_DOMAIN/$SERVE_PLIST_LABEL"
echo "      launchctl bootout $LAUNCHD_DOMAIN/$CLIENT_PLIST_LABEL"
echo "      rm -f $SERVE_PLIST_DST $CLIENT_PLIST_DST"
echo "    (Optional) Remove the client keys added to $ENV_FILE"
echo ""
echo "==> Setup complete."
echo "    Serve agent  : $SERVE_PLIST_LABEL"
echo "    Client agent : $CLIENT_PLIST_LABEL"
echo "    Env file     : $ENV_FILE"
echo "    Brain JS     : $RECENSE_JS"
echo "    Client JS    : $CLIENT_JS"
echo ""
