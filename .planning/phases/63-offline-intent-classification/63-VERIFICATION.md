---
phase: 63-offline-intent-classification
verified: 2026-08-02T21:21:48Z
status: human_needed
score: 4/4 must-haves verified
overrides_applied: 0
human_verification:
  - test: "Founder confirmation of the measured prompt-prefix token-cost figure (Plan 63-06, Task 3 — blocking checkpoint)"
    expected: "Founder reads scripts/eval/results/63-intent-prompt-token-delta.json, confirms measured:true reflects a real 2-call claude -p run against the Max subscription, confirms the +597 token / +117.52% delta quoted in 63-06-SUMMARY.md matches the JSON exactly (no rounding/annualizing/extrapolation), and is willing to defend the figure verbatim per CLAUDE.md's no-inflated-metrics rule. Founder then replies \"approved\" (or identifies a discrepancy, which triggers a harness re-run rather than a text edit)."
    why_human: "This is an explicit founder-only decision gate (checkpoint:human-verify, gate=\"blocking\", plan frontmatter autonomous:false). CLASSIFY-01's token-delta claim is only complete once a human, not an agent, has signed off on the number — the executor correctly refused to self-approve, and this verifier cannot approve on the founder's behalf either. The measurement itself (scripts/eval/results/63-intent-prompt-token-delta.json: measured:true, +597 input tokens, +117.52%) is verified as real and committed, but plan 63-06 is intentionally 2/3 tasks complete pending this checkpoint."
---

# Phase 63: Offline Intent Classification Verification Report

**Phase Goal:** The sleep pass decides, from gmail episodes only, whether an email implies a status change to a tracked entity — at zero net-new LLM-call cost — while online paths stay LLM-free and the existing `source==='hitl'` exclusion structurally extends to the new classification path instead of being re-implemented.
**Verified:** 2026-08-02T21:21:48Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth (ROADMAP Success Criteria) | Status | Evidence |
|---|---|---|---|
| 1 | CLASSIFY-01: a gmail episode implying a status change produces optional `intent_status`/`intent_entity`/`intent_confidence` fields as part of the SAME extraction call (no second LLM call); a token-cost check confirms the delta | ✓ VERIFIED | `src/model/claim-extractor.ts:69-397` — closed `IntentStatus`/`IntentConfidence` vocabularies, `toIntentStatus`/`toIntentConfidence` drop-on-mismatch coercers, three optional `ExtractedClaim` fields, `CLAIM_ARRAY_SCHEMA` enum built from the shared constants, all-or-nothing gate in `parseClaimsFromArray` (live-code-verified by direct grep, not SUMMARY claim). `src/consolidation/consolidator.ts` one-`generate`-call-per-episode proven by `tests/consolidation-intent.test.ts` (2 sentinel cases, 1↔1 / 2↔2). Token delta genuinely measured: `scripts/eval/results/63-intent-prompt-token-delta.json` shows `measured:true`, `+597` input tokens, `+117.52%`, model `claude-haiku-4-5`. Founder sign-off on the number is a separate, still-pending gate (see Human Verification). |
| 2 | CLASSIFY-02: classification runs as a branch inside the existing per-episode consolidator loop, after the `source==='hitl'` hard-stop; a sentinel test proves hitl episodes are never classified | ✓ VERIFIED | `consolidator.ts:660-661` hard-stop (`origin === 'inferred' \|\| echoSourceId !== null \|\| episode.source === 'hitl'`) `continue`s and `markSkipped`s BEFORE all four `claimIntentStatus` fill sites at lines 771-773, 869-871, 895-897, 958-960 (grep-verified, all fill sites textually after line 661). `tests/consolidation-intent.test.ts` hitl/inferred/echo sentinel tests pass (ran directly: 102/102 phase-scoped tests pass, including these three). |
| 3 | CLASSIFY-03: SessionStart inject, retrieval, `/v1/surface` (and `/v1/proposals` when it exists) stay LLM-free, confirmed by an automated regression test that fails if any online path calls the model provider | ✓ VERIFIED (scoped) | `tests/online-llm-free-sentinel.test.ts` — dynamic fail-if-called `ModelProvider` stub exercised through `ambientRecall` (SessionStart inject), direct `retrieveRanked` call (retrieval), and `GET /v1/surface` over real HTTP; plus a structural comment-stripped scan of `src/adapter/ambient-recall.ts` + `src/retrieval/*.ts` for `.generate(`/`.judge(`/`.judgeBatch(`. Ran directly: all pass. `/v1/proposals` does not exist in the codebase yet (confirmed: `grep -r "proposals" src/adapter/serve-cli.ts` finds no route) — CONTEXT.md D-13 explicitly scopes this phase's regression to the online paths that exist today and records the Phase 66 extension obligation in the test file's header docblock (confirmed present). This is a locked planning decision, not a phase gap. |
| 4 | CLASSIFY-04: the status vocabulary stays limited to the four scoped states, and no sender-domain fingerprint table exists anywhere in config or code | ✓ VERIFIED | `INTENT_STATUSES` is exactly `applied\|interviewing\|rejected\|offer` (`claim-extractor.ts:69-75`, size-4 tripwire test in `tests/intent-conservation.test.ts`). `tests/no-ats-domain-table.test.ts` — real `src/` walk for 11 known ATS vendor domain tokens returns `[]`, non-vacuousness proven with a planted offender, prose-allowed case proven separately. Ran directly: passes. |

**Score:** 4/4 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `src/model/claim-extractor.ts` | Intent vocabularies, coercers, `ExtractedClaim` fields, schema properties, parse gate | ✓ VERIFIED | Confirmed present by direct read/grep of live source, not SUMMARY. |
| `tests/claim-extractor-intent.test.ts` | Coercion/gate coverage | ✓ VERIFIED | Ran directly, passes. |
| `src/source/extraction-prompts.ts` | `GMAIL_INTENT_CLASSIFICATION_BLOCK` interpolated into both gmail prompts | ✓ VERIFIED | Confirmed present at lines 49, 90, 137; `RECENSE_ENABLE_EPISODIC_EMAIL` branch count unchanged (only the pre-existing episodic gate remains). |
| `tests/extraction-prompts-intent.test.ts` | Routing/ordering/isolation tests | ✓ VERIFIED | Ran directly, passes. |
| `tests/no-ats-domain-table.test.ts` | CLASSIFY-04 structural guard | ✓ VERIFIED | Ran directly, passes; non-vacuous. |
| `tests/online-llm-free-sentinel.test.ts` | CLASSIFY-03 dynamic + structural regression | ✓ VERIFIED | Ran directly, passes. |
| `src/consolidation/consolidator.ts` | Intent field threading at all 4 decision routes, below hard-stop | ✓ VERIFIED | Confirmed by grep: fill sites at 771-773/869-871/895-897/958-960, all after hard-stop at 660-661. |
| `tests/consolidation-intent.test.ts` | Threading + hitl/inferred/echo + one-call sentinels | ✓ VERIFIED | Ran directly, passes. |
| `tests/intent-conservation.test.ts` | Cross-stage vocabulary parity + zero-DB-delta inertness | ✓ VERIFIED | Ran directly, passes. No `intent` column/index/view anywhere in `src/db/schema.ts` (confirmed: zero grep matches). |
| `scripts/eval/63-intent-prompt-token-delta.cjs` + `scripts/eval/results/63-intent-prompt-token-delta.json` | Honest measured token delta | ✓ VERIFIED (artifact) / pending founder sign-off | JSON confirmed on disk: `measured:true`, `+597` tokens, `+117.52%`. Plan 63-06's Task 3 (founder checkpoint) is the pending gate — not an artifact gap. |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `CLAIM_ARRAY_SCHEMA` | `INTENT_STATUSES`/`INTENT_CONFIDENCES` | enum spread from shared constant | ✓ WIRED | `claim-extractor.ts:288,290` — `enum: [...INTENT_STATUSES]` / `[...INTENT_CONFIDENCES]`, confirmed no duplicated literal array. |
| `parseClaimsFromArray` | `toIntentStatus`/`toIntentConfidence` | all-or-nothing gate calls the coercers | ✓ WIRED | `claim-extractor.ts:376-387` confirmed. |
| `GMAIL_EXTRACTION_PROMPT` / `GMAIL_EPISODIC_EXTRACTION_PROMPT` | `GMAIL_INTENT_CLASSIFICATION_BLOCK` | template interpolation | ✓ WIRED | Confirmed at lines 90 and 137 — identical constant in both prompt variants. |
| `consolidator.ts` hard-stop | classification fill sites | textually after `continue` | ✓ WIRED | Confirmed: hard-stop at 660-661, all 4 fill sites at 771+. |
| `claim.intent_status` | `ClaimDecision.claimIntentStatus` | per-claim field copy at all 4 sites | ✓ WIRED | Confirmed at 771, 869, 895, 958 (post-judge site copies from `pendingJudges[i]!.claimIntentStatus`, correctly threading across the judge await). |
| `tests/online-llm-free-sentinel.test.ts` | `ambientRecall`, `createBrainHttpServer` | in-process call / HTTP request | ✓ WIRED | Ran directly, both entrypoints exercised and pass. |

### Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
|---|---|---|---|---|
| CLASSIFY-01 | 63-01, 63-02, 63-04, 63-05, 63-06 | Optional intent fields on the same extraction call, zero net-new LLM call, honest token-cost check | ✓ SATISFIED (measurement pending founder sign-off) | See Truth #1 above. |
| CLASSIFY-02 | 63-04, 63-05 | Classification branch inherits the hitl hard-stop structurally | ✓ SATISFIED | See Truth #2 above. |
| CLASSIFY-03 | 63-03 | Online paths stay LLM-free | ✓ SATISFIED (scoped per D-13; `/v1/proposals` extension deferred to Phase 66 by design) | See Truth #3 above. |
| CLASSIFY-04 | 63-01, 63-02, 63-04, 63-05 | Narrow 4-state vocabulary, no ATS domain fingerprint table | ✓ SATISFIED | See Truth #4 above. |

No orphaned requirements — all 4 IDs in `.planning/REQUIREMENTS.md`'s Phase 63 row are claimed by at least one plan's frontmatter `requirements:` field and are evidenced in the codebase above.

### Anti-Patterns Found

No blockers. `.planning/phases/63-offline-intent-classification/63-REVIEW.md` (advisory code review, 0 critical / 3 warnings / 5 info) was cross-checked against live source rather than trusted at face value:

| File | Severity | Issue | Impact |
|---|---|---|---|
| `src/model/claim-extractor.ts`, `src/consolidation/consolidator.ts` | ⚠️ WARNING (non-blocking) | WR-01: intent fields are accepted/threaded from ANY source (parser and consolidator are source-agnostic); D-11 gmail-only isolation is enforced only in prompt text. `ClaimDecision` does not carry `episode.source`, so a future consumer cannot enforce "gmail-derived only" without new plumbing. | Does not affect Phase 63's own goal (fields are inert this phase — verified zero DB writes), but is a real risk for Phase 64/65/66 to inherit. Recommend surfacing to Phase 64 planning. |
| `tests/intent-conservation.test.ts` | ⚠️ WARNING (non-blocking) | WR-02: the "byte-identical database" conservation test compares only one column per table (`value`/`content`); `consolidation_event.payload` (the most plausible future leak channel, per 63-04's own SUMMARY) is not compared. Production code is currently clean (verified by grep — no `intent` substring reaches `consolidation_event`), but the guard has a blind spot for future phases. | Does not affect Phase 63's current correctness; weakens the regression guard's future coverage. |
| `scripts/eval/63-intent-prompt-token-delta.cjs` | ⚠️ WARNING (non-blocking) | WR-03: `--offline` or failed harness runs overwrite the committed `measured:true` result-of-record JSON with `measured:false`. Confirmed current committed file still shows `measured:true` (verified above) — the risk is prospective (a future CI run in `--offline` mode would clobber it), not a present defect. | No current impact; operational risk if the harness is re-run carelessly. |
| Various | ℹ️ INFO (5 items) | Comment-stripper string-literal blind spot, harness Arm-A whitespace ablation imprecision (~0-1 token, immaterial to the 597-token delta), harness doesn't pin `RECENSE_ENABLE_EPISODIC_EMAIL` during measurement, hand-mirrored `EXTRACTION_MAX_TOKENS` constant, non-gmail isolation test omits transcript/`claude-code`/merged-mode sources | None block phase goal; all are true minor gaps worth tracking as follow-up polish, not phase-blocking. |

No unresolved `TBD`/`FIXME`/`XXX` debt markers found in the phase's modified files (checked directly, not from SUMMARY claims).

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| Full phase test suite (7 files) actually passes | `npx vitest run tests/claim-extractor-intent.test.ts tests/claim-extractor-temporal.test.ts tests/extraction-prompts-intent.test.ts tests/no-ats-domain-table.test.ts tests/online-llm-free-sentinel.test.ts tests/consolidation-intent.test.ts tests/intent-conservation.test.ts` | 7 files, 102 tests, all pass | ✓ PASS |
| Typecheck clean | `npm run typecheck` | exit 0, no errors | ✓ PASS |
| No consolidator/consolidation regression | `npx vitest run tests/consolidation.test.ts tests/consolidation-temporal.test.ts tests/hitl-audit-provenance.test.ts` | 3 files, 59 tests, all pass | ✓ PASS |
| No DB schema touched | `grep -n "intent" src/db/schema.ts` | zero matches | ✓ PASS |
| No ATS domain literal anywhere in `src/` | (covered by `tests/no-ats-domain-table.test.ts` real-walk) | `[]` | ✓ PASS |
| `/v1/proposals` genuinely does not exist yet (confirms CLASSIFY-03 scoping is real, not an excuse) | `grep -rn "proposals" src/adapter/serve-cli.ts` | no match | ✓ PASS |
| All cited commit hashes are real | `git log --oneline --all \| grep -E "^(4192bef\|da4345a\|6f1746d\|8c809c9\|d848e81\|6f97eb1\|b6424a3\|01de808\|04e7f91\|531586c\|bb94a9c\|c84f7a7\|19c7960)"` | all 13 found | ✓ PASS |

### Probe Execution

Not applicable — this phase is not a migration/tooling phase with `scripts/*/tests/probe-*.sh` conventions; no probes declared in any PLAN/SUMMARY. Skipped.

### Human Verification Required

### 1. Founder confirmation of the measured prompt-prefix token-cost figure

**Test:** Read `scripts/eval/results/63-intent-prompt-token-delta.json`, confirm `measured:true` reflects a genuine two-call `claude -p` run against the Max subscription, confirm the `+597` token / `+117.52%` delta quoted verbatim in `63-06-SUMMARY.md` matches the JSON exactly (no rounding, annualizing, or extrapolation), and confirm willingness to defend the figure per CLAUDE.md's no-inflated-metrics hard rule. Reply "approved" or identify a discrepancy (which should trigger a harness re-run, not a text edit, per the plan's own instruction).
**Expected:** Founder either approves the figure as-is, or flags a specific problem that the harness (not the SUMMARY text) is re-run to resolve.
**Why human:** This is a `checkpoint:human-verify`, `gate="blocking"` task (Plan 63-06, Task 3), and the plan is explicitly `autonomous: false`. The executor correctly refused to self-approve in an autonomous session (per CLAUDE.md's no-inflated-metrics rule — an agent affirming its own cost claim would be exactly the kind of unchecked number the rule exists to prevent), and this verifier — also an agent — cannot approve on the founder's behalf either. This is not a code gap: the measurement is real, honest, and already committed (`measured:true`, `+597` tokens, `+117.52%`); what remains is a human decision, not missing implementation.

### Gaps Summary

No code gaps found. All four ROADMAP Success Criteria for Phase 63 are observably true in the live codebase — verified by direct file reads, greps against actual source (not SUMMARY prose), and running all 7 phase-scoped test files (102/102 pass) plus 3 regression-sensitive neighbor suites (59/59 pass) directly in this verification pass, not taken on faith from any SUMMARY.md.

The phase's advisory `63-REVIEW.md` findings (0 critical, 3 warnings, 5 info) were independently cross-checked against live source and confirmed non-blocking for Phase 63's own goal — they identify real forward risk for Phases 64-66 (particularly WR-01's source-agnostic threading) worth carrying into Phase 64 planning, but none constitute an unmet Phase 63 truth.

The single open item is Plan 63-06's Task 3: a blocking founder-approval checkpoint on the honestly-measured token-cost figure. This is intentional incompleteness per the plan's own design (autonomous:false, gate="blocking") and CLAUDE.md's no-inflated-metrics rule — not a fabricated pass, not a stub, not a missing artifact. It routes to `human_needed` status rather than `passed` per the verification decision tree (Step 9, rule 2: any human verification item present forces `human_needed` regardless of truth-verification score).

---

_Verified: 2026-08-02T21:21:48Z_
_Verifier: Claude (gsd-verifier)_
