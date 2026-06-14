#!/bin/bash
# Overnight local-inference correctness eval (quick task 260611-ue6 verification).
# Per-role validated split: extraction granite4.1:8b (V8-adopted 2026-06-12; lineage
# V5 = 35b-thinking extractor bust, V6 = qwen2.5 61.5%, V7 = timeout-bug artifact,
# V8 = granite 84.6%), judge qwen3.6:35b-a3b (judge-eval v2 winner). Embeddings OpenAI.
# Detached via nohup so it survives the Claude Code session. Results land in
# scripts/eval/results/correctness-LOCAL-V8.json; log alongside.
set -uo pipefail
cd $HOME/recense

set -a
source .env 2>/dev/null || true
source $HOME/.config/recense/sleep.env 2>/dev/null || true
set +a

export RECENSE_JUDGE_PROVIDER=local
export RECENSE_EXTRACTOR_PROVIDER=local
# Per-role pins (resolveProviderOverlay role-specific keys) — the validated split.
# Extractor: granite4.1:8b — ADOPTED via V8 (84.6% scorer / 92.3% content-correct,
# vs qwen2.5:7b's V6 61.5%). The V7 "rejection" (38.5%) was an infra bug — 60s SDK
# timeout vs Ollama-serialized concurrent judge calls (fixed 1849c27, LOCAL_SDK_TIMEOUT_MS).
# Known residual: bare-entity nodes can win query-probe retrieval (V8 case 13 → "Biscuit").
export RECENSE_EXTRACTOR_LOCAL_MODEL=granite4.1:8b
export RECENSE_JUDGE_LOCAL_MODEL=qwen3.6:35b-a3b
# Unset the sleep.env shared override so the per-role pins are the only model selectors.
unset RECENSE_LOCAL_MODEL

LOG=scripts/eval/results/overnight-local-run.log
echo "=== overnight local eval start: $(date) ===" >> "$LOG"
echo "engine: $(git rev-parse --short HEAD)" >> "$LOG"

node scripts/eval/correctness-harness.cjs >> "$LOG" 2>&1
STATUS=$?

if [ $STATUS -eq 0 ] && [ -f scripts/eval/results/correctness-PENDING.json ]; then
  cp scripts/eval/results/correctness-PENDING.json scripts/eval/results/correctness-LOCAL-V8.json
  echo "=== done: $(date) — results copied to correctness-LOCAL-V8.json ===" >> "$LOG"
else
  echo "=== FAILED (exit $STATUS): $(date) ===" >> "$LOG"
fi
