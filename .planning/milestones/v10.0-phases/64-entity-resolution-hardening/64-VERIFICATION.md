---
phase: 64-entity-resolution-hardening
verified: 2026-08-02T21:15:00Z
status: passed
score: 14/14 must-haves verified
overrides_applied: 0
---

# Phase 64: Entity Resolution Hardening Verification Report

**Phase Goal:** A classified episode resolves to the correct tracked entity in recense's own graph, or to nothing at all — never to a wrong guess that could corrupt an external system of record recense has no write access to fix.
**Verified:** 2026-08-02T21:15:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Resolution uses broadened candidate generation — exact/entity-keyed ∪ BM25 ∪ dense cosine — never dense-only (RESOLVE-01) | VERIFIED | `src/consolidation/entity-resolution.ts:171-268` `generateCandidates` implements three independent channels deduped by node id; `score = max(lex, dense)` at :260 is structurally load-bearing. Two dedicated tests (`tests/entity-resolution.test.ts:131,144`) prove resolution succeeds with `channelCounts.dense === 0` (lexical-only) and with `lex === 0` on the winning candidate (dense-only). |
| 2 | Confident-or-null: below-floor or too-close-margin candidates abstain, never a best-available guess (RESOLVE-02) | VERIFIED | `resolve()` at `entity-resolution.ts:275-312` returns `below-floor` / `margin-too-close` / `no-candidates` discriminated abstain reasons. `tests/entity-resolution.test.ts:179` (flat-embedder near-duplicate abstains via margin), `:280` (dark-switch floor=2 abstains on every resolve). |
| 3 | Two near-duplicate tracked entities never cross-attribute | VERIFIED | `tests/entity-resolution.test.ts:163` resolves "Acme Corp" to the correct node and never "Acme Consulting" (lex 1.0 vs 0.5, margin 0.5 clears); `:179` proves the inverse — identical scores abstain rather than pick one. `tests/consolidation-resolution.test.ts` repeats this end-to-end through `consolidate()`. |
| 4 | Never-onboarded entity abstains — no node minted, both output fields absent (D-11/D-12) | VERIFIED | `tests/entity-resolution.test.ts:193` asserts abstain + unchanged node count. `tests/consolidation-resolution.test.ts` end-to-end case queries the node table for the untracked name post-pass and expects zero rows. Read-only contract structurally enforced: `entity-resolution.ts`'s only SQL is two `SELECT` statements; comment-stripped grep for `upsertNode|upsertEdge|.strengthen(|.tombstone(|db.transaction` returns `0` (verified live). |
| 5 | Floor and margin are conservative dark config knobs, documented disable values (D-05) | VERIFIED | `src/lib/config.ts:272,283` interface fields; `DEFAULT_CONFIG` at :834-835 ships `entityResolutionFloor: 0.75` / `entityResolutionMargin: 0.15`; JSDoc states disable values (`>1.0` unreachable for floor, `0` not-recommended for margin). |
| 6 | Resolution mutates nothing — full DB snapshot identical before/after, on vs off (D-12/D-09) | VERIFIED | `tests/resolution-conservation.test.ts` (534 lines, 5+ cases): two independent two-pass whole-DB snapshot equalities (floor dark-switch arm and margin dark-switch arm on an identical seeded graph), both with a sanity control proving resolution genuinely fired in the compared pass. Strengthened `snapshotDb` is payload-aware (closes 63-REVIEW WR-02 for these fields) and scans `consolidation_event.payload` for leaked field names/ids. |
| 7 | Resolution makes zero LLM calls by construction (D-04) | VERIFIED | Type-level: `EntityResolver` constructor (`entity-resolution.ts:149`) takes `(db, store, config)` — no `ModelProvider` parameter, confirmed by reading the signature. Runtime belt: `tests/resolution-sentinels.test.ts` asserts `provider.embed/generate/judge/judgeBatch` call counts are equal between a resolving run and an `entityResolutionFloor: 2` control run. |
| 8 | FTS absence degrades gracefully — exact + dense channels still work | VERIFIED | `tests/entity-resolution.test.ts:244` drops `node_fts` and confirms exact-channel resolution still succeeds without throwing; try/catch at `entity-resolution.ts:199-213` wraps the FTS query. |
| 9 | Adversarial descriptor (FTS5 operators/quotes/parens) cannot throw or inject MATCH | VERIFIED | `tests/entity-resolution.test.ts:254` (MATCH injection case); `ftsQueryFromText` is the sole path to the `@q` bound parameter (`entity-resolution.ts:197,200`), never string-concatenated. |
| 10 | WR-01 closure: non-gmail episodes can never smuggle intent fields into resolution (D-10) | VERIFIED | Hoisted `gmailSourced` predicate (`consolidator.ts:716`, strictly after the hard stop at :706) gates all three claim-side fill sites (:824-826, :922-924, :948-950). `tests/intent-source-gate.test.ts` (401 lines, 5 cases, mutation-checked: reverting the gate flips exactly the 3 non-gmail cases to failing). `tests/resolution-sentinels.test.ts` extends this one layer further with a seeded *resolvable* entity on the non-gmail smuggling case, proving the gate — not the resolver's own abstain path — is what blocks resolution, paired with a gmail positive control that does resolve. |
| 11 | hitl/inferred/echo episodes never resolved — branch inherits the hard stop by construction (D-03) | VERIFIED | Resolution branch (`consolidator.ts:1029-1055`) sits textually after the hard stop at :706 inside the same loop iteration, not an independent scan. `tests/resolution-sentinels.test.ts` proves all three sentinel classes never resolve and leave node/edge counts unchanged. |
| 12 | Resolved-entity fields are all-or-nothing; descriptor is the node's own canonical value, never a consumer ID (D-07/D-08/RESOLVE-03) | VERIFIED | Single write point at `consolidator.ts:1048-1049` assigns both fields together; `tests/consolidation-resolution.test.ts` asserts the all-or-nothing invariant as a loop over every captured decision (not per-case) and asserts `claimResolvedEntityDescriptor` via exact `toBe` against the seeded node's `value` string. `resolve()`'s resolved arm returns `nodeId: top.id` (recense-internal) and `descriptor: top.value` (own vocabulary) — no consumer schema referenced anywhere in the module. |
| 13 | Resolution attempts/hits/abstains/per-channel counts observable, logged once per pass (D-06) | VERIFIED | `consolidator.ts:1129` emits one `RESOLVE-64` line with `attempts/hits/abstains` + per-channel totals; observed verbatim in 64-03-SUMMARY.md and 64-04-SUMMARY.md fixture runs: `RESOLVE-64 attempts=1 hits=1 abstains=0 \| exact=1 bm25=1 dense=1`. |
| 14 | No DB schema change (D-09) | VERIFIED | `grep -n "resolved" src/db/schema.ts` returns no matches (confirmed live). `tests/resolution-conservation.test.ts` runtime-enumerates `sqlite_master` for column names containing `resolved`/`claimresolved` and SQL text containing the field names — zero matches. |

**Score:** 14/14 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/consolidation/entity-resolution.ts` | Standalone `EntityResolver`: reusable 3-channel generator + confident-or-null resolve | VERIFIED | 313 lines (>150 min); exports `EntityResolver`, `lexicalScore`, `EntityCandidate`, `ResolutionResult`, `ChannelCounts`, `ChannelName`. |
| `src/lib/config.ts` | `entityResolutionFloor`/`entityResolutionMargin` dark knobs, conservative defaults | VERIFIED | Interface fields :272,283; defaults 0.75/0.15 at :834-835. |
| `src/consolidation/consolidator.ts` | `claimResolvedEntityId`/`Descriptor` fields, resolver instance, resolution branch, D-06 log | VERIFIED | Fields :208,216; `new EntityResolver(` exactly once (:329); `entityResolver.resolve(` exactly once (:1039); `RESOLVE-64` exactly once (:1129). |
| `tests/intent-source-gate.test.ts` | WR-01 3-route smuggling regression + gmail positive control | VERIFIED | 401 lines (>120 min), 5 cases, mutation-checked. |
| `tests/entity-resolution.test.ts` | D-13 unit coverage (near-dup, unknown-abstain, margin-abstain, never-dense-only both directions, read-only, FTS-absent, MATCH-injection) | VERIFIED | 310 lines (>250 min), 17 cases — every D-13 required case present by name. |
| `tests/consolidation-resolution.test.ts` | End-to-end resolution through `consolidate()` across all 3 routes | VERIFIED | 587 lines (>200 min), 8+ cases per SUMMARY, all three decision routes covered, descriptor identity via `toBe`, no-mint proof, all-or-nothing loop, mutation-checked. |
| `tests/resolution-sentinels.test.ts` | hitl/inferred/echo inheritance, WR-01 no-resolution, zero-net-new-LLM sentinel | VERIFIED | 546 lines (>180 min), 6+ cases per SUMMARY. |
| `tests/resolution-conservation.test.ts` | D-09 inertness: 2-pass snapshot equality, schema negatives, payload leak scan | VERIFIED | 534 lines (>200 min), 5+ cases, payload-aware `snapshotDb`, mutation-checked. |
| `tests/intent-conservation.test.ts` | Header extended to cover resolved-entity fields | VERIFIED | Header references both new field names and the companion file; `git diff --stat` (per 64-04-SUMMARY) confined to comment lines. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `consolidator.ts` per-episode loop (after hard stop) | 3 claim-side fill sites | `gmailSourced ternary` | WIRED | `grep -c "gmailSourced ? claim.intent_"` → 9 (3 fields × 3 sites), confirmed. |
| `consolidator.ts` `pendingJudges.push` (site 3) | post-judge `decisionSlots` fill (site 4) | gated values carried through `PendingJudge` | WIRED | `pendingJudges[i]!.claimIntentStatus` etc. present at :1014-1016, inherits site-3 gate by construction. |
| `entity-resolution.ts` | `src/retrieval/topk.ts` | `ftsQueryFromText` + `cosineSimF32` | WIRED | Both imported and used; MATCH argument is exclusively the sanitized `@q` bound param. |
| `entity-resolution.ts` | `src/consolidation/normalize.ts` | `normalizeValue` | WIRED | Imported once, used in `tokenSet`, shared normalizer not reimplemented. |
| `entity-resolution.ts` | `src/db/semantic-store.ts` | `store.resolveEntityByName` | WIRED | Exact/entity-keyed channel calls it at :187. |
| `consolidator.ts` per-episode loop (after post-judge fill) | `EntityResolver.resolve` | branch over `decisionSlots` | WIRED | `entityResolver.resolve(` at :1039, strictly between hard stop (:706) and `decisionSlots.filter(` (:1058). |
| `consolidator.ts` | `entity-resolution.ts` | `new EntityResolver(db, store, config)` | WIRED | Constructor-time instantiation at :329, exactly once. |
| resolution counters | pass log output | `RESOLVE-64` line beside `RECON-03` | WIRED | Confirmed at :1129, observed verbatim in SUMMARY fixture runs. |
| `resolution-conservation.test.ts` | `src/lib/config.ts entityResolutionFloor` | `entityResolutionFloor: 2` (OFF control arm) | WIRED | 2 occurrences confirmed live. |
| `resolution-conservation.test.ts` | `consolidation_event.payload` | explicit substring scan | WIRED | 8 occurrences of `consolidation_event` confirmed live. |

### Data-Flow Trace (Level 4)

Not applicable in the standard sense (no UI/rendering component) — the equivalent trace here is the resolution branch's data flow from episode content → intent fields → resolver → `ClaimDecision`, which is covered end-to-end by `tests/consolidation-resolution.test.ts` running the real `consolidate()` path (not the module in isolation) and asserting exact descriptor identity against a real seeded node's canonical value.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Typecheck clean | `npm run typecheck` | exit 0, no output | PASS |
| Phase-named test set green | `npx vitest run` over 17 named phase/related files | 17 files, 224 tests passed | PASS |
| No schema change | `grep -n "resolved" src/db/schema.ts` | no matches | PASS |
| No ModelProvider param on EntityResolver | read constructor signature | `constructor(db, store, config)` — no provider param | PASS |
| Read-only contract | comment-stripped grep for write primitives | `0` matches | PASS |
| Full suite regression | `npx vitest run` (full 211 files) | 210 passed, 1 skipped; 3467 tests passed, 6 expected-fail, 3 skipped, 0 failed | PASS |

Note: the SUMMARY.md files for all four plans documented 23-24 pre-existing CLI-subprocess/timing failures at the time each plan closed (logged in `deferred-items.md`, none touching phase files). Re-running the full suite now shows 0 failures — those pre-existing issues have since cleared (flaky/environment-dependent), which is consistent with the phase never having caused them and does not change this phase's verification outcome.

### Probe Execution

No `scripts/*/tests/probe-*.sh` probes declared or discovered for this phase. SKIPPED (no runnable probes — this is a library/test-suite phase, not a migration/tooling phase).

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| RESOLVE-01 | 64-02, 64-03, 64-04 | Broadened candidate generation, never dense-only | SATISFIED | `generateCandidates` 3-channel union; never-dense-only proven both directions in `entity-resolution.test.ts`. |
| RESOLVE-02 | 64-01, 64-02, 64-03, 64-04 | Confident-or-null: abstain rather than best-available guess | SATISFIED | Floor + margin abstain paths, near-duplicate/unknown-entity/margin-too-close tests; WR-01 gate closes the upstream smuggling path that would otherwise feed a wrong guess into resolution. |
| RESOLVE-03 | 64-02, 64-03 | Resolved entity emitted as recense's own node ref + human-readable descriptor, never a consumer ID | SATISFIED | `descriptor: top.value` (own canonical value, exact-string tested); `nodeId` is recense-internal lineage only, documented as not a stable consumer FK; no consumer schema referenced. |

No orphaned requirements — all three RESOLVE-* IDs declared in REQUIREMENTS.md (lines 36-40) are claimed by at least one Phase 64 plan and are fully accounted for above. (REQUIREMENTS.md's checkbox/status table still shows `[ ]`/"Pending" for RESOLVE-01..03 — this is a document bookkeeping lag, not a code gap; live code evidence above satisfies all three.)

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `tests/entity-resolution.test.ts:307` (per 64-REVIEW WR-01) | — | D-12 read-only source-guard regex is a hand-maintained subset of the full write API (`setEmbedding`, `upsertNodeTemporal`, `recordContradiction`, `db.exec`, raw INSERT/UPDATE/DELETE inside `.prepare()` strings are not covered) | INFO (advisory) | No live defect — verified the module makes none of these calls today. A future edit adding one of them would not trip this guard. Not blocking; recorded per 64-REVIEW. |
| `tests/resolution-conservation.test.ts:137-228,487-533` (per 64-REVIEW WR-02) | — | Inertness snapshot omits numeric columns (`node.s/c/last_access`, `edge.w`, `consolidation_event.magnitude`) and `<ID>`-normalization could mask an id-substitution leak | INFO (advisory) | No live defect — verified `applyDecision` consumes the resolved fields nowhere. Would not currently catch a hypothetical future self-confirmation bug ("strengthen the resolved entity"). Not blocking; recorded per 64-REVIEW. |
| `src/consolidation/entity-resolution.ts:24,145` | 24, 145 | `grep -c "ModelProvider"` returns 2, not the plan's expected 0 (63-03-PLAN/64-03 acceptance criterion) | INFO (documentation-literal mismatch, not a defect) | Both occurrences are comment prose documenting the D-04 zero-LLM guarantee ("constructor MUST NOT accept a ModelProvider"). No import, no type reference, no constructor/method parameter of that type exists anywhere in the file (confirmed by reading the full source). The structural guarantee the acceptance criterion exists to protect — that `EntityResolver` cannot call an LLM because it never receives a provider — holds exactly as designed. Treated as satisfying intent, per the flagged known-context note. |

No debt markers (`TBD`/`FIXME`/`XXX`) found in any phase-modified file. No placeholder/stub returns, no empty handlers, no hardcoded-empty data flowing to output.

### Human Verification Required

None. This phase is entirely backend/algorithmic (candidate generation, scoring, config knobs, DB conservation) with no UI, no external service integration, and no behavior that resists grep/test-based verification. All must-haves were verified programmatically.

### Gaps Summary

No gaps. All 14 derived observable truths (covering all three ROADMAP success criteria RESOLVE-01/02/03, all D-01 through D-13 CONTEXT decisions, and the WR-01 carry-forward closure) are verified against live code and passing tests — not merely SUMMARY.md claims. Typecheck is clean, the phase's own 17 named test files pass (224 tests), and a full-suite run passes with zero failures. The two 64-REVIEW.md warnings are advisory test-guard-strength gaps (confirmed no live defect exists behind either), and the one documented acceptance-criterion literal mismatch (`ModelProvider` grep count) is a stale grep expectation against comment prose, not a structural gap — the type-level guarantee it was meant to protect is intact and separately verified by reading the constructor signature.

---

_Verified: 2026-08-02T21:15:00Z_
_Verifier: Claude (gsd-verifier)_
