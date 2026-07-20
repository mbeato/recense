# Phase 47: Hybrid Retrieval Recall — Pattern Map

**Mapped:** 2026-06-28
**Files analyzed:** 5 (all modified, none created)
**Analogs found:** 5 / 5 (all self-analog — each file is its own closest match; patterns extracted from sibling knobs/calls within the same file or its immediate caller)

---

## File Classification

| Modified File | Role | Data Flow | Closest Analog Pattern | Match Quality |
|---|---|---|---|---|
| `src/retrieval/topk.ts` | utility (retrieval primitive) | request-response | `strengthWeight > 0` conditional in `hybridTopk` (same file, lines 473–494) | exact |
| `src/retrieval/engine.ts` | service (retrieval orchestration) | request-response | `rankStrengthWeight` threading in `retrieveRanked` call at line 403 | exact |
| `src/responder/index.ts` | controller (answer orchestration) | request-response | existing `retrieveRanked` call at line 191 — add 4th arg | exact |
| `src/lib/config.ts` | config | N/A | `rankStrengthWeight` knob definition (interface lines 338–342, default line 794) | exact |
| `scripts/eval/locomo-harness.cjs` | test/eval batch script | batch | `evalRetriever.topk()` call at line 464 + `buildRetrievalEngine()` at line 158 | exact |

---

## Pattern Assignments

### `src/retrieval/topk.ts` (utility, request-response)

**Edit site:** `hybridTopk` method, lines 473–494 — specifically the `rrfFuse` call at line 494 that currently passes no weights (implicit weight=1 for both lists).

**Current core pattern — dark-knob conditional (lines 473–494):**
```typescript
if (strengthWeight > 0) {
  // ... build strengthList ...
  fused = rrfFuse(
    [cosineList, bm25List, strengthList],
    60, k,
    [1, 1, strengthWeight],   // <-- weights array: cosine=1, bm25=1, strength=tunable
  );
} else {
  // D-04 dark default: strengthWeight=0 → exact current behavior, no DB strength query
  fused = rrfFuse([cosineList, bm25List], 60, k);  // <-- THE EDIT SITE (line 494)
}
```

**What changes:** The `else` branch at line 494 passes no weights to `rrfFuse`, which defaults both to `w=1`. The new `bm25FusionWeight` scalar must be threaded as the second weight:
```typescript
fused = rrfFuse([cosineList, bm25List], 60, k, [1, bm25FusionWeight]);
```

**`hybridTopk` signature — current (lines 444–452):**
```typescript
hybridTopk(
  queryVec: Float32Array,
  queryText: string,
  k: number,
  preK = k * 3,
  strengthWeight = 0,
  nowMs?: number,
  lambda?: number,
): Array<{ id: string; score: number }>
```

**What changes:** Add `bm25FusionWeight = 1` parameter (defaulting to 1 preserves current behavior when callers don't pass it; the config knob default of 0 is the isolation switch). Place it after `strengthWeight` or use a distinct position — but the planner must match the call site in `engine.ts` (see below).

**`rrfFuse` signature (lines 239–256):**
```typescript
export function rrfFuse(
  lists: Array<Array<{ id: string }>>,
  k = 60,
  topK = 10,
  weights?: number[],
): Array<{ id: string; rrfScore: number }>
```
The `weights?.[li] ?? 1` fallback at line 247 means passing `[1, 0]` as weights makes the BM25 list contribute zero — exactly the isolation behavior required by D-02.

**Invariant to preserve:** `ftsQueryFromText()` sanitization (line 457) and the `try/catch` FTS-absent fallback (lines 459–465) must remain untouched.

---

### `src/retrieval/engine.ts` (service, request-response)

**Edit site:** `retrieveRanked` method, lines 400–407 — the `hybridTopk` call that currently passes `this.config.rankStrengthWeight` as the strength weight. Add `bm25FusionWeight` in the same position.

**Current LEVER 1 routing (lines 400–407):**
```typescript
const hits = queryText
  ? this.retriever.hybridTopk(
      queryVec, queryText, k, undefined,
      this.config.rankStrengthWeight,   // strength weight — stays unchanged
      this.clock.nowMs(),
      this.config.lambda,
    )
  : this.retriever.topk(queryVec, k);
```

**What changes:** Thread `this.config.bm25FusionWeight` into the `hybridTopk` call as the `bm25FusionWeight` parameter. Exact position depends on where the parameter lands in the updated `hybridTopk` signature (coordinate with the `topk.ts` change).

**Invariant to preserve:** The `floor gate` loop at lines 413–421 (the `break` vs `continue` logic for pure-cosine vs hybrid modes) is unchanged. LEVER 2 temporal sort at lines 456–499 is unchanged and stays ON when fusion is on (D-03).

**`retrieveRanked` full signature for reference (lines 388–394):**
```typescript
retrieveRanked(
  queryVec: Float32Array,
  k: number,
  floor: number,
  queryText?: string,
  opts?: { temporalAnnotate?: boolean; vizFloor?: number },
): Array<{ id: string; value: string; score: number }>
```

---

### `src/responder/index.ts` (controller, request-response)

**Edit site:** `respond()` method, lines 191–195 — the `retrieveRanked` call that currently passes no `queryText` (pure cosine path).

**Current call (lines 191–195):**
```typescript
const ranked = this.retrieval.retrieveRanked(
  cueVec,
  this.config.rankedRetrievalK,
  this.config.rankedRetrievalFloor,
);
```

**What changes (D-07):** Add `queryForEmbed` as the 4th argument so the live QA path uses hybrid fusion:
```typescript
const ranked = this.retrieval.retrieveRanked(
  cueVec,
  this.config.rankedRetrievalK,
  this.config.rankedRetrievalFloor,
  queryForEmbed,   // <-- new: enables LEVER 1 hybrid fusion on the product path
);
```

`queryForEmbed` is already in scope at this point (set at line 160, possibly LEVER-3-rewritten at line 169). It is user-derived, satisfying T-04-03-I.

**Comment block to update (lines 186–190):** The block currently explains why LEVER 1 is "intentionally absent." It must be replaced with a note that LEVER 1 is now ON with the `bm25FusionWeight` scalar, the `w=0` isolation knob, and the D-04 per-category gate as the regression guard.

**Variable in scope at line 191:**
```typescript
let queryForEmbed = boundedQuery;   // line 160
// ... possibly rewritten to declarative statement ... (lines 161–173)
const [cueVec] = await this.provider.embed([queryForEmbed]);  // line 177
```

---

### `src/lib/config.ts` (config)

**Edit sites:** Two locations — the `EngineConfig` interface (add field definition + JSDoc) and the `DEFAULT_CONFIG` object (add default value).

**Pattern to copy — interface field (lines 338–342, `rankStrengthWeight`):**
```typescript
  /**
   * Phase 35 RANK-01: weight for the strength-ranked third RRF list in hybridTopk (D-01).
   * ...
   * CAUTION: effective_s already folds recency via exp(−λ·Δt since last_access) — this is
   * one signal, one knob (D-03). Do NOT add a separate last_access recency list.
   */
  rankStrengthWeight: number;
```

**New field follows this pattern — place immediately after `rankStrengthWeight` field:**
```typescript
  /**
   * Phase 47 RETR-02: BM25 fusion weight for the rrfFuse call in hybridTopk.
   * Controls how strongly lexical (BM25) matches contribute relative to cosine (fixed at 1.0).
   * Dark isolation switch: weight=0 reproduces exactly today's pure-cosine behavior
   * (mirrors bm25CandidateK=0 and rankStrengthWeight=0 conventions — D-02).
   * Tune via held-out LoCoMo sweep; ship w* = argmax(R@5) with zero per-category regression (D-04/D-05).
   */
  bm25FusionWeight: number;
```

**Pattern to copy — default value (line 794, `rankStrengthWeight`):**
```typescript
  rankStrengthWeight: 0,  // D-04: dark default — ships w=0; no behavior change at merge
```

**New default follows this pattern — place immediately after `rankStrengthWeight` default:**
```typescript
  bm25FusionWeight: 0,  // Phase 47 D-02: dark default — w=0 reproduces pure-cosine; flip to w* after held-out tune
```

**Neighboring knobs for placement reference:**
```
line 785:  bm25CandidateK: 5,
line 794:  rankStrengthWeight: 0,
line 806:  rankedRetrievalK: 10,
line 807:  rankedRetrievalFloor: 0.3,
```

---

### `scripts/eval/locomo-harness.cjs` (eval/test, batch)

**CRITICAL CONTEXT — UNCOMMITTED WORKING-TREE DIFF:**
The file has a 28-line uncommitted diff (`+23/-5`) that is the answerer-V2 abstention prompt experiment (`RECENSE_LOCOMO_ANSWER_V2=1` env-var path, lines ~515–545). This diff is OUT OF SCOPE for Phase 47 (explicitly deferred in CONTEXT.md). The planner/executor must NOT entangle it with the hybrid retrieval arm changes. The hybrid arm edits are at the retrieval call site (line 464) and R@K computation (lines 500–501, and category aggregation); the answerer-V2 diff touches lines 515+ (answer prompt construction). The two sections are non-overlapping — apply the Phase 47 changes surgically to lines 460–510 without rebasing or resolving the answerer-V2 diff.

**Edit site 1 — retrieval call (line 464):**
```javascript
// Current:
const topkResults    = evalRetriever.topk(queryVec, TOP_K);

// Hybrid arm replaces or augments this with hybridTopk:
const topkResults    = evalRetriever.hybridTopk(queryVec, questionText, TOP_K);
//   OR use buildRetrievalEngine (already defined at line 158) + retrieveRanked with floor=0
//   to exercise the exact same fusion+temporal path as the responder (D-08).
```

**`buildRetrievalEngine` pattern (lines 158–165) — use this for the hybrid arm to mirror the responder path:**
```javascript
function buildRetrievalEngine(db, dbPath) {
  const config    = { ...DEFAULT_CONFIG, dbPath };
  const retriever = new CandidateRetriever(db);
  const store     = new SemanticStore(db, realClock, config);
  const strength  = new StrengthDecayManager(db, realClock, config);
  const gate      = new AllocationGate(config);
  const traceSink = new NoopActivationTraceSink();
  return new RetrievalEngine(db, realClock, config, retriever, store, strength, gate, traceSink);
}
```
This factory is already imported and wired (line 57: `require(DIST + '/retrieval/engine')`). The planner should decide whether to call `hybridTopk` directly on `evalRetriever` or construct a `RetrievalEngine` via `buildRetrievalEngine` to get the full LEVER 2 temporal sort that the responder uses (D-08 requires exercising the same fusion+temporal path). Using `buildRetrievalEngine` + `retrieveRanked(queryVec, TOP_K, 0, questionText)` with `floor=0` (to let all fused results through for eval) is the more faithful option.

**Edit site 2 — R@K computation (lines 500–501):**
```javascript
const sessionsAt5  = retrievedSessionsForIds(topkIds.slice(0, 5));
const sessionsAt10 = retrievedSessionsForIds(topkIds.slice(0, 10));
```
`topkIds` is populated at line 467 from `topkResults.map(r => r.id)`. For the hybrid arm, populate `topkIds` identically from the hybrid result (same field, same shape — `{ id, score }` array). No change to `retrievedSessionsForIds` or the `hit5`/`hit10` computation needed.

**Per-category R@K reporting (D-04 gate) — current pattern:**
`qa.category` is already in the record at line 390/567 and propagated to the JSONL output. The harness does NOT currently aggregate per-category R@K statistics at runtime — `hit5`/`hit10` are per-QA booleans in the JSONL, and any category-level aggregation is done post-hoc by reading the JSONL. The planner must decide whether per-category aggregation is added as in-harness console output at the end or deferred to the post-processing script. The existing `category` field in the output record is the hook.

**Output record shape (lines 563–578) — hybrid arm must produce the same shape:**
```javascript
qaResults[qaIdx] = {
  sample_id:    sampleId,
  question:     questionText,
  gold_answer:  goldAnswer,
  category:     qa.category,
  hypothesis,
  evidence:     qa.evidence || [],
  hit5,
  hit10,
  retrieval_ms: retrievalMs,
  embed_ms:     embedMs,
  answer_ms:    answerMs,
  topk_ids:     topkIds,
  topk_scores:  topkScores,
};
```

**Imports already in place (lines 50–64):**
```javascript
const { RetrievalEngine }       = require(DIST + '/retrieval/engine');
const { CandidateRetriever }    = require(DIST + '/retrieval/topk');
const { DEFAULT_CONFIG }        = require(DIST + '/lib/config');
// ... StrengthDecayManager, AllocationGate, NoopActivationTraceSink all imported
```
No new imports needed for the hybrid arm regardless of which approach (direct `hybridTopk` or `buildRetrievalEngine`).

---

## Shared Patterns

### Dark/Isolation-Knob Convention
**Source:** Multiple sites — `bm25CandidateK` (config.ts line 785), `rankStrengthWeight` (config.ts line 794), `insightSurfacingEnabled` (config.ts line 827), `strengthWeight > 0` guard (topk.ts lines 473–494).
**Apply to:** `bm25FusionWeight` default in `DEFAULT_CONFIG` and its conditional guard in `hybridTopk`.

The convention is:
1. Default is `0` (or `false`) — ships dark with zero behavior change.
2. Inline comment cites the phase + decision: `// Phase 47 D-02: dark default — ...`
3. Code guard uses `if (weight > 0)` or passes `weight` directly into the weights array (when 0 collapses to cosine-only via the `w / (k + rank + 1)` term being 0).
4. `weight=0` must be mathematically equivalent to the previous behavior — verified by the rrfFuse weights: `[1, 0]` means BM25 list contributes `0 * 1/(60+rank+1) = 0` → all scores from cosine only.

### Config Knob JSDoc Pattern
**Source:** `rankStrengthWeight` interface doc at config.ts lines 333–342; `rankedRetrievalFloor` at lines 396–404.
**Apply to:** New `bm25FusionWeight` interface field.

Each knob doc includes: phase origin, what it controls, what zero means, calibration note (tune against what dataset, what constraint).

### FTS Safety Invariant (T-17-02-T)
**Source:** `ftsQueryFromText()` call at topk.ts line 457; stmtBm25 comment at lines 273–276.
**Apply to:** Any code in the harness that passes `questionText` into BM25. The harness must call through `hybridTopk` (which internally calls `ftsQueryFromText`) or use `retrieveRanked` — never pass raw text directly to `stmtBm25`.

---

## No Analog Found

None. All five files are straightforward extensions of existing patterns already present in the same file or its direct caller.

---

## Metadata

**Analog search scope:** `src/retrieval/`, `src/responder/`, `src/lib/config.ts`, `scripts/eval/`
**Files read:** 5 source files (topk.ts, engine.ts, responder/index.ts, config.ts, locomo-harness.cjs)
**Pattern extraction date:** 2026-06-28
