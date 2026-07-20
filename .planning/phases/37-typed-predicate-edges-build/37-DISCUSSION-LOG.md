# Phase 37: Typed Predicate Edges — Build - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-20
**Phase:** 37-typed-predicate-edges-build
**Areas discussed:** Gate verification, Edge-model representation, Extraction integration + metric, Recall traversal shape, Query→predicate matching

---

## Gate verification (precondition)

Phase 37 is explicitly gated on a Phase 36 go/no-go. The Phase 36 dir held only CONTEXT.md + DISCUSSION-LOG.md (discussed, not executed), and STATE.md showed live focus still on Phase 35 — so the gate appeared unsatisfied. Surfaced this before discussing.

**User's choice:** "Spike already happened" — pointed outside `.planning/phases/`.
**Notes:** Located the spike at `.planning/spikes/004-typed-predicate-edges/`. README carries a founder **GO (2026-06-20)** resting on the precision axis (+22–30pts), not reachability (+5.3 @ K=20). Gate confirmed satisfied; discussion proceeded.

---

## Edge-model representation

| Option | Description | Selected |
|--------|-------------|----------|
| Reuse `rel` field | Predicate in existing free-text `rel` on `kind='relation'` edges, no migration | ✓ |
| Dedicated `predicate` column | Indexed column + edge_v13 migration | |
| Promote into `kind` enum | Each predicate a first-class EdgeKind | |

**User's choice:** Reuse `rel` field.
**Notes:** User asked whether a `predicate` column would "kill the need for 2 rows." Checked the spike code: there were never 2 stored rows — the untyped control was the same edge with `rel` ignored at traversal time (`02-extract.ts:12`), a measurement artifact. Live engine is one edge per relation regardless, and `rel` already exists — so the column buys only an (unneeded at ~7k nodes) index, not row reduction. User: "lock it."

---

## Extraction integration

| Option | Description | Selected |
|--------|-------------|----------|
| Fold into existing call | Extend `EXTRACTION_PROMPT` to emit facts + triples in one Haiku call | ✓ |
| Separate second call | Keep the spike's distinct triple prompt as a second call (~2× cost) | |
| You decide | Defer to planning | |

**User's choice:** Fold into existing call.
**Notes:** Gated behind a fact-quality regression check (D-03) so the heavier prompt doesn't degrade fact extraction; separate-call is the fallback.

---

## Merge gate / metric

| Option | Description | Selected |
|--------|-------------|----------|
| Deterministic precision primary | nodes-to-answer / top-3, LLM-judge secondary | ✓ |
| LLM-judge primary | Judge as product truth, precision as sanity check | |
| Both must pass | Strictest; noisy judge could veto a real deterministic win | |

**User's choice:** Deterministic precision primary.
**Notes:** Matches what the GO actually rested on. Re-derive the query set with founder sign-off before the gate binds (spike caveat).

---

## Cost lever (thinking on/off)

| Option | Description | Selected |
|--------|-------------|----------|
| Defer to Phase 42 | Note as a deferred token-efficiency lever | ✓ |
| In scope for Phase 37 | Evaluate thinking-off as part of this phase | |

**User's choice:** Defer to Phase 42.
**Notes:** Flipping the thinking default affects ALL extraction; belongs in the dedicated token-efficiency phase with its own baseline-before-optimize.

---

## Recall traversal shape

| Option | Description | Selected |
|--------|-------------|----------|
| Augment with fallback | Confident match → typed path; else schema neighborhood unchanged | ✓ |
| Parallel + RRF merge | Always run both, blend | |
| Replace neighborhood | Typed-path primary, drop neighborhood | |

**User's choice:** Augment with fallback.
**Notes:** One mode per query — never path *plus* neighborhood, or the small-payload token win is erased.

---

## Query→predicate matching (online, LLM-free)

| Option | Description | Selected |
|--------|-------------|----------|
| Embedding-match predicate glosses | Sleep-embed glosses; cosine vs the already-embedded query; tunable threshold | ✓ |
| Keyword/pattern map | Hand-authored keyword→predicate rules | |
| Lock constraint, defer mechanism to research | Lock constraints, let researcher pin design | |

**User's choice:** Embedding-match predicate glosses.
**Notes:** Reuses the existing online query embedding (no new online LLM/embedding cost); threshold = the confidence knob from the recall-shape decision. v1 is single-predicate-from-anchor; gloss wording, threshold value, and multi-hop chaining delegated to the phase researcher.

---

## Claude's Discretion

- Exact gloss wording per predicate, the cosine threshold value, and multi-hop path handling → phase researcher.
- Whether folding lands as a single merged or sectioned prompt → planning, subject to the fact-quality gate.

## Deferred Ideas

- Thinking-on/off extraction cost lever → Phase 42 (token efficiency).
- Multi-hop predicate chaining → research/follow-on (v1 is single-predicate-from-anchor).
- Predicate granularity refinement beyond the 12-vocab → future lever (spike q02 finding).
- Dedicated indexed `predicate` column → revisit only if traversal proves too slow at larger scale.
