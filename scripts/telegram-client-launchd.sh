#!/usr/bin/env bash
# telegram-client-launchd.sh — launchd wrapper for the recense Telegram reference client.
#
# Committed, secret-free. Sources the gitignored env file (keys + config) then execs
# node on the compiled Telegram client. The env file path is taken from
# RECENSE_SLEEP_ENV (set in the plist) or defaults to
# ~/.config/recense/sleep.env.
#
# The Telegram client has NO native dependencies (no better-sqlite3), so the bare-node
# fallback (:-node) is safe here. This contrasts with serve-launchd.sh, which requires
# the ABI-pinned RECENSE_NODE_BIN because recense serve opens better-sqlite3.
#
# Secrets (TELEGRAM_BOT_TOKEN, BRAIN_SERVE_TOKEN) are sourced from the env file and
# passed as process environment variables. They are never echoed to stdout or any log.
set -euo pipefail

ENV_FILE="${RECENSE_SLEEP_ENV:-$HOME/.config/recense/sleep.env}"
if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi
exec "${RECENSE_NODE_BIN:-node}" "${RECENSE_TELEGRAM_CLIENT_JS:?RECENSE_TELEGRAM_CLIENT_JS not set (check $ENV_FILE)}"
