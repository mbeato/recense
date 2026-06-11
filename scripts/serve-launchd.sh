#!/usr/bin/env bash
# serve-launchd.sh — launchd wrapper for brain serve (loopback HTTP + Bearer auth).
#
# Committed, secret-free. Sources the gitignored env file (keys + per-role config)
# then execs the ABI-pinned node on the brain dispatcher with the 'serve' subcommand.
# The env file path is taken from BRAIN_MEMORY_SLEEP_ENV (set in the plist) or
# defaults to ~/.config/brain-memory/sleep.env.
#
# brain serve opens better-sqlite3, so the node binary MUST be the ABI-pinned binary
# written by setup-dogfood.sh as BRAIN_MEMORY_NODE_BIN. There is NO bare-node fallback
# (contrast telegram-client-launchd.sh). A bare-node ABI mismatch crashes better-sqlite3
# at load time; the :? guard fails fast with a clear error message instead (T-13-16).
#
# BRAIN_SERVE_TOKEN is read by serve from the env (sourced from the env file below).
# It is never passed on the command line and never echoed to stdout or any log file.
#
# serve binds loopback (127.0.0.1:7701) by default — no --host flag is passed.
# Remote exposure requires a deliberate opt-in not present here (T-13-15 mitigation).
set -euo pipefail

ENV_FILE="${BRAIN_MEMORY_SLEEP_ENV:-$HOME/.config/brain-memory/sleep.env}"
if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi
exec "${BRAIN_MEMORY_NODE_BIN:?BRAIN_MEMORY_NODE_BIN not set (check $ENV_FILE)}" "${BRAIN_MEMORY_DIST_BRAIN_JS:?BRAIN_MEMORY_DIST_BRAIN_JS not set (check $ENV_FILE)}" serve
