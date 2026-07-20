# Phase 26: Retrieval-Embedding Fix - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-18
**Phase:** 26-retrieval-embedding-fix
**Mode:** `--auto` (all areas auto-selected from recommended option; no interactive prompts)
**Areas discussed:** Diagnosis ordering, Which fix lever, Embedding dimensions, Re-embed mechanism, Validation & cost control

---

## Diagnosis ordering

| Option | Description | Selected |
|--------|-------------|----------|
| Confirm root cause cheaply first, then fix | $0 spot-check that the weakness is model-bound before re-embed + paid replay | ✓ |
| Go straight to the known-best fix | Skip diagnosis; apply text-embedding-3-large immediately | |

**Choice:** Confirm root cause cheaply first (D-01). RETR-01 explicitly requires a diagnosed root cause.
**Notes:** Diagnosis is already strongly indicated by prior eval work (small-model cues never clear 0.7); this step re-confirms model-bound vs threshold/prefix-bound before spending budget.

---

## Which fix lever

| Option | Description | Selected |
|--------|-------------|----------|
| Swap live embedder to text-embedding-3-large | Model swap on the OpenAI production path | ✓ |
| Add query-instruction prefix | Qwen3-style asymmetric prefix | |
| Both | Prefix + model swap | |

**Choice:** Model swap to text-embedding-3-large (D-02/D-03/D-04).
**Notes:** Scout confirmed the live engine embedder is always `OpenAIEmbedder` (`provider.ts:134`, `config.ts:623`) — no local Qwen3 in production. OpenAI text-embedding-3 models are symmetric, so the prefix lever is local/eval-stack-only and out of scope. Single lever first; stack more only if the gate fails.

---

## Embedding dimensions

| Option | Description | Selected |
|--------|-------------|----------|
| Keep 1536 (large reduced) | Surgical, storage-flat, no dims-guard change | ✓ |
| Native 3072 | Max quality, doubles embedding storage | |

**Choice:** Keep 1536 (D-05). 3072 retained as a documented fallback lever.
**Notes:** large@1536 > small@1536; keeps topk dims-mismatch guard and write-side assertion untouched.

---

## Re-embed mechanism (RETR-03)

| Option | Description | Selected |
|--------|-------------|----------|
| Reuse dirty-flag machinery | Null all embedded_hash/embedding, replay existing re-embed pass | ✓ |
| Bespoke re-embed migration | New standalone re-embed script outside the dirty-flag path | |

**Choice:** Reuse dirty-flag + setEmbedding single writer (D-06), back up DB first (D-07), add embed-model version stamp (D-08).
**Notes:** Graph stays source of truth; vector store fully rebuildable. Full re-embed must include tombstoned nodes (still cosine-scannable, D-29). No embed-model stamp currently exists in the DB.

---

## Validation & cost control (RETR-02)

| Option | Description | Selected |
|--------|-------------|----------|
| Success-criteria gates + $0 diagnosis + approval-gated paid run | KU retrieval up AND judge engages AND EVAL-02 ≥84.6%; approval before paid replay | ✓ |
| Run paid replay immediately | Skip cheap diagnosis | |

**Choice:** Success-criteria gates with cost discipline (D-09/D-10).
**Notes:** Hard signal — a KU number bump alone is insufficient; the reconsolidation judge must actually engage. Budget tight (~$14–15); re-embed is pennies, the replay eval is the ~$3–5 cost; quote and get approval first.

---

## Claude's Discretion
- Exact $0 diagnosis spot-check method (known KU query/cue pairs, large@1536 vs small@1536 cosine).
- Whether to escalate to native 3072 dims — fallback only if large@1536 misses the gate.
- Cosine thresholds left as-is unless diagnosis proves threshold-bound (not expected).

## Deferred Ideas
- Local Qwen3-Embedding query-instruction prefix — $0 fix for the local/eval stack only; out of scope while production uses OpenAI.
- Native 3072-dim embeddings — fallback lever.
- General threshold re-tuning — untouched unless diagnosis shows threshold-bound weakness.
- Reviewed-not-folded todos: `content-hardening-deferred.md` (ingestion, off-domain), `viz-search-and-hull-quality.md` (viz, off-domain) — both spurious "source/phase" keyword matches.
