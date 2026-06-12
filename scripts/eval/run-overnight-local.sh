#!/bin/bash
# Overnight local-inference correctness eval (quick task 260611-ue6 verification).
# Per-role validated split (V5 postmortem 2026-06-12): extraction on qwen2.5:7b-instruct
# (won the 2026-06-07 extraction bake-off; 35b-with-thinking silently breaks claim parsing
# — V5 scored 38.5% from empty extractions), judge on qwen3.6:35b-a3b (won judge-eval v2
# under the contradicted_ids+order-swap contract). Embeddings OpenAI.
# Detached via nohup so it survives the Claude Code session. Results land in
# scripts/eval/results/correctness-LOCAL-V7.json; log alongside.
set -uo pipefail
cd $HOME/brain-memory

set -a
source .env 2>/dev/null || true
source $HOME/.config/brain-memory/sleep.env 2>/dev/null || true
set +a

export BRAIN_MEMORY_JUDGE_PROVIDER=local
export BRAIN_MEMORY_EXTRACTOR_PROVIDER=local
# Per-role pins (resolveProviderOverlay role-specific keys) — the validated split.
# Extractor: granite4.1:8b won the 2026-06-12 bake-off (scripts/eval/extractor-bakeoff-results.json):
# best change-normalization (incl. both V6 genuine-miss cases 7/8), 0 regurgitation, 0 think-leak,
# 2.32s/ep under constrained decoding. Prior winner qwen2.5:7b-instruct kept as fallback.
export BRAIN_MEMORY_EXTRACTOR_LOCAL_MODEL=qwen2.5:7b-instruct
export BRAIN_MEMORY_JUDGE_LOCAL_MODEL=qwen3.6:35b-a3b
# Unset the sleep.env shared override so the per-role pins are the only model selectors.
unset BRAIN_MEMORY_LOCAL_MODEL

LOG=scripts/eval/results/overnight-local-run.log
echo "=== overnight local eval start: $(date) ===" >> "$LOG"
echo "engine: $(git rev-parse --short HEAD)" >> "$LOG"

node scripts/eval/correctness-harness.cjs >> "$LOG" 2>&1
STATUS=$?

if [ $STATUS -eq 0 ] && [ -f scripts/eval/results/correctness-PENDING.json ]; then
  cp scripts/eval/results/correctness-PENDING.json scripts/eval/results/correctness-LOCAL-V7.json
  echo "=== done: $(date) — results copied to correctness-LOCAL-V7.json ===" >> "$LOG"
else
  echo "=== FAILED (exit $STATUS): $(date) ===" >> "$LOG"
fi
