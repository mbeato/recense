#!/usr/bin/env bash
# serve-launchd.sh — launchd wrapper for recense serve (loopback HTTP + Bearer auth).
#
# Committed, secret-free. Sources the gitignored env file (keys + per-role config)
# then execs the ABI-pinned node on the brain dispatcher with the 'serve' subcommand.
# The env file path is taken from RECENSE_SLEEP_ENV (set in the plist) or
# defaults to ~/.config/recense/sleep.env.
#
# recense serve opens better-sqlite3, so the node binary MUST be the ABI-pinned binary
# written by setup-dogfood.sh as RECENSE_NODE_BIN. There is NO bare-node fallback
# (contrast telegram-client-launchd.sh). A bare-node ABI mismatch crashes better-sqlite3
# at load time; the :? guard fails fast with a clear error message instead (T-13-16).
#
# RECENSE_SERVE_TOKEN is read by serve from the env (sourced from the env file below).
# It is never passed on the command line and never echoed to stdout or any log file.
#
# serve binds loopback (127.0.0.1:7701) by default — no --host flag is passed.
# Remote exposure requires a deliberate opt-in not present here (T-13-15 mitigation).
set -euo pipefail

ENV_FILE="${RECENSE_SLEEP_ENV:-$HOME/.config/recense/sleep.env}"
if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi
exec "${RECENSE_NODE_BIN:?RECENSE_NODE_BIN not set (check $ENV_FILE)}" "${RECENSE_DIST_JS:?RECENSE_DIST_JS not set (check $ENV_FILE)}" serve
