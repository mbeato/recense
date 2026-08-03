---
phase: 65-belief-gated-status-drift-provenance-distinctness-fix
verified: 2026-08-03T05:20:00Z
status: human_needed
score: 5/5 must-haves verified
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 3/5
  gaps_closed:
    - "DRIFT-04 — Out-of-order evidence (e.g. a rejection processed after an offer during backfill) does not silently revert a newer status"
  gaps_remaining: []
  regressions: []
deferred: []
human_verification:
  - test: "Phase 65 Plan 65-10 Task 3: review the DRIFT-05 dry-run harness against a real multi-inbox export and record an ENABLE/HOLD decision for provenanceDistinctnessEnabled"
    expected: "Founder exports a real multi-email status-thread sample as JSONL, runs `npm run eval:drift05 -- --inbox <path>`, reviews the four verification questions in 65-10-PLAN.md's how-to-verify section, and records ENABLE (optionally with revised knob values) or HOLD (naming the blocking observation) in a revision of 65-10-SUMMARY.md"
    why_human: "Requires a real Gmail export + a real API key (ANTHROPIC_API_KEY/OPENAI_API_KEY) — cannot be automated or substituted with synthetic data per D-14's dark-launch discipline. This is the designed pre-decision state, not an oversight: the knob (provenanceDistinctnessEnabled) correctly remains false pending this review."
  - test: "During the same Task 3 review, evaluate REVIEW.md WR-01 before flipping provenanceDistinctnessEnabled: the composed key's real farming bar is one sender domain + N freely-mintable Gmail threads (every fresh Subject/no-In-Reply-To starts a new thread), not 'N domains' as provenance-key.ts's own rationale comment claims"
    expected: "Either (a) correct the in-file rationale comments in provenance-key.ts and gmail-adapter.ts to state the real bar, and decide whether to drop threadId from the key or raise contradictionNBySource.gmail to price in thread-minting cost, before enabling — or (b) explicitly accept the residual risk in the enablement record with the corrected threat model stated"
    why_human: "This is a judgment call about acceptable risk for a load-bearing correctness mechanism (per CONTEXT D-02's own 'same caution class as GMAIL_EXTRACTION_PROMPT changes' framing) — not something a grep-based verifier can resolve. Since provenanceDistinctnessEnabled is currently false, this does not block phase closure, but it does directly inform the enablement decision Task 3 is the gate for. Re-confirmed still unaddressed in this re-verification pass (source comment at provenance-key.ts:19 unchanged)."
  - test: "During the same Task 3 review, note REVIEW.md WR-03: stripQuotedForwarded (src/source/strip-quoted.ts) violates its own documented idempotence guarantee for ≥4-space-indented quote lines, and leaks an entire un-'>'-prefixed indented quoted body into the residual when the attribution/forward-marker line itself is indented ≥1 space (boundary regexes are anchored at column 0 with zero leading-space tolerance while QUOTE_LINE_RE tolerates 3 spaces)"
    expected: "Confirmed by direct execution during this verification: stripQuotedForwarded('    > x') !== stripQuotedForwarded(stripQuotedForwarded('    > x')) ('> x' vs ''). Decide whether to fix before enablement (both defects resolve toward MORE residual — the over-count/farming direction the module's own asymmetry doctrine forbids) or accept as a residual risk given the feature ships dark."
    why_human: "Judgment call on acceptable pre-enablement risk for the D-06 farming guard, same class as WR-01. Re-confirmed still unaddressed in this re-verification pass (`once='> x'`, `twice=''` reproduced again against current `dist/`)."
---

# Phase 65: Belief-Gated Status Drift + Provenance-Distinctness Fix Verification Report

**Phase Goal:** Status transitions for a tracked entity update through the existing PE-gated belief machinery completely unmodified, and email evidence can finally satisfy (or correctly fail to satisfy) the distinct-provenance mechanism the differentiator depends on — closing the gap where every Gmail episode today shares one literal `session_id`, making `countDistinctProvenance` mathematically unreachable on email-only evidence.
**Verified:** 2026-08-03T05:20:00Z
**Status:** human_needed
**Re-verification:** Yes — after gap closure (Plan 65-11, commits `2150c80`/`d10ca0d`/`1b03628`)

## Re-Verification Note

The prior pass (`gaps_found`, 3/5, 2026-08-03T04:46:12Z) found DRIFT-04 FAILED via a standalone reproduction test. That gap is now closed by Plan 65-11. This pass re-ran the exact same reproduction methodology against the fixed code.

**Self-correction disclosed:** on first re-run, my original repro fixture still reproduced the revert against the *fixed* code, which was surprising. Investigation found the fixture's contradicting claim was missing `intent_confidence`, which makes `StatusDrift.evaluate()` short-circuit to `staleness: 'not-applicable'` before ever consulting the event_ts guard (by design — "structural no-op for every decision without intent confidence," `status-drift.ts` header) — so the original repro was accidentally bypassing the drift layer entirely on both runs, not exercising the `SUPPORTING_EVENT_TYPES` logic the gap and fix are about. This means the ORIGINAL gaps_found verdict, while directionally correct (independently corroborated by `65-REVIEW.md` WR-02's from-first-principles source analysis, and by reading `consolidator.ts`'s `'unrelated'` branch directly), was backed by an invalid reproduction. Corrected fixture (with `intent_status`/`intent_entity`/`intent_confidence: 'high'` set on the contradicting claim, matching the pattern every other e2e fixture in `tests/drift-belief-correction-e2e.test.ts` already uses) was bisected against both the pre-fix and post-fix source:

- Against `d10ca0d~1` (pre-fix `status-drift.ts`, restored via `git show`, run, then reverted): **RED** — `tombstoned: 1`, offer silently reverted by the stale rejection.
- Against current `HEAD` (post-fix): **GREEN** — `tombstoned: 0`, `value` unchanged, zero new `consolidation_event` rows for the stale rejection (dropped, not held).

The corrected reproduction test was written, executed both ways, and deleted (not committed) — same discipline as the original pass.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | DRIFT-01: Status lifecycle is an ordinary fact node, updated only through the unmodified `routeContradiction()`/tombstone/`supersedes` machinery — no new data model, no bi-temporal or supersedes-chain columns | ✓ VERIFIED | `git diff` confirms `src/consolidation/update-decision.ts`, `src/consolidation/consolidator.ts`, `src/db/schema.ts`, `src/lib/config.ts` are byte-unchanged by Plan 65-11 (`git diff a8b6ab0..HEAD --stat -- src/` shows only `status-drift.ts` touched). `tests/pe-machinery-lock.test.ts` still passes. |
| 2 | DRIFT-02: A single ambiguous status email holds rather than flipping the belief, and a held update produces no downstream proposal | ✓ VERIFIED | Unchanged from prior pass — `tests/drift-belief-correction-e2e.test.ts`, `tests/emission-hold-sentinel.test.ts` both re-confirmed passing. |
| 3 | DRIFT-03: Provenance distinctness for email evidence is derived from sender identity + thread lineage with quoted/forwarded content stripped first — 3 independent emails count as 3 distinct provenances, 3 forwards of one thread count as 1 | ✓ VERIFIED (see human_verification) | Unchanged from prior pass — `tests/provenance-key.test.ts`, `tests/drift-belief-correction-e2e.test.ts` re-confirmed passing. WR-01 (farming-bar accuracy) re-confirmed still present in `provenance-key.ts:19` and remains a Task-3-review item, not a blocker (feature is dark by default). |
| 4 | DRIFT-04: Out-of-order evidence (a rejection processed after an offer during backfill) does not silently revert a newer status | ✓ **VERIFIED (gap closed)** | `'unrelated'` added to `SUPPORTING_EVENT_TYPES` (`src/consolidation/status-drift.ts:160-168`) so a cold-start standalone mint's founding event now counts as supporting evidence for the staleness horizon. Re-confirmed via a bisected reproduction (RED pre-fix / GREEN post-fix, see Re-Verification Note above). New unit coverage in `tests/status-drift.test.ts` (drop/ok/cross-node-isolation/MAX-composition cases, `SUPPORTING_EVENT_TYPES.size === 7`) and new e2e cases in `tests/drift-belief-correction-e2e.test.ts` (`establishBeliefColdStart()` / `assertColdStartMint()`, a stale-backfill-vs-cold-start-mint case plus a chronological control) both pass and exercise exactly the path the original gap fell through. |
| 5 | DRIFT-05: Belief-correction accuracy on real multi-inbox traffic is measured and recorded honestly against recense's own harness, with no external accuracy bar cited, before Phase 66 wires any consumer live | ✓ VERIFIED (harness/process complete) — human decision pending | Unchanged from prior pass — harness re-confirmed still runs and matches `65-10-SUMMARY.md`'s numbers. `65-10-SUMMARY.md`'s own key-decision note confirms re-running the harness post-65-11-fix reproduces the same `eventTsUnknown=26`/`staleDropped=2` figures unchanged (its synthetic founding episodes are undated by design, so this fix doesn't move that harness's numbers). Task 3's ENABLE/HOLD decision remains open by design — see human_verification. |

**Score:** 5/5 must-haves verified. Three items (Task 3's ENABLE/HOLD decision, WR-01, WR-03) are correctly gated as human decisions rather than automation gaps — none of the three are new; all three were already open before this re-verification and remain open, none regressed.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/consolidation/status-drift.ts` | Drift layer: damping, staleness guard, emission-eligibility | ✓ VERIFIED | `SUPPORTING_EVENT_TYPES` now includes `'unrelated'` with a corrected doc comment explicitly naming the DRIFT-04/WR-02 history; `EMISSION_ELIGIBLE_EVENT_TYPES` unaffected (still size 3, `contradict_hold` never eligible) |
| `tests/status-drift.test.ts` | Unit coverage of all guarantees | ✓ VERIFIED | New assertions: `SUPPORTING_EVENT_TYPES.has('unrelated') === true`, `.size === 7`; drop/ok pair and cross-node-isolation control for the cold-start path; all pass |
| `tests/drift-belief-correction-e2e.test.ts` | DRIFT-02/03/04 e2e proof | ✓ VERIFIED | Now covers both the `'extend'`-minted path (pre-existing) and the genuine `'unrelated'` cold-start path (new, via `establishBeliefColdStart()`/`assertColdStartMint()`), with a chronological control proving the guard discriminates on time, not content, for the new path too |
| `src/consolidation/consolidator.ts` | Drift layer wired at both contradict branches | ✓ VERIFIED | Byte-unchanged by 65-11 (confirmed via `git diff a8b6ab0..HEAD --stat`) — the fix is entirely inside `status-drift.ts`, consistent with the plan's "one-member set change" framing |

All other artifacts from the prior pass are unchanged and remain VERIFIED (see prior pass's full artifact table, preserved in git history of this file for the record — not restated here since nothing else moved).

### Key Link Verification

Unchanged from the prior pass — all links previously WIRED remain WIRED; no new key links were introduced by the narrow 65-11 fix (a one-member `Set` literal change plus test-only additions).

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Full suite | `npx vitest run` | 220 files passed / 1 skipped; **3714** tests passed / 6 expected-fail / 3 skipped — exact match to the coordinator's claimed post-fix state (was 3708 pre-fix; +6 new tests from 65-11) | ✓ PASS |
| Typecheck clean | `npx tsc --noEmit` | exit 0 | ✓ PASS |
| Engine files byte-unchanged by the fix | `git diff a8b6ab0..HEAD --stat -- src/consolidation/update-decision.ts src/consolidation/consolidator.ts src/db/schema.ts src/lib/config.ts` | zero output (no changes) | ✓ PASS |
| **DRIFT-04 cold-start out-of-order revert — corrected reproduction, bisected** | Standalone repro (written, run against pre-fix commit `d10ca0d~1`, run against post-fix `HEAD`, then deleted) | Pre-fix: `tombstoned: 1` (reverts, RED). Post-fix: `tombstoned: 0`, value unchanged, zero new `consolidation_event` rows for the stale claim (dropped, GREEN) | ✓ PASS |
| WR-01 still unaddressed (expected — human decision item, not a regression) | `grep -n "reduces that to controlling N domains" src/source/provenance-key.ts` | 1 match, unchanged | (expected, tracked as human_verification) |
| WR-03 still unaddressed (expected — human decision item, not a regression) | `stripQuotedForwarded('    > x')` twice via `node -e` against current `dist/` | `once='> x'`, `twice=''` — still not idempotent, unchanged | (expected, tracked as human_verification) |
| Debt markers in the fix's files | `grep -n -E "TBD\|FIXME\|XXX" src/consolidation/status-drift.ts tests/status-drift.test.ts tests/drift-belief-correction-e2e.test.ts` | zero matches | ✓ PASS |

### Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
|-------------|-----------------|--------------|--------|----------|
| DRIFT-01 | 65-05, 65-07, 65-08, 65-09 | Status lifecycle rides unmodified PE machinery | ✓ SATISFIED | pe-machinery-lock.test.ts, git diff confirms engine files untouched by 65-11 |
| DRIFT-02 | 65-03, 65-05, 65-08, 65-09 | Ambiguous email holds, no downstream proposal | ✓ SATISFIED | emission-hold-sentinel.test.ts, drift-belief-correction-e2e.test.ts |
| DRIFT-03 | 65-01, 65-02, 65-03, 65-04, 65-06, 65-07 | Provenance-distinctness key, farming-resistant | ✓ SATISFIED (with enablement-time caveat WR-01, unchanged) | provenance-key.test.ts, drift-belief-correction-e2e.test.ts |
| DRIFT-04 | 65-03, 65-05, 65-06, 65-08, 65-09, **65-11** | Out-of-order evidence cannot silently revert | ✓ **SATISFIED (gap closed)** | status-drift.ts fix, status-drift.test.ts, drift-belief-correction-e2e.test.ts cold-start cases, re-verified by bisected reproduction |
| DRIFT-05 | 65-10 | Honest belief-correction measurement before Phase 66 | ✓ SATISFIED (harness) — human decision pending | Harness built/green; Task 3 founder decision remains the correctly-surfaced open item |

No orphaned requirements: all five DRIFT-01..05 IDs declared in ROADMAP.md and REQUIREMENTS.md are claimed by at least one plan's `requirements:` frontmatter field (now including 65-11 for DRIFT-04).

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/source/strip-quoted.ts` | 48, 57, 64, 67, 156 | Boundary regexes anchored at column 0 while `QUOTE_LINE_RE` tolerates 3 leading spaces; final `.trim()` can create new column-0 quote context | ⚠️ Warning | WR-03 — re-confirmed by execution this pass; over-count/farming-direction leak, inert while `provenanceDistinctnessEnabled` is dark; unchanged, tracked as human_verification |
| `src/source/provenance-key.ts` | 17-24 | In-file rationale claims farming bar is "N domains"; composed key's actual bar is "1 domain + N mintable threads" | ⚠️ Warning | WR-01 — re-confirmed unchanged this pass; tracked as human_verification |
| `scripts/eval/drift-05-dry-run.cjs` | 236-250 | `computeMagnitudeForAction('reconcile', ...)` does not divide the target ratio by the confidence-damping factor | ℹ️ Info | WR-04 in REVIEW.md — eval-harness-only, unchanged, does not affect shipped `src/` behavior |
| (none — previously listed BLOCKER on `status-drift.ts:143-150` is resolved) | — | `SUPPORTING_EVENT_TYPES` now includes `'unrelated'` | — | Closed by Plan 65-11 |
| (none) | — | TBD/FIXME/XXX debt markers | — | None found in any phase-modified file, including the new 65-11 files |

## Human Verification Required

Unchanged from the prior pass — three items, all correctly gated on the still-open Plan 65-10 Task 3 checkpoint, none of which are automatable and none of which are new regressions:

1. **Task 3 ENABLE/HOLD decision** — requires a real Gmail export and a real API key; cannot be automated. Designed pre-decision state, not a gap.
2. **WR-01 review** (farming-bar accuracy) — judgment call on acceptable risk before flipping `provenanceDistinctnessEnabled`; non-blocking while the knob is dark.
3. **WR-03 review** (quote-stripper idempotence/indentation defects) — same class, non-blocking while dark.

## Gap Closure Summary

The one BLOCKER from the prior pass — **DRIFT-04 not closed for the cold-start (`'unrelated'`-minted) path** — is now closed by Plan 65-11 (commits `2150c80` RED / `d10ca0d` GREEN / `1b03628` e2e regression). The fix is exactly as narrow as the prior verification's `missing:` list specified: a one-member addition to `SUPPORTING_EVENT_TYPES`, an inverted+extended locked-exclusion test, and a new e2e case exercising the genuine cold-start mint path the existing suite structurally could not reach. All four PE-machinery engine files (`update-decision.ts`, `consolidator.ts`, `schema.ts`, `config.ts`) remain byte-unchanged, preserving DRIFT-01's "unmodified machinery" guarantee.

This re-verification did not merely trust the coordinator's summary or `65-REVIEW.md`'s prose: the closure was independently re-derived by writing a standalone reproduction, discovering and correcting a flaw in the original reproduction's own fixture (a missing `intent_confidence` field that caused the drift layer to no-op regardless of the bug under test — self-disclosed above), and then bisecting the corrected reproduction against both the pre-fix and post-fix commits to confirm it genuinely discriminates (RED before, GREEN after). The full test suite (3714 passed / 6 expected-fail / 3 skipped) and `tsc --noEmit` were both independently re-run and match the coordinator's claimed state exactly.

No new gaps were introduced. The three remaining human_verification items are unchanged from the prior pass, are not automatable, and do not block phase closure — they gate the separate, already-flagged Task 3 enablement decision. **Status is `human_needed`, not `passed`, solely because those three items exist** — every automatable must-have now verifies clean.

---

*Verified: 2026-08-03T05:20:00Z*
*Verifier: Claude (gsd-verifier)*
