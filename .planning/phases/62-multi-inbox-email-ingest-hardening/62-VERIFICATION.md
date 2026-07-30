---
phase: 62-multi-inbox-email-ingest-hardening
verified: 2026-07-29T23:22:00Z
status: gaps_found
score: 4/5 must-haves verified
overrides_applied: 0
gaps:
  - truth: "An older message in a backfill batch cannot silently apply over newer state — proven end-to-end, not just at the sort seam (EMAIL-04, roadmap SC #4 / plan 62-05 must-have #2 and T-62-36)"
    status: partial
    reason: >
      The underlying production mechanism genuinely works — independently verified by writing a
      content-keyed ModelProvider stub (extraction value derived from the episode's own content
      marker, not from call order) and running it against the real Consolidator both with and
      without the orderEpisodesForConsolidation wiring in src/consolidation/consolidator.ts:532.
      With the wiring present, the newer episode's content correctly survives; with the wiring
      removed, the older episode's content incorrectly survives. So EMAIL-04's actual behavior is
      real and correct.
      However, the shipped regression test that is supposed to be "the EMAIL-04 end-to-end proof"
      (tests/backfill-chronological-order.test.ts, first `it()` block) does NOT discriminate on
      this wiring. Its DynamicReconcileProvider.generate() returns extraction values from a fixed
      script indexed by CALL ORDER (script[0] = OLDER_VALUE, script[1] = NEWER_VALUE), not derived
      from which physical episode (older-content vs newer-content) is actually being processed.
      Combined with the codebase's genuine "second-processed episode wins" reconcile-last-applied
      semantics, the test's core assertion (`currentNodes[0]!.value === NEWER_VALUE`) is TRUE
      regardless of whether orderEpisodesForConsolidation is wired into consolidate() at all.
      Verified directly: reverting src/consolidation/consolidator.ts:532 to the bare
      `this.episodes.listUnconsolidated()` (no reorder) still leaves this test GREEN. A silent
      future regression that drops the wiring would not be caught by this test suite — the exact
      failure mode (T-62-36, "a green test that proves nothing") the plan explicitly called out and
      tried to guard against, but the guard itself is not effective for the primary assertion.
      The isolated unit tests in tests/episode-order.test.ts (10/10) correctly and rigorously test
      orderEpisodesForConsolidation as a pure function (permutation, slot-preservation, idempotence,
      the T-62-30 null-never-moves security case) — that half of the proof is solid. It is only the
      end-to-end wiring proof through the real Consolidator that is compromised.
    artifacts:
      - path: "tests/backfill-chronological-order.test.ts"
        issue: >
          DynamicReconcileProvider.generate() (lines 110-147) assigns extraction values by array
          index / call order rather than by episode content or identity, so the first `it()` block
          (lines 159-237) passes identically whether or not src/consolidation/consolidator.ts:532
          actually calls orderEpisodesForConsolidation. Confirmed by three independent
          break/restore cycles during verification.
    missing:
      - "Rewrite DynamicReconcileProvider.generate() (or add a second provider) to derive the extracted claim VALUE from the episode CONTENT actually passed in the prompt (e.g. a distinguishing marker string per episode), not from call-order index, so the test fails when the reorder wiring is removed or reverted."
      - "Re-verify the rewritten test fails against a deliberately-reverted src/consolidation/consolidator.ts:532 before considering this closed."
human_verification: []
---

# Phase 62: Multi-Inbox Email Ingest Hardening Verification Report

**Phase Goal:** A user can onboard a second Gmail account through a guided flow and scope each inbox's initial backfill independently, and no hidden/attacker-controlled content from either inbox can reach a future classifier.
**Verified:** 2026-07-29T23:22:00Z
**Status:** gaps_found
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth (roadmap SC) | Status | Evidence |
|---|---|---|---|
| 1 | User can authorize an additional Google account through a guided CLI flow (loopback OAuth redirect) that mints and stores `GOOGLE_<ID>_REFRESH_TOKEN` without hand-rolling OAuth or hand-editing env files (EMAIL-01) | ✓ VERIFIED | `recense gmail-auth <id>` dispatched from `src/adapter/recense.ts:152` (`case 'gmail-auth': spawnScript('gmail-auth-cli.js', process.argv.slice(3))`), listed in `Commands:` usage. `src/adapter/gmail-auth-cli.ts` implements loopback catcher (`127.0.0.1`, ephemeral port, `timingSafeEqual` state check), `access_type: 'offline'`/`prompt: 'consent'`, and persists via the reused `writeEnvFile`. `planEnvUpdate` writes exactly `GOOGLE_<ID>_REFRESH_TOKEN` + `RECENSE_GOOGLE_ACCOUNTS` (verified in source at lines 215-224) — the identical contract 62-01's `resolveGoogleAccounts` reads, confirmed by direct source read, not just SUMMARY narration. 38/38 + 32/38 relevant tests pass. |
| 2 | User can set a per-account Gmail query scoping that account's initial backfill independently; the backfill-only limitation is stated in the config doc comment AND surfaced by `recense doctor`, never implied away (EMAIL-02) | ✓ VERIFIED | `src/lib/config.ts:645-654` doc comment states, in full prose, the backfill-only limitation, names `users.history.list`, both env vars, and `sourceWeights.gmail`/`consolSkipThresholdBySource.gmail` dampening — genuinely explains the mechanism, not just a keyword hit. `src/adapter/recense-doctor.ts:367-397` `checkGmailAccounts` appends a substantive limitation sentence ("a per-account query bounds that account's initial backfill only — users.history.list accepts no q, so incremental pulls are unfiltered") on BOTH pass and fail paths, plus per-account token-presence/query-provenance detail. A real user running `recense doctor` would genuinely learn the limitation, not just satisfy a grep. Confirmed the earlier wording defect (commit `f26dba9`, uppercase-only phrasing) was corrected. |
| 3 | Hidden/invisible content in HTML-only emails is deterministically stripped before reaching the extractor, verified by a regression fixture with a hidden injected instruction that must not survive into episode content (EMAIL-03) | ✓ VERIFIED | `tests/fixtures/gmail-hidden-injection.html` contains a `display:none` div payload, a `<style>`-class-hidden span payload, and a zero-width-joined ("T​H​I​R​D") payload — all three named mechanisms (display:none, hidden spans, zero-width chars). `tests/gmail-hidden-content.test.ts` asserts against `normalizeGmailMessage(...).content` (episode content, not the stripper's raw return value) that none of the three payloads, no stray U+200B, and no markup survive, while visible prose and the provenance header do. `src/source/strip-hidden.ts` is a pure, zero-import, 8-stage compile-once-regex module. Two residuals (white-on-white, external stylesheet) are named as accepted, not silently omitted. |
| 4 | A fresh account's initial backfill batch is consolidated in chronological order (derived from the `Date:` header), so an older message cannot silently apply over newer state (EMAIL-04) | ⚠ PARTIAL (see gap) | `episode.event_ts` column, `parseEmailDate` (confident-or-null, 48h future-skew clamp), and `orderEpisodesForConsolidation` (pure, slot-preserving, permutation-safe, wired at `consolidator.ts:532`) all genuinely exist and were independently verified to work correctly end-to-end (see gap detail: a custom content-keyed provider proves the real `Consolidator` produces the correct newer-wins outcome with the wiring present and the wrong outcome with it removed). However, the SHIPPED end-to-end regression test (`tests/backfill-chronological-order.test.ts`) does not actually discriminate on the wiring — it passes identically whether or not the fix is applied, because its mock provider assigns extraction values by call order rather than by episode identity. The feature works; its designated end-to-end proof does not prove it. |
| 5 | (Implicit, out-of-scope guard) DRIFT-03/DRIFT-04 items (`session_id: 'ingest:gmail'`, `countDistinctProvenance`, `contradictionN`, `routeContradiction`, `labelId` incremental filtering, bi-temporal columns) are untouched | ✓ VERIFIED | `git log` shows `src/consolidation/update-decision.ts` last touched at `fb09293` (pre-phase-62, phase 14). No `ingest:gmail` string anywhere in `src/`. No `labelId` reference in gmail-adapter/runtime-config. `schema.ts:275` bi-temporal-DEFER comment confirms only the single additive `event_ts` column was added, no validity-interval model. |

**Score:** 4/5 truths fully verified; 1 partially verified (feature works, its regression proof does not).

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `src/adapter/runtime-config.ts::resolveGoogleAccounts` | env-driven multi-account resolution | ✓ VERIFIED | Exists, fail-safe posture, anti-drift test against `DEFAULT_CONFIG.googleAccounts` |
| `src/lib/config.ts::googleAccounts` doc comment | honest backfill-only limitation | ✓ VERIFIED | Substantive prose, not just grep-satisfying |
| `src/source/gmail-adapter.ts::resolveAccountQuery` | per-account query w/ fallback | ✓ VERIFIED | `GmailAdapter.pull()` calls it; `config.gmail.query` reference remains only inside the fallback |
| `src/adapter/recense-doctor.ts::checkGmailAccounts` | dimension 9 | ✓ VERIFIED | Registered in `runDoctor`, never leaks token/query values |
| `src/adapter/gmail-auth-cli.ts` | guided onboarding CLI | ✓ VERIFIED | Exports match plan; loopback/state/scope all source-asserted and test-covered |
| `src/source/strip-hidden.ts` | deterministic stripper | ✓ VERIFIED | 420 lines, zero imports, 8-stage pipeline, module-scope regex |
| `tests/fixtures/gmail-hidden-injection.html` | named regression fixture | ✓ VERIFIED | Contains all three named hiding mechanisms + visible sentence |
| `src/db/schema.ts::event_ts` | additive nullable column | ✓ VERIFIED | `SCHEMA_VERSION = 16`, guarded `ALTER TABLE`, 62 tests exercise it |
| `src/source/gmail-adapter.ts::parseEmailDate` | attacker-hostile Date parse | ✓ VERIFIED | Confident-or-null, 48h future clamp, 1990 floor, no clock read inside pure fn |
| `src/consolidation/episode-order.ts::orderEpisodesForConsolidation` | slot-preserving reorder | ✓ VERIFIED | Pure, permutation-safe, non-mutating, correctly wired at `consolidator.ts:532` |
| `tests/backfill-chronological-order.test.ts` | EMAIL-04 end-to-end proof | ⚠ HOLLOW | Exists, asserts the right things about the *pure function* (bare-order precondition, reorder differs from bare order), but its production-path assertion (`currentNodes[0]!.value === NEWER_VALUE`) is invariant to whether the wiring is present — see gap |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `src/adapter/ingest-cli.ts` | `resolveGoogleAccounts` | config construction in `main()` | ✓ WIRED | `googleAccounts: resolveGoogleAccounts()` present |
| `src/source/gmail-adapter.ts` | `config.googleAccounts[].query` | `pull()` → `resolveAccountQuery` | ✓ WIRED | Confirmed no direct `this.config.gmail.query` reference remains in `pull()` |
| `src/adapter/gmail-auth-cli.ts` | `writeEnvFile` | reused atomic env writer | ✓ WIRED | `planEnvUpdate` → `writeEnvFile(sleepEnvPath(), ...)` |
| `src/adapter/recense.ts` | `gmail-auth-cli.js` | dispatcher case | ✓ WIRED | `case 'gmail-auth'` confirmed, single hit |
| `src/source/gmail-adapter.ts` | `stripHiddenContent` | `normalizeGmailMessage` before `redactSecrets` | ✓ WIRED | Source-order regression test confirms ordering |
| `src/adapter/ingest-cli.ts` | `IngestionPipeline.recordEvent` | `eventTs: r.event_ts ?? null` | ✓ WIRED | Confirmed in `runPullPhase` |
| `src/consolidation/consolidator.ts` | `orderEpisodesForConsolidation` | wraps `listUnconsolidated()` | ⚠ WIRED-BUT-UNPROVEN | Wiring genuinely present and correct (independently verified via a content-keyed provider), but the designated regression test does not exercise this link discriminatingly — see gap |

### Data-Flow Trace (Level 4)

Not applicable in the UI-rendering sense (this phase has no frontend component); the equivalent trace was performed at the mechanism level above (event_ts → orderEpisodesForConsolidation → consolidate() → node value), and is where the one substantive gap was found.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| `recense doctor` honestly surfaces backfill-only limitation | Read `checkGmailAccounts` source directly | Substantive prose naming `users.history.list`, dampening weights | ✓ PASS |
| EMAIL-03 fixture hides via named mechanisms and survives-check is on episode content | Read fixture + test assertions | Confirmed `record.content` (not raw stripper output) is asserted | ✓ PASS |
| EMAIL-04 wiring correctness | Custom content-keyed `ModelProvider`, break/restore `consolidator.ts:532` 3x | Correct output with wiring, wrong output without | ✓ PASS (mechanism) |
| EMAIL-04 shipped regression test discriminates on wiring | Break/restore `consolidator.ts:532`, re-run `tests/backfill-chronological-order.test.ts` | Test passes in BOTH states | ✗ FAIL (test is non-discriminating) |
| Full suite regression | `npx vitest run` (orchestrator-run) | 2858 passed / 3 skipped / 0 failed | ✓ PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|---|---|---|---|---|
| EMAIL-01 | 62-02 | Guided CLI OAuth onboarding | ✓ SATISFIED | Dispatcher + helper core + tests, verified above |
| EMAIL-02 | 62-01 | Per-account query scoping, honest limitation | ✓ SATISFIED | Doc comment + doctor dimension 9, verified substantively honest |
| EMAIL-03 | 62-03 | Hidden-content stripping | ✓ SATISFIED | Fixture + episode-content assertion, verified |
| EMAIL-04 | 62-04, 62-05 | event_ts + chronological consolidation | ⚠ PARTIAL | Mechanism verified correct independently; shipped end-to-end proof does not discriminate on the wiring it claims to prove |

No orphaned requirements: REQUIREMENTS.md maps exactly EMAIL-01..04 to phase 62, and all four appear in plan frontmatter (`requirements:` fields across 62-01..05).

### Anti-Patterns Found

No `TBD`/`FIXME`/`XXX` markers found in phase-62-touched files. No placeholder/stub returns. `TODO`/`HACK` scan against the phase's touched files returned nothing load-bearing. The schema-version stale-literal gate (`grep -rnE "to(Be|Equal)\(['\"]?15['\"]?\)" tests/`) returns 0 as previously confirmed by the orchestrator.

The one substantive anti-pattern found is the vacuous-test issue described above (`tests/backfill-chronological-order.test.ts`'s `DynamicReconcileProvider` script-order-keyed extraction), categorized as:

| File | Line | Pattern | Severity | Impact |
|---|---|---|---|---|
| `tests/backfill-chronological-order.test.ts` | 110-147, 200-208 | Mock provider assigns extraction value by call-order index rather than by episode identity/content | 🛑 Blocker (for the specific must-have "proven end-to-end") | A future regression that silently removes `orderEpisodesForConsolidation` from `consolidator.ts:532` would not be caught by any test in the suite; the isolated `episode-order.test.ts` tests the pure function only, and this file's assertion is order-invariant, not wiring-dependent |

### Human Verification Required

None. This gap is independently, programmatically confirmed (reproduced 3x via direct source-level break/restore), not a matter of subjective judgment.

### Gaps Summary

Four of the five roadmap success criteria are fully and substantively achieved — EMAIL-01, EMAIL-02, and EMAIL-03 are all solid, with EMAIL-02 in particular passing the "would a real user actually learn this" bar rather than merely grep-satisfying it, and EMAIL-03's fixture genuinely exercises episode content rather than the stripper's raw return value.

EMAIL-04 is more nuanced: the underlying mechanism (episode.event_ts, parseEmailDate's attacker-hostile clamp, and the slot-preserving orderEpisodesForConsolidation reorder wired into Consolidator.consolidate()) is real, correctly implemented, and was independently verified to function correctly end-to-end using a custom content-keyed test provider. The gap is narrower and more surgical than "the feature doesn't work" — it is that the specific artifact the plan designated as "the EMAIL-04 end-to-end proof... not just at the sort seam" (tests/backfill-chronological-order.test.ts) fails to actually prove the production wiring, because its scripted mock provider assigns extracted claim values by call order rather than by which physical episode is being processed. This was verified by three independent break/restore cycles against the real source: the test stays green whether or not the wiring line at consolidator.ts:532 is present.

This matters because the plan's own threat model named this exact failure mode (T-62-36, "a green test that proves nothing") as something to guard against, and its own SUMMARY frontmatter records a deviation about the fixture's salience pairing without noticing the deeper issue that the mock's extraction-by-call-order design defeats the wiring proof regardless of the salience pairing chosen.

**Recommended fix:** rewrite `DynamicReconcileProvider.generate()` to derive the extracted claim's value from a marker embedded in the episode content actually passed into the prompt (mirroring the manual verification test written during this audit), so the assertion becomes wiring-dependent, then re-confirm it fails against a deliberately-reverted `consolidator.ts:532`.

This is scoped as a small, targeted test-fix — not a rearchitecture — and does not implicate the production code, the schema, the OAuth flow, or the stripper, all of which verified cleanly.
