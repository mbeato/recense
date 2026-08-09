---
phase: 65-belief-gated-status-drift-provenance-distinctness-fix
reviewed: 2026-08-03T07:45:00Z
depth: standard
files_reviewed: 30
files_reviewed_list:
  - scripts/eval/cases/drift-05-cases.json
  - scripts/eval/drift-05-dry-run.cjs
  - src/adapter/ingest-cli.ts
  - src/consolidation/consolidator.ts
  - src/consolidation/status-drift.ts
  - src/lib/config.ts
  - src/source/gmail-adapter.ts
  - src/source/provenance-key.ts
  - src/source/source-adapter.ts
  - src/source/strip-quoted.ts
  - tests/drift-05-harness-smoke.test.ts
  - tests/drift-belief-correction-e2e.test.ts
  - tests/emission-hold-sentinel.test.ts
  - tests/gmail-adapter-multiaccount.test.ts
  - tests/gmail-adapter.test.ts
  - tests/gmail-event-ts.test.ts
  - tests/gmail-future-date-ordering.test.ts
  - tests/gmail-hidden-content.test.ts
  - tests/gmail-per-account-query.test.ts
  - tests/gmail-provenance-key.test.ts
  - tests/ingest-cli-multiaccount.test.ts
  - tests/ingest-cli.test.ts
  - tests/pe-machinery-lock.test.ts
  - tests/provenance-key.test.ts
  - tests/runtime-config.test.ts
  - tests/session-id-provenance-consumers.test.ts
  - tests/status-drift-wiring.test.ts
  - tests/status-drift.test.ts
  - tests/strip-quoted.test.ts
  - tests/update-decision.test.ts
findings:
  critical: 0
  warning: 4
  info: 5
  total: 9
status: issues_found
---

# Phase 65: Code Review Report

**Reviewed:** 2026-08-03T07:45:00Z
**Depth:** standard
**Files Reviewed:** 30
**Status:** issues_found

## Summary

Reviewed the Phase 65 status-drift + provenance-distinctness implementation: the pure key
derivation (`provenance-key.ts`, `strip-quoted.ts`), the drift decision module
(`status-drift.ts`), the consolidator wiring at both contradict branches, the adapter/ingest
plumbing (`gmail-adapter.ts`, `source-adapter.ts`, `ingest-cli.ts`), the six config knobs,
the DRIFT-05 harness + case set, and all twenty test files. Field conservation across the
pipeline was traced end-to-end (adapter `provenance_key` → `ingest-cli` sessionId mint →
`episode.session_id` → `ClaimDecision.episodeSessionId` → `recordContradiction` →
`countDistinctProvenance`) and holds; the guard-set/ship-set parity between
`SUPPORTING_EVENT_TYPES` and the prepared SQL is enforced structurally; the machinery-lock,
no-session-id-inspection, and emission-hold sentinels are real and non-vacuous. All 289 tests
in the phase-relevant suites pass, and `tsc --noEmit` is clean.

Four warnings survive scrutiny. Two are substantive: (1) the provenance-distinctness key's
actual farming bar is one sender domain plus N free-to-mint Gmail threads, not "N domains"
as the module's own threat rationale claims — material to the pending enablement decision;
(2) the live-by-default `event_ts` staleness guard is silently inert for beliefs minted via
the `unrelated` path (the most common cold-start mint), re-opening the exact DRIFT-04
out-of-order revert for that class. Two defects in `stripQuotedForwarded` (idempotence
contract violation; indented-boundary leak toward the forbidden over-count direction) were
verified by execution. The remainder are eval-harness fragility and minor items.

## Warnings

### WR-01: Provenance-distinctness farming bar is one domain + N threads, not "N domains" as the threat rationale claims

**File:** `src/source/provenance-key.ts:17-24` (rationale), `src/source/provenance-key.ts:174` (composed key); see also `src/source/gmail-adapter.ts:77-82`, `tests/provenance-key.test.ts:512-515`
**Issue:** The module's discretionary-choice rationale states that keying on the sender
domain "reduces that to controlling N domains — the same bar as controlling N Claude Code
sessions." That claim describes the domain component in isolation, but the composed key is
`(domain, threadId)`, and a Gmail `threadId` — while server-*assigned* — is sender-*mintable*
at zero cost: every new email with a fresh Subject and no `In-Reply-To` starts a new thread.
`tests/provenance-key.test.ts` ("same domain, different threads → 3 distinct keys") locks
this as intended behavior. Consequence when `provenanceDistinctnessEnabled` is flipped on:
a single mailbox at a single domain sends three freshly-worded emails (each trivially clears
the 20-char residual gate — the residual gate only stops *duplicated* quoted/forwarded
content, not fresh text) → three distinct provenance keys → three held contradictions →
`countDistinctProvenance` = 3 ≥ `contradictionN` → force-destabilize of a belief from one
sender. Confidence damping does not mitigate this: a damped-to-zero magnitude still routes
to `hold`, and holds still record toward the counter (`src/lib/config.ts:166-169` documents
this as intended). Additionally, the domain component itself is derived from the sender-
forgeable `From:` header, so the adjacent claim in `gmail-adapter.ts:77-82` that `threadId`
is "the one component of the key not under the sender's control" has the threat model
inverted — `threadId` is the mintable component, `From:` is the assertable one.

The pre-Phase-65 collapsed key made single-sender force-destabilization on Gmail-only
evidence mathematically impossible (distinct count stuck at 1); enabling this key as-is
makes it a three-email operation. The feature ships dark (`provenanceDistinctnessEnabled:
false`), so shipped default behavior is unaffected — which is why this is a Warning rather
than a Blocker — but the Plan 65-10 enablement review will be made against an inaccurate
in-file threat statement.
**Fix:** Before the enablement decision: (a) correct the rationale in `provenance-key.ts`
and `gmail-adapter.ts` to state the real bar (one domain, N threads, From:-asserted domain);
(b) either drop `threadId` from the key (domain-only distinctness — matches the "same bar
as N domains" claim; the cost is under-counting multiple genuine threads from one company,
the module's own stated conservative direction) or ship a `contradictionNBySource.gmail`
entry raised high enough to price in thread minting; (c) record the residual risk in the
65-10 enablement checklist.

### WR-02: event_ts staleness guard is silently inert for standalone-minted beliefs — DRIFT-04 out-of-order revert still reachable

**File:** `src/consolidation/status-drift.ts:143-150` (`SUPPORTING_EVENT_TYPES` excludes `'unrelated'`), `src/consolidation/consolidator.ts:1356-1376` (`unrelated` mint emits `node_id` = minted node), `tests/status-drift.test.ts:448-455` (locks the exclusion)
**Issue:** `SUPPORTING_EVENT_TYPES` excludes `'unrelated'` with the justification "excluded
as not evidence about this node's value." That justification is wrong for the mint case: the
`unrelated` consolidation event is emitted with `node_id` = the freshly minted node and IS
that node's founding evidence — exactly like `extend`, which *is* included. Because
`unrelated` events carry `candidate_id: null` and always point at their own mint, including
it could never produce a false positive. Concrete failure, with the guard ON by default
(`statusDriftEventTsGuard: true`): a first status email (e.g. a June-15 rejection) arrives
with no prior belief → routes `unrelated` → mints a standalone node tied to a *dated* gmail
episode. A June-1 backfill email ("interview invite") is ingested in a later run and judged
`contradict` against that node. `latestSupportingEventTs` finds zero supporting rows (the
only event is the excluded `unrelated` mint) → `unknown-prior-ts` abstention → high-
confidence claim vs fresh-node resistance 0.05 → reconcile → the stale June-1 email silently
reverts the June-15 rejection. That is the exact revert DRIFT-04 is a phase success
criterion for closing. This is NOT covered by the header's named residual risks: limit (b)
covers *undated* evidence, but here both episodes are dated and the guard fails purely
because of the event-type set. The 65-09 e2e fixtures dodge the path because `establishBelief`
mints via `extend` and the cases apply the newer email first (whose `reconcile` mint is a
supporting event). Severity moderated to Warning because the failure degrades to pre-Phase-65
behavior (no guard existed) and the abstention is counted in `driftEventTsUnknown` — but the
phase claims DRIFT-04 closed while its most common cold-start path is unprotected.
**Fix:** Add `'unrelated'` to `SUPPORTING_EVENT_TYPES`:
```ts
export const SUPPORTING_EVENT_TYPES: ReadonlySet<ConsolidationEventType> = new Set([
  'confirm',
  'extend',
  'unrelated', // standalone mint — the node's founding evidence (node_id = minted node)
  'contradict_reconcile',
  'contradict_append_new',
  'contradict_force_destabilize',
  'contradict_oscillation',
]);
```
and update the locked exclusion assertions in `tests/status-drift.test.ts:448-455` plus add
a staleness case seeding an `unrelated` mint. (`EMISSION_ELIGIBLE_EVENT_TYPES` is unaffected.)

### WR-03: stripQuotedForwarded violates its own idempotence contract and leaks indented quotes/attributions into the residual (over-count direction)

**File:** `src/source/strip-quoted.ts:48,57,64,67` (boundary regexes), `src/source/strip-quoted.ts:156` (final `.trim()`), contract at `src/source/strip-quoted.ts:24`
**Issue:** Two verified defects, both resolving toward MORE residual — the direction the
module's own asymmetry doctrine ("when in doubt, this module strips more, not less") forbids:

1. **Idempotence violation (contract breach, verified by execution).** Input
   `'    > x'` (4 leading spaces): `QUOTE_LINE_RE` tolerates only 0-3 spaces, so the line
   survives; the final `.trim()` then shifts `>` to column 0; a second application strips it
   to `''`. So `stripQuotedForwarded(stripQuotedForwarded(x)) !== stripQuotedForwarded(x)`,
   directly contradicting the header's "Idempotent" guarantee. The test suite asserts
   idempotence only over a fixture table that lacks any ≥4-space-indented quote, so it passes.
2. **Indented-boundary leak.** `ATTRIBUTION_RE`, `FORWARD_MARKER_RE`, and
   `SIGNATURE_DELIM_RE` are all anchored at column 0 with zero leading-space tolerance,
   while `QUOTE_LINE_RE` tolerates 3 spaces "matching common mailer soft-wrap." Verified:
   `'  On Mon, Jan 5, 2026 at 9:00 AM Alice <a@x.com> wrote:\n<original body>'` matches no
   boundary, so the entire un-`>`-prefixed quoted body leaks into the residual and earns
   independent provenance. A benign mailer that indents the attribution/banner line (or a
   quote block by ≥4 spaces) makes forwards of one thread count as independent provenances —
   a partial reopening of the Pitfall-3 duplication vector the module exists to close.
**Fix:** (a) Add the same ` {0,3}` leading-space tolerance to the three boundary regexes
(e.g. `/^ {0,3}On [^\n]{0,200}... wrote:\s*$/gim`, and likewise for the forward/signature
markers); (b) replace the final character-level `.trim()` with a whitespace-only-line trim
(drop leading/trailing blank lines, `trimEnd()` per line) so trimming can never create a new
column-0 quote context — or run the strip to fixpoint. Add both cases to the FIXTURES table
so the idempotence loop covers them.

### WR-04: drift-05 harness 'reconcile' magnitude targeting ignores confidence damping — routing label is wrong and case coverage is silently coupled to the damping default

**File:** `scripts/eval/drift-05-dry-run.cjs:236-250` (`computeMagnitudeForAction`), `scripts/eval/drift-05-dry-run.cjs:226-233` (`targetActionFor`)
**Issue:** `computeMagnitudeForAction(..., 'reconcile')` computes a magnitude for ratio
`peReconcileBandLow + 0.05·(high−low)` = 0.86 and its doc comment claims the target band is
reached "deterministically." For every medium-confidence message (all release-three and
forward/quote-farm cases), the drift layer then damps by 0.6 before routing: effective ratio
0.86 × 0.6 = 0.516 < 0.8 → the claim routes to **hold**, not the labeled reconcile. The
release-three cases currently reach `expected_outcome: 'corrected'` only via the
hold→hold→force-destabilize volume path — arguably the mechanism worth testing, but that is
an accident of the current `statusDriftConfidenceDamping.medium: 0.6` default, not of the
harness's stated design. If damping is set to the documented reversibility value
(`{high:1, medium:1, low:1}`, `src/lib/config.ts:171-173`), msg1 reconciles immediately and
the release cases silently stop exercising the distinctness counter at all while still
reporting green — an eval that no longer measures what its rationale says it measures.
**Fix:** Divide the target ratio by the message's damping factor before computing the
magnitude:
```js
const dampFactor = DEFAULT_CONFIG.statusDriftConfidenceDamping[message.intent_confidence] ?? 1;
return Math.max(0.01, (resistance * ratio) / Math.max(dampFactor, 1e-9));
```
(or, for `low`/factor-0 messages, keep the hold target as-is), and/or assert per-pass
intermediate routing from the DRIFT-65 counters so a routing-path change fails the case
instead of passing coincidentally.

## Info

### IN-01: `expected_distinct_provenance` is not consumed by the harness itself

**File:** `scripts/eval/drift-05-dry-run.cjs` (Section 2), `scripts/eval/cases/drift-05-cases.json`
**Issue:** The per-case `expected_distinct_provenance` field is validated only by
`tests/drift-05-harness-smoke.test.ts` (Test 3) against the pure derivation; the harness's
Section 2 never recomputes or reports observed distinct counts per case, so a wiring-level
distinctness regression (e.g. in the session-id mint) would not surface in the harness output.
**Fix:** Report the observed distinct `session_id` count over each case's gmail episodes in
the per-case result and compare against `expected_distinct_provenance`.

### IN-02: Harness robustness — unhandled top-level rejection, unvalidated sweep values, unvalidated inbox rows

**File:** `scripts/eval/drift-05-dry-run.cjs:74,508-517`
**Issue:** (a) The top-level async IIFE has no `.catch` — every failure (including the
missing `--cases` path the smoke test exercises) surfaces as an unhandled-rejection crash
rather than a deliberate `console.error` + `process.exit(1)`. (b) `--sweep-residual` values
are `.map(Number)` with no NaN filtering, producing a `"NaN"` sweep key. (c) Inbox JSONL rows
missing `body`/`from` throw a raw `TypeError` deep in `stripQuotedForwarded`.
**Fix:** Add `.catch(err => { console.error(err); process.exit(1); })`, filter
`Number.isFinite` on sweep values, and validate inbox rows with a clear per-line error.

### IN-03: strip-quoted blank-line comment does not match the regex

**File:** `src/source/strip-quoted.ts:72-73`
**Issue:** Comment says "Three or more consecutive blank lines collapse to one," but
`/\n{3,}/g → '\n\n'` collapses runs of **two or more** blank lines (3 newlines = 2 blank
lines) to one blank line. Behavior is fine; the comment is wrong.
**Fix:** Correct the comment (or, if three-blank-lines was intended, use `/\n{4,}/g`).

### IN-04: Two-line attribution window can over-strip one genuine line

**File:** `src/source/strip-quoted.ts:133-141`
**Issue:** The two-line window test joins `line\nnext` and tests `ATTRIBUTION_RE` with the
`m` flag, so a *single-line* attribution at `i+1` matches at the window's second line-start
and sets `boundaryIndex = i`, dropping line `i` (potentially the author's own text) one line
early. Safe direction per the module's under-count asymmetry, but not the documented intent
of the window (which exists for genuinely wrapped two-line attributions).
**Fix:** For the window check, use a non-multiline anchor or verify the match starts at
offset 0 of the joined window before attributing the boundary to line `i`.

### IN-05: Primary drift evaluation runs before the candidate-existence check

**File:** `src/consolidation/consolidator.ts:1397-1441`
**Issue:** In the primary contradict branch, `statusDrift.evaluate` (and the
`driftEvaluations++` counter) runs before `const node = this.store.getNode(...)` /
`if (!node) break;`. For a `bestCandidateId` whose node row is absent, an evaluation (and
possibly a staleness SELECT) is counted against a nonexistent node before the branch breaks.
No graph effect (the module is read-only and the branch still breaks), but the DRIFT-65
counters can over-report evaluations relative to routed decisions.
**Fix:** Hoist the `getNode`/null check above the drift consultation, or accept and note the
counter semantics in the DRIFT-65 log line's doc comment.

---

_Reviewed: 2026-08-03T07:45:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
