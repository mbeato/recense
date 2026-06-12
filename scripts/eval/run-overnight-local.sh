#!/bin/bash
# Overnight local-inference correctness eval (quick task 260611-ue6 verification).
# Judge + extractor on local Ollama (qwen3.6:35b-a3b via config default); embeddings OpenAI.
# Detached via nohup so it survives the Claude Code session. Results land in
# scripts/eval/results/correctness-LOCAL-V5.json; log alongside.
set -uo pipefail
cd $HOME/brain-memory

set -a
source .env 2>/dev/null || true
source $HOME/.config/brain-memory/sleep.env 2>/dev/null || true
set +a

export BRAIN_MEMORY_JUDGE_PROVIDER=local
export BRAIN_MEMORY_EXTRACTOR_PROVIDER=local
# Unset the sleep.env 7b override so BOTH roles use config default qwen3.6:35b-a3b
# (the judge model validated against Haiku on contradiction detection, 2026-06-07).
unset BRAIN_MEMORY_LOCAL_MODEL

LOG=scripts/eval/results/overnight-local-run.log
echo "=== overnight local eval start: $(date) ===" >> "$LOG"
echo "engine: $(git rev-parse --short HEAD)" >> "$LOG"

node scripts/eval/correctness-harness.cjs >> "$LOG" 2>&1
STATUS=$?

if [ $STATUS -eq 0 ] && [ -f scripts/eval/results/correctness-PENDING.json ]; then
  cp scripts/eval/results/correctness-PENDING.json scripts/eval/results/correctness-LOCAL-V5.json
  echo "=== done: $(date) — results copied to correctness-LOCAL-V5.json ===" >> "$LOG"
else
  echo "=== FAILED (exit $STATUS): $(date) ===" >> "$LOG"
fi
