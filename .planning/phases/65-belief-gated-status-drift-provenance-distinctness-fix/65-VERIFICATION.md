---
phase: 65-belief-gated-status-drift-provenance-distinctness-fix
verified: 2026-08-03T04:46:12Z
status: gaps_found
score: 3/5 must-haves verified
overrides_applied: 0
gaps:
  - truth: "DRIFT-04 — Out-of-order evidence (e.g. a rejection processed after an offer during backfill) does not silently revert a newer status"
    status: failed
    reason: >
      Verified by direct execution (a standalone reproduction test was written, run against the
      real Consolidator/StatusDrift/routeContradiction stack, and deleted after confirming),
      not just by reading REVIEW.md. `SUPPORTING_EVENT_TYPES`
      (src/consolidation/status-drift.ts:143-150) excludes the `'unrelated'` consolidation
      event type. But a consolidator `'unrelated'` mint (src/consolidation/consolidator.ts:1356-1372)
      IS a node's founding evidence — it fires whenever a status claim has no existing related
      node, which is the common cold-start case for every brand-new tracked entity's first status
      email. Because that founding event is excluded from the staleness guard's supporting-evidence
      query, a later-ingested but chronologically OLDER contradicting claim finds
      `latestSupportingEventTs === null`, abstains as `'unknown-prior-ts'` (not `'ok'`, not
      `'stale-event'`), and proceeds through the UNMODIFIED `routeContradiction` unguarded —
      which, at fresh-node resistance, force-reconciles and tombstones the newer belief. This is
      the literal scenario the ROADMAP's own DRIFT-04 example names ("a rejection processed after
      an offer during backfill"), reproduced directly: a cold-start offer (event_ts=day30, minted
      via `'unrelated'`, no seeded anchor) was silently reverted by a rejection ingested afterward
      but dated event_ts=day10 — `node.tombstoned` flipped to `1` and the surviving value became
      the stale rejection. Critically, this is NOT a pre-enablement / dark-launch question like
      DRIFT-03's provenance key: `statusDriftEnabled: true` and `statusDriftEventTsGuard: true`
      are the SHIPPED DEFAULTS in `src/lib/config.ts` (lines 914, 916) — this gap is live in the
      current default configuration today, not gated behind an unflipped knob pending human
      review. `65-REVIEW.md` WR-02 documents the same defect (moderated to "Warning" under a
      code-review lens); this verification treats it as a phase-goal BLOCKER because it falsifies
      the literal DRIFT-04 success criterion for the most common real-world path (a new entity's
      very first status email), not an edge case.
    artifacts:
      - path: "src/consolidation/status-drift.ts"
        issue: "SUPPORTING_EVENT_TYPES (lines 143-150) omits 'unrelated', so a standalone/cold-start mint's event_ts is invisible to the staleness guard's MAX(event_ts) query"
    missing:
      - "Add 'unrelated' to SUPPORTING_EVENT_TYPES (REVIEW.md WR-02's proposed fix) and update the locked exclusion assertions in tests/status-drift.test.ts:448-455"
      - "Add an e2e regression case (extending tests/drift-belief-correction-e2e.test.ts) that seeds a belief via a genuine cold-start 'unrelated' mint (no seeded anchor node, no candidates) and then applies a stale backfilled contradiction — the existing DRIFT-04 e2e suite only exercises the 'extend'-minted path via establishBelief() and therefore does not catch this regression class"
      - "Re-verify that the fix does not reintroduce a false positive for the module's own stated invariant ('including it could never produce a false positive' per WR-02's fix note, since unrelated events carry candidate_id: null and always point at their own mint)"
deferred: []
human_verification:
  - test: "Phase 65 Plan 65-10 Task 3: review the DRIFT-05 dry-run harness against a real multi-inbox export and record an ENABLE/HOLD decision for provenanceDistinctnessEnabled"
    expected: "Founder exports a real multi-email status-thread sample as JSONL, runs `npm run eval:drift05 -- --inbox <path>`, reviews the four verification questions in 65-10-PLAN.md's how-to-verify section, and records ENABLE (optionally with revised knob values) or HOLD (naming the blocking observation) in a revision of 65-10-SUMMARY.md"
    why_human: "Requires a real Gmail export + a real API key (ANTHROPIC_API_KEY/OPENAI_API_KEY) — cannot be automated or substituted with synthetic data per D-14's dark-launch discipline. This is the designed pre-decision state, not an oversight: the knob (provenanceDistinctnessEnabled) correctly remains false pending this review."
  - test: "During the same Task 3 review, evaluate REVIEW.md WR-01 before flipping provenanceDistinctnessEnabled: the composed key's real farming bar is one sender domain + N freely-mintable Gmail threads (every fresh Subject/no-In-Reply-To starts a new thread), not 'N domains' as provenance-key.ts's own rationale comment claims"
    expected: "Either (a) correct the in-file rationale comments in provenance-key.ts and gmail-adapter.ts to state the real bar, and decide whether to drop threadId from the key or raise contradictionNBySource.gmail to price in thread-minting cost, before enabling — or (b) explicitly accept the residual risk in the enablement record with the corrected threat model stated"
    why_human: "This is a judgment call about acceptable risk for a load-bearing correctness mechanism (per CONTEXT D-02's own 'same caution class as GMAIL_EXTRACTION_PROMPT changes' framing) — not something a grep-based verifier can resolve. Since provenanceDistinctnessEnabled is currently false, this does not block phase closure, but it does directly inform the enablement decision Task 3 is the gate for."
  - test: "During the same Task 3 review, note REVIEW.md WR-03: stripQuotedForwarded (src/source/strip-quoted.ts) violates its own documented idempotence guarantee for ≥4-space-indented quote lines, and leaks an entire un-'>'-prefixed indented quoted body into the residual when the attribution/forward-marker line itself is indented ≥1 space (boundary regexes are anchored at column 0 with zero leading-space tolerance while QUOTE_LINE_RE tolerates 3 spaces)"
    expected: "Confirmed by direct execution during this verification: stripQuotedForwarded('    > x') !== stripQuotedForwarded(stripQuotedForwarded('    > x')) ('> x' vs ''). Decide whether to fix before enablement (both defects resolve toward MORE residual — the over-count/farming direction the module's own asymmetry doctrine forbids) or accept as a residual risk given the feature ships dark."
    why_human: "Judgment call on acceptable pre-enablement risk for the D-06 farming guard, same class as WR-01."
---

# Phase 65: Belief-Gated Status Drift + Provenance-Distinctness Fix Verification Report

**Phase Goal:** Status transitions for a tracked entity update through the existing PE-gated belief machinery completely unmodified, and email evidence can finally satisfy (or correctly fail to satisfy) the distinct-provenance mechanism the differentiator depends on — closing the gap where every Gmail episode today shares one literal `session_id`, making `countDistinctProvenance` mathematically unreachable on email-only evidence.
**Verified:** 2026-08-03T04:46:12Z
**Status:** gaps_found
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | DRIFT-01: Status lifecycle is an ordinary fact node, updated only through the unmodified `routeContradiction()`/tombstone/`supersedes` machinery — no new data model, no bi-temporal or supersedes-chain columns | ✓ VERIFIED | `git diff` confirms `src/consolidation/update-decision.ts` is byte-unchanged since Phase 14 (`fix(14-05)` is the last commit to touch it). `tests/pe-machinery-lock.test.ts` (219 lines) source-pins `routeContradiction`/`isOscillation`, pins the exact node/edge/episode column sets, and bans bi-temporal/`supersedes` tokens across all three tables — passes (16 tests). `grep` confirms no `valid_from`/`valid_to`/`supersedes_id`/`version_of` columns in `src/db/schema.ts`. |
| 2 | DRIFT-02: A single ambiguous status email holds rather than flipping the belief, and a held update produces no downstream proposal | ✓ VERIFIED | `tests/drift-belief-correction-e2e.test.ts` ("DRIFT-02: a single ambiguous email holds", 2 tests) proves this through a real `consolidate()` pass: node stays live, value unchanged, one `pending_contradictions` entry recorded, zero emission-eligible consolidation events. `tests/emission-hold-sentinel.test.ts` (523 lines, 8 tests) proves the same claim both behaviorally (real pass, zero emission-eligible rows) and structurally (comment-stripped source scan of both hold branches in `consolidator.ts`, non-vacuous — a planted `proposalSink.emit` inside a synthetic hold block IS flagged; a comment merely naming `proposalSink` is NOT). All tests pass. |
| 3 | DRIFT-03: Provenance distinctness for email evidence is derived from sender identity + thread lineage with quoted/forwarded content stripped first — 3 independent emails count as 3 distinct provenances, 3 forwards of one thread count as 1 | ✓ VERIFIED (see WARNING) | `src/source/provenance-key.ts` (175 lines) composes `ingest:gmail:<domain>:<threadId>`, residual-gated first via `src/source/strip-quoted.ts`. `tests/provenance-key.test.ts` (580 lines) and `tests/drift-belief-correction-e2e.test.ts` ("DRIFT-03 consequence", 4 tests) both assert the locked D-07 pair directly against the real derivation and through a real `consolidate()` pass — 3-independent → `countDistinctProvenance === 3` and belief corrects; 3-forwards → `=== 1` and belief holds. The 65-01 audit (121 lines) locks the PRIMARY mechanism shape and is corroborated by `tests/session-id-provenance-consumers.test.ts`. **However:** `65-REVIEW.md` WR-01 (verified independently, see human_verification) shows the composed key's actual farming resistance is one sender domain + N freely-mintable Gmail threads, weaker than the in-file threat-model comment claims — a real design gap, but one the dark-launch default (`provenanceDistinctnessEnabled: false`) correctly defers to the still-open Task 3 human decision rather than shipping live. |
| 4 | DRIFT-04: Out-of-order evidence (a rejection processed after an offer during backfill) does not silently revert a newer status | ✗ FAILED | See `gaps` in frontmatter. Confirmed by direct execution (independent reproduction test, not just re-reading REVIEW.md): a belief established via a cold-start `'unrelated'` mint (the common path for any brand-new tracked entity — no existing candidate node) is NOT protected by the `event_ts` staleness guard, because `SUPPORTING_EVENT_TYPES` excludes `'unrelated'`. A stale backfilled contradiction silently reverts the newer belief exactly as the ROADMAP's own example describes. This is live default behavior (`statusDriftEnabled: true`, `statusDriftEventTsGuard: true` are NOT dark-launched), not a pending-decision gap. |
| 5 | DRIFT-05: Belief-correction accuracy on real multi-inbox traffic is measured and recorded honestly against recense's own harness, with no external accuracy bar cited, before Phase 66 wires any consumer live | ◐ PARTIAL — human decision required | Harness (`scripts/eval/drift-05-dry-run.cjs`, 609 lines) and 14-case labeled set are built, committed, and independently re-run during this verification — output matches `65-10-SUMMARY.md`'s reported numbers exactly (30 messages, 1→15 distinct keys, 12 fallbacks all `near-empty-residual`, 14/14 mock-provider accuracy, methodology block cites no external bar). This is genuinely Task 1-2 complete. Task 3 (founder reviews a REAL inbox run and records ENABLE/HOLD) has not happened — `provenanceDistinctnessEnabled` remains `false`, correctly. This is the designed pre-decision state per D-14, not a silently-skipped criterion; see `human_verification`. |

**Score:** 3/5 truths fully verified (1 with a non-blocking warning attached); 1 failed (BLOCKER); 1 partial pending a human decision that was never claimed to be automatable.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `.planning/phases/65.../65-SESSION-ID-AUDIT.md` | Per-consumer table + LOCKED D-02 verdict | ✓ VERIFIED | 121 lines, VERDICT section present, 17-row per-consumer table, decision rule applied and shown satisfied |
| `tests/session-id-provenance-consumers.test.ts` | Structural lock, non-vacuous | ✓ VERIFIED | 213 lines, passes |
| `src/source/strip-quoted.ts` | D-06 quote/forward stripper | ✓ VERIFIED (functional) / ⚠️ has a real idempotence defect | 193 lines; exports `stripQuotedForwarded`/`isNearEmptyResidual`; WR-03 confirmed by execution (indented-quote idempotence violation) but does not break the shipped test-pair or block phase closure since `provenanceDistinctnessEnabled` is dark |
| `tests/strip-quoted.test.ts` | Table-driven coverage | ✓ VERIFIED | 339 lines, passes |
| `src/lib/config.ts` | Six dark knobs, all reproduce pre-Phase-65 behavior by default | ✓ VERIFIED | `provenanceDistinctnessEnabled: false` (dark, correct); `statusDriftEnabled: true` / `statusDriftEventTsGuard: true` (live by design — this is exactly the surface where DRIFT-04's gap is live, not dark) |
| `tests/runtime-config.test.ts` | Stock-default assertion block | ✓ VERIFIED | passes |
| `src/source/provenance-key.ts` | Pure key derivation | ✓ VERIFIED | 175 lines; matches D-01 composition; WR-01 farming-bar accuracy concern noted but pre-enablement |
| `tests/provenance-key.test.ts` | D-07 locked pair + adversarial coverage | ✓ VERIFIED | 580 lines, passes |
| `src/consolidation/status-drift.ts` | Drift layer: damping, staleness guard, emission-eligibility | ✓ VERIFIED (existence/wiring) / ✗ **staleness guard incomplete** | 250 lines; `dampByConfidence` correct (lower-only, clamped); `EMISSION_ELIGIBLE_EVENT_TYPES`/`isEmissionEligible` correct; staleness guard's `SUPPORTING_EVENT_TYPES` omits `'unrelated'` — the DRIFT-04 gap (see gaps) |
| `tests/status-drift.test.ts` | Unit coverage of all guarantees | ✓ VERIFIED (as written) | 456 lines, passes — but the locked exclusion of `'unrelated'` (lines 448-455) locks in the buggy behavior rather than catching it |
| `src/source/gmail-adapter.ts` | threadId capture, gated key derivation, backfill ordering | ✓ VERIFIED | `threadId` field present, ternary gate matches SUMMARY claim |
| `src/source/source-adapter.ts` | `NormalizedRecord.provenance_key` | ✓ VERIFIED | field present |
| `tests/gmail-provenance-key.test.ts` | Adapter-level coverage | ✓ VERIFIED | 355 lines, passes |
| `src/adapter/ingest-cli.ts` | PRIMARY-shape sessionId mint | ✓ VERIFIED | matches 65-01 VERDICT |
| `tests/pe-machinery-lock.test.ts` | DRIFT-01 structural lock | ✓ VERIFIED | 219 lines, passes |
| `tests/update-decision.test.ts` | D-07 pair on real mechanism | ✓ VERIFIED | 289 lines, passes |
| `src/consolidation/consolidator.ts` | Drift layer wired at both contradict branches | ✓ VERIFIED (wiring) / ✗ **wired guard is incomplete for cold-start path** | `statusDrift.evaluate` called at both branches (`:1400`, `:1667`); wiring itself matches the plan; the underlying module has the DRIFT-04 gap |
| `tests/status-drift-wiring.test.ts` | Wiring-level proof | ✓ VERIFIED | 949 lines, passes |
| `tests/emission-hold-sentinel.test.ts` | D-13 sentinel | ✓ VERIFIED | 523 lines, passes, non-vacuous |
| `tests/drift-belief-correction-e2e.test.ts` | DRIFT-02/03/04 e2e proof | ✓ VERIFIED (for the paths it covers) / ⚠️ **does not cover the cold-start mint path** | 679 lines, passes; `establishBelief()` always mints via `'extend'` from a seeded anchor, which is exactly the path that dodges the DRIFT-04 gap (confirmed by this verification's own independent repro against a genuine `'unrelated'` cold-start mint) |
| `scripts/eval/drift-05-dry-run.cjs` | DRIFT-05 harness | ✓ VERIFIED | 609 lines; independently re-run during this verification, output matches SUMMARY exactly |
| `scripts/eval/cases/drift-05-cases.json` | 14 labeled cases | ✓ VERIFIED | 366 lines / 14 cases, all 7 scenario types present |
| `tests/drift-05-harness-smoke.test.ts` | Zero-network smoke suite | ✓ VERIFIED | 257 lines, passes |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `65-SESSION-ID-AUDIT.md` | `src/adapter/ingest-cli.ts` | verdict names exact edit site | ✓ WIRED | ingest-cli.ts:188 matches |
| `tests/session-id-provenance-consumers.test.ts` | `src/` | recursive walk | ✓ WIRED | confirmed by passing test |
| `src/source/provenance-key.ts` | `src/source/strip-quoted.ts` | residual gate applied first | ✓ WIRED | confirmed in source read |
| `src/source/provenance-key.ts` | `src/source/strip-hidden.ts` | invisible-codepoint stripping on From: | ✓ WIRED | confirmed in source read |
| `src/source/gmail-adapter.ts` | `src/source/provenance-key.ts` | `deriveGmailProvenanceKey` called | ✓ WIRED | confirmed |
| `src/source/gmail-adapter.ts` | `src/source/source-adapter.ts` | `NormalizedRecord.provenance_key` | ✓ WIRED | confirmed |
| `src/adapter/ingest-cli.ts` | `src/source/source-adapter.ts` | `provenance_key` consumed at mint | ✓ WIRED | confirmed |
| `tests/pe-machinery-lock.test.ts` | `src/consolidation/update-decision.ts` | source-text pin | ✓ WIRED | passes |
| `src/consolidation/consolidator.ts` | `src/consolidation/status-drift.ts` | `StatusDrift` instantiated, evaluated at both contradict branches | ✓ WIRED | confirmed via `grep` (`:298, :365, :1400, :1667`) |
| `src/consolidation/consolidator.ts` | `src/lib/config.ts` | `contradictionNBySource[source] ?? contradictionN` | ✓ WIRED | confirmed by passing `tests/status-drift-wiring.test.ts` |
| `tests/emission-hold-sentinel.test.ts` | `src/consolidation/status-drift.ts` | `isEmissionEligible` applied to real pass output | ✓ WIRED | confirmed |
| `tests/drift-belief-correction-e2e.test.ts` | `src/consolidation/consolidator.ts` | real `consolidate()` passes | ✓ WIRED | confirmed |
| `scripts/eval/drift-05-dry-run.cjs` | `dist/src/source/provenance-key.js` | compiled-dist require | ✓ WIRED | confirmed by re-running the harness |
| `scripts/eval/drift-05-dry-run.cjs` | `package.json` | `eval:drift05` / `eval:drift05:dry` scripts | ✓ WIRED | ran successfully via `npm run eval:drift05:dry` |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Phase-relevant test suites pass | `npx vitest run tests/session-id-provenance-consumers.test.ts tests/strip-quoted.test.ts tests/runtime-config.test.ts tests/provenance-key.test.ts tests/status-drift.test.ts tests/gmail-provenance-key.test.ts tests/pe-machinery-lock.test.ts tests/update-decision.test.ts tests/status-drift-wiring.test.ts tests/emission-hold-sentinel.test.ts tests/drift-belief-correction-e2e.test.ts tests/drift-05-harness-smoke.test.ts` | 12 files / 280 tests passed | ✓ PASS |
| Full suite matches claimed "green" state | `npx vitest run` | 220 files passed / 1 skipped; 3708 tests passed / 6 expected-fail / 3 skipped — exact match to the claimed state | ✓ PASS |
| Typecheck clean | `npx tsc --noEmit` | exit 0 | ✓ PASS |
| DRIFT-05 harness runs and reproduces SUMMARY's numbers | `npm run eval:drift05:dry` | Output matches `65-10-SUMMARY.md` verbatim (30 messages, 15 distinct keys, 12 fallbacks, 14/14 mock accuracy) | ✓ PASS |
| DRIFT-01 machinery unmodified | `git log --oneline -- src/consolidation/update-decision.ts` | Last touch: `fix(14-05)`, Phase 14 — untouched by Phase 65 | ✓ PASS |
| No bi-temporal/supersedes columns added | `grep -n "valid_from\|valid_to\|supersedes_id\|version_of" src/db/schema.ts` | zero matches | ✓ PASS |
| **DRIFT-04 cold-start out-of-order revert** | Standalone reproduction test (written for this verification, run, confirmed, then deleted — see gap above) | A cold-start `'unrelated'`-minted offer (event_ts=day30) was silently reverted (`tombstoned: 1`) by a stale rejection ingested afterward but dated event_ts=day10 | ✗ **FAIL** |
| WR-03 idempotence claim | `node -e "... stripQuotedForwarded('    > x') twice ..."` | `once='> x'`, `twice=''` — not idempotent | ✗ FAIL (pre-enablement, non-blocking) |
| Debt markers (TBD/FIXME/XXX) in phase-modified files | `grep -n -E "TBD\|FIXME\|XXX"` across all phase source files | zero matches | ✓ PASS |

### Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
|-------------|-----------------|--------------|--------|----------|
| DRIFT-01 | 65-05, 65-07, 65-08, 65-09 | Status lifecycle rides unmodified PE machinery | ✓ SATISFIED | pe-machinery-lock.test.ts, git history |
| DRIFT-02 | 65-03, 65-05, 65-08, 65-09 | Ambiguous email holds, no downstream proposal | ✓ SATISFIED | emission-hold-sentinel.test.ts, drift-belief-correction-e2e.test.ts |
| DRIFT-03 | 65-01, 65-02, 65-03, 65-04, 65-06, 65-07 | Provenance-distinctness key, farming-resistant | ✓ SATISFIED (with enablement-time caveat WR-01) | provenance-key.test.ts, drift-belief-correction-e2e.test.ts |
| DRIFT-04 | 65-03, 65-05, 65-06, 65-08, 65-09 | Out-of-order evidence cannot silently revert | ✗ **BLOCKED** | See gap — fails for the cold-start `'unrelated'`-mint path, live default config |
| DRIFT-05 | 65-10 | Honest belief-correction measurement before Phase 66 | ◐ NEEDS HUMAN | Harness built/green; Task 3 founder decision outstanding by design |

No orphaned requirements: all five DRIFT-01..05 IDs declared in ROADMAP.md and REQUIREMENTS.md are claimed by at least one plan's `requirements:` frontmatter field.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/consolidation/status-drift.ts` | 143-150 | `SUPPORTING_EVENT_TYPES` omits `'unrelated'` despite it being founding evidence for a minted node | 🛑 Blocker | DRIFT-04 gap — see above |
| `src/source/strip-quoted.ts` | 48, 57, 64, 67, 156 | Boundary regexes anchored at column 0 while `QUOTE_LINE_RE` tolerates 3 leading spaces; final `.trim()` can create new column-0 quote context | ⚠️ Warning | WR-03 — confirmed by execution; over-count/farming-direction leak, but inert while `provenanceDistinctnessEnabled` is dark |
| `src/source/provenance-key.ts` | 17-24 | In-file rationale claims farming bar is "N domains"; composed key's actual bar is "1 domain + N mintable threads" | ⚠️ Warning | WR-01 — inaccurate in-code threat-model comment, relevant to the pending enablement decision |
| `scripts/eval/drift-05-dry-run.cjs` | 236-250 | `computeMagnitudeForAction('reconcile', ...)` does not divide the target ratio by the confidence-damping factor, so release-three cases reach `'corrected'` via force-destabilize volume, not the labeled `'reconcile'` routing path, and would silently stop testing the distinctness counter if damping defaults changed | ℹ️ Info | WR-04 in REVIEW.md — eval-harness-only, does not affect shipped `src/` behavior |
| (none) | — | TBD/FIXME/XXX debt markers | — | None found in any phase-modified file |

## Human Verification Required

See `human_verification` in frontmatter. Three items, all correctly gated on the still-open Plan 65-10 Task 3 checkpoint:

1. **Task 3 ENABLE/HOLD decision** — requires a real Gmail export and a real API key; cannot be automated. This is the designed pre-decision state, not a gap in this phase's execution.
2. **WR-01 review** (farming-bar accuracy) — a judgment call on acceptable risk before flipping `provenanceDistinctnessEnabled`; currently non-blocking because the knob is dark.
3. **WR-03 review** (quote-stripper idempotence/indentation defects) — same class, confirmed by execution during this verification, non-blocking while dark.

## Gaps Summary

One BLOCKER: **DRIFT-04 is not actually closed for the most common real-world path.** The phase's e2e test suite (`tests/drift-belief-correction-e2e.test.ts`) proves the out-of-order guard works when a belief is established via an `'extend'` mint (i.e., an existing anchor/candidate node was in scope), but every genuinely new tracked entity's very first status email mints via `'unrelated'` (no existing candidate at all) — and that founding event is excluded from `SUPPORTING_EVENT_TYPES`, so the staleness guard cannot see it. A stale backfilled contradiction against such a node abstains as "unknown-prior-ts" and proceeds unguarded through the unmodified `routeContradiction`, silently reverting the newer belief exactly as ROADMAP's own DRIFT-04 example describes. This was independently confirmed by writing and executing a standalone reproduction (not merely trusting `65-REVIEW.md` WR-02's prose), and the underlying config knobs that gate this behavior (`statusDriftEnabled`, `statusDriftEventTsGuard`) default to `true` — this is live shipped behavior today, not a pending dark-launch decision.

The fix is narrow and already specified in `65-REVIEW.md` WR-02: add `'unrelated'` to `SUPPORTING_EVENT_TYPES`, update the locked exclusion test, and add an e2e regression case that exercises the cold-start mint path (the existing suite's `establishBelief()` helper always seeds an anchor and therefore never exercises this branch).

Everything else in the phase — DRIFT-01, DRIFT-02, DRIFT-03's literal test criteria, and DRIFT-05's harness construction — is genuinely built, wired, and passing, independently re-verified in this pass (not merely re-reading SUMMARY.md claims). DRIFT-05's Task 3 founder checkpoint remains open by design and is correctly surfaced as human_verification rather than silently treated as passed.

---

*Verified: 2026-08-03T04:46:12Z*
*Verifier: Claude (gsd-verifier)*
