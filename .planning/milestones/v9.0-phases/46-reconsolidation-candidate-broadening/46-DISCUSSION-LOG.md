# Phase 46: Reconsolidation Candidate Broadening - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.
>
> Resolved in `--auto` mode: every area auto-selected its recommended default (first/recommended option). No interactive prompts.

**Date:** 2026-06-27
**Phase:** 46-reconsolidation-candidate-broadening
**Areas discussed:** BM25 query text, Union assembly & dedup, Candidate-count knobs, Auto-unrelated gate, Subject-keyed scope, Instrumentation, Default/dark-knob behavior

---

## BM25 query text (D-01 / D-03)

| Option | Description | Selected |
|--------|-------------|----------|
| `ftsQueryFromText(claim.value)` | Reuse existing FTS5 sanitizer; lexical match over claim value only | ✓ (recommended) |
| claim.value + links/entities | Concatenate links/entity tokens into the MATCH query | |
| extracted subject keys only | Match on subject keys rather than full value | |

**Choice:** claim.value via existing sanitizer.
**Notes:** Entity/link overlap already covered by the M1 anchor path; BM25 stays a pure lexical pass to avoid double-counting. `bm25CandidateK` default 5, mirroring `candidateK`/`entityAnchorK`.

---

## Union assembly & dedup ordering (D-02)

| Option | Description | Selected |
|--------|-------------|----------|
| cosine → anchors → bm25, deduped by id, unranked | Precedence-for-dedup; judge does the screening | ✓ (recommended) |
| RRF-fuse all three sources then top-k | Rank the union before the judge | |

**Choice:** cosine → anchors → bm25, deduped, unranked.
**Notes:** Preserves D-17 fast-path precedence and current anchor behavior; BM25 only adds nodes the others missed. No fusion in candidate-gen — that's Phase 47's online concern.

---

## Auto-unrelated gate interaction (D-04)

| Option | Description | Selected |
|--------|-------------|----------|
| BM25 hit rescues into judge | auto-unrelated fires only when low-cosine AND no anchors AND no BM25 | ✓ (recommended) |
| Keep gate cosine+anchor only | BM25 candidates added but gate unchanged | |

**Choice:** BM25 hit rescues into judge escalation.
**Notes:** The load-bearing change — lets the judge see the cosine-0.48 contradiction it currently auto-drops. Without it, broadening the union has no effect on judge-fire rate.

---

## Subject-keyed lookup scope (D-05)

| Option | Description | Selected |
|--------|-------------|----------|
| Reuse M1 anchors + BM25 only | No new subject-hub traversal this phase | ✓ (recommended) |
| Add subject-hub graph traversal | New candidate source over corpus/subject hubs | |

**Choice:** Reuse M1 anchors + BM25 lexical only.
**Notes:** BM25 over `node_fts` already captures subject-keyed lexical overlap on fact nodes; subject hubs are doc/corpus nodes the judge doesn't screen. Subject-hub traversal kept as documented fallback if RECON-03 still reads zero.

---

## Instrumentation (D-06)

| Option | Description | Selected |
|--------|-------------|----------|
| Source + judge-fire counters in run summary | Observability only, never gates behavior | ✓ (recommended) |
| No new counters | Rely on existing logs | |

**Choice:** Add candidate-source + judge-fired-on-contradiction counters.
**Notes:** RECON-03 ("judge fires >0") is verified from these counters — the phase's pass/fail signal.

---

## Default / dark-knob behavior (D-07)

| Option | Description | Selected |
|--------|-------------|----------|
| ON by default, `bm25CandidateK=0` reproduces old behavior | Ship-on-but-zeroable for A/B | ✓ (recommended) |
| Dark-launch behind a flag | Default OFF, opt-in | |

**Choice:** ON by default; `bm25CandidateK=0` is the isolation switch.
**Notes:** Judge fires zero today — there is nothing to regress against by shipping ON. Zeroable knob gives clean A/B and regression isolation, mirroring the existing `w=0` dark-RRF pattern.

---

## Claude's Discretion

- Exact insertion site of the BM25 fetch (~`consolidator.ts:754`), config placement of `bm25CandidateK` (~`config.ts:773-790`), counter naming.

## Deferred Ideas

- Subject-hub graph traversal as a distinct candidate source — only if BM25 insufficient for RECON-03.
- DEO-style negation-aware query rewrite — revisit only if candidate broadening proves insufficient.
- Cache constant judge/extraction prompt prefix via `--system-prompt` (`todos/2026-06-23-...`) — adjacent cost optimization (P46 raises judge-call volume), independent of candidate broadening; not in scope.
