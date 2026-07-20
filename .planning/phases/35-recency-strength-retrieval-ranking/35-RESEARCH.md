# Phase 35: Recency/Strength-Weighted Retrieval Ranking — Research

**Researched:** 2026-06-20
**Domain:** Retrieval ranking — RRF fusion extension, strength signal plumbing, eval harness mechanics
**Confidence:** HIGH (all findings verified directly against live source at exact lines)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Third weighted RRF list — `rrfFuse([cosineList, bm25List, strengthList])`. Strength contributes `w · 1/(k+rank)`. NOT post-RRF blend.
- **D-02:** Strength list drawn ONLY from the existing candidate pool (cosinePreK ∪ BM25preK). Never widens the pool.
- **D-03:** Rank by `effective_s` alone (one signal, one knob). No separate `last_access` recency list.
- **D-04:** Ship default weight `w = 0` (dark). Zero behavior change at merge.
- **D-05:** Eval sweeps `w` over a range and reports the winning value.
- **D-06:** Two measurements — (a) token-saving OR (b) precision. Phase passes if EITHER wins.
- **D-07:** "No regression" = within run-to-run variance (~1–2 pts LLM-judge noise).
- **D-08:** Cue-based path only — `retrieveRanked`/`hybridTopk`. Leave `retrieveCueless`/SessionStart untouched.
- **D-09:** Scope stays provenance-only, never a retrieval signal.
- **D-10:** Strength term never resurfaces tombstoned nodes. Inherited from D-02 (pool excludes tombstoned).
- **D-11:** Online path stays LLM-free; net-zero new runtime deps.

### Claude's Discretion
- Exact `w` sweep grid (e.g. {0, 0.25, 0.5, 1.0, …})
- `candidateK`/preK sizing for the candidate pool
- Config knob name (suggest `rankStrengthWeight` or similar, sibling to existing `rankWeightS`/`rankWeightR`)

### Deferred Ideas (OUT OF SCOPE)
- Flipping the activated default (raising `w` from 0 to the eval-winning value on the live hot path)
- Unifying cue-less and cue-based ranking under one mechanism
- Separate fresh-but-weak recency boost (a distinct `last_access` list/knob)
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| RANK-01 | Strength/recency term fused into ranking, tunable weight, online path LLM-free | D-01 mechanism lives in `rrfFuse` + `hybridTopk`; `effectiveStrength` is pure and LLM-free |
| RANK-02 | Eval-backed: no regression + token saving OR precision win on KU/LongMemEval harness | Focus Area 4 documents the gaps that must be closed before RANK-02 is measurable |
</phase_requirements>

---

## Summary

This is a surgical, well-scoped change to two functions in one file (`topk.ts`) plus one config knob and one wire-up call in `engine.ts`. The mechanism design is already locked in CONTEXT.md; research focused on the four plumbing questions the planner cannot safely assume.

**The most important finding:** The KU replay harness currently calls `retrieveRanked` WITHOUT `queryText`, which routes through pure cosine `topk` — NOT `hybridTopk` — meaning the strength fusion mechanism (which lives entirely in the `hybridTopk` branch) is NOT exercised by the KU harness as-is. This is a planning gap that must be addressed explicitly: either update the KU harness to pass `kuCase.question` as queryText, or accept that RANK-02 measurement uses LME only.

**Secondary finding:** `hybridTopk` and `rrfFuse` have no per-list weight parameter today. Both need minimal additive changes (optional params, backward compatible). The `CandidateRetriever` class also has no access to `s`/`last_access` per candidate — a new private prepared statement is required to fetch strength data for the pool.

**Primary recommendation:** Implement the strength list assembly inside `hybridTopk` via a new private SQL statement on `CandidateRetriever` that fetches `s`/`last_access` for pool candidates using `json_each`. Pass `nowMs` and `lambda` as optional params to `hybridTopk`. Add optional `weights` param to `rrfFuse`. Extend the KU harness to pass `queryText`. Wire everything through `rankStrengthWeight: 0` in DEFAULT_CONFIG.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Strength/recency signal computation | Retrieval layer (`topk.ts`) | — | `effectiveStrength` is pure; call site lives in retrieval, not engine business logic |
| RRF fusion with weights | Retrieval layer (`topk.ts:rrfFuse`) | — | Already owns fusion; extends naturally |
| Candidate pool assembly | Retrieval layer (`topk.ts:hybridTopk`) | — | cosineList + bm25List assembled here; strength list must also be built here (D-02) |
| Config knob + wiring | Engine layer (`engine.ts:retrieveRanked`) | Config (`config.ts`) | Engine reads config and passes weight params to retriever |
| Eval harness measurement | Scripts layer (`scripts/eval/`) | — | LLM-free measurement concern; no engine change needed |

---

## Focus Area 1: `rrfFuse` Extension Shape

### Current signature (topk.ts L58) [VERIFIED: live source]

```typescript
export function rrfFuse(
  lists: Array<Array<{ id: string }>>,
  k = 60,
  topK = 10,
): Array<{ id: string; rrfScore: number }> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((hit, rank) => {
      scores.set(hit.id, (scores.get(hit.id) ?? 0) + 1 / (k + rank + 1));
    });
  }
  ...
}
```

**Finding:** `rrfFuse` does NOT currently accept per-list weights. Every list contributes equally with `1 / (k + rank + 1)`. To add a weighted third list, the signature must change.

### Minimal diff shape [ASSUMED: design recommendation]

Add optional `weights?: number[]` as 4th param:

```typescript
export function rrfFuse(
  lists: Array<Array<{ id: string }>>,
  k = 60,
  topK = 10,
  weights?: number[],
): Array<{ id: string; rrfScore: number }> {
  const scores = new Map<string, number>();
  for (let li = 0; li < lists.length; li++) {
    const w = weights?.[li] ?? 1;
    lists[li]!.forEach((hit, rank) => {
      scores.set(hit.id, (scores.get(hit.id) ?? 0) + w / (k + rank + 1));
    });
  }
  ...
}
```

When `weights` is omitted, every list defaults to weight 1 — byte-identical to current behavior. All existing callers pass 3 args max; no call sites break.

### Callers of `rrfFuse` today [VERIFIED: live source]

Only one call site in production code:
- `topk.ts:203`: `rrfFuse([cosineList, bm25List], 60, k)` — inside `hybridTopk`

Test call sites:
- `fts-retrieval.test.ts` — direct unit tests of `rrfFuse` with 2 lists

**None require changes.** The optional `weights` param leaves all callers untouched.

### Dark-default invariant (D-04) [VERIFIED: math]

When `rankStrengthWeight = 0`, the strength list contribution is `0 · 1/(k+rank+1) = 0` for all ranks. If the strength list is empty (no-op when w=0, optimization), the call becomes `rrfFuse([cosineList, bm25List], 60, k, [1, 1, 0])` or equivalently `rrfFuse([cosineList, bm25List], 60, k)` — identical result. D-04 holds: w=0 reproduces today's exact ranking.

### Floor gate composition (engine.ts:402-414) [VERIFIED: live source]

`hybridTopk` (L205-210) preserves cosine scores via `cosineScoreMap` independent of the RRF step:

```typescript
const cosineScoreMap = new Map(cosineList.map(h => [h.id, h.score]));
return fused.map(f => ({
  id: f.id,
  score: cosineScoreMap.get(f.id) ?? 0,  // 0 for BM25-only hits
}));
```

Adding a third strength list does NOT change this. Candidates from the strength list are a subset of `cosineList ∪ bm25List` (D-02 guarantee). Cosine scores for those candidates are already in `cosineScoreMap`. The floor gate in `retrieveRanked` applies to `hit.score` (the cosine score component), which is unaffected by the RRF weight change. **Floor gate composition is safe.**

One edge case: BM25-only candidates that rank highly in the strength list still get `score = 0` from `cosineScoreMap`. They will be filtered by the cosine floor (default 0.3). This is the EXISTING behavior for BM25-only hits — Phase 35 does not change it.

---

## Focus Area 2: Candidate Pool Plumbing

### What `hybridTopk` currently carries per row [VERIFIED: live source]

**cosineList** (from `topk()`, L122-139): `Array<{ id: string; score: number }>` — cosine score only. The underlying SQL is `SELECT id, embedding FROM node WHERE embedding IS NOT NULL AND tombstoned = 0`. Does NOT include `s` or `last_access`.

**bm25List** (from `stmtBm25`, L104-109): `Array<{ id: string }>` — id only. SQL is `SELECT f.node_id AS id, bm25(node_fts) AS bm25score FROM node_fts f JOIN node n ON ...`. Does NOT include `s` or `last_access`.

**Finding:** Neither list carries `s` or `last_access`. A new DB query is required to fetch strength data for the assembled pool.

### Required new private statement on `CandidateRetriever` [ASSUMED: design recommendation]

```typescript
// Fetch s + last_access for a set of candidate ids (D-02 pool query)
// json_each pattern mirrors stmtLatestSupportTs in engine.ts
private readonly stmtPoolStrength: Database.Statement;

// In constructor:
this.stmtPoolStrength = db.prepare(
  'SELECT id, s, last_access FROM node WHERE id IN (SELECT value FROM json_each(?))'
);
```

This follows the `json_each` pattern already used in `engine.ts` (see `stmtLatestSupportTs` which applies the same pattern for retrieving timestamps per candidate set).

### Where `effectiveStrength` is called [VERIFIED: live source]

`StrengthDecayManager.effectiveStrength(s, lastAccessMs, nowMs, lambda)` at `decay.ts:93`. Pure function — no DB access, no side effects. Called in `retrieveCueless` at `engine.ts:246`. Legal to call from any read path (T-03-1-E).

`CandidateRetriever` currently has no `clock` or `config` dependency. To compute `effectiveStrength`, `hybridTopk` needs `nowMs` and `lambda`. Options:
- Pass as optional params to `hybridTopk(queryVec, queryText, k, preK, strengthWeight, nowMs, lambda)`
- Pass a pre-computed callback `computeStrength?: (s, lastAccess) => number`

**Recommended (see below):** Pass `nowMs` and `lambda` as optional params (defaulting to `Date.now()` and `0.05` if not provided). The engine always provides them; external callers (doc-gather, harnesses) that don't provide them just get the current behavior (no strength list when `strengthWeight` defaults to 0).

### Proposed `hybridTopk` new signature [ASSUMED: design recommendation]

```typescript
hybridTopk(
  queryVec: Float32Array,
  queryText: string,
  k: number,
  preK = k * 3,
  strengthWeight = 0,    // D-04 default dark
  nowMs?: number,        // required only when strengthWeight > 0
  lambda?: number,       // required only when strengthWeight > 0
): Array<{ id: string; score: number }>
```

Inside, when `strengthWeight > 0`:
```typescript
const poolIds = [...new Set([...cosineList.map(h => h.id), ...bm25List.map(h => h.id)])];
const poolStrength = this.stmtPoolStrength.all(JSON.stringify(poolIds)) as Array<{
  id: string; s: number; last_access: number;
}>;
const strengthList = poolStrength
  .map(r => ({
    id: r.id,
    // CALL THE SHARED PURE HELPER — never re-derive s·exp(−λΔt) inline in topk.ts
    // ("Don't Hand-Roll" + D-01 one-place-math; project hard-rule). The decay.ts
    // formula (Example 1) is the ONLY copy; topk.ts must contain no `Math.exp(-`.
    effS: effectiveStrength(r.s, r.last_access, nowMs ?? Date.now(), lambda ?? 0.05),
  }))
  .sort((a, b) => b.effS - a.effS);
// strengthList has no extra .effS in the rrfFuse call — just {id}
const fused = rrfFuse(
  [cosineList, bm25List, strengthList],
  60, k,
  [1, 1, strengthWeight],
);
```

When `strengthWeight = 0` (dark): the `if (strengthWeight > 0)` guard skips the DB query entirely. `rrfFuse([cosineList, bm25List], 60, k)` — identical to today.

### D-10 tombstone exclusion inheritance [VERIFIED: live source]

`stmtSelectEmbedded` at topk.ts:97-99:
```typescript
'SELECT id, embedding FROM node WHERE embedding IS NOT NULL AND tombstoned = 0'
```

The candidate pool comes from this scan (cosineList) plus the BM25 FTS scan (which has `JOIN node n ON n.tombstoned = 0` at L104-109). Tombstoned nodes are excluded at the source queries. The strength list is a subset of these candidates. **D-10 is inherited for free — no new exclusion code needed.**

### Callers of `hybridTopk` that must not break [VERIFIED: live source]

All current callers pass exactly 3 positional args. New params 4–7 are optional with safe defaults:

| Caller | Current call | After change | Impact |
|--------|-------------|--------------|--------|
| `engine.ts:399` | `hybridTopk(queryVec, queryText, k)` | unchanged | no break |
| `doc-gather.ts:87` | `hybridTopk(queryVec, slug, semanticK)` | unchanged | no break |
| `doc-gather.ts:249` | `hybridTopk(centroid, schemaLabel, semanticK)` | unchanged | no break |
| `longmemeval-harness.cjs:685` | `hybridTopk(queryVec, questionForEmbed, TOP_K)` | unchanged | no break |

`doc-gather.ts` is a **non-obvious additional caller** not mentioned in CONTEXT.md. With `strengthWeight` defaulting to 0, both doc-gather calls are unaffected. Planner must confirm this understanding is correct before implementation.

---

## Focus Area 3: Config Knob Wiring

### Current config values (DEFAULT_CONFIG, config.ts) [VERIFIED: live source]

```
L608: lambda: 0.05
L634: candidateK: 5
L642: rankWeightS: 1.0     // cue-less weight
L643: rankWeightR: 0.0     // cue-less recency (D-24 caveat — held at 0)
L644: injectionTokenBudget: 500
```

### EngineConfig interface addition [ASSUMED: design recommendation]

Add after `rankWeightR` (around L318 in the interface block):

```typescript
/**
 * Weight of strength-ranked third list in hybridTopk RRF fusion (D-01, Phase 35).
 * Ships at 0 (dark, D-04): w=0 reproduces today's exact [cosine, bm25] ranking.
 * Raise after eval sweep (RANK-02) confirms a win. Sibling to rankWeightS/rankWeightR,
 * but applies to the CUE-BASED path only (hybridTopk); cue-less path unchanged (D-08).
 *
 * CAUTION: effective_s already encodes recency (D-03). Setting this knob activates
 * both strength and recency re-ordering simultaneously (one signal, one knob).
 */
rankStrengthWeight: number;
```

### DEFAULT_CONFIG addition [ASSUMED: design recommendation]

After `rankWeightR: 0.0` at approximately L643:

```typescript
rankStrengthWeight: 0,  // D-04: dark default — ships w=0; no behavior change at merge
```

### Wire-up in `retrieveRanked` (engine.ts:399) [ASSUMED: design recommendation]

```typescript
const hits = queryText
  ? this.retriever.hybridTopk(
      queryVec, queryText, k, undefined,
      this.config.rankStrengthWeight,
      this.clock.nowMs(),
      this.config.lambda,
    )
  : this.retriever.topk(queryVec, k);
```

The pure-cosine fallback (`this.retriever.topk`) is unchanged — it serves callers that don't supply `queryText` (ambient-recall.ts:128, etc.). These callers are outside the D-08 scope.

**Thread-through count:** 4 sites total — EngineConfig interface, DEFAULT_CONFIG, `retrieveRanked` call, `hybridTopk` signature. No other threading needed.

---

## Focus Area 4: Eval Harness Mechanics (RANK-02)

### CRITICAL GAP: KU harness does not exercise strength fusion [VERIFIED: live source]

`replay-ku-harness.cjs:239`:
```javascript
const results = engine.retrieveRanked(
  queryVec,
  scratch.config.rankedRetrievalK,
  scratch.config.rankedRetrievalFloor
  // NO queryText argument
);
```

Without `queryText`, `retrieveRanked` (engine.ts:395-400) routes through `this.retriever.topk(queryVec, k)` — pure cosine, NO RRF, NO hybridTopk, NO strength list.

**The strength fusion mechanism (D-01) lives exclusively in the `hybridTopk` path.** The KU harness as-is will NOT measure the effect of `rankStrengthWeight` at all — it will always produce the same score regardless of `w`.

**Remediation options for planner (pick one):**
1. **Update KU harness to pass queryText:** `engine.retrieveRanked(queryVec, k, floor, kuCase.question)`. The question string is a valid cue — this correctly activates the hybrid path and makes the harness exercise strength fusion.
2. **Accept KU harness cannot measure RANK-02(b):** Use LME harness only for RANK-02 measurement. KU harness serves as regression check (verify w=0 scores are unchanged), not as the precision measurement.

Option 1 is recommended — the question string IS available in `kuCase.question` (see harness line 50: `KU_FILE`, loaded as `kuCase.question`).

### Config injection pattern in harnesses [VERIFIED: live source]

**Current pattern (both harnesses):**
```javascript
const config = { ...DEFAULT_CONFIG, dbPath };  // KU harness L97 / LME harness L185
```

No env var or CLI flag for config weight overrides exists today. To inject `rankStrengthWeight` for a sweep:
- Add a CLI flag `--strength-weight <w>` parsed at the top of each harness
- Build config as: `const config = { ...DEFAULT_CONFIG, dbPath, rankStrengthWeight: strengthWeight }`
- For the KU harness, also pass it through the `hybridTopk` call (via `retrieveRanked` which reads from `engine.config`)

For the LME harness, the `hybridTopk` is called directly on `evalRetriever` (not through the engine), so the strength weight must also be passed directly to `hybridTopk`.

### LME harness retrieval path [VERIFIED: live source]

`longmemeval-harness.cjs:679-686`:
```javascript
const evalRetriever = new CandidateRetriever(scratch.db);
const topkResults = IS_HYBRID
  ? evalRetriever.hybridTopk(queryVec, questionForEmbed, TOP_K)
  : evalRetriever.topk(queryVec, TOP_K);
```

The `--hybrid` flag is the relevant one for RANK-02 measurement — it activates `hybridTopk`. After Phase 35, the harness needs to also pass `strengthWeight, nowMs, lambda` when `--strength-weight > 0`:

```javascript
const topkResults = IS_HYBRID
  ? evalRetriever.hybridTopk(queryVec, questionForEmbed, TOP_K, undefined, STRENGTH_WEIGHT, Date.now(), DEFAULT_CONFIG.lambda)
  : evalRetriever.topk(queryVec, TOP_K);
```

### Metrics emitted by each harness today [VERIFIED: live source]

**KU harness** (`replay-ku-harness.cjs`) output (`scores` block):
```json
{
  "ku_score": 0.XXX,           // fraction of KU questions answered correctly
  "ku_correct": N,
  "ku_scored_cases": 18,
  "total_tombstones": N,
  "total_contradicts": N,
  "total_duplicate_mints": N
}
```

**LME harness** (`longmemeval-harness.cjs` → `longmemeval-scorer.cjs`) output:
```json
{
  "scores": {
    "headline": 0.XXX,          // overall accuracy (all question types)
    "by_category": {
      "knowledge-update": 0.XXX,
      "single-session-user": 0.XXX,
      // ... 7 categories total
    }
  }
}
```

### Mapping to D-06 measurements [VERIFIED: live source + ASSUMED for mapping]

**D-06(a) token-saving:** Equal answer quality at smaller inject budget. Measure: run LME harness at `--topk 5 --hybrid` baseline vs. `--topk 5 --hybrid --strength-weight W` (w = winning value). If KU score / LME headline holds at smaller top-k, that IS the token saving. The `--topk` flag already exists in `longmemeval-harness.cjs` (line 150).

**D-06(b) precision:** Higher top-k judge accuracy at same budget. Measure: run LME harness at `--topk 10 --hybrid` baseline vs. `--topk 10 --hybrid --strength-weight W`. Compare LME headline or knowledge-update sub-score.

### Baseline commands (as-is today) [VERIFIED: live source for commands]

```bash
# KU harness baseline (currently uses pure cosine, NOT hybrid)
npm run build && OPENAI_API_KEY=... ANTHROPIC_API_KEY=... \
  node scripts/eval/replay-ku-harness.cjs \
  --out scripts/eval/results/35-baseline-ku.json

# LME harness baseline (probe first)
npm run build && OPENAI_API_KEY=... ANTHROPIC_API_KEY=... \
  node scripts/eval/longmemeval-harness.cjs --probe --hybrid \
  --out scripts/eval/results/35-baseline-lme-hypotheses.jsonl

# LME scorer
node scripts/eval/longmemeval-scorer.cjs \
  --hypotheses scripts/eval/results/35-baseline-lme-hypotheses.jsonl \
  --eval scripts/eval/longmemeval-s.jsonl \
  --out scripts/eval/results/35-baseline-lme.json
```

### W-sweep approach (no precedent today — must be built) [ASSUMED: design recommendation]

No existing sweep mechanism. Cheapest approach: a small Node.js sweep script that spawns the harness for each `w` in `{0, 0.25, 0.5, 1.0, 2.0}` and collects results into a comparison table. Alternatively, a shell loop over CLI invocations. Given the cost (~$X per LME run), the planner should specify whether to run the sweep on KU only (cheap) or LME (paid, cost-probe first).

---

## Focus Area 5: Test Surface

### Existing tests covering the modified code [VERIFIED: live source]

| File | What it tests | Assertion style |
|------|--------------|-----------------|
| `tests/fts-retrieval.test.ts` | `ftsQueryFromText`, `rrfFuse`, `hybridTopk` | `expect(...).toBe(...)`, `expect(...).toContain(...)`, `expect(...).not.toContain(...)` |
| `tests/retrieval.test.ts` | `retrieveCueless`, `retrieve` (RET-01/02), `RetrievalEngine` | `expect(...).toContain(...)`, score ordering checks |
| `tests/responder.test.ts` | `retrieveRanked` called by HybridResponder | mock-based — verifies call routing, not ranking order |

No existing test exercises `retrieveRanked` directly with real strength data. `responder.test.ts:277-298` mocks `retrieveRanked` to verify it's called — not a ranking correctness test.

### Required new tests (identified gaps)

**Test 1: `rrfFuse` with weights — regression (w=0 = no change)**
```typescript
// In fts-retrieval.test.ts
it('rrfFuse with weights=[1,1,0] and empty third list = same as [list1, list2] without weights', () => {
  const listA = [{ id: 'a' }, { id: 'b' }];
  const listB = [{ id: 'b' }, { id: 'c' }];
  const noWeights = rrfFuse([listA, listB], 60, 10);
  const withZeroWeight = rrfFuse([listA, listB, []], 60, 10, [1, 1, 0]);
  expect(withZeroWeight.map(r => r.id)).toEqual(noWeights.map(r => r.id));
});
```

**Test 2: `rrfFuse` weighted math — strength list boosts a candidate**
```typescript
it('a node in the strength list (w>0) is ranked higher than without', () => {
  const cosineList = [{ id: 'low_strength' }, { id: 'high_strength' }]; // cosine order
  const bm25List: Array<{ id: string }> = [];
  const strengthList = [{ id: 'high_strength' }, { id: 'low_strength' }]; // strength order

  const withoutStrength = rrfFuse([cosineList, bm25List], 60, 10);
  const withStrength = rrfFuse([cosineList, bm25List, strengthList], 60, 10, [1, 1, 0.5]);

  // Without strength: 'low_strength' at rank 0 beats 'high_strength' at rank 1
  expect(withoutStrength[0]?.id).toBe('low_strength');
  // With strength w=0.5: 'high_strength' moves up (boost from being rank-0 in strengthList)
  expect(withStrength[0]?.id).toBe('high_strength');
});
```

**Test 3: Strength list candidate pool enforcement (D-02)**

Integration test — in `fts-retrieval.test.ts` or a new `tests/retrieval-strength.test.ts`:
```typescript
it('high-strength node NOT in cosine/BM25 pool does not appear in output (D-02)', () => {
  // node A: embedded, in cosine pool, low strength
  // node B: embedded, NOT in cosine pool (basisVec far from query), HIGH strength
  // Assert: hybridTopk result does not include B
});
```

**Test 4: w=0 `hybridTopk` regression (exact current output)**
```typescript
it('hybridTopk with strengthWeight=0 produces identical output to unweighted call', () => {
  // Set up nodes, embed them
  const baseline = retriever.hybridTopk(queryVec, 'test', 5);
  const withZeroWeight = retriever.hybridTopk(queryVec, 'test', 5, undefined, 0);
  expect(withZeroWeight.map(r => r.id)).toEqual(baseline.map(r => r.id));
});
```

**Test 5: Tombstone exclusion from strength list (D-10)**
```typescript
it('tombstoned high-strength node never surfaces via strength list (D-10)', () => {
  // tombstone a high-strength node, verify it never appears in hybridTopk output
});
```

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Strength decay computation | Custom `s * exp(-λ * Δt)` in hybridTopk | `StrengthDecayManager.effectiveStrength(s, lastAccess, nowMs, lambda)` | Pure function, already the single shared computation site (T-03-1-E) |
| Candidate set intersection | Custom set logic | `json_each` prepared statement over pool ids | Already the pattern in `engine.ts` (`stmtLatestSupportTs`); avoids in-JS loops over DB |
| Score normalization before RRF | Any normalization of `effective_s` to [0,1] | None — RRF uses rank position only (D-01) | Normalizing reintroduces the scale reconciliation RRF exists to avoid |

---

## Common Pitfalls

### Pitfall 1: Widening the candidate pool (D-02 violation)
**What goes wrong:** Sorting the entire graph by `effective_s` and passing it as the strength list. Nodes not in the cosine+BM25 pool get RRF scores from the strength term alone (`w * 1/(60+rank+1)`) and can appear in results.
**Why it happens:** The strength list sort comes from a graph-wide query, not a pool-scoped query.
**How to avoid:** The `stmtPoolStrength` statement MUST use `WHERE id IN (SELECT value FROM json_each(?))` with the assembled pool ids. Never query all live nodes.
**Warning signs:** A high-strength but topically irrelevant node appears in retrieval results.

### Pitfall 2: Disturbing the cosine score for the floor gate
**What goes wrong:** Returning `rrfScore` instead of cosine score from `hybridTopk`. The floor gate in `retrieveRanked` (engine.ts:406-410) gates on `hit.score` expecting a cosine value. If `hybridTopk` starts returning `rrfScore` instead, BM25-only hits (cosine=0) would incorrectly clear a 0.3 floor.
**Why it happens:** Confusion between the RRF score (used for ranking order) and cosine score (used for floor gate).
**How to avoid:** The existing `cosineScoreMap` pattern at topk.ts:206-210 is correct and must be preserved exactly. Only the RRF fusion input changes; the score output map is unchanged.
**Warning signs:** Test assertions on floor gate behavior fail, or BM25-only hits start appearing in `retrieveRanked` results when they shouldn't.

### Pitfall 3: KU harness measuring the wrong thing
**What goes wrong:** Running the KU harness w-sweep without adding `queryText` to `retrieveRanked`. All sweep values produce the same score (pure cosine is used regardless of `rankStrengthWeight`).
**Why it happens:** `replay-ku-harness.cjs:239` calls `retrieveRanked(queryVec, k, floor)` without a fourth argument.
**How to avoid:** Must add `kuCase.question` as the `queryText` argument before the sweep. Verify that the harness now shows different scores for different `w` values.
**Warning signs:** All w values in the sweep produce identical KU scores.

### Pitfall 4: Self-confirmation via strength strengthening
**What goes wrong:** Calling `materializeDecay` (the write-path method on `StrengthDecayManager`) instead of `effectiveStrength` during retrieval. This would update `s` and `last_access` in the DB as a side effect of retrieval — violating the correctness invariant (surfacing/inference never strengthens a fact).
**Why it happens:** Confusion between `effectiveStrength` (pure, no DB writes) and `materializeDecay` (mutating).
**How to avoid:** The retrieval path MUST use `effectiveStrength` only (the pure computation at decay.ts:93). `materializeDecay` is a write-path method. `engine.ts` docstring explicitly calls this out (T-03-1-E).
**Warning signs:** `last_access` timestamps update during a retrieval-only session.

---

## Code Examples

### Example 1: `effectiveStrength` call pattern (reference for strength list computation)
```typescript
// Source: src/strength/decay.ts:93 — the ONLY legal strength call from retrieval (T-03-1-E)
effectiveStrength(s: number, lastAccessMs: number, nowMs: number, lambda: number): number {
  const deltaDays = Math.max(0, nowMs - lastAccessMs) / 86_400_000;
  return s * Math.exp(-lambda * deltaDays);
}
```
The `Math.max(0, ...)` clamp for negative deltaDays (clock rollback) is load-bearing — preserve it.

### Example 2: `retrieveCueless` strength scoring (reference implementation for the cue-less path, D-08)
```typescript
// Source: src/retrieval/engine.ts:246-257 — reference only; D-08: do NOT modify
const eff = this.strength.effectiveStrength(row.s, row.last_access, nowMs, this.config.lambda);
const deltaDays = (nowMs - row.last_access) / 86_400_000;
const recency = Math.exp(-this.config.lambda * deltaDays);
scores.set(row.id, this.config.rankWeightS * eff + this.config.rankWeightR * recency);
```
Phase 35 uses `effective_s` only (D-03) — the `rankWeightR * recency` term stays zero (D-24 caveat).

### Example 3: `json_each` pattern for bulk node lookup (existing pattern to follow)
```typescript
// Source: src/retrieval/engine.ts (stmtLatestSupportTs — exact same json_each pattern)
// In constructor:
this.stmtLatestSupportTs = db.prepare(`
  SELECT ce.node_id, MAX(e.ts) AS latest_ts
  FROM consolidation_event ce JOIN episode e ON e.id = ce.episode_id
  WHERE ce.node_id IN (SELECT value FROM json_each(?))
  GROUP BY ce.node_id
`);
// At call site:
const nodeIdsJson = JSON.stringify(filtered.map(c => c.id));
const tsRows = this.stmtLatestSupportTs.all(nodeIdsJson);
```
The `stmtPoolStrength` query for Phase 35 follows this exact pattern.

---

## Context Corrections

No corrections to CONTEXT.md are required. All cited line numbers are accurate against the live source:

| CONTEXT.md claim | Verified? | Note |
|-----------------|-----------|------|
| `rrfFuse` at `topk.ts:58` | VERIFIED | Exact match |
| `hybridTopk` at `topk.ts:181` | VERIFIED | Exact match |
| `topk` at `topk.ts:122` | VERIFIED | Exact match |
| `retrieveRanked` at `engine.ts:388` | VERIFIED | Exact match |
| `retrieveCueless` at `engine.ts:195` | VERIFIED | Exact match |
| `effectiveStrength` at `decay.ts:93` | VERIFIED | Exact match |
| `config.ts L304-318` (`rankWeightS`/`rankWeightR` interface) | VERIFIED | Interface block at these lines |
| `config.ts L634` (`candidateK=5`) | VERIFIED | `candidateK: 5` at L634 |
| `config.ts L644` (`injectionTokenBudget=500`) | VERIFIED | Exact match |
| Floor gate at `engine.ts:402-414` | VERIFIED | Exact match |
| Tombstone exclusion at `topk.ts:96-109` | VERIFIED | `stmtSelectEmbedded` at L97-99; `stmtBm25` JOIN at L104-109 |

**One non-obvious finding not in CONTEXT.md:** `hybridTopk` has two additional callers in `src/reader/doc-gather.ts` (lines 87 and 249). Both call `hybridTopk(queryVec, slug/schemaLabel, semanticK)` with 3 args. New optional params are backward compatible — these callers are unaffected. Flag for implementer to be aware.

---

## Open Questions (RESOLVED)

All three resolved during planning — captured in the Phase 35 plans. None remain open at execution time.

1. **KU harness queryText gap (BLOCKING for RANK-02 KU measurement) — RESOLVED**
   - What we know: KU harness calls `retrieveRanked` without queryText → pure cosine → strength fusion not exercised.
   - **Resolution:** Plan 35-02 Task 1 updates `replay-ku-harness.cjs:239` to pass `kuCase.question` as the 4th `queryText` arg (option a) — a BLOCKING task before the paid sweep run.

2. **Pure-cosine arm of `retrieveRanked` (ambient-recall.ts) — RESOLVED**
   - What we know: `ambient-recall.ts:128` calls `retrieveRanked(vec, k, floor, undefined)` — pure cosine, no strength fusion.
   - **Resolution:** Out of scope by D-08. `retrieveRanked → hybridTopk` is the only path in scope; ambient recall without queryText is the no-fusion case by design. Plan 35-01 Task 3 explicitly leaves the `topk` fallback branch untouched.

3. **Sweep script location and format — RESOLVED**
   - What we know: No existing sweep mechanism. Must be built. LME full run is expensive.
   - **Resolution:** Plan 35-02 Task 1 builds `scripts/eval/35-strength-sweep.cjs` sweeping `--strength-weight ∈ {0,0.25,0.5,1.0,2.0}`, run KU-first (cheap) after the queryText fix; LME run is the paid `autonomous: false` checkpoint in Task 2.

---

## Environment Availability

Step 2.6: Internal code change and eval script work — no new external dependencies (D-11). Existing deps (`better-sqlite3`, `vitest`, `@anthropic-ai/sdk`, `openai`) are already present. LME eval requires `OPENAI_API_KEY` + `ANTHROPIC_API_KEY` and the downloaded `longmemeval-s.jsonl` dataset (not committed).

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest ^4.1.8 |
| Config file | none detected (runs `vitest run` from package.json) |
| Quick run command | `npm test` (runs build then vitest) |
| Full suite command | `npm test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| RANK-01 | `rrfFuse` with weights param computes correctly | unit | `npm test -- --grep "rrfFuse"` | ❌ Wave 0: add to `tests/fts-retrieval.test.ts` |
| RANK-01 | `hybridTopk` with `strengthWeight > 0` builds strength list from pool only | unit | `npm test -- --grep "strengthWeight"` | ❌ Wave 0: add to `tests/fts-retrieval.test.ts` |
| RANK-01 | w=0 default reproduces exact current ranking (regression) | unit | `npm test -- --grep "w=0"` | ❌ Wave 0 |
| RANK-01 | Tombstoned node never surfaces via strength list | unit | `npm test -- --grep "tombstone"` | partial — existing test covers topk tombstone; extend for strength path |
| RANK-02 | KU harness baseline run (w=0) matches prior recorded scores | manual eval | `node scripts/eval/replay-ku-harness.cjs` | ✅ harness exists; needs queryText fix |
| RANK-02 | w-sweep shows non-decreasing KU or LME score at some w > 0 | manual eval | sweep script | ❌ Wave 0: sweep script needed |

### Wave 0 Gaps

- [ ] `tests/fts-retrieval.test.ts` — add tests T1..T5 (rrfFuse weights, hybridTopk strength, pool enforcement, w=0 regression, tombstone via strength)
- [ ] `scripts/eval/35-strength-sweep.cjs` (or shell equivalent) — sweep script for w in {0, 0.25, 0.5, 1.0, 2.0}

---

## Security Domain

No new security surface. The strength list is computed from existing DB rows (`s`, `last_access`) using a parameterized prepared statement with `json_each` — the same pattern already used in the engine. No user input reaches the query directly (pool ids are derived from queryVec cosine scan results, not from user-supplied strings). D-11 net-zero deps means no new libraries to audit.

---

## Sources

### Primary (HIGH confidence)
- `src/retrieval/topk.ts` (live source) — `rrfFuse` L58-73, `CandidateRetriever.topk` L122-139, `hybridTopk` L181-211
- `src/retrieval/engine.ts` (live source) — `retrieveRanked` L388-496, `retrieveCueless` L195-330, floor gate L402-414
- `src/strength/decay.ts` (live source) — `effectiveStrength` L93-104
- `src/lib/config.ts` (live source) — interface L303-318, DEFAULT_CONFIG L607-649 (`lambda:0.05`, `candidateK:5`, `rankWeightS:1.0`, `rankWeightR:0.0`, `injectionTokenBudget:500`)
- `scripts/eval/replay-ku-harness.cjs` (live source) — retrieval call L239, config pattern L97-109
- `scripts/eval/longmemeval-harness.cjs` (live source) — retrieval path L679-686, hybridTopk call L684-685
- `tests/fts-retrieval.test.ts` (live source) — rrfFuse tests L127-158, hybridTopk tests L160-200
- `tests/retrieval.test.ts` (live source) — RetrievalEngine test structure L1-93

### Secondary (MEDIUM confidence)
- `src/reader/doc-gather.ts` — additional `hybridTopk` callers at L87, L249 (not mentioned in CONTEXT.md)
- `src/adapter/ambient-recall.ts:128` — `retrieveRanked` caller without queryText (establishes pure-cosine usage pattern)

---

## Metadata

**Confidence breakdown:**
- rrfFuse extension shape: HIGH — source verified, math confirmed
- Candidate pool plumbing: HIGH — source verified; recommended impl is ASSUMED but grounded in existing patterns
- Config knob wiring: HIGH — current config verified; new knob placement is ASSUMED
- Eval harness mechanics: HIGH (current behavior) / ASSUMED (sweep design)
- Test surface: HIGH (existing tests) / ASSUMED (new test shapes)

**Research date:** 2026-06-20
**Valid until:** 2026-07-20 (stable engine; no fast-moving deps)

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | New `hybridTopk` params should be positional optionals (not an opts object) | Focus Area 2 | Minor — style choice; opts object is equally valid |
| A2 | `stmtPoolStrength` with `json_each` is the right SQL pattern | Focus Area 2 | Low — pattern confirmed in `stmtLatestSupportTs`; only risk is large pool size, but preK default is k*3 = ~30 ids |
| A3 | `rankStrengthWeight: 0` placed between `rankWeightR` and `injectionTokenBudget` in DEFAULT_CONFIG | Focus Area 3 | None — cosmetic location |
| A4 | W-sweep grid `{0, 0.25, 0.5, 1.0, 2.0}` is appropriate | Focus Area 4 | Low — planner/discretion area per CONTEXT.md |
| A5 | Sweep script should live in `scripts/eval/` | Focus Area 4 | None — location only |
