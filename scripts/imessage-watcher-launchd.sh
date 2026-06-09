#!/usr/bin/env bash
# imessage-watcher-launchd.sh — launchd wrapper for the brain-memory iMessage watcher.
#
# Committed, secret-free. Sources the same gitignored env file as the sleep pass
# (keys + per-role config) then execs node on the compiled iMessage watcher CLI.
# The env file path is taken from BRAIN_MEMORY_SLEEP_ENV (set in the plist) or
# defaults to ~/.config/brain-memory/sleep.env.
#
# The env file holds BRAIN_MEMORY_WATCHER_JS (written additively by
# scripts/setup-imessage-channel.sh) alongside the existing ANTHROPIC_API_KEY,
# OPENAI_API_KEY, BRAIN_MEMORY_DB, and other sleep-pass keys — no second file needed.
set -euo pipefail

ENV_FILE="${BRAIN_MEMORY_SLEEP_ENV:-$HOME/.config/brain-memory/sleep.env}"
if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi
exec "${BRAIN_MEMORY_NODE_BIN:-node}" "${BRAIN_MEMORY_WATCHER_JS:?BRAIN_MEMORY_WATCHER_JS not set (check $ENV_FILE)}"
