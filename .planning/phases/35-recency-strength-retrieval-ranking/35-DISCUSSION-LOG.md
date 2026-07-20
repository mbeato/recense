# Phase 35: Recency/Strength-Weighted Retrieval Ranking - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-20
**Phase:** 35-recency-strength-retrieval-ranking
**Areas discussed:** Fusion mechanism, Default posture, Success bar (RANK-02), Path scope

---

## Fusion mechanism

| Option | Description | Selected |
|--------|-------------|----------|
| 3rd RRF list (weighted) | Add a strength-ranked list to `rrfFuse([cosine, bm25, strength])` with a tunable weight on its `1/(k+rank)` contribution. Rank-based, scale-agnostic, reuses existing `rrfFuse`. | ✓ |
| Post-RRF blended score | Keep `rrfFuse([cosine,bm25])`, then re-rank `final = rrf_score + w·normalize(effective_s)`. More direct knob but scale-fragile. | |
| You decide | Defer mechanism to research/planner. | |

**User's choice:** 3rd RRF list (weighted)
**Notes:** User asked what RRF is; after explanation, agreed the post-RRF blend is the worse option (scale reconciliation). Locked sub-decision: strength list sourced ONLY from the existing cosine/BM25 candidate pool, so strength can only re-order relevant candidates and never inject an off-topic high-strength node.

### Sub-area: Signal shape

| Option | Description | Selected |
|--------|-------------|----------|
| effective_s only | One list ranked by `effective_s = s·exp(−λ·Δt)` — recency already baked in via decay (mirrors cue-less D-24 caveat, `w_r=0`). One knob. | ✓ |
| effective_s + separate recency | Two lists/two knobs; expressive (boosts fresh-but-weak) but double-counts Δt. | |

**User's choice:** effective_s alone, keep one knob
**Notes:** Confirmed "fresh-but-weak should still surface" is not a needed behavior; "strong-and-recent in one number" is enough.

---

## Default posture

| Option | Description | Selected |
|--------|-------------|----------|
| OFF (w=0) | Ships dark — default reproduces today's `[cosine, bm25]` ranking; tune `w` up only after eval proves a win, then flip default in a follow-up. | ✓ |
| Small conservative ON | Ships with a small default (~0.3) so strength nudges out of the box; regression risk lands on live recall. | |
| Eval picks the default | Whatever wins the sweep becomes the shipped default — recall changes at merge. | |

**User's choice:** ship the default at 0, prove it in eval
**Notes:** Agent clarified OFF vs eval-picks aren't mutually exclusive — OFF = committed default value; eval still sweeps and reports the winning value. User wants the mechanism proven but dormant until a deliberate later flip.

---

## Success bar (RANK-02)

| Option | Description | Selected |
|--------|-------------|----------|
| Token-saving | Equal answer quality at a smaller inject budget (the headline phase goal). | |
| Precision | Higher top-k judge accuracy at the same budget. | |
| Either, whichever wins | Run both measurements; pass if either wins with no regression on the other. | ✓ |

**User's choice:** Either, whichever wins

### Sub-area: No-regression bar

| Option | Description | Selected |
|--------|-------------|----------|
| Small tolerance band | Non-winning metric may dip within eval noise (~1–2 pts / run-to-run variance); winning metric must clear the band decisively. | ✓ |
| Strict (no dip at all) | Non-winning metric must be ≥ baseline; risks failing on judge variance. | |
| You decide | Let planner/eval set tolerance from measured variance. | |

**User's choice:** Small tolerance band

---

## Path scope

| Option | Description | Selected |
|--------|-------------|----------|
| Cue-based only | Apply only to `retrieveRanked`/`hybridTopk` (memory_ask, Telegram, ambient, serve); leave `retrieveCueless`/SessionStart untouched. | ✓ |
| Unify both paths | Reconcile cue-less + cue-based under one mechanism/knob. | |

**User's choice:** Cue-based only
**Notes:** User initially chose "unify," then asked what SessionStart inject is even for. Agent explained `retrieveCueless` is the ambient prior at turn 0 (the `[keep]` lines in the session's own SessionStart context are its output) — a distinct purpose, already strength-ranked. Agent surfaced two blockers to a naive unify: (1) RRF needs ≥2 lists but cue-less has only a strength list (nothing to fuse against); (2) a single shared knob defaulting to 0 would regress cue-less's live `w_s=1.0`. Also noted there's no real duplication — `effective_s` already lives in one shared helper. User concluded the surgical cue-based-only change is correct.

---

## Claude's Discretion

- Exact `w` sweep grid.
- `candidateK`/preK candidate-pool sizing (keep current unless the sweep shows the pool starves the strength signal).
- New config knob name (suggested `rankStrengthWeight`).

## Deferred Ideas

- Flipping the activated default (raise `w` from 0 to the eval-winning value on the live hot path) — a separate step after the win is proven.
- Unifying cue-less + cue-based ranking under one mechanism — rejected as scope creep / rewrite of the working SessionStart path.
- Separate fresh-but-weak recency boost (distinct `last_access` list/knob) — only if dogfood later shows `effective_s` alone misses fresh-session recall (standing D-24 caveat).
