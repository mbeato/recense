#!/bin/bash
# Autonomous EVAL-02 variance band (260613): confirm the batching finding reproduces.
# Branch A already established: batch-off = 84.6% (11/13), batched = 53.8% (7/13).
# This locks it in across reps so it's not a lucky draw.
#
# Launch DETACHED so it survives a session restart:
#   nohup bash scripts/eval/sweep-all.sh > scripts/eval/results/sweep-all.log 2>&1 </dev/null &
#
# Steerable from phone (SSH): echo stop > /tmp/eval-cmd
# Component swaps (judge-27b, extractor) are DEFERRED — the cause is already found;
# they'd only characterize the system further. Decide on resume.
cd $HOME/brain-memory || exit 1
source $HOME/.config/brain-memory/sleep.env 2>/dev/null || true
CHAT=$(echo "${BRAIN_CLIENT_ALLOWLIST:-}" | cut -d, -f1 | tr -d ' ')
ping() { [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "$CHAT" ] && curl -s --max-time 10 "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" --data-urlencode "chat_id=${CHAT}" --data-urlencode "text=$1" >/dev/null 2>&1 || true; }

ping "🔬 EVAL-02 variance band started: 3× batch-off then 3× batch-on (~3h). Confirming batch-off≈84.6% / batched≈53.8%. Reply not needed; per-run pings follow. Stop anytime: ssh in + echo stop > /tmp/eval-cmd"

LABEL=var-off BATCH=off REPS=3 bash scripts/eval/eval02-sweep.sh
LABEL=var-on  BATCH=on  REPS=3 bash scripts/eval/eval02-sweep.sh

ping "🏁 EVAL-02 variance band complete. Full table in eval02-sweep.csv. Component swaps deferred (cause = batching, already found) — your call on resume."
