#!/usr/bin/env bash
# watcher-launchd.sh — launchd wrapper for the recense channel watcher.
#
# Committed, secret-free. Sources the same gitignored env file as the sleep pass
# (keys + per-role config) then execs node on the compiled watcher CLI.
# The env file path is taken from RECENSE_SLEEP_ENV (set in the plist) or
# defaults to ~/.config/recense/sleep.env.
#
# The env file holds RECENSE_WATCHER_JS (written additively by
# scripts/setup-watcher.sh) alongside the existing ANTHROPIC_API_KEY,
# OPENAI_API_KEY, RECENSE_DB, and other sleep-pass keys — no second file needed.
set -euo pipefail

ENV_FILE="${RECENSE_SLEEP_ENV:-$HOME/.config/recense/sleep.env}"
if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi
exec "${RECENSE_NODE_BIN:-node}" "${RECENSE_WATCHER_JS:?RECENSE_WATCHER_JS not set (check $ENV_FILE)}"
