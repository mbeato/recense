# Phase 37: Typed Predicate Edges — Build — Research

**Researched:** 2026-06-20
**Domain:** Typed graph edges, offline extraction integration, online LLM-free predicate matching
**Confidence:** HIGH (architecture locked in CONTEXT.md; spike is authoritative source; live code verified)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Predicate stored in existing `rel` field on `kind='relation'` edges; closed 12-vocab; no migration, no new column.
- **D-02:** Fold typed-triple extraction into the existing `EXTRACTION_PROMPT` — one Haiku call per episode.
- **D-03:** Gate D-02 behind a fact-quality regression check; fall back to a separate triple call if facts degrade.
- **D-04:** PRIMARY merge gate = deterministic precision (nodes-to-answer / answer-in-top-3, variance-free). SECONDARY = 3x-majority LLM-judged compose-quality. Do NOT let the noisy judge gate the merge on small N.
- **D-05:** Re-derive the query set with founder sign-off before the gate binds.
- **D-06:** Augment-with-fallback: typed path OR neighborhood per query, never both. No-match → today's K=20 schema-neighborhood, unchanged.
- **D-07:** Embedding-match predicate glosses (offline embed, online cosine); tunable threshold; v1 = single-predicate-from-anchor.
- **D-08:** Typed edges minted only at sleep from episodes; inferred output never mints or strengthens a typed edge.
- **D-09:** Keep the 12-predicate closed vocabulary for v1.

### Claude's Discretion
- Exact gloss wording per predicate, the cosine threshold value, and multi-hop path handling are delegated to the phase researcher to pin (D-07).
- Whether D-02 folding lands as a merged or sectioned prompt is a planning/implementation detail.

### Deferred Ideas (OUT OF SCOPE)
- Thinking-on/off extraction cost lever (Phase 42).
- Multi-hop predicate chaining.
- Predicate granularity refinement (coarse `uses`).
- Dedicated indexed `predicate` column.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| TYPED-01 | Typed edge model + offline typed extraction: the schema + edge model carry a predicate type; offline consolidation extraction emits typed edges | D-01 (rel field, no migration), D-02/D-03 (extraction fold), spike vocab.ts + 02-extract.ts confirm the write path works with upsertEdge as-is |
| TYPED-02 | Typed-path recall: recall traverses a typed relational path instead of dumping an untyped schema-neighborhood, returning a smaller, more precise payload | D-06/D-07 (predicate match + fallback), traverse.ts confirms the traversal algorithm, getOutEdges landmine (see §6) requires a new `getOutEdgesWithRel` primitive |
</phase_requirements>

---

## Summary

Phase 37 promotes spike-004-validated typed predicate edges into the live engine. The architecture is fully locked (D-01 through D-09). Research fills in the three gaps CONTEXT.md delegates to the researcher: exact predicate gloss wording (D-07), the cosine threshold default (D-07), and the multi-hop fallback spec (D-07). It also surfaces the one genuine integration landmine: `SemanticStore.getOutEdges()` at `src/db/semantic-store.ts:153` returns `{ dst, w, kind }` WITHOUT `rel`, which means predicate-filtered traversal cannot be implemented using the existing primitive. A new `getOutEdgesWithRel` prepared statement must be added as Wave 0 work.

Everything else is straightforwardly ported from the spike. The extraction fold (D-02) and the build harness (D-04/D-05) have direct analogs in existing eval infrastructure (`replay-ku-harness.cjs`, `35-strength-sweep.cjs`).

**Primary recommendation:** Build in four waves — (0) predicate vocab module + `getOutEdgesWithRel` + gloss embedding; (1) extraction integration; (2) recall traversal; (3) build harness — in that dependency order. Waves 0 and 1 are independent of each other after Wave 0's primitives land.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Predicate vocabulary + gloss embedding | Offline sleep pass | — | Embedding is LLM/embed cost; must be offline |
| Typed edge write (upsertEdge) | Offline sleep pass (consolidator) | — | D-08: only sleep mints typed edges |
| Typed-triple extraction (Haiku) | Offline sleep pass (consolidator) | — | D-02: folded into the existing per-episode Haiku call |
| Predicate→gloss cosine matching | Online recall (RecallEngine) | — | D-07: reuses already-embedded query vec, 12-way cosine only, LLM-free |
| Typed-path traversal | Online recall (RecallEngine) | — | D-06: replaces neighborhood assembly when match fires |
| Fallback neighborhood | Online recall (RecallEngine) | — | D-06: existing schema-neighborhood path unchanged on no-match |
| Build gate measurement | Offline harness (scripts/eval/) | — | D-04/D-05: deterministic primary + LLM-compose secondary |
| Self-confirmation guard | Offline sleep pass + online recall | — | D-08: no upsertEdge anywhere in recall/index.ts (T-04-03-SC) |

---

## Research Findings by Question

### 1. D-07 Predicate Glosses — Exact Wording

Source: `CONTEXT.md §specifics` ("phrased as the natural-language QUESTION form users actually ask"), plus `vocab.ts` inline comments for the semantics of each predicate.

The spike did NOT define glosses — it used the spike's annotated predicate paths directly (traverse.ts upper-bound). These glosses are proposed here for the first time and are the implementer's concrete deliverable for D-07.

**Recommended gloss strings (embed these at sleep, cosine-match at recall):**

| Predicate | Recommended Gloss | Question Forms Covered |
|-----------|-------------------|------------------------|
| `built_by` | `"who created or built this / who is the author"` | "who made X", "who authored X", "who built X" |
| `works_on` | `"what project does this person work on"` | "what does Max work on", "what is X working on" |
| `part_of` | `"what system or project is this a component of"` | "what is X part of", "X belongs to", "X is a subsystem of" |
| `uses` | `"what tool library or service does this use"` | "what does X use", "what technology does X depend on", "what does X run with" |
| `depends_on` | `"what does this depend on to function"` | "what does X need", "what is X dependent on", "what must run for X" |
| `runs_on` | `"what runtime host or platform does this run on"` | "where does X run", "what runs X", "what platform is X on" |
| `located_in` | `"where is this located or stored / what repo or dir"` | "where is X", "where does X live", "what directory is X in" |
| `integrates_with` | `"what peer system does this integrate with"` | "what does X integrate with", "what does X connect to", "what works alongside X" |
| `supersedes` | `"what does this replace or supersede"` | "what did X replace", "what is X the successor to" |
| `prefers` | `"what does this person prefer or favor"` | "what does Max prefer", "what is X's preference" |
| `evaluated` | `"what was evaluated or considered for this"` | "what was X evaluated for", "what alternatives were considered" |
| `configured_with` | `"what settings or configuration does this use"` | "how is X configured", "what settings does X use", "what flags or values configure X" |

**Implementation note:** Each gloss is a single short string to embed. The implementer MAY add 2–3 representative phrasings as a multi-sentence gloss (e.g. `"who created or built this / who is the author"`) — the embedder averages their meaning well. Avoid over-lengthening; short precise glosses outperform paragraph-length prompts for cosine matching. `[ASSUMED]` — gloss effectiveness at these exact phrasings has not been numerically validated; the D-05 harness should include at least 2 queries per predicate to confirm above-threshold matching.

---

### 2. D-07 Cosine Threshold — Recommended Value and Tuning Protocol

**No direct spike measurement exists for threshold calibration.** The spike used annotated predicate paths (the upper bound) rather than gloss-matching. The threshold is a new knob introduced in the build phase.

**Recommendation:** Default `predicateGlossThreshold: 0.35`

Rationale (cross-referenced from live config):
- `rankedRetrievalFloor` = 0.35 in DEFAULT_CONFIG (`config.ts:662`) — the established "real queries score 0.4–0.6; noise < 0.3" calibration from Phase 17, applied to the same embedding space.
- `unrelatedSimilarityThreshold` = 0.3 — lower bound for any meaningful match in this system.
- The predicate glosses are short and focused; a genuine user question about a `located_in` predicate should score 0.5–0.7 against the gloss; an unrelated question should score <0.3. A 0.35 threshold keeps the fallback rate high on ambiguous queries (precision over recall for the path-mode trigger).
- `rankStrengthWeight` ships at 0 (Phase 35 dark-default pattern); this threshold ships at 0.35 to avoid silent dark-default behavior that is never triggered.

**Config key:** `predicateGlossThreshold: number` — add to `EngineConfig` interface and `DEFAULT_CONFIG` in `src/lib/config.ts`, following the `rankStrengthWeight` pattern:
```typescript
// Phase 37: min cosine for query→predicate confident match (D-07).
// Below threshold → schema-neighborhood fallback (D-06).
// Calibration placeholder (D-13): tune against build harness D-05 query set.
predicateGlossThreshold: 0.35,
```

**Tuning protocol:** The D-05 harness (re-derived query set, founder sign-off) should include at least 2 queries per predicate that SHOULD match above threshold. Run the gloss-cosine test before the full precision gate. If >30% of expected-match queries fall below 0.35, lower to 0.30. If unrelated queries trigger predicate mode, raise toward 0.40. The +29.5pts precision win from the spike is the ceiling — any threshold that causes frequent false-matches will erode it.

**Threshold storage:** Predicate gloss embeddings (12 × 1536-dim float32 vectors) are pre-computed at sleep time and stored in a dedicated config/cache location (e.g., `meta` table key `predicate_gloss_embeddings` serialized as JSON, or a companion `.bin` file alongside recense.db). The 12 vectors are tiny (~75 KB total) and loaded once at `RecallEngine` constructor time. `[ASSUMED]` — the meta-table storage approach has not been prototyped; the planner should choose between meta-table JSON and a sidecar file.

---

### 3. D-07 Multi-Hop — v1 Spec

Source: `CONTEXT.md §D-07`: "v1 scope: single-predicate-from-anchor."

**v1 behavior (confirmed from CONTEXT.md):**
- The recall traversal follows exactly ONE predicate from the resolved anchor (`bestMatch`), returning the frontier nodes reachable in one typed hop.
- This mirrors `typedReach(db, anchorId, [single_predicate], K)` from `traverse.ts:39` with `predicatePath.length === 1`.

**No-match fallback (exact spec):**
When `maxCosine < predicateGlossThreshold` (no confident match), RecallEngine executes the EXISTING schema-neighborhood assembly path unchanged — `store.getOutEdges(schemaNode.id)` filtered to `kind='abstracts'`, with the sideways `schema_rel` hop (D-05/SREL-03), capped at `recallNeighborhoodBudget = 20`. No new code needed for the fallback; it is the existing path.

**The augment-with-fallback logic (D-06) expressed as pseudocode:**
```typescript
const bestPredIdx = argmax(cosineSimilarities);  // index into PREDICATES
const bestScore = cosineSimilarities[bestPredIdx];
if (bestScore >= config.predicateGlossThreshold) {
  // typed-path mode: single hop along bestPredicate from bestMatch
  const predicate = PREDICATES[bestPredIdx];
  const payload = typedReach(db, bestMatch.id, [predicate], config.recallNeighborhoodBudget);
  // ... compose with labeled triples
} else {
  // fallback: existing schema-neighborhood assembly (UNCHANGED)
  // ... existing code from recall/index.ts lines 181-242
}
```

**Multi-hop is deferred** (CONTEXT.md §Deferred). Do not implement. Do not add research items for it here.

---

### 4. D-02/D-03 Prompt Folding — Merged Prompt Structure

#### Current EXTRACTION_PROMPT (verbatim from `src/model/claim-extractor.ts:91`)

```
You are a knowledge extraction assistant. Extract all structured knowledge from the given memory document.

For each item extract:
- "type": "entity" for named people, projects, tools, technologies, and organizations; "fact" for rules, preferences, capabilities, and factual statements
- "value": a concise, self-contained string
- "links": an array of OTHER item values referenced via [[WikiLink]] syntax in the document, provided WITHOUT the double brackets (omit if none)

Return ONLY a valid JSON array — no preamble, no explanation, no markdown fences.

Example:
[
  {"type":"entity","value":"Jane Doe is the founder","links":["recense project"]},
  {"type":"fact","value":"Never inflate metrics","links":[]},
  {"type":"entity","value":"recense project"}
]

Document type: 
```

#### Spike TYPED_EXTRACTION_PROMPT (verbatim from `lib/vocab.ts:40`)

```
You extract typed relationship triples from a memory note about a software founder's projects.

Extract every clear (subject, predicate, object) relationship. The predicate MUST be exactly one of this closed set:
built_by, works_on, part_of, uses, depends_on, runs_on, located_in, integrates_with, supersedes, prefers, evaluated, configured_with

Rules:
- subject and object are short canonical entity names (e.g. "recense", "Max", "claude-headless", "OpenAI", "launchd"). Reuse the SAME name for the same thing across the note. No sentences, no descriptions — just the entity name.
- predicate MUST be one of the closed set above, verbatim. If no predicate fits a relationship, SKIP it.
- Only extract relationships actually stated or directly implied by the note. Do not invent.
- Prefer relationships between two named things (project↔tool, person↔project, component↔system).

Return ONLY a valid JSON array, no preamble, no markdown fences:
[
  {"subject":"recense","predicate":"uses","object":"claude-headless"},
  {"subject":"Max","predicate":"works_on","object":"recense"}
]

Memory note:
```

#### Proposed Merged Prompt Structure (D-02 — sectioned, one Haiku call)

The fold uses a **two-section JSON output** approach: the model emits a single JSON object with two top-level keys, `facts` and `triples`. The existing `parseClaims` parser reads only `facts`; a new `parseTriples` (ported from `vocab.ts:69`) reads only `triples`. The `rel` filter (`PRED_SET.has(p)`) in `parseTriples` is the application-level vocab constraint (D-01).

```
You are a knowledge extraction assistant. From the given memory document, extract TWO things:

## Part 1 — Facts and Entities
For each item extract:
- "type": "entity" for named people, projects, tools, technologies, and organizations; "fact" for rules, preferences, capabilities, and factual statements
- "value": a concise, self-contained string
- "links": an array of OTHER item values referenced via [[WikiLink]] syntax in the document, provided WITHOUT the double brackets (omit if none)

## Part 2 — Typed Relationship Triples
Extract every clear (subject, predicate, object) relationship where predicate is EXACTLY one of:
built_by, works_on, part_of, uses, depends_on, runs_on, located_in, integrates_with, supersedes, prefers, evaluated, configured_with

Rules:
- subject and object are short canonical entity names (e.g. "recense", "Max", "launchd"). No sentences.
- If no predicate fits a relationship, SKIP it. Do not invent.
- Only relationships between two named things.

Return ONLY a single valid JSON object with two keys — no preamble, no markdown fences:
{
  "facts": [
    {"type":"entity","value":"Jane Doe is the founder","links":["recense project"]},
    {"type":"fact","value":"Never inflate metrics","links":[]}
  ],
  "triples": [
    {"subject":"recense","predicate":"uses","object":"claude-headless"},
    {"subject":"Max","predicate":"works_on","object":"recense"}
  ]
}

Document type: 
```

**D-03 fact-quality regression check — what to measure and threshold:**
- **Measurement:** Run the folded prompt on the existing KU/LongMemEval extraction cache (or a held-out sample of ~50 real episodes from the live DB). Compare `facts` array: count of extracted claims and mean cosine similarity of claim values (using `text-embedding-3-small`) against the baseline extraction output from the current `EXTRACTION_PROMPT`.
- **Threshold for "degraded":** Claim count drops >15% OR mean cosine similarity of claim values drops >0.05 (meaning extracted facts drift significantly from baseline wording). `[ASSUMED]` — these thresholds are proposed based on analogy with the Phase 35 regression gates; no prior calibration for this specific check.
- **Fallback:** If degraded, revert to a SEPARATE Haiku call for triples using the spike's standalone `TYPED_EXTRACTION_PROMPT`. This is the "two-call fallback" mode. The consolidator gate is an env var (`RECENSE_TYPED_EXTRACTION_MODE=merged|separate`), dark-default `merged`, switchable without a rebuild.
- **Per-source routing:** The folded prompt should be applied to the same sources as `EXTRACTION_PROMPT` (claude-code/obsidian/default). Source-specific prompts (gmail, gcal, granola, etc.) in `promptForSource` already diverge and do NOT participate in D-02 — those pass unchanged.

---

### 5. D-04/D-05 Build Harness — Measurements and Structure

#### Primary Metric (D-04, deterministic)

Ported directly from `05-precision.ts`:
- **Nodes-to-answer (NTA):** gold's rank in the arm's sorted payload. Lower = tighter.
- **Answer in top-3:** `NTA <= 3` → boolean. Aggregate: `% of queries where answer is in top-3`.
- Spike result: typed 82.4% vs untyped 52.9%, **+29.5pts** (the GO anchor).
- The build harness must reproduce this metric on the re-derived query set (D-05).

#### Secondary Metric (D-04, LLM-judged)

Ported from `05-precision.ts:91–98`:
- Run RUNS=3 majority-vote compose calls per query per arm.
- **Typed payload** format: labeled triples (`recense uses better-sqlite3`) — spike `typedPayloadLines`.
- **Untyped payload** format: same structural edges, predicate stripped (`recense — better-sqlite3`) — spike `untypedPayloadLines`.
- Aggregate: `% compose-correct (3x majority)`. Spike: typed 50.9% vs untyped 28.1%, +22.8pts.

#### Payload Size (required by CONTEXT.md §specifics — the token win)

The harness MUST record:
- **Typed arm:** mean `typedFull.length` (nodes in the typed path, before K truncation).
- **Untyped arm:** K (= 20, always fills budget). Spike mean typed payload = 2.6 nodes.
- Report as "typed path ~N nodes vs neighborhood ~20" — this is the interview-defensible token-reduction claim.

#### Existing Harness to Reuse

- `scripts/eval/replay-ku-harness.cjs` — the baseline evaluation framework (fresh scratch DB per case, consolidate → retrieve → score pattern). The build harness (call it `37-precision-harness.cjs`) mirrors its structure:
  - Uses `scripts/eval/results/` as output dir.
  - Takes `--dry-run` to validate wiring without LLM calls.
  - Uses `--headless` flag pattern for subscription-billed runs.
  - Writes a JSON results file with per-query detail + aggregate metrics.
- `scripts/eval/35-strength-sweep.cjs` — sweep pattern for the D-05 threshold sweep. The build harness may optionally implement a `--threshold-sweep` mode that iterates `predicateGlossThreshold` values (e.g., 0.25, 0.35, 0.45, 0.55) to confirm the recommended default.

#### D-05 Query Set Re-derivation

The spike used 20 queries authored by Claude against ground-truth corpus facts (founder-accepted at GO, not line-by-line verified). For Phase 37 the query set must be:
1. Re-derived from the live DB's actual typed edges (post-extraction Wave 1).
2. Presented to the founder for explicit per-query sign-off before the gate runs.
3. Balanced across predicates (at least 1 query per predicate, ideally 2).
4. Anti-circularity: hi/mid-tier queries authored blind to the graph (D-03 spike discipline), lo-tier controls from confirmed-reachable chains.

N will likely be 20–30 queries. At N=20, each query = 5pts; the +29.5pt gap is ~6 queries wide — large enough to be robust to small N at the deterministic primary metric.

---

### 6. Integration Landmines

#### LANDMINE 1 (CRITICAL): `getOutEdges` does NOT return `rel`

**Live code:** `src/db/semantic-store.ts:152–154`
```typescript
this.stmtGetOutEdges = db.prepare(
  'SELECT dst, w, kind FROM edge WHERE src = ?'
);
```
Return type: `Array<{ dst: string; w: number; kind: string }>` — `rel` is ABSENT.

**Impact:** `typedReach()` in `traverse.ts:43` does `if (e.rel !== pred) continue` — this cannot work with the existing `getOutEdges` return shape. The predicate-filtered traversal is blocked.

**Fix required (Wave 0):** Add `getOutEdgesWithRel` to `SemanticStore`:
```typescript
private readonly stmtGetOutEdgesWithRel: Database.Statement;
// In constructor:
this.stmtGetOutEdgesWithRel = db.prepare(
  'SELECT dst, rel, w, kind FROM edge WHERE src = ?'
);
// Public method:
getOutEdgesWithRel(nodeId: string): Array<{ dst: string; rel: string; w: number; kind: string }> {
  return this.stmtGetOutEdgesWithRel.all(nodeId) as Array<{ dst: string; rel: string; w: number; kind: string }>;
}
```
Existing `getOutEdges` callers are unchanged. `getOutEdgesWithRel` is used only in typed-path traversal (D-06/D-07). The traversal filters by `edge.kind === 'relation'` first to avoid following `abstracts`/`schema_rel`/etc. edges as predicate paths.

**Verified:** `getInEdges` at line 160–162 similarly omits `rel`: `SELECT src, w, kind FROM edge WHERE dst = ?`. The typed traversal is forward-only (D-07: "from bestMatch"), so `getInEdges` is not affected.

#### LANDMINE 2: `upsertEdge` is called with `kind='relation'` and two existing free-text `rel` values

Live code produces `kind='relation'` edges with:
- `rel: 'links_to'` — wikilink edges (seeder: `src/seeder/cold-start.ts:106`)
- `rel: 'extends'` — knowledge-extension edges (consolidator: `src/consolidation/consolidator.ts:825`)

**Impact:** The typed-path traversal must NOT follow `links_to` or `extends` edges as if they were typed predicates. The traversal filter for D-06 must check `edge.rel in PREDICATES_SET` (not just `edge.kind === 'relation'`). The existing non-typed relation edges coexist harmlessly as long as the traversal is predicate-vocab-filtered.

**Fix:** In the traversal code, after `getOutEdgesWithRel`, filter by `PREDICATES_SET.has(edge.rel)` before any predicate match. This is already the spike behavior (via `parseTriples`'s `PRED_SET`).

**No migration needed:** D-01 confirmed — the 12 typed predicates are stored verbatim in `rel`; `links_to` and `extends` are not in the closed vocab; the filter separates them at query time.

#### LANDMINE 3: Query embedding is available in `RecallEngine` but NOT in the path that resolves `schemaNode`

**Live code flow (recall/index.ts):**
1. Line 129: `const [cueVec] = await this.provider.embed([boundedQuery])` — embedding computed.
2. Lines 131–135: `topk(cueVec, ...)` → `bestMatch`.
3. Lines 151–175: schema resolution (Case A/B) → `schemaNode`.
4. Lines 181–242: neighborhood assembly.

**D-07 integration point:** The 12-way cosine between `cueVec` and the 12 pre-embedded predicate gloss vectors must happen AFTER step 2 (bestMatch resolved, cueVec available) and BEFORE step 4 (neighborhood assembly). Insert the predicate-match decision between steps 2 and 4:
```typescript
// D-07: attempt predicate match against pre-loaded gloss embeddings
const matchedPredicate = matchPredicate(cueVec, predicateGlossEmbeddings, config.predicateGlossThreshold);
if (matchedPredicate !== null) {
  // D-06: typed-path mode — bypass schema-neighborhood assembly entirely
  return await this.recallTypedPath(bestMatch.id, matchedPredicate, ...);
}
// fall through to existing schema-neighborhood assembly (unchanged)
```
`cueVec` is a `Float32Array` (1536-dim). The 12-way cosine is O(12×1536) ≈ 18,432 FLOPs — negligible online latency.

**No new online LLM or embed cost.** The gloss embeddings are pre-loaded constants (embedded once at sleep).

#### LANDMINE 4: Self-confirmation guard location (D-08)

**Current guard (already in place):** `src/recall/index.ts` comment at line 19: "NEVER calls store.upsertNode/upsertEdge/tombstone or strength.strengthen." Enforced by source grep assertion (T-04-03-SC).

**D-08 compliance:** The typed-path recall path (D-06) must honor the same invariant. The `recallTypedPath` method must not call `upsertEdge` or `strengthen`. The typed payload is ONLY surfaced to the LLM compose step and logged as `origin='inferred'` episode — same as the existing neighborhood path. No new edge writes.

The D-08 guard does NOT need a new mechanism — it is already the invariant at the only place typed edges could be incorrectly written (the recall path). The sleep-pass extraction side (D-02) writes typed edges naturally via `upsertEdge`, which is already the correct write site.

#### LANDMINE 5: `consolSkipThreshold` gates extraction — typed triples skipped on low-salience turns

The merged prompt (D-02) fires only when the existing `consolSkipThreshold` gate passes (salience >= 0.2 for user turns, 0.5 for assistant turns). Low-salience turns are skipped entirely (no facts extracted, no triples extracted). This is correct behavior — do not bypass the skip gate for triple extraction. The result is that typed edges form only from salient episodes, which is the intended quality gate.

**No action needed.** Document this as a design property, not a bug.

#### No net-new runtime deps

The implementation requires:
- No new npm packages — everything uses existing `better-sqlite3`, existing headless transport, existing `text-embedding-3-small` embedder.
- The 12 gloss embeddings are pre-computed using the existing `ModelProvider.embed` seam.
- `PREDICATES` array and `parseTriples` function from the spike's `lib/vocab.ts` are pure TypeScript with no external deps; copy into `src/typed/` (or `src/model/typed-predicates.ts`).

Engine invariant "net-zero new runtime deps" is satisfied. `[VERIFIED: live code + spike code — all required capabilities exist in the current dependency graph]`

---

### 7. Sequencing / Build Order

**Wave 0 — Primitives (blocks all downstream, ~half a day):**
- Port `PREDICATES`, `parseTriples`, `Triple` from `lib/vocab.ts` into `src/model/typed-predicates.ts` (or similar).
- Add `predicateGlossThreshold` to `EngineConfig` + `DEFAULT_CONFIG`.
- Add `getOutEdgesWithRel` to `SemanticStore` (the critical landmine fix).
- Offline: embed 12 predicate gloss strings using `ModelProvider.embed`; store embeddings in `meta` table or sidecar (implementation detail for planner).

**Wave 1 — Extraction (independent of Wave 2 after Wave 0):**
- Write merged `TYPED_EXTRACTION_PROMPT` variant (D-02 fold).
- Add a D-03 regression check: run baseline vs merged on ~50 real episodes, confirm claim count/cosine within threshold.
- Wire into `consolidator.ts` (after the existing extract call, parse `triples` from the merged output, call `upsertEdge` for each with `kind='relation'`).
- D-08 guard: assert the consolidator extraction is the ONLY upsertEdge site for typed predicates.

**Wave 2 — Recall traversal (independent of Wave 1 after Wave 0):**
- Port `typedReach` from `traverse.ts` into `src/recall/typed-traversal.ts`.
- Add `matchPredicate` function: cosine-match `cueVec` against pre-loaded gloss embeddings.
- Augment `RecallEngine.recall()` with the D-06 branch (typed-path mode vs fallback).
- Integrate pre-loaded gloss embeddings via constructor injection (testable).

**Wave 3 — Build harness (depends on Wave 1 + Wave 2 both landed):**
- Implement `37-precision-harness.cjs` in `scripts/eval/`, modeled on `replay-ku-harness.cjs`.
- Re-derive query set → founder sign-off (D-05).
- Run PRIMARY metric (NTA/top-3) and SECONDARY (3x-majority compose).
- Record payload size (token-reduction evidence).
- Gate on PRIMARY: typed top-3% >= 75% AND lift over untyped >= +20pts. SECONDARY is confirmation only.

**Parallelizable:** Wave 1 and Wave 2 can run in parallel after Wave 0 lands (they touch different source files). Wave 3 depends on both.

---

## Standard Stack

No new packages. All implementation uses:

| Component | Source | Notes |
|-----------|--------|-------|
| `better-sqlite3` | Existing | All DB access via `SemanticStore` owned primitives |
| `text-embedding-3-small` | Existing | Gloss embeddings at sleep; 1536-dim float32 |
| `claude -p` headless transport | Existing | Haiku for merged extraction prompt |
| `src/lib/config.ts` | Existing | Add `predicateGlossThreshold` following `rankStrengthWeight` pattern |
| `src/model/claim-extractor.ts` | Existing | `EXTRACTION_PROMPT`, `parseClaims` — extend, don't replace |
| `src/db/semantic-store.ts` | Existing | Add `getOutEdgesWithRel` only |
| `src/recall/index.ts` | Existing | Augment `recall()` with D-06 branch |

## Package Legitimacy Audit

Not applicable — Phase 37 installs zero external packages. Net-zero new runtime deps is an engine invariant.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead |
|---------|-------------|-------------|
| Typed edge storage | New column, new table, `EdgeKind` enum expansion | `EdgeRow.rel` free-text field — already exists, D-01 |
| Predicate-filtered traversal | Custom BFS from scratch | Port `typedReach` from `traverse.ts` verbatim (44 lines) |
| Online predicate matching | Keyword regex / pattern map | 12-way cosine against pre-embedded gloss vectors (D-07 — already designed) |
| LLM-free online cosine | Custom SIMD library | Standard JS `Float32Array` dot-product loop (12 vectors × 1536 dims = trivial) |
| Extraction evaluation | Custom harness | Extend `replay-ku-harness.cjs` scaffold |

---

## Common Pitfalls

### Pitfall 1: Using `getOutEdges` for typed traversal

**What goes wrong:** Implementing predicate-filtered traversal using the existing `getOutEdges` which returns `{ dst, w, kind }` — `rel` is absent, so the predicate filter silently drops all edges.
**Why it happens:** The field omission is invisible in TypeScript if the caller does `edge.rel` and gets `undefined` rather than a compile error (the return type is typed as `{ dst, w, kind }` without `rel`).
**How to avoid:** Use only `getOutEdgesWithRel` (Wave 0 addition) for typed traversal. Add a lint-friendly comment at `getOutEdges` noting the missing `rel` and directing predicate-traversal code to `getOutEdgesWithRel`.
**Warning signs:** Typed arm always returns empty payload; all queries fall through to neighborhood fallback.

### Pitfall 2: Following `links_to` and `extends` edges as if they were typed predicates

**What goes wrong:** Predicate traversal iterates `getOutEdgesWithRel` and matches on `kind='relation'` without checking `PREDICATES_SET.has(edge.rel)`. Links from wikilink-based `links_to` edges and extend-chain `extends` edges contaminate the typed path.
**Why it happens:** The traversal is written for the spike's scratch DB (all edges are typed predicates); in the live DB, `relation`-kind edges have three distinct `rel` values.
**How to avoid:** Always gate on `PREDICATES_SET.has(edge.rel) && edge.kind === 'relation'` before the predicate filter.
**Warning signs:** Typed arm returns irrelevant nodes via `links_to` hops; wikilink targets appear in "precise" typed payloads.

### Pitfall 3: Merged prompt schema breaks `parseClaims`

**What goes wrong:** The merged prompt returns a JSON object `{ facts: [...], triples: [...] }` but the existing `parseClaims` parser in `claim-extractor.ts` expects a bare JSON array `[...]`. Passing the merged output to the unmodified parser fails silently (parseClaims returns `[]`).
**Why it happens:** `parseClaims` searches for the first `[` and last `]` — in a `{ "facts": [...], "triples": [...] }` response, it will extract the `facts` array correctly IF `facts` appears first in the output. But this is fragile.
**How to avoid:** Parse the merged response as a JSON object explicitly, extract `.facts` array for `parseClaims`, `.triples` array for `parseTriples`. Do not rely on the `[`/`]` search heuristic in `parseClaims` for the merged output.
**Warning signs:** Claim counts drop to 0 after folding; no TypeScript error because `parseClaims` returns `ExtractedClaim[]` on parse failure.

### Pitfall 4: Gloss embeddings recomputed on every recall

**What goes wrong:** The 12 predicate gloss embeddings are re-embedded on every `recall()` call, adding 12 embed API calls to the online path (violating the LLM-free invariant).
**Why it happens:** Glosses are embedded inside `recall()` instead of at construction or sleep time.
**How to avoid:** Embed glosses ONCE during the offline sleep pass (or on first startup if not yet embedded); load into `RecallEngine` constructor as a frozen `Float32Array[]` constant. The 12 vectors are 12 × 1536 × 4 bytes = ~75 KB.
**Warning signs:** Online recall latency spikes; `ModelProvider.embed` called with predicate gloss strings during a session.

### Pitfall 5: LLM-judged compose result used as the PRIMARY gate (D-04)

**What goes wrong:** The build harness gates the merge on compose-correct rate rather than the deterministic NTA/top-3 metric. The compose metric has residual CLI temperature variance; small N amplifies it.
**Why it happens:** Compose-correct "feels more product-relevant" and is easier to interpret.
**How to avoid:** D-04 is explicit: PRIMARY = deterministic NTA/top-3. SECONDARY = compose (confirmation only, never blocking gate). The harness must enforce this order. The compose result is informative; it does not pass or fail the merge.

### Pitfall 6: Self-confirmation via typed edges from recall output

**What goes wrong:** A recall inference ("recense uses better-sqlite3") is appended as an `origin='inferred'` episode; the next sleep pass extracts a `uses` triple from that episode and mints a new typed edge from an inferred source.
**Why it happens:** The consolidator processes all unconsolidated episodes including `origin='inferred'` ones.
**How to avoid:** The consolidator's typed-edge extraction path (D-02) must gate on `episode.origin !== 'inferred'` before emitting typed triples — exactly the same guard that already protects node writes from self-confirmation (the existing `origin` guard in `claim-extractor.ts`). Verify this guard is present in the Wave 1 implementation. `[VERIFIED: the existing consolidator already stamps `claim.origin = episode.origin` and the strengthen guard respects it — the same guard applied to triple extraction closes the self-confirmation loop for typed edges]`

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest (existing) |
| Config file | `vitest.config.ts` (root) |
| Quick run | `npm test` |
| Full suite | `npm test -- --run` |
| Build prerequisite | `npm run build` (required before running `.cjs` eval harnesses) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command |
|--------|----------|-----------|-------------------|
| TYPED-01a | `PREDICATES` vocab closed set (12 predicates) | unit | `npm test -- --run typed-predicates` |
| TYPED-01b | `parseTriples` filters out-of-vocab predicates | unit | `npm test -- --run typed-predicates` |
| TYPED-01c | Consolidator emits typed edges via upsertEdge with `kind='relation'` | unit | `npm test -- --run consolidator` |
| TYPED-01d | D-03 regression: merged prompt claim count >= baseline × 0.85 | integration | `37-precision-harness.cjs --regression-only --dry-run` |
| TYPED-02a | `getOutEdgesWithRel` returns `rel` field | unit | `npm test -- --run semantic-store` |
| TYPED-02b | `typedReach` returns only nodes reachable via specified predicate | unit | `npm test -- --run typed-traversal` |
| TYPED-02c | Recall returns typed-path payload when cosine >= threshold | unit | `npm test -- --run recall-engine` (with mock gloss embeddings) |
| TYPED-02d | Recall falls back to schema-neighborhood when cosine < threshold | unit | `npm test -- --run recall-engine` |
| TYPED-02e | Typed path never calls upsertEdge/strengthen (D-08 guard) | static / grep | `grep -rn 'upsertEdge\|strengthen' src/recall/` (must return 0 hits) |
| TYPED-02f | Build gate PRIMARY: typed top-3% >= 75% AND lift >= +20pts | eval harness | `node scripts/eval/37-precision-harness.cjs` |

### Wave 0 Gaps

- [ ] `src/model/typed-predicates.ts` — `PREDICATES`, `PRED_SET`, `parseTriples`, `Triple` (ported from spike)
- [ ] `src/db/semantic-store.ts::getOutEdgesWithRel` — new prepared statement + public method
- [ ] `src/lib/config.ts::predicateGlossThreshold` — new field on `EngineConfig` + default in `DEFAULT_CONFIG`
- [ ] `tests/typed-predicates.test.ts` — unit tests for parseTriples, PREDICATES closed set
- [ ] `tests/typed-traversal.test.ts` — unit tests for typedReach (ported from spike `05-precision.ts` test patterns)
- [ ] `scripts/eval/37-precision-harness.cjs` — build gate harness scaffold (modeled on `replay-ku-harness.cjs`)

---

## Security Domain

`security_enforcement` not explicitly set to false — included.

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V5 Input Validation | Yes (typed triple JSON parse) | `parseTriples` with `PRED_SET.has(p)` vocab filter; existing `parseClaims` safe fallback pattern |
| V4 Access Control | No | Engine is single-tenant; no tenancy change in this phase |
| V2 Authentication | No | No new auth surfaces |
| V6 Cryptography | No | No new crypto |

### Threat Patterns

| Pattern | STRIDE | Mitigation |
|---------|--------|------------|
| LLM extracts malformed predicate not in vocab | Tampering | `PRED_SET.has(p)` filter in `parseTriples` — out-of-vocab predicates silently dropped |
| Typed triple with self-referential edge (src == dst) | Tampering | Add `s !== obj` guard in `parseTriples` (not in spike; recommend adding) |
| Typed edge minted from inferred episode | Elevation | `episode.origin !== 'inferred'` gate in consolidator triple-extraction path (D-08) |
| Predicate-match triggers path from wrong anchor | Spoofing | `bestMatch` is the cosine top-1 — existing retrieval trust boundary unchanged |
| Gloss embedding injection via predicate string | Tampering | Glosses are hardcoded constants, not user-supplied |

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Gloss wording at proposed phrasings will cosine-match user queries at >=0.35 for intended predicates | D-07 Glosses | D-05 harness shows <75% match rate → glosses need revision before gate |
| A2 | `predicateGlossThreshold: 0.35` avoids false triggers on unrelated queries | D-07 Threshold | High false-trigger rate → neighborhood fallback underused, payload quality degrades |
| A3 | Merged prompt `{facts, triples}` JSON schema is reliably produced by Haiku (thinking-off) | D-02 Prompt | Malformed output → D-03 regression triggers → fall back to separate call |
| A4 | D-03 regression thresholds (claim count >=85%, mean cosine drop <=0.05) are correct | D-03 | Too strict → unnecessary separate-call fallback; too loose → undetected fact quality drop |
| A5 | Meta-table storage is adequate for 12 gloss embeddings (~75 KB) | D-07 storage | If meta-table JSON is slow to deserialize on startup, use sidecar `.bin` file instead |
| A6 | `self-confirmation` for typed edges is already blocked by the existing `episode.origin` guard in the consolidator | D-08 | If the guard is not applied to the triple-extraction branch, a new explicit guard must be added |

---

## Open Questions

1. **Gloss embedding storage location**
   - What we know: 12 × 1536 × 4 bytes = ~75 KB; must be loaded once at RecallEngine startup; must survive DB open.
   - What's unclear: `meta` table JSON vs a sidecar `.bin` file alongside `recense.db`. Meta-table JSON requires a JSON parse on load; `.bin` is faster but adds a file outside the DB.
   - Recommendation: Use `meta` table key `predicate_gloss_embeddings` (base64-encoded Float32Array per predicate as a JSON object). The parse cost is one-time at startup; the meta table is already the store for engine state.

2. **Typed extraction mode for source-specific prompts**
   - What we know: `promptForSource` has 8 distinct prompt variants; D-02 targets the `EXTRACTION_PROMPT` path (claude-code/obsidian/default).
   - What's unclear: Should gmail/gcal/granola sources also emit typed triples?
   - Recommendation: v1 scope is the default path only. Source-specific prompts are out of scope for Phase 37 (D-09: keep 12-vocab, don't expand surface area).

3. **Re-derived query set ownership**
   - What we know: D-05 requires "re-derive with founder sign-off before the gate binds."
   - What's unclear: Who derives the queries — the implementer in Wave 3, or the founder before Wave 3 starts?
   - Recommendation: Implementer derives a candidate query set (20–30 queries, balanced across predicates, after Wave 1 extraction lands on a copy of live DB); founder reviews and signs off; THEN Wave 3 gate runs. This sequence must be explicit in the plan.

---

## Sources

### Primary (HIGH confidence — verified from live code and spike files)
- `src/lib/types.ts:65–73` — `EdgeRow.rel` field, `EdgeKind` enum (D-01 grounding confirmed)
- `src/db/schema.ts:57–65` — edge DDL; confirmed no migration needed for D-01 (rel is already free-text TEXT NOT NULL)
- `src/db/schema.ts:440–463` — v12 migration is the latest; current `kind` CHECK includes 7 values; no typed predicate enum entry needed
- `src/db/semantic-store.ts:152–162` — `getOutEdges` and `getInEdges` SQL (critical landmine: no `rel` in SELECT)
- `src/db/semantic-store.ts:384–400` — `upsertEdge` signature (D-01: accepts rel as free-text)
- `src/recall/index.ts:129–335` — full RecallEngine.recall() flow (D-07 integration point at lines 129–135)
- `src/lib/config.ts:331,657` — `rankStrengthWeight` dark-default pattern (D-07 threshold follows same pattern)
- `src/lib/config.ts:667` — `recallNeighborhoodBudget: 20` (confirmed K=20)
- `src/model/claim-extractor.ts:91–107` — `EXTRACTION_PROMPT` verbatim (D-02 fold basis)
- `src/source/extraction-prompts.ts:305–328` — `promptForSource` routing (confirms D-02 scope = default path only)
- `src/consolidation/consolidator.ts:825` — `rel: 'extends'` (landmine 2: existing free-text rel values)
- `src/seeder/cold-start.ts:106` — `rel: 'links_to'` (landmine 2)
- `.planning/spikes/004-typed-predicate-edges/lib/vocab.ts` — `PREDICATES` (12), `TYPED_EXTRACTION_PROMPT` (verbatim), `parseTriples`
- `.planning/spikes/004-typed-predicate-edges/lib/traverse.ts` — `typedReach`, `untypedTopK` (exact traversal algorithm)
- `.planning/spikes/004-typed-predicate-edges/05-precision.ts` — NTA metric, payload lines, compose harness (D-04 template)
- `.planning/spikes/004-typed-predicate-edges/README.md` — GO verdict, precision results (+29.5pts deterministic, +22.8pts compose), K-sweep, cost
- `.planning/spikes/MANIFEST.md §"Requirements — Phase 36/37"` — carry-forward constraints (control fairness, K=20)
- `.planning/phases/37-typed-predicate-edges-build/37-CONTEXT.md` — locked decisions D-01 through D-09

### Secondary (MEDIUM confidence)
- `scripts/eval/replay-ku-harness.cjs` — harness scaffold pattern for D-04/D-05
- `scripts/eval/35-strength-sweep.cjs` — sweep pattern for threshold calibration

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new packages; all primitives verified in live code
- Architecture: HIGH — locked in CONTEXT.md; spike is authoritative; integration landmines verified in live source
- Pitfalls: HIGH — most pitfalls discovered by direct code inspection (not assumption)
- Gloss wording: MEDIUM — proposed for first time; D-05 harness validates before gate
- Cosine threshold: MEDIUM — extrapolated from existing `rankedRetrievalFloor` calibration; D-05 harness confirms

**Research date:** 2026-06-20
**Valid until:** 2026-07-20 (stable tech; re-verify only if schema.ts or semantic-store.ts changes)

---

## RESEARCH COMPLETE

**Phase:** 37 — Typed Predicate Edges Build
**Confidence:** HIGH

### Key Findings

1. **Critical integration landmine:** `SemanticStore.getOutEdges()` (`src/db/semantic-store.ts:153`) returns `{ dst, w, kind }` without `rel` — predicate-filtered traversal is blocked. Wave 0 must add `getOutEdgesWithRel` before any recall work can proceed.

2. **Two existing `kind='relation'` edges in the live DB** (`rel='links_to'` and `rel='extends'`) must be filtered out by `PREDICATES_SET.has(edge.rel)` in the traversal — they are not typed predicates despite sharing the same `EdgeKind`.

3. **D-07 glosses pinned:** 12 exact gloss strings proposed (natural-language question form per predicate). Default threshold `predicateGlossThreshold: 0.35` following `rankStrengthWeight` dark-default config pattern in `src/lib/config.ts`.

4. **D-02 merged prompt structure:** Two-section JSON object `{ facts: [...], triples: [...] }`; existing `parseClaims` must NOT be fed the raw merged output — parse as JSON object first, route `.facts` and `.triples` separately.

5. **D-06 fallback is exactly the existing schema-neighborhood code** (lines 181–242 of `recall/index.ts`) — no changes needed on the fallback path; the augment-with-fallback branch wraps around it.

6. **D-05 query set derivation is a founder-sign-off checkpoint** that must be explicit in the plan between Wave 1 (extraction lands) and Wave 3 (gate runs).

### File Created
`.planning/phases/37-typed-predicate-edges-build/37-RESEARCH.md`

### Confidence Assessment
| Area | Level | Reason |
|------|-------|--------|
| Edge model (D-01) | HIGH | Live DDL + types.ts verified; no migration needed confirmed |
| Integration landmines | HIGH | Found by direct code inspection of semantic-store.ts:153 |
| Extraction fold (D-02/D-03) | HIGH | Prompt texts quoted verbatim; merged structure is a design decision, not a code discovery |
| Recall traversal (D-06/D-07) | HIGH | traverse.ts algorithm verified; integration point in recall/index.ts pinned |
| Gloss wording | MEDIUM | Proposed for first time; D-05 harness provides the validation gate |
| Cosine threshold | MEDIUM | Extrapolated from analogous existing config values |

### Open Questions
- Gloss embedding storage: `meta` table JSON vs sidecar `.bin` (planner chooses).
- D-05 query set: who derives the candidate set (implementer recommendation: Wave 1 complete → implementer drafts → founder signs off → Wave 3 runs).

### Ready for Planning
Research complete. Planner can now create PLAN.md files.
