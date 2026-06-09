#!/usr/bin/env bash
# setup-dogfood.sh — one-time dogfood cutover for brain-memory (ADAPT-01/02, D-88).
#
# D-88 migration (OSS floor): hook entries now reference the `brain` dispatcher
# (`brain hook session-start`, `brain hook turn-capture`, `brain hook stop`) instead
# of the old standalone *-cli.js paths. `brain init` is the preferred new-install path;
# this script remains for manual/CI wiring and legacy reference.
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

# Compiled adapter CLI paths (D-88: brain.js is now the dispatcher entry point)
DIST_ADAPTER="$PROJECT_ROOT/dist/src/adapter"
# D-88: brain dispatcher — single entry point for all subcommands
BRAIN_JS="$DIST_ADAPTER/brain.js"
# Hook CLIs invoked via the brain dispatcher (brain hook session-start, etc.)
SESSION_START_CLI="$DIST_ADAPTER/session-start-cli.js"
TURN_CAPTURE_CLI="$DIST_ADAPTER/turn-capture-cli.js"
STOP_CLI="$DIST_ADAPTER/stop-cli.js"
# Sleep-pass and ingest CLIs (invoked via the launchd wrapper using BRAIN_MEMORY_SLEEP_JS)
# Dispatcher forms: brain sleep-pass (hourly consolidation), brain ingest (pull + consolidate)
SLEEP_PASS_CLI="$DIST_ADAPTER/sleep-pass-cli.js"
# brain ingest CLI — multi-source pull-then-consolidate (D-66); dispatcher form: brain ingest
# Swap BRAIN_MEMORY_SLEEP_JS to this path in sleep.env to enable multi-channel ingestion.
# enabledSources defaults to [] so it is a safe drop-in before any source is activated.
INGEST_CLI="$DIST_ADAPTER/ingest-cli.js"
# brain-seed CLI — one-shot cold-start bootstrap (D-77/D-82); dispatcher form: brain seed
# Documented in step 6 below; not auto-run (operator-driven, one-shot + lock-guarded).
SEED_CLI="$DIST_ADAPTER/seed-cli.js"

# DB path: env var takes precedence; fall back to project default
DB_PATH="${BRAIN_MEMORY_DB:-$PROJECT_ROOT/brain.db}"

# Per-role split config for the detached sleep pass (validated config defaults).
# Extraction → local model; judge → anthropic. Env vars override.
EXTRACTOR_PROVIDER="${BRAIN_MEMORY_EXTRACTOR_PROVIDER:-local}"
LOCAL_MODEL="${BRAIN_MEMORY_LOCAL_MODEL:-qwen2.5:7b-instruct}"
JUDGE_PROVIDER="${BRAIN_MEMORY_JUDGE_PROVIDER:-anthropic}"

# Committed, secret-free launchd wrapper (sources the env file, then execs node).
WRAPPER="$SCRIPT_DIR/sleep-pass-launchd.sh"

# Gitignored env file the wrapper sources at runtime (keys + per-role config).
# Env var overrides; default ~/.config/brain-memory/sleep.env. NEVER committed.
ENV_FILE="${BRAIN_MEMORY_SLEEP_ENV:-$HOME/.config/brain-memory/sleep.env}"

# launchd plist locations
PLIST_TEMPLATE="$SCRIPT_DIR/com.brain-memory.sleep-pass.plist.template"
LAUNCHAGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST_DST="$LAUNCHAGENTS_DIR/com.brain-memory.sleep-pass.plist"
PLIST_LABEL="com.brain-memory.sleep-pass"

# ── Step 1: Build ──────────────────────────────────────────────────────────────
echo ""
echo "==> [1/6] Building brain-memory..."
cd "$PROJECT_ROOT"
npm run build
echo "    Build complete."
echo ""

# Verify all required dist files exist after build (incl. brain.js dispatcher, D-88)
MISSING=0
for f in "$BRAIN_JS" "$SESSION_START_CLI" "$TURN_CAPTURE_CLI" "$STOP_CLI" "$SLEEP_PASS_CLI"; do
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

# ── Step 2: Generate the gitignored sleep env file (secret-safe, idempotent) ───
echo ""
echo "==> [2/6] Writing sleep env file..."
mkdir -p "$(dirname "$ENV_FILE")"

# Preserve any existing key line from a prior run — never clobber real keys.
preserve_key() {
    # $1 = var name; echoes the last "NAME=..." line from $ENV_FILE if present.
    if [[ -f "$ENV_FILE" ]]; then
        grep -E "^${1}=" "$ENV_FILE" | tail -n 1 || true
    fi
}
EXISTING_ANTHROPIC="$(preserve_key ANTHROPIC_API_KEY)"
EXISTING_OPENAI="$(preserve_key OPENAI_API_KEY)"

# Resolve each key line: existing file line > current env var > commented placeholder.
KEY_WARN=0
if [[ -n "$EXISTING_ANTHROPIC" ]]; then
    ANTHROPIC_LINE="$EXISTING_ANTHROPIC"
elif [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
    ANTHROPIC_LINE="ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}"
else
    ANTHROPIC_LINE="# ANTHROPIC_API_KEY="
    KEY_WARN=1
fi
if [[ -n "$EXISTING_OPENAI" ]]; then
    OPENAI_LINE="$EXISTING_OPENAI"
elif [[ -n "${OPENAI_API_KEY:-}" ]]; then
    OPENAI_LINE="OPENAI_API_KEY=${OPENAI_API_KEY}"
else
    OPENAI_LINE="# OPENAI_API_KEY="
    KEY_WARN=1
fi

# Write atomically with restrictive perms (umask 077 → 600). Key values go to the
# file ONLY — never echoed to stdout.
(
    umask 077
    cat > "$ENV_FILE" <<ENVEOF
# brain-memory sleep-pass env — GITIGNORED, chmod 600. Do NOT commit.
# Generated by scripts/setup-dogfood.sh; existing key lines preserved on re-run.
BRAIN_MEMORY_NODE_BIN=$NODE_BIN
# D-88: BRAIN_MEMORY_SLEEP_JS points to the compiled CLI used by the launchd wrapper.
# The brain dispatcher form is: brain sleep-pass (run manually: $NODE_BIN $BRAIN_JS sleep-pass)
BRAIN_MEMORY_SLEEP_JS=$SLEEP_PASS_CLI
# ── brain ingest rewire (D-66): to point the hourly job at ingest-cli ──────────
# Dispatcher form: brain ingest (run manually: $NODE_BIN $BRAIN_JS ingest)
# 1. Uncomment the line below (and comment out the BRAIN_MEMORY_SLEEP_JS line above).
# 2. Verify the drop-in safety test first: BRAIN_MEMORY_DB=<backup> node $INGEST_CLI --all
# 3. enabledSources defaults to [] so ingest-cli is a no-op until you add sources + creds.
# BRAIN_MEMORY_SLEEP_JS=$INGEST_CLI
BRAIN_MEMORY_DB=$DB_PATH
BRAIN_MEMORY_EXTRACTOR_PROVIDER=$EXTRACTOR_PROVIDER
BRAIN_MEMORY_LOCAL_MODEL=$LOCAL_MODEL
BRAIN_MEMORY_JUDGE_PROVIDER=$JUDGE_PROVIDER
$ANTHROPIC_LINE
$OPENAI_LINE
# ── Optional Gmail ingestion creds (D-68) — uncomment + fill in to enable Gmail ──
# Get these from Google Cloud Console → OAuth 2.0 client credentials (Desktop client).
# Also add 'gmail' to enabledSources in your engine config to activate the adapter.
# GMAIL_CLIENT_ID=
# GMAIL_CLIENT_SECRET=
# GMAIL_REFRESH_TOKEN=
ENVEOF
)
chmod 600 "$ENV_FILE"
echo "    Env file written: $ENV_FILE (chmod 600)"
echo "    Split config: extractor=$EXTRACTOR_PROVIDER ($LOCAL_MODEL), judge=$JUDGE_PROVIDER"
if [[ "$KEY_WARN" -eq 1 ]]; then
    echo "    ⚠ add ANTHROPIC_API_KEY / OPENAI_API_KEY to $ENV_FILE before the job can run" >&2
fi

# ── Step 3: Install launchd LaunchAgent ───────────────────────────────────────
echo ""
echo "==> [3/6] Installing launchd LaunchAgent..."
mkdir -p "$LAUNCHAGENTS_DIR"

# Render plist template: wrapper path + env-file path (keys live in the env file).
sed \
    -e "s|__WRAPPER__|$WRAPPER|g" \
    -e "s|__ENV_FILE__|$ENV_FILE|g" \
    "$PLIST_TEMPLATE" > "$PLIST_DST"
echo "    Plist written: $PLIST_DST"

# Validate the rendered plist XML
if ! plutil -lint "$PLIST_DST" > /dev/null 2>&1; then
    echo "ERROR: plutil -lint failed on rendered plist. Details:" >&2
    plutil -lint "$PLIST_DST" >&2
    exit 1
fi
echo "    plutil -lint: OK"

# Load via the modern per-user domain API. The legacy `launchctl load`/`unload`
# is deprecated and fails with "Input/output error" (errno 5) on current macOS —
# and from any non-GUI context (SSH, sandbox, CI) bootstrap also can't reach the
# gui/<uid> domain, so surface the exact manual command instead of failing hard.
LAUNCHD_DOMAIN="gui/$(id -u)"
launchctl bootout "$LAUNCHD_DOMAIN/$PLIST_LABEL" 2>/dev/null || true
# Clear any stale disabled override — a prior `launchctl unload`/`disable` leaves the
# label flagged disabled in the per-user override DB, which makes bootstrap fail with
# errno 5 (Input/output error) even though the plist is valid. `enable` clears it.
launchctl enable "$LAUNCHD_DOMAIN/$PLIST_LABEL" 2>/dev/null || true
if launchctl bootstrap "$LAUNCHD_DOMAIN" "$PLIST_DST" 2>/dev/null; then
    echo "    Loaded: $PLIST_LABEL"
    echo "    Verify: launchctl print $LAUNCHD_DOMAIN/$PLIST_LABEL | grep state"
else
    echo "    ⚠ Could not load from this context (need a GUI login session — not SSH/sandbox)." >&2
    echo "      Run this in your own terminal:" >&2
    echo "        launchctl bootstrap $LAUNCHD_DOMAIN $PLIST_DST" >&2
fi

# ── Step 4: Print settings.json hook snippet (D-88: brain dispatcher forms) ───
echo ""
echo "==> [4/6] Merge the following into ~/.claude/settings.json"
echo "    IMPORTANT: Do NOT replace the entire file — merge only these entries."
echo "    Append each hook entry to its existing array (or create the array)."
echo "    Keep all your other existing hooks intact."
echo "    NOTE: 'brain init' automates this merge — run it on new installs instead."
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
            "command": "$NODE_BIN $BRAIN_JS hook session-start",
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
            "command": "$NODE_BIN $BRAIN_JS hook turn-capture",
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
            "command": "$NODE_BIN $BRAIN_JS hook stop",
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
echo "    Node binary  : $NODE_BIN"
echo "    Brain dispatcher: $BRAIN_JS"
echo "    Hook form    : brain hook session-start / turn-capture / stop (D-88)"
echo ""
echo "    NOTE: BRAIN_MEMORY_DB must be visible to Claude Code's process."
echo "    If not set in your shell profile, hooks fall back to:"
echo "      $PROJECT_ROOT/brain.db"
echo "    Set it explicitly if the cold-start-seeded DB is elsewhere:"
echo "      export BRAIN_MEMORY_DB=/absolute/path/to/brain.db"

# ── Step 5: Rollback instructions ────────────────────────────────────────────
echo ""
echo "==> [5/6] Rollback (reversible — MEMORY.md is NEVER deleted):"
echo "    1. Remove the three brain-memory hook entries from ~/.claude/settings.json"
echo "       (D-88 dispatcher form: brain hook session-start / turn-capture / stop)"
echo "    2. launchctl unload $PLIST_DST"
echo "    3. (Optional) rm $PLIST_DST"
echo "    4. (Optional) rm $ENV_FILE"
echo "    After rollback Claude Code uses MEMORY.md as the injection source (unchanged)."
echo ""
# ── Step 6: Cold-start seed (one-shot — skipped if already seeded) ────────────
echo ""
echo "==> [6/6] Cold-start seed (one-shot — skipped if already seeded)..."
if [[ ! -f "$SEED_CLI" ]]; then
    echo "    seed-cli not found — skipping (build may be incomplete)." >&2
else
    echo "    To seed the graph from your memory files, set env vars and run:"
    echo "      BRAIN_MEMORY_DB=$DB_PATH \\"
    echo "      BRAIN_MEMORY_COLD_START_MEMORY_DIR=<path-to-memory-dir> \\"
    echo "      BRAIN_MEMORY_COLD_START_CLAUDE_FILE=<path-to-CLAUDE.md> \\"
    echo "      $NODE_BIN $BRAIN_JS seed"
    echo ""
    echo "    Or using the legacy direct form: $NODE_BIN $SEED_CLI"
    echo ""
    echo "    Optional — route extraction through a different provider (default: anthropic):"
    echo "      BRAIN_MEMORY_EXTRACTOR_PROVIDER=local  # 'anthropic', 'vertex', or 'local'"
    echo ""
    echo "    One-shot: if the 'seeded' meta flag is already set the command is a no-op."
    echo "    Safe no-op: if no source files resolve (misconfigured paths) the one-shot"
    echo "    flag is NOT burned — fix the paths and re-run."
    echo "    Lock-guarded: safe to run alongside the watcher or sleep-pass."
    echo "    Logs: /tmp/brain-memory-seed.log"
fi

echo ""
echo "==> Setup complete."
echo "    Sleep pass: hourly via launchd, wrapper sources $ENV_FILE"
echo "    Split route: extractor=$EXTRACTOR_PROVIDER ($LOCAL_MODEL), judge=$JUDGE_PROVIDER"
echo "    Next: merge the hook snippet, then see docs/dogfood-setup.md"
echo "    for the MEMORY.md double-injection check (Task 2)."
echo ""
