# Phase 64: Entity Resolution Hardening - Context

**Gathered:** 2026-08-02 (auto mode — decisions are the recommended defaults, grounded in the v10.0 research pass, live-code scout, and the 63-REVIEW WR-01 carry-forward; audit trail in 64-DISCUSSION-LOG.md)
**Status:** Ready for planning

<domain>
## Phase Boundary

A classified gmail episode (Phase 63's `claimIntentStatus`/`claimIntentEntity`/`claimIntentConfidence` on the in-memory `ClaimDecision`) resolves its free-text entity descriptor to the correct tracked entity node in **recense's own graph**, or to nothing at all. Resolution uses broadened candidate generation — exact/entity-keyed match ∪ BM25 lexical ∪ dense cosine union, reusing v9.0's RECON machinery — never dense-cosine alone (RESOLVE-01). When no candidate clears the confidence bar, resolution abstains and nothing downstream is produced from that episode (RESOLVE-02). A resolved entity is exposed as recense's own node reference plus a human-readable descriptor; recense never mirrors, imports, or queries a consumer's canonical ID space (RESOLVE-03 — the consumer's adapter owns that mapping, per the resolved PROJECT.md open question).

Like Phase 63, this phase touches **no database schema**: output is optional fields on the in-memory `ClaimDecision` (roadmap foundation-phase call — the `action_proposal` table is Phase 66's first task). The resolver runs in the sleep pass; online paths stay LLM-free.

Out of phase: PE-gated status drift, confidence→PE-magnitude mapping, provenance distinctness, lifecycle-lattice awareness (Phase 65); `ActionProposalSink` / `action_proposal` table / `/v1/proposals` (Phase 66); consumer-side ID mapping (Phase 67); HITL surface (Phase 68); entity-anchored ambient recall reusing this phase's generator (Phase 69).

Hard prerequisite satisfied: Phase 63 complete (verification 4/4, 2026-08-02) — intent fields exist and thread through all four `ClaimDecision` routes.

</domain>

<decisions>
## Implementation Decisions

### Resolver placement & reuse seam (RESOLVE-01)
- **D-01:** Resolution lives in a **standalone module** (e.g. `src/consolidation/entity-resolution.ts`; exact name/location planner discretion) exposing (a) the broadened union candidate generator and (b) the confident-or-null resolver over it — called from a branch inside `consolidate()`'s per-episode loop, not implemented inline. Rationale: Phase 69 (roadmap, added 2026-08-02) explicitly plans to reuse "Phase 64's union generator" for entity-anchored ambient recall — an inline implementation would force a second divergent generator, the exact duplication the roadmap warns against.
- **D-02:** The union's three channels mirror shipped machinery, not new inventions: exact/entity-keyed via the `resolveEntityByName` priority ladder + `normalizeValue` normalization (`semantic-store.ts:519`, `normalize.ts:18`); BM25 via `node_fts` with the mandatory `ftsQueryFromText` sanitizer and the FTS-absent try/catch fallback (consolidator.ts:816-837 precedent); dense cosine via the existing vector sidecar path. Never dense-only — a structural test must prove a resolution can succeed/fail on lexical evidence with the dense channel empty and vice versa.
- **D-03:** The resolver branch runs strictly AFTER the existing `origin === 'inferred' || echoSourceId !== null || source === 'hitl'` hard-stop, inside the same per-episode loop — inheriting Phase 63's D-09 structural-guard discipline (Pitfall 6). It fires only for decisions actually carrying intent fields; episodes without them pay zero resolution cost.

### Confident-or-null mechanics (RESOLVE-02)
- **D-04:** Resolution is **deterministic and LLM-free — zero net-new LLM calls**, mirroring the D-02 `validateProposal` pattern, not the judge-escalation pattern. Confident-or-null = (a) top candidate must clear a similarity/score floor AND (b) the top-2 candidates must be separated by a minimum margin (too-close-to-call → abstain). Both are the exact prescriptions of research Pitfall 4. An LLM disambiguation tier is explicitly deferred until recense's own measurement (Phase 65's DRIFT-05 harness) shows deterministic precision is insufficient.
- **D-05:** Floor and margin are **config knobs with conservative defaults** (dark-knob convention, like `bm25CandidateK`); exact default values are planner/research discretion but must err toward abstention — a missed resolution costs nothing (no proposal), a wrong one silently corrupts an external system of record recense cannot fix.
- **D-06:** Abstention is **observable, never silent**: count/log resolution attempts, hits, and abstains (per-channel counters mirroring the Phase 46 D-06 candidate-source counters), so Phase 65's honest-measurement requirement (DRIFT-05) has data to stand on.

### Output shape & threading (RESOLVE-03)
- **D-07:** Two new optional fields on `ClaimDecision` beside the intent fields (exact names planner discretion, e.g. `claimResolvedEntityId` / `claimResolvedEntityDescriptor`): recense's own node id + a human-readable descriptor. **All-or-nothing** (both present or both absent, mirroring 63's D-05); absence = abstained/unresolved. The raw email-stated `claimIntentEntity` stays untouched alongside — it is the resolution INPUT, not overwritten by the output.
- **D-08:** The descriptor is the resolved node's own canonical `value` string (recense's vocabulary), per ARCHITECTURE.md Q4: consumers key on the descriptor semantically; the node id is carried for recense-internal lineage but is NOT a stable foreign key across belief-correction (tombstone-and-mint-new) — Phase 66's contract docs own stating that caveat to consumers. No consumer ID, no consumer schema knowledge, anywhere.
- **D-09:** **No DB schema change in Phase 64.** Fields are in-memory and inert this phase (Phase 65 consumes them). The Phase 63 inertness-conservation discipline extends: two consolidation passes with resolution on vs off must produce identical persisted state.

### WR-01 closure (63-REVIEW carry-forward — first consumption is HERE)
- **D-10:** Close 63-REVIEW WR-01 in this phase via its recommended option (a): gate intent-field pickup on episode source at the consolidator fill sites — `episode.source === 'gmail' ? claim.intent_status : undefined` (one predicate, hoisted once per episode, applied at all four fill sites). This makes D-11 gmail-only isolation structural instead of prose-deep BEFORE resolution consumes the fields. If the planner finds threading `episodeSource` onto `ClaimDecision` additionally useful for downstream phases, that is permitted, but the fill-site gate is the mandatory minimum. A regression test proves a non-gmail episode whose extraction response smuggles intent fields produces no threading and no resolution.

### Candidate pool & read-only contract (RESOLVE-01/02)
- **D-11:** The candidate universe is **live (non-tombstoned) `type='entity'` nodes** in recense's graph — the graph IS the canonical list (research Q4 resolution; the Phase 25 entity-dedup pass is what keeps this pool clean). BM25/dense channel hits are filtered to entity-type nodes for the resolution use (the generator seam itself may stay type-agnostic for Phase 69 reuse — planner discretion on where the filter sits).
- **D-12:** The resolver is **strictly read-only over the graph**: it never mints an entity node on a miss (that would defeat confident-or-null — an unknown company must abstain, Pitfall 4 failure mode 2), never strengthens anything (D-43 discipline), and never writes. Entity creation remains the extraction pipeline's job.

### Verification approach
- **D-13:** Test set must cover, at minimum: near-duplicate separation ("Acme Corp" vs "Acme Consulting" both tracked — resolves correctly or abstains, never cross-attributes); unknown-entity abstain (never-onboarded company → both fields absent); top-2 margin abstain; never-dense-only structural proof (D-02); hitl/inferred/echo sentinel inheritance (D-03); WR-01 non-gmail smuggling regression (D-10); zero-net-new-LLM-calls sentinel (resolution adds no `provider.generate` call — extend Phase 63's counting-stub pattern); persisted-state inertness (D-09).

### Claude's Discretion
- Exact module name/location for the resolver seam (D-01) and field names on `ClaimDecision` (D-07) — semantics locked.
- Exact floor/margin default values and config-knob names (D-05) — conservatism locked.
- Where the entity-type filter sits relative to the reusable generator (D-11).
- Whether `episodeSource` is additionally threaded onto `ClaimDecision` beyond the mandatory fill-site gate (D-10).
- How resolution scores are combined across the three channels (rank-union with priority ladder vs fused score) — but NO off-the-shelf reranker (v9.0 research: a reranker over fused top-k HURT; do not add without measuring).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements & roadmap
- `.planning/REQUIREMENTS.md` — RESOLVE-01..03 (lines 36-40: requirements + the resolved canonical-list-ownership preamble)
- `.planning/ROADMAP.md` — Phase 64 entry (goal, success criteria) + the v10.0 preamble foundation-phase call (why NO `action_proposal` table exists before Phase 66) + the Phase 69 entry (why the union generator must be a reusable seam)

### v10.0 research (load-bearing for this phase)
- `.planning/research/PITFALLS.md` — **Pitfall 4** (the phase's defining pitfall: three failure modes, confident-or-null prescription, floor + top-2-margin mechanics); Pitfall 6 (branch-inside-loop guard inheritance); Pitfall 16 fix (a) (off-topic mail must abstain cheaply)
- `.planning/research/SUMMARY.md` — "Phase 4: Entity Resolution Hardening" section; "skip research-phase" note (mirrors v9.0 RECON + D-02 pattern verbatim)
- `.planning/research/ARCHITECTURE.md` — **Q4** (canonical-list ownership: option (c), the two-different-resolutions insight, why node ids are not stable consumer FKs)

### Upstream phase context (decisions this phase consumes)
- `.planning/phases/63-offline-intent-classification/63-CONTEXT.md` — D-04 (descriptor is free text, "resolution is Phase 64's job"), D-05 (all-or-nothing precedent), D-07/D-08 (ClaimDecision threading, no-DB-change precedent), D-09 (branch-after-hard-stop discipline)
- `.planning/phases/63-offline-intent-classification/63-REVIEW.md` — **WR-01** (source-agnostic threading — MUST be closed in this phase per D-10; also WR-02's inertness-snapshot payload gap is context for D-09's conservation test)

### Code seams (live source is source of truth)
- `src/consolidation/consolidator.ts` — Phase 46 union candidate generation (:790-900: cosine ∪ anchors ∪ BM25, dedup, D-06 counters, extend-gate), hitl hard-stops (:106, :643), `ClaimDecision` interface (:151), the four intent-field fill sites (:771-773, :869-871, :895-897, :958-960 per 63-REVIEW)
- `src/db/semantic-store.ts` — `resolveEntityByName` (:519, the exact-match priority ladder + length-capped contains), entity-node queries
- `src/consolidation/normalize.ts` — `normalizeValue` (:18, the normalization the exact channel must share)
- `src/retrieval/topk.ts` — `hybridTopk` (FTS fallback precedent; BM25+dense fusion machinery if score fusion is chosen)
- `src/consolidation/entity-dedup.ts` — Phase 25 pass shaping the candidate pool
- `src/model/claim-extractor.ts` — intent-field parse/validation (:376-387 per 63-REVIEW), `ExtractedClaim` optional-field pattern

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **Phase 46 RECON union** (consolidator.ts:790-900): the exact cosine ∪ entity-anchor ∪ BM25 shape to mirror — including `ftsQueryFromText` sanitization, FTS-absent try/catch, dedup-across-channels, and per-channel counters. Phase 64 extracts this shape into a reusable seam rather than adding a third inline copy.
- **`resolveEntityByName` ladder** (semantic-store.ts:519): the shipped exact/contains entity matcher — the exact/entity-keyed channel starts here, hardened with normalization.
- **Phase 63 test patterns**: counting/fail-if-called provider stubs (zero-net-new-calls sentinel), the hitl-never-classified sentinel, and the two-pass DB-inertness comparison (note 63-REVIEW WR-02: compare ALL deterministic columns, not one privileged column).

### Established Patterns
- Sleep pass is sole graph writer; resolution is read-only over the graph and LLM-free (D-04).
- Optional-field threading through `ClaimDecision` (TEMP-02 → CLASSIFY-02 → now RESOLVE), backward-compatible by absence.
- Convention-enforced invariants fail (six bypasses in Phase 62 alone) — hence structural tests for never-dense-only, source-gating, and read-only, not prose.
- Dark-knob config convention (`bm25CandidateK=0` reproduces old behavior) — floor/margin knobs follow it.

### Integration Points
- `consolidate()` per-episode loop, strictly after the :643 hard-stop, on decisions carrying intent fields — the ONLY place the resolution branch may live.
- `ClaimDecision` (consolidator.ts:151) — where the two resolved-entity fields sit, beside the intent fields.
- Downstream (not this phase): Phase 65 consumes the resolved entity for belief-gated drift; Phase 66 carries `{recense_node_id, descriptor}` into the proposal contract; Phase 69 reuses the union generator for retrieval anchoring.

</code_context>

<specifics>
## Specific Ideas

- "Never let 'closest' stand in for 'correct'" (Pitfall 4) — the abstain path is a hard prerequisite of this phase, not hardening to add after an incident. Err toward abstention in every tie-break.
- The two-different-resolutions insight (ARCHITECTURE Q4): this phase solves recense's INTERNAL resolution (descriptor → own graph node); the EXTERNAL question (which jobfill row) is deliberately not recense's problem and must not leak in.
- Same-company multi-role granularity (Pitfall 4 failure mode 3: "Stripe — Backend" vs "Stripe — Platform" merged into one "Stripe" node by entity-dedup) — the planner should note this as a KNOWN precision limit of resolving against the dedup'd graph; if both map to one node, resolution to that node is honest, and per-role splitting is a Phase 65+ concern if measurement demands it. Do not "fix" entity-dedup in this phase.

</specifics>

<deferred>
## Deferred Ideas

- Consumer-ID mirror channel (ARCHITECTURE Q4 option (b)) — higher-precision hardening path; v11 SEED behind a measured trigger, explicitly out of v10.0 scope.
- LLM disambiguation tier for too-close-to-call candidates — deferred until DRIFT-05 measurement shows deterministic precision insufficient (D-04).
- Confidence → PE-magnitude mapping, lifecycle-lattice awareness, provenance distinctness — Phase 65.
- `action_proposal` table / `ActionProposalSink` / routes — Phase 66.
- Entity-anchored ambient recall reusing this generator (+ the D-S1 reversal record) — Phase 69.
- Per-role entity granularity under one company node — revisit only on measured mis-attribution (see Specifics).

### Reviewed Todos (not folded)
All four pending todos matched at score 0.6 on generic keywords only (`system`, `phase`, `status`, `hardening`) — the same keyword-noise matches Phase 63 already reviewed. None folded:
- `2026-06-23-cache-constant-judge-extraction-prompt-prefix-via-system-pro.md` — prompt-prefix caching; Phase 64 changes no prompts (resolution is LLM-free). Stays pending.
- `content-hardening-deferred.md` — gmail extraction-prompt coverage boundary; no prompt work in this phase. Stays pending.
- `corpus-brain-3d-transition.md` — viz camera transition; unrelated. Stays pending.
- `viz-search-and-hull-quality.md` — viz search/hull; unrelated. Stays pending.

</deferred>

---

*Phase: 64-Entity Resolution Hardening*
*Context gathered: 2026-08-02*
