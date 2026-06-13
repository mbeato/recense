#!/bin/bash
# EVAL-02 parameterized sweep runner (260613 regression bisect).
# Runs EVAL-02 on the local stack with the given knobs, appends ONE comparable
# result row per rep to eval02-sweep.csv, saves the full per-run log, pings Telegram.
#
# Hardened: (1) lockfile prevents concurrent Ollama contention; (2) rate parsed
# from the 13 contradiction rows (not the scorecard) so a crash on a trailing
# control case still yields the metric; (3) steering hook (stop/skip).
#
# One variable per invocation. Runs are SEQUENTIAL.
#
# Usage:
#   LABEL=batch-off BATCH=off bash scripts/eval/eval02-sweep.sh
#   LABEL=repro     BATCH=off REPS=3 bash scripts/eval/eval02-sweep.sh
#   LABEL=judge-27b BATCH=off JUDGE_MODEL=qwen3.6:27b bash scripts/eval/eval02-sweep.sh
set -uo pipefail
cd $HOME/brain-memory || exit 1

source .env 2>/dev/null || true
source $HOME/.config/brain-memory/sleep.env 2>/dev/null || true

LABEL="${LABEL:-run}"
BATCH="${BATCH:-on}"
JUDGE_MODEL="${JUDGE_MODEL:-qwen3.6:35b-a3b}"
EXTRACTOR_MODEL="${EXTRACTOR_MODEL:-granite4.1:8b}"
REPS="${REPS:-1}"

export BRAIN_MEMORY_JUDGE_PROVIDER=local
export BRAIN_MEMORY_EXTRACTOR_PROVIDER=local
export BRAIN_MEMORY_JUDGE_LOCAL_MODEL="$JUDGE_MODEL"
export BRAIN_MEMORY_EXTRACTOR_LOCAL_MODEL="$EXTRACTOR_MODEL"
unset BRAIN_MEMORY_LOCAL_MODEL
# Per-claim is now the engine default; batching is opt-in. BATCH=on enables it.
if [ "$BATCH" = "on" ]; then export BRAIN_MEMORY_ENABLE_JUDGE_BATCH=1; else unset BRAIN_MEMORY_ENABLE_JUDGE_BATCH; fi

[ -n "${OPENAI_API_KEY:-}" ] || { echo "FATAL: OPENAI_API_KEY not set (harness embedder needs it)." >&2; exit 1; }

# --- lock: only one EVAL-02 at a time (Ollama serializes the 35b judge) ---
LOCK=/tmp/brain-eval02.lock
if [ -f "$LOCK" ] && kill -0 "$(cat "$LOCK" 2>/dev/null)" 2>/dev/null; then
  echo "FATAL: another EVAL-02 run active (pid $(cat "$LOCK")). Refusing to start." >&2
  exit 1
fi
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"' EXIT

# --- telegram progress ping (token from sleep.env, chat id from allowlist) ---
NOTIFY_CHAT_ID="${NOTIFY_CHAT_ID:-$(echo "${BRAIN_CLIENT_ALLOWLIST:-}" | cut -d, -f1 | tr -d ' ')}"
notify() {
  [ "${NOTIFY:-1}" = "1" ] && [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "$NOTIFY_CHAT_ID" ] || return 0
  curl -s --max-time 10 "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${NOTIFY_CHAT_ID}" --data-urlencode "text=$1" >/dev/null 2>&1 || true
}

CSV=scripts/eval/results/eval02-sweep.csv
[ -f "$CSV" ] || echo "ts_utc,commit,label,batch,judge_model,extractor_model,rep,rate_pct,corrected,contra_total" > "$CSV"
COMMIT=$(git rev-parse --short HEAD)

echo "building dist (src must match the run)..."
npm run build >/dev/null 2>&1 || { echo "FATAL: build failed" >&2; exit 1; }

for rep in $(seq 1 "$REPS"); do
  # Steering hook (phone via SSH: echo stop > /tmp/eval-cmd | echo skip > /tmp/eval-cmd).
  if [ -f /tmp/eval-cmd ]; then
    if grep -qiw stop /tmp/eval-cmd; then rm -f /tmp/eval-cmd; notify "🛑 EVAL-02 sweep '${LABEL}' stopped by command before rep ${rep}."; echo "STOPPED by /tmp/eval-cmd"; exit 0; fi
    if grep -qiw skip /tmp/eval-cmd; then rm -f /tmp/eval-cmd; notify "⏭️ EVAL-02 '${LABEL}': skipped remaining reps."; echo "SKIPPED remaining reps of $LABEL"; break; fi
  fi
  TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  RUNLOG="scripts/eval/results/eval02-${LABEL}-rep${rep}.log"
  echo "[$TS] EVAL-02  label=$LABEL batch=$BATCH judge=$JUDGE_MODEL extractor=$EXTRACTOR_MODEL  rep=$rep/$REPS"
  node scripts/eval/correctness-harness.cjs > "$RUNLOG" 2>&1 || echo "  (harness exited non-zero — parsing whatever completed)"

  # Rate from the 13 contradiction rows directly (robust to a crash on a trailing control case).
  CORR=$(grep -cE "contradict[[:space:]]*\|[[:space:]]*brain-memory[[:space:]]*\|[[:space:]]*CORRECTED" "$RUNLOG")
  CONTRA=$(grep -cE "contradict[[:space:]]*\|[[:space:]]*brain-memory[[:space:]]*\|[[:space:]]*(CORRECTED|STALE|UNCHANGED)" "$RUNLOG")
  if [ "${CONTRA:-0}" -ge 1 ]; then RATE=$(awk -v c="$CORR" -v t="$CONTRA" 'BEGIN{printf "%.1f", c*100/t}'); else RATE="ERR"; fi
  FLAG=""; [ "${CONTRA:-0}" -lt 13 ] && FLAG=" ⚠partial(${CONTRA}/13)"

  echo "$TS,$COMMIT,$LABEL,$BATCH,$JUDGE_MODEL,$EXTRACTOR_MODEL,$rep,$RATE,$CORR,$CONTRA" >> "$CSV"
  echo "  -> rate=${RATE}%  (${CORR}/${CONTRA})${FLAG}   log: $RUNLOG"
  notify "EVAL-02 ${LABEL} ${rep}/${REPS}: ${RATE}% (${CORR}/${CONTRA})${FLAG}  [batch=${BATCH} judge=${JUDGE_MODEL}]"
done

notify "✅ EVAL-02 sweep '${LABEL}' done (${REPS} rep(s)). See eval02-sweep.csv."
echo ""
echo "=== eval02-sweep.csv ==="
column -t -s, "$CSV"
