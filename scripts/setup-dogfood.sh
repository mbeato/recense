#!/usr/bin/env bash
# setup-dogfood.sh — one-time dogfood cutover for brain-memory (ADAPT-01/02).
#
# What this script does:
#   1. Builds the project (npm run build → dist/)
#   2. Renders the launchd plist template with your absolute node + DB paths
#      and loads it as a user LaunchAgent (hourly sleep-pass fallback)
#   3. Prints the exact three hook JSON entries to merge into ~/.claude/settings.json
#   4. Shows rollback commands
#
# Safe to re-run (idempotent): plist is overwritten and re-loaded on each run.
#
# DO NOT run as root — this installs a user-space LaunchAgent under ~/Library/LaunchAgents/.
# DO NOT let this script edit ~/.claude/settings.json — you merge the printed snippet.
#
# See docs/dogfood-setup.md for the full runbook including the MEMORY.md
# double-injection check and rollback procedure.

set -euo pipefail

# ── Resolve paths ──────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Absolute node binary — must be absolute; 'node' may not be on PATH in hook context.
# Run this script with your target nvm version active (e.g. nvm use <version>).
NODE_BIN="$(command -v node 2>/dev/null || true)"
if [[ -z "$NODE_BIN" ]]; then
    echo "ERROR: node not found on PATH. Activate nvm first: nvm use <version>" >&2
    exit 1
fi
# Follow symlinks to the real binary (nvm may symlink node on some configs)
NODE_BIN="$(cd "$(dirname "$NODE_BIN")" && pwd)/$(basename "$NODE_BIN")"

# Compiled adapter CLI paths
DIST_ADAPTER="$PROJECT_ROOT/dist/src/adapter"
SESSION_START_CLI="$DIST_ADAPTER/session-start-cli.js"
TURN_CAPTURE_CLI="$DIST_ADAPTER/turn-capture-cli.js"
STOP_CLI="$DIST_ADAPTER/stop-cli.js"
SLEEP_PASS_CLI="$DIST_ADAPTER/sleep-pass-cli.js"

# DB path: env var takes precedence; fall back to project default
DB_PATH="${BRAIN_MEMORY_DB:-$PROJECT_ROOT/brain.db}"

# Model provider for the detached sleep pass: env var takes precedence; default
# anthropic (zero behavior change). Validated again at runtime by sleep-pass-cli.
MODEL_PROVIDER="${BRAIN_MEMORY_MODEL_PROVIDER:-anthropic}"

# launchd plist locations
PLIST_TEMPLATE="$SCRIPT_DIR/com.brain-memory.sleep-pass.plist.template"
LAUNCHAGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST_DST="$LAUNCHAGENTS_DIR/com.brain-memory.sleep-pass.plist"
PLIST_LABEL="com.brain-memory.sleep-pass"

# ── Step 1: Build ──────────────────────────────────────────────────────────────
echo ""
echo "==> [1/4] Building brain-memory..."
cd "$PROJECT_ROOT"
npm run build
echo "    Build complete."
echo ""

# Verify all required dist CLIs exist after build
MISSING=0
for f in "$SESSION_START_CLI" "$TURN_CAPTURE_CLI" "$STOP_CLI" "$SLEEP_PASS_CLI"; do
    if [[ ! -f "$f" ]]; then
        echo "ERROR: Expected compiled file missing: $f" >&2
        MISSING=1
    fi
done
if [[ "$MISSING" -eq 1 ]]; then
    echo "       Check tsconfig.json and re-run 'npm run build'." >&2
    exit 1
fi
echo "    All dist CLIs present."

# ── Step 2: Install launchd LaunchAgent ───────────────────────────────────────
echo ""
echo "==> [2/4] Installing launchd LaunchAgent..."
mkdir -p "$LAUNCHAGENTS_DIR"

# Render plist template: substitute placeholders with resolved absolute paths
sed \
    -e "s|__NODE__|$NODE_BIN|g" \
    -e "s|__SLEEP_PASS_JS__|$SLEEP_PASS_CLI|g" \
    -e "s|__DB__|$DB_PATH|g" \
    -e "s|__MODEL_PROVIDER__|$MODEL_PROVIDER|g" \
    "$PLIST_TEMPLATE" > "$PLIST_DST"
echo "    Plist written: $PLIST_DST"

# Validate the rendered plist XML
if ! plutil -lint "$PLIST_DST" > /dev/null 2>&1; then
    echo "ERROR: plutil -lint failed on rendered plist. Details:" >&2
    plutil -lint "$PLIST_DST" >&2
    exit 1
fi
echo "    plutil -lint: OK"

# Unload first (idempotent — exits 0 even if the agent was not loaded)
launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load "$PLIST_DST"
echo "    Loaded: $PLIST_LABEL"
echo "    Verify: launchctl list | grep brain-memory"

# ── Step 3: Print settings.json hook snippet ──────────────────────────────────
echo ""
echo "==> [3/4] Merge the following into ~/.claude/settings.json"
echo "    IMPORTANT: Do NOT replace the entire file — merge only these entries."
echo "    Append each hook entry to its existing array (or create the array)."
echo "    Keep all your other existing hooks intact."
echo ""
echo "-------- copy below --------"
cat <<JSON
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "$NODE_BIN $SESSION_START_CLI",
            "timeout": 5
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "$NODE_BIN $TURN_CAPTURE_CLI",
            "timeout": 5
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "$NODE_BIN $STOP_CLI",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
JSON
echo "-------- copy above --------"
echo ""
echo "    Node binary : $NODE_BIN"
echo "    SessionStart: $SESSION_START_CLI"
echo "    TurnCapture : $TURN_CAPTURE_CLI"
echo "    Stop        : $STOP_CLI"
echo ""
echo "    NOTE: BRAIN_MEMORY_DB must be visible to Claude Code's process."
echo "    If not set in your shell profile, the CLIs fall back to:"
echo "      $PROJECT_ROOT/brain.db"
echo "    Set it explicitly if the cold-start-seeded DB is elsewhere:"
echo "      export BRAIN_MEMORY_DB=/absolute/path/to/brain.db"

# ── Step 4: Rollback instructions ────────────────────────────────────────────
echo ""
echo "==> [4/4] Rollback (reversible — MEMORY.md is NEVER deleted):"
echo "    1. Remove the three brain-memory hook entries from ~/.claude/settings.json"
echo "       (SessionStart → session-start-cli, UserPromptSubmit → turn-capture-cli,"
echo "        Stop → stop-cli)"
echo "    2. launchctl unload $PLIST_DST"
echo "    3. (Optional) rm $PLIST_DST"
echo "    After rollback Claude Code uses MEMORY.md as the injection source (unchanged)."
echo ""
echo "==> Setup complete. Next: merge the hook snippet, then see docs/dogfood-setup.md"
echo "    for the MEMORY.md double-injection check (Task 2)."
echo ""
