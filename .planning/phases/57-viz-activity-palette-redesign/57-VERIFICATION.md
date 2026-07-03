---
phase: 57-viz-activity-palette-redesign
verified: 2026-07-03T19:35:00Z
status: human_needed
score: 9/9 must-haves verified
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 7/9
  gaps_closed:
    - "Amber (HOT_COLOR) is reserved exclusively for live retrieval/hover (CR-02) — replayed non-recall rows now resolve to KIND_COLORS.neutral, both client-side (trace.js) and server-side (server.ts admission guard)"
    - "Trace reveal/fade cleanup does not permanently leak node visibility state (CR-01) — all five _applyIngestion add-sites now schedule their own scoped fade, and focusNode's comment was corrected to state its true sticky-until-reload semantics instead of a false fade-back claim"
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "Founder re-observes an idle replay of a consolidation event (ingestion kind, e.g. oscillation or neutral) and confirms it renders in the neutral slate hue, never amber; separately leaves the tray running for an extended session and confirms previously-revealed nodes/links return to LOD-hidden after their fade window (excluding any node reached via explicit focusNode, which is deliberately sticky-until-reload)."
    expected: "Neither the amber flash nor the permanent-leak behavior recurs. Founder either re-affirms the existing Stage-1/Stage-2 sign-offs now that the underlying code matches what was originally shown, or flags a fresh concern."
    why_human: "This is a visual/behavioral judgment call on code that changed after the founder's original Stage-1/Stage-2 approvals (docs/superpowers/evidence/57-stage1-palette/, 57-stage2-system/) — those checkpoints signed off on a system that (unknown to the founder at the time) contained CR-01/CR-02. The fixes are now independently verified in code and by regression test, but the founder has not yet visually re-observed the corrected behavior. The 57-08-SUMMARY.md explicitly flags this as an open item."
---

# Phase 57: viz activity-palette redesign — Verification Report (Re-Verification)

**Phase Goal:** Redesign the viz activity color system so hue carries IDENTITY and salience comes from motion/scale/density — never from brightness-scaling saturated hues. Approach: (1) luminance-equalized identity palette in a bounded band with a new replay identity hue; (2) SC3 salience ordering (live > replay > spontaneous > twinkle) expressed through machine-checkable motion/scale constants; (3) one bloom/tone-mapping calibration pass against the real hull; (4) founder visual checkpoints close it. Honesty constraints untouched — presentation layer only.

**Verified:** 2026-07-03T19:35:00Z
**Status:** human_needed
**Re-verification:** Yes — after gap-closure plan 57-08 (commits a72feec, 194de76, f613f0d)

## Goal Achievement

This re-verification independently re-checked both previously-FAILED truths (CR-01, CR-02) at full depth (exists / substantive / wired / behaviorally tested), and did a regression pass on the 7 previously-VERIFIED truths plus the 1 PARTIAL. All findings below are from direct code reads and test execution in this session — not from trusting 57-REVIEW.md's or 57-08-SUMMARY.md's narrative.

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | VIZ-PAL-01: Luminance-equalized identity palette — 8 KIND_COLOR entries (incl. replay hue) inside the locked band; oscillation off amber-family | VERIFIED (regression) | `constants.js:176` oscillation=`0xe89c9c` (coral), `:183` neutral=`0xaab3c4`, `:202` replay=`0xb3ecf5` — unchanged since prior verification; confirmed present |
| 2 | VIZ-PAL-02: SC3 salience re-expressed as per-layer motion profiles, wired into activate() calls, not just constants | VERIFIED (regression) | Unchanged from prior verification; not touched by 57-08 (57-08 only touched trace.js's replay-branch color resolution and _applyIngestion fade scoping, confirmed by diff scope in 57-08-SUMMARY key-files) |
| 3 | VIZ-PAL-03: Single shared source of truth for scheduler constants | VERIFIED (regression) | `server.ts` `parseSchedulerScalars()` untouched by 57-08; still source-parses `constants.js` |
| 4 | VIZ-PAL-04 (literal): own-trace-scoped fades in the three original branches (live, replay, spontaneous) | VERIFIED (regression) | Still 0 `.clear()` calls; original 3 `.delete()` sites at trace.js:760/844/948 intact |
| 5 | Trace reveal/fade cleanup does not permanently leak node visibility state (CR-01) | **VERIFIED (fixed)** | Independently re-read all five `_applyIngestion` branches (trace.js:958-1099): `new_node` (976/986), `oscillation` (990/1005-1013), `reconsolidation` seed+candidate (1036/1053, 1060 covered by same 1053 forEach), `neutral fallback` (1083/1092) — each now has its own scoped `setTimeout(() => { ctx.traceNodes.delete(...); ... }, fadeMs)` that deletes only that branch's own added id(s), mirroring the three pre-existing branches. `grep -c 'ctx.traceNodes.delete('` in trace.js = 9 occurrences (7 call-sites; reconsolidation's forEach counts as 1 site deleting 1-2 ids), `clear()` = 0. `detail.js:424-430` focusNode's comment was rewritten to honestly state the reveal is sticky-until-reload, user-driven, and explicitly distinguished from the automatic per-trace fades — the previously-false "next trace's fade-back may re-hide it" claim is gone (grep for "next trace" in detail.js = 0 matches). New regression test `tests/viz-ambient-liveliness.test.ts:728-...` ("CR-01: an ingestion-kind trace bounds ctx.traceNodes") fires a `kind:'new_node'` trace, asserts add to `traceNodes`, invokes the scheduled fade callback, asserts `traceNodes.size === 0` afterward — ran it directly, passes. |
| 6 | Amber stays reserved for live retrieval/hover (D-04) — no replayed ingestion kind ever renders amber (CR-02) | **VERIFIED (fixed)** | Independently re-read trace.js:731-732: `const seedColor = isRecallReplay ? KIND_COLORS.recall_seed : KIND_COLORS.neutral;` / same pattern for `hopColor` — no `undefined` branch remains, so `activate()`'s `kindColor \|\| HOT_COLOR` fallback (line ~369) can never fire from the replay path. Server-side defense-in-depth also added: `server.ts:492` `(row.kind == null \|\| row.kind === 'recall')` gates the replay ring buffer admission, keeping ingestion-kind rows out entirely. New regression test `tests/viz-ambient-liveliness.test.ts:698-726` ("CR-02: a replayed ingestion-kind row activates its seed at KIND_COLOR.neutral, never HOT amber") fires a `replay:true, kind:'oscillation'` trace and asserts `__actColor` matches neutral and does not match HOT — ran it directly, passes. |
| 7 | VIZ-PAL-05: One dedicated invariants test file owns all palette/motion locks | VERIFIED (regression) | `tests/viz-activity-palette-invariants.test.ts` unchanged by 57-08; re-ran, all green |
| 8 | VIZ-PAL-06: Global bloom/tone-mapping calibration; single composer | VERIFIED (regression) | `effects.js` untouched by 57-08; unchanged since prior verification |
| 9 | VIZ-PAL-07: Two-stage founder checkpoint with provisional values ratcheted to locks | PARTIAL — routed to human verification | Both Stage-1/Stage-2 checkpoints remain approved as recorded in `docs/superpowers/evidence/57-stage1-palette/` and `.../57-stage2-system/` (unchanged by 57-08). However, the underlying code the founder approved has since been corrected for CR-01/CR-02 — the founder has not yet re-observed the corrected behavior. This item is not a code defect; it is an open founder-facing follow-up explicitly flagged in 57-08-SUMMARY.md's "Next Phase Readiness" section. |

**Score:** 9/9 truths pass code-level verification (0 FAILED). 1 of the 9 (VIZ-PAL-07) carries an open human-verification item that must resolve before the phase can be marked fully `passed`.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/viz/modules/constants.js` | 8-hue luminance-banded palette + motion profiles | VERIFIED | Unchanged, re-confirmed |
| `src/viz/modules/trace.js` | Replay identity hue wired; own-trace-scoped fades (now 7 sites); neutral fallback for non-recall replay | VERIFIED | Both CR-01 and CR-02 fixes independently re-read and confirmed correct; 1145 lines, no debt markers |
| `src/viz/modules/detail.js` | focusNode reveal lifetime documented truthfully | VERIFIED | Comment at lines 415-430 rewritten; matches actual sticky-until-reload behavior; no stale claim remains |
| `src/viz/server.ts` | Sole scheduler-scalar source-parse; replay ring buffer with kind filter | VERIFIED | `server.ts:492` kind-filter admission guard confirmed present and correctly scoped (does not touch live SSE emission) |
| `src/viz/modules/effects.js` | Recalibrated bloom, single composer | VERIFIED (regression) | Untouched by 57-08 |
| `src/viz/modules/graph.js` | Exposure/tone-mapping calibration surface documented | VERIFIED (regression) | Untouched by 57-08 |
| `tests/viz-activity-palette-invariants.test.ts` | D-10/D-02/D-06/D-05 invariants | VERIFIED | Re-ran: all green |
| `tests/viz-ambient-liveliness.test.ts` | CR-01/CR-02 behavioral regression tests (new) | VERIFIED | Two new tests present at lines 698-726 (CR-02) and 728+ (CR-01); both independently re-run and pass; count went from 46 to 48 tests in this file (79 total across both invariant files, up from 77) |
| `docs/superpowers/evidence/57-stage1-palette/`, `.../57-stage2-system/` | Durable founder approval evidence incl. screenshots | PARTIAL (unchanged) | `APPROVAL.md`+`TRIGGER-STEPS.md` exist; screenshots still absent (disclosed, not a 57-08 scope item, not re-litigated here) |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `trace.js` replay branch | `activate()` `__actColor` | `seedColor = isRecallReplay ? KIND_COLORS.recall_seed : KIND_COLORS.neutral` | VERIFIED | Exact pattern confirmed at trace.js:731-732, matches 57-08-PLAN's key_link `pattern` regex |
| `trace.js` `_applyIngestion` add-sites | `ctx.traceNodes.delete` | scoped `setTimeout` per branch | VERIFIED | All 5 branches confirmed; `grep -c 'ctx.traceNodes.delete('` = 9 (up from 3) |
| `ctx.traceNodes` | `lod.js:192` `nodeVisible` predicate | `traceNodes.has(n.id)` | VERIFIED (bounded) | Now correctly bounded for all automatic reveal paths; `focusNode`'s user-driven reveal is the sole permanent-until-reload exception, and is now honestly documented as such (not a leak — a deliberate design decision) |
| `server.ts` replay buffer | `trace.js` replay branch | `row.kind` filter | VERIFIED | `server.ts:492` admission guard confirmed; defense-in-depth alongside the client-side neutral fallback |

### Data-Flow Trace (Level 4)

Re-walked the seed-color resolution path end-to-end (server.ts row admission → SSE payload → trace.js replay branch → activate() color assignment): a replayed `kind:'oscillation'` row is now rejected at the server admission guard (`server.ts:492`) before it ever reaches the replay buffer; even if it somehow arrived client-side (bypassing the server guard, e.g. via a stale buffer entry from before the fix), `isRecallReplay` would be `false` and `seedColor` would resolve to `KIND_COLORS.neutral`, never `undefined` → never `HOT_COLOR`. Two independent layers both correctly resolve to non-amber. Re-walked the traceNodes lifecycle (add → visibility predicate → delete): all 5 automatic ingestion add-sites now have a matching scoped delete; the only unmatched add-site (`detail.js:430` focusNode) is a documented, deliberate, user-driven exception — not an unbounded/automatic leak.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| CR-01 + CR-02 regression tests + full invariant/liveliness suite | `npx vitest run tests/viz-ambient-liveliness.test.ts tests/viz-activity-palette-invariants.test.ts` | 79/79 tests passed (independently re-ran) | PASS |
| Full project test suite (regression check for any collateral breakage from 57-08) | `npx vitest run` | 2594 passed / 3 skipped (172 test files, 1 skipped) — no failures | PASS |
| TypeScript compiles clean | `npx tsc --noEmit` | Exit 0 | PASS |
| No global clear reintroduced | `grep -c 'ctx.traceNodes.clear()' src/viz/modules/trace.js` | 0 | PASS |
| Scoped delete sites present (CR-01) | `grep -c 'ctx.traceNodes.delete(' src/viz/modules/trace.js` | 9 (>= 7 required) | PASS |
| Neutral fallback present, no undefined path (CR-02) | `grep -n 'KIND_COLORS.recall_seed : KIND_COLORS.neutral' src/viz/modules/trace.js` | 1 match (+1 for hopColor) | PASS |
| Server admission guard present | `grep -n "row.kind === 'recall'" src/viz/server.ts` | Found inside `replayBuffer.push` guard at line 492 | PASS |
| Git commits for 57-08 exist in history | `git log --oneline` for a72feec, 194de76, f613f0d | All three present with expected commit messages | PASS |
| No debt markers introduced | `grep -n 'TBD\|FIXME\|XXX'` on all 4 modified files | 0 matches | PASS |

### Probe Execution

No dedicated probe scripts (`scripts/*/tests/probe-*.sh`) exist for this phase — SKIPPED (no runnable entry points beyond the vitest suite already exercised above; consistent with the prior verification's disposition).

### Requirements Coverage

Unchanged disposition from the initial verification: this phase's requirement IDs (`VIZ-PAL-01`..`07`) were derived directly in `ROADMAP.md`'s Phase 57 entry (2026-07-02), as a founder-requested insertion outside the "v9.0 Memory Quality" milestone that `.planning/REQUIREMENTS.md` is scoped to. `grep -n "VIZ-PAL" .planning/REQUIREMENTS.md` returns zero matches — expected, not an omission, since ROADMAP.md's own Phase 57 section is the authoritative requirement record for this ad hoc phase and fully enumerates VIZ-PAL-01..07. No requirement IDs are orphaned: all 7 appear in ROADMAP.md, and all 7 are traced below.

| Requirement | Source Plan(s) | Description | Status | Evidence |
|---|---|---|---|---|
| VIZ-PAL-01 | 57-02, 57-03, 57-08 | Luminance-equalized identity palette; oscillation off amber-family | SATISFIED | 8-hue band verified (regression); 57-08 additionally closes the CR-02 amber-leak-via-fallback path that would have violated this requirement's amber-exclusivity intent at runtime |
| VIZ-PAL-02 | 57-04, 57-06, 57-07, 57-08 | Per-layer motion profiles + monotonic ordering + dim floors | SATISFIED | Verified above (regression); 57-08 does not touch motion-profile wiring itself, only the replay branch's color resolution and ingestion fade scoping, both within scope of the D-06 salience system |
| VIZ-PAL-03 | 57-01 | Shared scheduler-constant source of truth | SATISFIED | Verified above (regression) |
| VIZ-PAL-04 | 57-06, 57-08 | Own-trace-scoped fades — ALL trace-adding branches, not leaking visibility state | SATISFIED | CR-01 fix extends the WR-06 pattern from 3 to all automatic branches; this is the requirement's full realization — the initial verification's "SATISFIED (literal) / BLOCKED (system property)" split is now fully SATISFIED |
| VIZ-PAL-05 | 57-01, 57-02, 57-04, 57-08 | Dedicated invariants/regression test coverage | SATISFIED | 79 tests across the two dedicated files (up from 77), now including the WR-03-class CR-01/CR-02 behavioral locks |
| VIZ-PAL-06 | 57-05, 57-07 | Bloom/exposure calibration, single composer | SATISFIED | Verified above (regression) |
| VIZ-PAL-07 | 57-03, 57-07 | Two-stage founder checkpoint | PARTIAL | Checkpoints exist and were approved on the pre-fix code; founder has not yet re-observed the CR-01/CR-02-corrected behavior — routed to human verification, not a code gap |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/viz/modules/trace.js` | 333-344 vs 365 | Halo coalesce path lacks the node-envelope's lower-level guard (WR-01, carryover, out of 57-08 scope) | Warning | Latent logic asymmetry; a lower-salience activation can shrink/recolor an in-flight higher-salience halo. Non-blocking per review; explicitly deferred, not part of this phase's must-haves |
| `src/viz/modules/trace.js` | 757-762, 841-846, 945-950, 984-989, 1009-1015, 1048-1056, 1089-1095 | Own-trace-scoped fades are delete-by-id on a Set, not refcounted (WR-02, carryover, surface grew from 3 to 7 sites but same class, out of 57-08 scope) | Warning | Overlapping traces sharing a node id can transiently clobber each other's fade (re-hide too early) — transient, not a permanent leak; explicitly deferred |
| `tests/viz-activity-palette-invariants.test.ts` | whole file | No behavioral test asserts motion profiles (attack/halo/scale) are wired end-to-end via activate() args, beyond CR-01/CR-02's narrower scope (WR-03, carryover, out of 57-08 scope) | Warning | Silently deleting the profile 4th arg from a non-replay activate() call would still pass the full suite |
| `src/viz/server.ts` | 87-98 | `parseSchedulerScalars` regex captures first numeric token, not full initializer — silent mis-parse risk for expression-valued or comment-shadowed constants (WR-04, new in 57-REVIEW re-review, not part of 57-08's task scope) | Warning | Not currently incorrect (all 7 values are plain integer literals); latent risk if any constant is ever refactored to an expression |
| `src/viz/modules/trace.js` | 610-643 | Twinkle rotation doesn't restore outgoing subset to `__hazeBase`, amplified by this phase's `TWINKLE_AMP` raise (WR-05, new in 57-REVIEW re-review, pre-existing defect from Phase 54, not part of 57-08's task scope) | Warning | Frozen steel-blue tint accumulates across the haze cloud over idle time; pre-existing, but this phase's amplitude change roughly doubled its magnitude |

No `TBD`/`FIXME`/`XXX` debt markers found in any file modified by this phase (initial phase or 57-08 gap closure). WR-01/WR-02/WR-03 were explicitly out of scope for 57-08 per its plan's "Scope discipline" instruction and are correctly still present — they were never must-haves for this phase and do not block the phase goal. WR-04/WR-05 are new findings from the fresh code review but likewise are not must-haves for VIZ-PAL-01..07 and do not block phase completion; they are informational carryover risk, not regressions caused by 57-08.

### Human Verification Required

### 1. Founder re-observation of corrected replay/leak behavior

**Test:** Observe an idle replay of a consolidation event (e.g. `oscillation` or `neutral` kind) and confirm it renders in the neutral slate hue, never amber. Separately, leave the tray running for an extended session and confirm previously-revealed nodes/links (other than any reached via explicit focusNode) return to LOD-hidden after their fade window.
**Expected:** Neither the amber flash nor the permanent leak recurs; founder either re-affirms the Stage-1/Stage-2 approvals now that the code matches (or exceeds) what they originally reviewed, or raises a fresh concern.
**Why human:** The founder's Stage-1/Stage-2 sign-offs (docs/superpowers/evidence/57-stage1-palette/APPROVAL.md, 57-stage2-system/APPROVAL.md) were given on code that, unknown to the founder at the time, contained CR-01/CR-02. Those defects are now independently code-verified and regression-tested as fixed in this session, but "does the fix look right in the running tray" is a visual/behavioral judgment this verifier cannot execute — the 57-08-SUMMARY.md itself explicitly flags this as the one remaining open item ("Next Phase Readiness" section) and did not fabricate a founder sign-off for it.

## Gaps Summary

No code-level gaps remain. Both Critical findings from the initial verification (CR-01 permanent traceNodes leak, CR-02 replayed-row amber flash) were independently re-verified as closed in this session — not by trusting 57-REVIEW.md's or 57-08-SUMMARY.md's claims, but by:

1. Directly reading all five `_applyIngestion` branches in `trace.js` and confirming each now has its own scoped fade `setTimeout` that deletes only its own added id(s), with 0 remaining `.clear()` calls and 9 `.delete()` call-sites (up from 3).
2. Directly reading the replay branch's `seedColor`/`hopColor` resolution and confirming both now resolve to `KIND_COLORS.neutral` for non-recall rows (never `undefined` → `HOT_COLOR`), plus a server-side kind-filter admission guard as defense-in-depth.
3. Independently running the two new behavioral regression tests (`tests/viz-ambient-liveliness.test.ts`) and confirming both pass, and that they exercise the actual defect code paths (not tautological).
4. Running the full 79-test invariants/liveliness suite, the full 2597-test project suite (2594 passed / 3 skipped, no failures), and `tsc --noEmit` (clean).
5. Confirming the three 57-08 commits (a72feec, 194de76, f613f0d) exist in git history with the claimed content.

The fresh code review (57-REVIEW.md) independently confirms 0 Critical findings remain; this verification concurs based on direct code inspection rather than deferring to that report.

The phase carries exactly one open item: the founder has not yet visually re-observed the corrected behavior, since the two visual checkpoints (Stage-1, Stage-2) were approved on code that has since changed underneath them for these two specific defects. This is routed to human verification per the escalation-gate pattern, not treated as a code gap — status is `human_needed`, not `gaps_found`, because no artifact, truth, or key link failed independent code-level verification.

---

_Verified: 2026-07-03T19:35:00Z_
_Verifier: Claude (gsd-verifier)_
