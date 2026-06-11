#!/usr/bin/env bash
# telegram-client-launchd.sh — launchd wrapper for the brain-memory Telegram reference client.
#
# Committed, secret-free. Sources the gitignored env file (keys + config) then execs
# node on the compiled Telegram client. The env file path is taken from
# BRAIN_MEMORY_SLEEP_ENV (set in the plist) or defaults to
# ~/.config/brain-memory/sleep.env.
#
# The Telegram client has NO native dependencies (no better-sqlite3), so the bare-node
# fallback (:-node) is safe here. This contrasts with serve-launchd.sh, which requires
# the ABI-pinned BRAIN_MEMORY_NODE_BIN because brain serve opens better-sqlite3.
#
# Secrets (TELEGRAM_BOT_TOKEN, BRAIN_SERVE_TOKEN) are sourced from the env file and
# passed as process environment variables. They are never echoed to stdout or any log.
set -euo pipefail

ENV_FILE="${BRAIN_MEMORY_SLEEP_ENV:-$HOME/.config/brain-memory/sleep.env}"
if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi
exec "${BRAIN_MEMORY_NODE_BIN:-node}" "${BRAIN_MEMORY_TELEGRAM_CLIENT_JS:?BRAIN_MEMORY_TELEGRAM_CLIENT_JS not set (check $ENV_FILE)}"
