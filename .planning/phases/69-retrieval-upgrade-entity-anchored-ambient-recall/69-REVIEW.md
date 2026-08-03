---
phase: 69-retrieval-upgrade-entity-anchored-ambient-recall
reviewed: 2026-08-03T00:00:00Z
depth: standard
files_reviewed: 16
files_reviewed_list:
  - src/retrieval/entity-anchor.ts
  - src/retrieval/honest-trace.ts
  - src/retrieval/engine.ts
  - src/adapter/ambient-recall.ts
  - src/adapter/turn-capture-cli.ts
  - src/adapter/recall-cli.ts
  - src/recall/index.ts
  - src/db/semantic-store.ts
  - src/viz/server.ts
  - src/lib/config.ts
  - scripts/eval/recall-audit-gate.cjs
  - scripts/eval/69-entity-anchor-latency.cjs
  - tests/entity-anchor.test.ts
  - tests/retrieval-anchor-union.test.ts
  - tests/ambient-recall.test.ts
  - tests/recall-evidence.test.ts
findings:
  critical: 2
  warning: 6
  info: 4
  total: 12
status: issues_found
---

# Phase 69: Code Review Report

**Reviewed:** 2026-08-03
**Depth:** standard
**Files Reviewed:** 16
**Status:** issues_found

## Summary

Reviewed the entity-anchored ambient recall implementation (anchor module, retrieveRanked union, ordering nudge, budget renderer, evidence mode, eval gates). The load-bearing disciplines the phase context asked to check hardest mostly hold and were verified:

- **Prompt-token → SQL/FTS injection safety:** VERIFIED SAFE. Anchor tokens reach SQL only through bound parameters (`resolveEntityByName`, T-01-SQL) and reach FTS MATCH only through `ftsQueryFromText`, which re-tokenizes to `[\p{L}\p{N}]+` runs and double-quote-escapes every token — no MATCH syntax can survive; FTS errors are caught (entity-resolution.ts:196-214). One wildcard nit (IN-04).
- **Floor-exemption honesty:** VERIFIED. Anchored rows score real cosine of the stored embedding, 0 on null/shape-mismatch, never synthesized (engine.ts:490-511); locked by tests 5a/5b. One clamp nit (IN-02).
- **Hop projection not leaking `rel`:** VERIFIED. Both trace-sink emit sites (engine.ts:642, viz/server.ts:862) route through `projectHopsForSink`; the sink hop array is re-filtered to `src ∈ emitSeeds` before projection; locked by the trace-shape-equality test.
- **Evidence mode zero-write:** VERIFIED. Both evidence short-circuits return before `provider.generate`, `episodes.append`, and the trace emit; locked by tests 3/4. But the typed-path evidence FABRICATES edge attributions (CR-02).
- **Eval scripts never committing personal prompts:** VERIFIED. `.gitignore` `scripts/eval/results/*` covers the eval-set JSONL and both gate artifacts; the gate output is prompt-id-hash-only with a pre-write >200-char/verbatim-prompt self-check; the latency probe's prompts are hand-written literals.
- **Byte-identity when knobs dark:** VERIFIED for the three dark knobs (empty-`anchoredIds` no-op guard, no-sort-when-nothing-unioned, no `hopCollector` key, `docLinks:false` path), and pinned by the hard-coded-string regression tests (Test 1, f2).

However, two Critical findings: the config literal for `ambientHopInjectionEnabled` contradicts its own gate annotation and the recorded ship decision (the gated-ON feature actually ships dark in the live hook), and evidence mode's typed path emits edges that may not exist in the graph. The anchor module also has a tokenization defect that makes it whiff on any prompt with sentence punctuation adjacent to the entity name — plausibly a contributor to its measured G2 relevance failure.

## Critical Issues

### CR-01: `ambientHopInjectionEnabled` ships `false` while its own gate annotation and the ship record say "enabled"

**File:** `src/lib/config.ts:1089-1094`
**Issue:** The default literal is `ambientHopInjectionEnabled: false`, but the comment block immediately below it records: *"Phase 69 D-08 gate 2026-08-03: enabled — G1/G2/G3/G4 all pass … REAL exercise (not vacuous): 11 hop lines rendered across the 58-prompt replay."* The phase record also lists this knob as SHIPPED-ON alongside `sameProjectRankNudge=0.05` / `foreignDocDemotion=0.10` (both of which DID have their literals flipped). The live hook path consumes `DEFAULT_CONFIG` directly (`turn-capture-cli.ts:73` — no settings-loader overlay; `settings-loader.ts` has no Phase-69 keys), so hop lines never render in production. Corroborating evidence the literal is the wrong side of the contradiction: `tests/ambient-recall.test.ts` case f's comment justifies the shipped-default fixture output *despite* hop injection ("only adds lines when the seed has edges — this fixture exercises neither") and explicitly names only `entityAnchoringEnabled` and `ambientDocLinkRenderEnabled` as the two staying dark.
**Fix:**
```ts
ambientHopInjectionEnabled: true,   // Phase 69 D-08 gate 2026-08-03: enabled — G1-G4 pass, real exercise (11 hop lines / 58 prompts)
```
(or, if dark was actually intended, correct the gate annotation and the phase ship record — as submitted the code and its own comment cannot both be true).

### CR-02: Evidence mode typed path fabricates edge attributions — cited (src, rel, dst) triples may not exist in the graph

**File:** `src/recall/index.ts:281-287`
**Issue:** `typedReach` seeds its frontier from the UNION of the top `typedAnchorPoolK` (default 20) retrieval candidates (`src/recall/index.ts:232-237`, `typed-traversal.ts:62-63`) and returns only dst ids — it does not report which anchor produced each dst. Evidence mode then emits one edge per frontier node with `src: anchorNode.id` (i.e. `bestMatch`, `topHits[0]`) hardcoded:
```ts
const edges: RecallEvidence['edges'] = typedNodes.map(n => ({
  src: anchorNode.id, rel: matchedPredicate, dst: n.id, kind: 'relation',
}));
```
Any frontier node reached via a pool anchor other than `bestMatch` gets a citation for an edge that does not exist. This directly violates the `RecallEvidence` contract ("the edges actually traversed … never a re-derivation", index.ts:62-66) and the codebase's own honest-attribution spine ("the (src→node_id) pair is a real relation edge in the graph, never a guessed attribution", honest-trace.ts:22-24). The whole point of `--evidence` is verifiable citations; a consumer dereferencing these edges will find phantom relations. `tests/recall-evidence.test.ts` Test 1 only exercises the single-anchor case, so this is untested.
**Fix:** Track provenance during traversal — e.g., have the evidence branch re-derive edges honestly by scanning `getOutEdgesWithRel(a)` for each pool anchor `a` and emitting only `(a, matchedPredicate, dst)` pairs that actually exist for the frontier dsts; or extend `typedReach` to optionally return `{ dst, viaAnchor }` pairs and cite those.

## Warnings

### WR-01: Anchor tokenization keeps trailing punctuation — the module whiffs on "…with vtx?" / "…with vtx."

**File:** `src/retrieval/entity-anchor.ts:93-114`
**Issue:** `normalizeValue` only lowercases and collapses whitespace (normalize.ts:18-20) — it does NOT strip punctuation. Verified against the built module: `extractAnchorTokens('do you remember the contract i have with vtx?')` → `["contract","vtx?","contract vtx?"]`. For token `"vtx?"`: the exact channel (`LOWER(value) = 'vtx?'`, `LIKE '%vtx?%'`) misses; the BM25 channel finds the node (ftsQueryFromText strips punctuation) but the candidate is then scored `max(lex, dense)` where `lexicalScore('vtx?', 'vtx')` = 0 (token sets disjoint) and dense = 0 (no vec passed) → score 0 < ANCHOR_LEX_FLOOR(0.5) → rejected. The exact audit class this module exists for fails whenever the entity name abuts sentence punctuation — which is most natural prompts. Punctuated stopwords ("the,") also survive the STOPWORDS check and burn MAX_ANCHOR_TOKENS slots. All tests use punctuation-free prompts, so this is invisible to the suite, and it plausibly contributed to the recorded G2 relevance failure that keeps the knob dark.
**Fix:** Strip non-alphanumeric edges per token before filtering, e.g.:
```ts
const rawTokens = normalized.split(' ')
  .map(t => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
  .filter(t => t.length > 0);
```
(and add a punctuated-prompt regression test for the F2 class).

### WR-02: Edge channel returns neighbouring ENTITY nodes as "facts" — injecting bare entity names

**File:** `src/retrieval/entity-anchor.ts:199-207`
**Issue:** The edge channel takes any live PRED_SET relation neighbour without checking `node.type`. Entity→entity relation edges exist in this graph (e.g. `built_by`, `works_at` — `tests/recall-evidence.test.ts:174-176` builds exactly such an edge), so anchoring on "vtx" can return the neighbouring entity node "max" as an AnchoredFact whose injected line is just a name — the precise waste the module's own contract rules out ("an entity node's value is just a name, a wasted injected token; only the facts it anchors are returned", lines 152-153). These ids then flow into `retrieveRanked.anchoredIds` and can occupy one of the two reserved injection slots.
**Fix:** In the edge-channel walk, skip non-fact neighbours:
```ts
if (!node || node.tombstoned === 1 || node.type === 'entity') continue;
```

### WR-03: "Indexed-lookup-only" claim is false — the exact channel runs full node-table scans per token

**File:** `src/retrieval/entity-anchor.ts:135-138` (claim), `src/adapter/ambient-recall.ts:21-26` (T-RT1-06 claim), `src/db/semantic-store.ts:190-201` (actual scans)
**Issue:** `collectAnchoredFacts` calls `generateCandidates` per token (up to 12) plus once per accepted entity (up to 3); each call's exact channel runs `resolveEntityByName`, whose three statements (`LOWER(value) = LOWER(?)` ×2, `LIKE '%…%' ORDER BY LENGTH`) cannot use any existing index (schema.ts has no expression index on `LOWER(value)`) — up to ~45 full scans of the node table per prompt on the hook-latency-bound hot path. The T-RT1-06 comment asserts "indexed-lookup-only (no dense/full-table scan)" — only the dense-scan half is true. This is the mechanism behind the recorded G5 failure (p95 458→682ms) that keeps the knob dark.
**Fix:** Either add a normalized-value lookup column/index used by an anchor-specific exact statement, or drop the exact channel on this path (BM25 + Dice re-score already covers exact names); at minimum, correct both comments so the latency record traces to a true statement.

### WR-04: Renderer can exceed the AMBIENT_BLOCK_CHAR_BUDGET invariant that gate G4 asserts

**File:** `src/adapter/ambient-recall.ts:157-201` vs `scripts/eval/recall-audit-gate.cjs:287`
**Issue:** Budget accounting counts `marker.length + value.length` per fact, and fact lines are ALWAYS emitted regardless of the running total (facts-win, D-06). With 5 scoped facts at max length, content = 5 × (200 + len("[scope] ")) > 1000 = `AMBIENT_BLOCK_CHAR_BUDGET` (= AMBIENT_K × MAX_VALUE_CHARS, with zero allowance for scope markers). G4 (`charCount > AMBIENT_BLOCK_CHAR_BUDGET` → violation) fails on output the renderer defines as correct. The guard-set (gate) and ship-set (renderer) disagree on the same named constant — a false-fail waiting for the first eval row with 5 long scoped facts.
**Fix:** Make the two agree: either include marker length inside the per-line `MAX_VALUE_CHARS` truncation (cap `marker + value` at 200), or size the budget as `AMBIENT_K × (MAX_VALUE_CHARS + MAX_SCOPE_MARKER_CHARS)`, or have G4 assert the invariant the renderer actually guarantees (hops never push past budget; facts capped per-line).

### WR-05: `hopCollector` receives hops for non-returned viz-lit seeds — broader than its documented contract

**File:** `src/retrieval/engine.ts:606-638`
**Issue:** The doc comment (engine.ts:425-431) says the collector receives the 1-hop trace "for every returned row — cosine AND anchored." Actually `seedsForHopPass = emitSeeds ∪ finalResults`, and with `vizFloor` set (the ambient path always sets it, ambient-recall.ts:320) `emitSeeds` includes below-floor nodes that are never returned — so the collector also receives hops whose `src` is a node the caller never saw. Today's only consumer filters by `selectedIds.has(hop.src)` (ambient-recall.ts:413), so nothing leaks, but the contract-vs-payload mismatch is a trap: a future consumer trusting the documented contract would render hop lines attributed to facts that were never surfaced.
**Fix:** Either filter before invoking: `opts.hopCollector(hops.filter(h => finalResultIds.has(h.src)))`, or amend the doc comment to state the payload covers the union of returned rows AND viz-lit seeds and that consumers MUST filter by their own selected set.

### WR-06: Knob docstrings still claim "Dark default `0`" for values that now ship at 0.05 / 0.10

**File:** `src/lib/config.ts:511-531` (interface docs), `1036`, `1046` (value-line comments)
**Issue:** Both `sameProjectRankNudge` and `foreignDocDemotion` interface docs say "Dark default `0` reproduces pre-phase ambient ranking exactly," and the value lines themselves open with "dark default" — while the shipped literals are 0.05 and 0.10 per the same lines' gate annotations. Given CR-01 shows a knob where the comment/value contradiction went the OTHER way, this stale text is actively dangerous: it is the exact ambiguity that makes it impossible to tell which side of a comment/literal disagreement is the bug. Note also `foreignDocDemotion` now demotes ANY scoped doc for unknown-cwd callers (currentScope = GLOBAL, ambient-recall.ts:358-363) — a live default-behavior change worth stating in the doc.
**Fix:** Update both docstrings and value-line comments to state the shipped magnitudes and the gate date; keep the "0 disables" sentence as the off-switch documentation.

## Info

### IN-01: `buildHonestOneHopTrace` does not skip a MISSING hop dst

**File:** `src/retrieval/honest-trace.ts:65`
**Issue:** `if (reader.getNode(edge.dst)?.tombstoned === 1) continue;` — a null/undefined node (dangling edge, possible around eviction sweeps since edge cleanup and `PRAGMA foreign_keys` are not guaranteed) yields `undefined === 1` → false → a hop is emitted for a nonexistent node. `entity-anchor.ts:203` and the ambient hop renderer (`ambient-recall.ts:417`) both use the stricter `!node ||` guard; only the viz sink/SSE consumers can receive the phantom hop. Pre-existing (Phase 56 verbatim extraction), noted because this phase added a second consumer of the hop array.
**Fix:** `const n = reader.getNode(edge.dst); if (!n || n.tombstoned === 1) continue;`

### IN-02: Anchored-row score comment says "clamped to [0,1]" but only the lower bound is clamped

**File:** `src/retrieval/engine.ts:506`
**Issue:** `Math.max(0, cosineSimF32(...))` — float error can produce a score marginally above 1.0; the doc comment (engine.ts:422-423) claims a two-sided clamp. Cosmetic (renders as "1.00"; only tiebreak order observable).
**Fix:** `Math.min(1, Math.max(0, cosineSimF32(queryVec, decoded)))`.

### IN-03: recall-cli fatal path emits no JSON to stdout

**File:** `src/adapter/recall-cli.ts:209-213`
**Issue:** `main().catch` logs and exits 1 without writing `safeNull`/any JSON — violating the file's own WR-03 always-parseable-stdout discipline on the one path where e.g. `acquireLockWithRetry` throws. Pre-existing; noted because this phase extended the CLI (`--evidence`) and the evidence-shaped safe-null was carefully threaded through every OTHER exit.
**Fix:** Write `SAFE_NULL_RESULT` (evidence-shape detection is available via `process.argv`) before `process.exit(1)`.

### IN-04: `resolveEntityByName` contains-channel LIKE has no ESCAPE clause

**File:** `src/db/semantic-store.ts:196-201`
**Issue:** A prompt token containing `%` or `_` (now fed raw from `collectAnchoredFacts`) acts as a LIKE wildcard in `LIKE '%' || LOWER(@name) || '%'`. Bound-param so injection-safe, and the downstream Dice floor bounds the blast radius to an odd low-scoring candidate — but the semantics are unintended for prompt-derived input.
**Fix:** Add `ESCAPE '\'` and escape `%`/`_` in the bound value, or strip wildcards at the anchor-token layer (subsumed by the WR-01 fix).

---

_Reviewed: 2026-08-03_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
