# Phase 35: Recency/Strength-Weighted Retrieval Ranking - Context

**Gathered:** 2026-06-20
**Status:** Ready for planning

<domain>
## Phase Boundary

Fuse a belief-strength/recency signal (`effective_s`, which already encodes recency
via decay) into the **cue-based** retrieval ranking so a strongly-reinforced recent
belief outranks a stale weak one at equal semantic similarity — improving
quality-per-injected-token. The signal sits behind a **tunable weight**, the online
path stays **LLM-free**, and the change is **eval-backed** (no regression + a token or
precision win on the existing KU/LongMemEval replay harness).

**The gap:** the cue-based path `retrieveRanked` → `hybridTopk`
(`src/retrieval/engine.ts:388`, `src/retrieval/topk.ts:181`) ranks purely by
`rrfFuse([cosine, bm25])` + a cosine floor gate. It has **no strength/recency term**.
The cue-less SessionStart path `retrieveCueless` (`engine.ts:195`) already ranks by
`effective_s` — it is explicitly **out of scope** here.

**In scope:** strength fusion in `retrieveRanked`/`hybridTopk` only.
**Out of scope:** any change to `retrieveCueless`/SessionStart inject; the schema-prior
`RecallEngine.recall` LLM path; new embedders/retrievers; multi-tenancy.

</domain>

<decisions>
## Implementation Decisions

### Fusion mechanism (RANK-01 core)
- **D-01: Third weighted RRF list.** Add a strength-ranked list to the existing
  fusion: `rrfFuse([cosineList, bm25List, strengthList])`. The strength list
  contributes a *weighted* reciprocal-rank term — `score += w · 1/(k+rank)` for the
  strength list — so the signal stays **rank-based and scale-agnostic** (no
  normalization needed, reusing the existing `rrfFuse` primitive at `topk.ts:58`).
  Rejected: post-RRF blended score (`rrf_score + w·normalize(effective_s)`) because it
  reintroduces the score-scale reconciliation RRF exists to avoid.
- **D-02: Strength list drawn ONLY from the existing candidate pool** (the union of
  the cosine preK and BM25 preK hits), not the whole graph. Consequence: the strength
  term can only **re-order already-relevant candidates** — it can never pull an
  irrelevant high-strength node into the results. This is a load-bearing correctness
  property (keeps a strong-but-off-topic belief from being injected).

### Signal shape
- **D-03: Rank by `effective_s` alone.** `effective_s = s·exp(−λ·Δt since last_access)`
  already folds recency into one number — mirrors the cue-less path's D-24 caveat,
  where `rankWeightR` is held at `0.0` precisely to avoid double-counting Δt
  (`config.ts:312-318`). **One signal, one knob.** No separate `last_access` recency
  list. (Tradeoff knowingly accepted: a *fresh-but-weak* belief is not specially
  boosted — "strong AND recent in one number" is sufficient.)

### Default posture
- **D-04: Ship the default weight at `w = 0` (dark).** The committed default
  reproduces today's exact `[cosine, bm25]` ranking — **zero behavior change on the
  hot path** at merge. The phase's job is to build the mechanism and *prove* a win;
  *activating* it (flipping the default) is a separate, later, deliberate step.
  Rationale: RANK-02 demands an eval-backed win before live recall changes.

### Success bar (RANK-02)
- **D-05: Eval sweeps `w`** over a range and **reports the winning value** (the value
  that would later become the activated default).
- **D-06: Two measurements, either-wins.** The eval runs *both* (a) token-saving —
  equal answer quality at a smaller inject budget (lower top-k / `injectionTokenBudget`)
  — and (b) precision — higher top-k judge accuracy at the same budget. The phase
  **passes if EITHER** shows a decisive win. Headline metric is whichever wins.
- **D-07: "No regression" = small tolerance band.** The non-winning metric may dip
  within run-to-run variance (~1–2 pts / within measured LLM-judge noise); the winning
  metric must clear that band decisively. Avoids failing the phase on judge variance
  rather than a real regression.

### Path scope
- **D-08: Cue-based path only.** Implement in `retrieveRanked`/`hybridTopk`. Leave
  `retrieveCueless`/SessionStart untouched — it serves a different purpose (ambient
  prior at turn 0, already strength-ranked) and works today. **No "unify" refactor**:
  the `effective_s` math already lives in one place
  (`StrengthDecayManager.effectiveStrength`, `strength/decay.ts:93`) and both paths
  already call it, so there is no duplication to consolidate. The fusion *step*
  legitimately differs between paths because their inputs differ (cue-less has no
  cosine/BM25 lists to fuse against).

### Invariants (SC3 — must hold)
- **D-09:** Scope stays **provenance-only, never a retrieval signal** (D-S1, Phase
  999.3). The strength term must not touch the scope path.
- **D-10:** The strength term **never resurfaces tombstoned nodes**. Inherited for
  free from D-02: the candidate pool comes from `topk`/`hybridTopk`, which already
  exclude tombstoned rows (`topk.ts:96-109`). The new code must not widen the pool.
- **D-11:** Online path stays **LLM-free**; **net-zero new runtime deps**.

### Claude's Discretion
- Exact `w` sweep grid (e.g. {0, 0.25, 0.5, 1.0, …}) — planner/eval choice.
- `candidateK`/preK sizing for the candidate pool — keep current unless the sweep shows
  the pool starves the strength signal.
- Config knob name (suggest `rankStrengthWeight` or similar, sibling to existing
  `rankWeightS`/`rankWeightR`).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Ranking code to modify
- `src/retrieval/topk.ts` — `rrfFuse` (L58), `hybridTopk` (L181), `topk` (L122). The
  strength list + weighted RRF lands here.
- `src/retrieval/engine.ts` §`retrieveRanked` (L388) — cue-based path; the floor gate +
  stale-entity filter the new list must compose with. §`retrieveCueless` (L195) — the
  existing `w_s·effective_s + w_r·recency` pattern + D-24 caveat (reference only; do NOT
  modify per D-08).

### Strength / config
- `src/strength/decay.ts` §`effectiveStrength` (L93) — the single shared `effective_s`
  computation; the strength list ranks by this.
- `src/lib/config.ts` L304-318 (`rankWeightS=1.0`, `rankWeightR=0.0` + D-24 caveat
  comment), L325/644 (`injectionTokenBudget=500`), L634 (`candidateK=5`). New knob added
  near these.

### Eval harness (RANK-02)
- `scripts/eval/replay-ku-harness.cjs` — KU extraction-replay, fresh scratch DB, no
  re-extraction; measures retrieve→score on cached extractions.
- `scripts/eval/longmemeval-harness.cjs` — LongMemEval-S end-to-end; `--topk` flag,
  judge-scored precision; `--probe`/`--dry-run` modes.
- `scripts/eval/longmemeval-scorer.cjs`, `scripts/eval/README.md`, `docs/evals.md`.

### Roadmap
- `.planning/ROADMAP.md` §"Phase 35" — goal + RANK-01/RANK-02 + 3 success criteria.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `rrfFuse(lists, k, topK)` (`topk.ts:58`) — already fuses N rank lists, scale-agnostic.
  Extend to accept a per-list weight (or pass the strength list and scale its
  contribution) rather than writing a new fusion path.
- `StrengthDecayManager.effectiveStrength(s, last_access, nowMs, λ)` (`decay.ts:93`) —
  pure, side-effect-free; the *only* legal strength call from the retrieval path
  (T-03-1-E). Both ranking paths already use it.
- `retrieveCueless` (`engine.ts:245-257`) — reference implementation of an `effective_s`
  rank term (with `deltaDays`/`recency` shaping) to mirror conceptually.

### Established Patterns
- RRF is **rank-only** (`topk.ts:55-57`): never normalize scores; combine by rank
  position. The chosen mechanism (D-01) preserves this.
- Cue-based ranking already separates "fusion order" from "cosine score for the floor
  gate" (`hybridTopk` returns RRF order but carries the cosine score for
  `retrieveRanked`'s floor). The strength list must not disturb the floor gate (floor
  still applies to the cosine score component, `engine.ts:402-414`).
- Tombstone exclusion is structural at the source statements (`topk.ts:96-109`); the
  strength list inherits it via the candidate pool (D-10).

### Integration Points
- `retrieveRanked` (`engine.ts:388`) is reached by memory_ask, Telegram client, ambient
  recall (`adapter/ambient-recall.ts:128`), and `brain serve` /v1/search — all pick up
  the change once `w > 0`.
- New config knob flows through `DEFAULT_CONFIG` (`config.ts:~644`) → wherever the
  retriever/engine reads weights.

</code_context>

<specifics>
## Specific Ideas

- The `[keep]` lines injected at this session's SessionStart *are* `retrieveCueless`
  output — concrete anchor for why that path is a distinct "ambient prior" and stays out
  of scope.
- Mechanism intuition the founder endorsed: strength should act as a **tiebreaker/nudge
  on relevant candidates**, not a force that overrides similarity — hence rank-based
  fusion over magnitude blending, and candidate-pool-only sourcing.

</specifics>

<deferred>
## Deferred Ideas

- **Flipping the activated default** (raising `w` from 0 to the eval-winning value on the
  live hot path) — deliberately a separate step after this phase proves the win.
- **Unifying cue-less and cue-based ranking under one mechanism** — considered and
  rejected as scope creep / a rewrite of the working SessionStart path; revisit only if a
  future need for a single shared fusion primitive emerges.
- **Separate fresh-but-weak recency boost** (a distinct `last_access` list/knob) — only if
  dogfood later shows `effective_s` alone misses fresh-session recall (the standing D-24
  caveat).

</deferred>

---

*Phase: 35-recency-strength-retrieval-ranking*
*Context gathered: 2026-06-20*
