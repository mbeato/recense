---
phase: 48-correctness-hardening
verified: 2026-06-27T23:10:30Z
status: passed
score: 8/8 must-haves verified
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 7/8
  gaps_closed:
    - "HARD-02 regression test now exercises both Phase-B write paths (markSkipped at :507 AND per-episode write at :953-969) in a single consolidate() pass, with a non-vacuous assertion tied to confirmed Phase-B effects (node minted + both episodes consolidated) and immediateCallCount>=2"
    - "setEmbedding jsdoc updated to document HARD-04 embedding_model stamp+assert guard (WR-03)"
  gaps_remaining: []
  regressions: []
---

# Phase 48: Correctness Hardening Verification Report

**Phase Goal:** Correctness Hardening — close C-2 self-confirmation loop (HARD-01), immediate() write txns / M-5 (HARD-02), schema-version read-first guard / M-9 (HARD-03), embedding model/dims stamp+assert / L-2 (HARD-04); EACH WITH A REGRESSION TEST; independent of 46/47. Engine invariants: graph is source of truth, never strengthen from inferred output, no accuracy regression, net-zero new runtime deps.
**Verified:** 2026-06-27T23:10:30Z
**Status:** passed
**Re-verification:** Yes — after gap closure (commit e73c490)

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | setEmbedding stamps `embedding_model` in meta on first embed | VERIFIED | `semantic-store.ts:401-405` — `getMeta('embedding_model')` null → `setMeta('embedding_model', model)` |
| 2 | A subsequent embed under a different model throws fail-closed | VERIFIED | `semantic-store.ts:406-410` — `storedModel !== model` → `throw new Error('embedding_model mismatch…')` |
| 3 | A subsequent embed under the matching model does NOT throw | VERIFIED | Same guard: same model is a no-op (no `else` branch past the `!==` check) |
| 4 | HARD-04 has three named regression tests (stamp, mismatch-throws, happy-path) | VERIFIED | `tests/store.test.ts:226-255` — three tests labeled `HARD-04 (L-2)`, all green (49/49) |
| 5 | An assistant-role confirm does NOT strengthen a node (C-2, incl. D-17 fast path) | VERIFIED | `consolidator.ts:1082` — `if (decision.episodeRole !== 'assistant')` gates `strengthen()`; D-17 fast path sets `episodeRole: episode.role` at line 730, flows through the same single gate |
| 6 | The consolidator Phase-B write transaction runs in IMMEDIATE mode (M-5) | VERIFIED | Both Phase-B paths confirmed: `consolidator.ts:507` (`markSkipped`) and `:953-969` (per-episode write) chain `.immediate()`. HARD-02 regression test exercises both paths in one pass; non-vacuous assertion (`immediateCallCount>=2`, node minted, both episodes consolidated). |
| 7 | `initSchema` throws when stored `schema_version` > `SCHEMA_VERSION` (M-9 downgrade guard) | VERIFIED | `schema.ts:613-618` — reads stored version first, throws on `stored > SCHEMA_VERSION`; HARD-03 labeled test at `schema.test.ts:76` confirms throw fires |
| 8 | Each of the three guards (HARD-01, HARD-02, HARD-03) has a regression test labeled with its HARD-0X id | VERIFIED | HARD-01: `consolidation.test.ts:1295`; HARD-02: `consolidation.test.ts:1768`; HARD-03: `schema.test.ts:74` — all labeled, all passing. HARD-02 now covers both Phase-B paths. |

**Score:** 8/8 truths verified

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/db/semantic-store.ts` | `embedding_model` stamp/assert block in `setEmbedding` | VERIFIED | Lines 401-410; labeled `// HARD-04 (L-2)`; reads `this.config.openaiEmbedModel`; jsdoc updated at lines 376-382 documenting the model-consistency throw |
| `tests/store.test.ts` | Three HARD-04 regression tests | VERIFIED | Lines 226-255; stamp test, mismatch-throws test, happy-path test; all labeled `HARD-04 (L-2)` |
| `src/consolidation/consolidator.ts` | C-2 gate at confirm branch (HARD-01) | VERIFIED | Lines 1079-1084; `if (decision.episodeRole !== 'assistant')` — pre-existing guard confirmed airtight |
| `src/consolidation/consolidator.ts` | Both Phase-B write txns use `.immediate()` (HARD-02) | VERIFIED | Line 507 (`markSkipped`) and lines 953-969 (per-episode graph write) — both chain `.immediate()` |
| `src/db/schema.ts` | M-9 downgrade guard (HARD-03) | VERIFIED | Lines 607-623; reads `schema_version` before stamping; throws on `stored > SCHEMA_VERSION` |
| `tests/consolidation.test.ts` | HARD-01 and HARD-02 labeled tests | VERIFIED | HARD-01 at line 1295; HARD-02 at line 1768. HARD-02 now covers both Phase-B paths with non-vacuous assertion. |
| `tests/schema.test.ts` | HARD-03 labeled test | VERIFIED | Line 74 carries `// HARD-03 (M-9)` comment; test at line 76 passes (6/6) |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `semantic-store.ts setEmbedding` | `this.config.openaiEmbedModel` | `getMeta/setMeta('embedding_model')` | WIRED | `const model = this.config.openaiEmbedModel` at line 402; guard at 403-410 mirrors dims guard |
| `tests/store.test.ts HARD-04 mismatch test` | `store.setEmbedding` | Two `SemanticStore` instances on same `:memory:` db with differing `openaiEmbedModel` | WIRED | `configA` / `configB` set different model names; `storeA` stamps, `storeB` throws `/embedding_model mismatch/` |
| `consolidator.ts applyDecision` | `this.strength.strengthen()` | Single gate `if (decision.episodeRole !== 'assistant')` | WIRED | Gate exists at line 1082; D-17 fast path threads `episodeRole` via `episode.role` at line 730 |
| `consolidator.ts Phase-B write (markSkipped)` | `.immediate()` | `this.db.transaction(…).immediate()` at line 507 | WIRED | Verified by grep AND regression test: sub-threshold episode (salience=0.05) triggers this path; `listUnconsolidated().length===0` confirms both episodes consolidated |
| `consolidator.ts Phase-B write (per-episode)` | `.immediate()` | `this.db.transaction(…).immediate()` at lines 953-969 | WIRED | Verified by grep AND regression test: high-salience episode (salience=0.8) mints a node via this path; `minted.c===1` confirms it ran |
| `tests/consolidation.test.ts HARD-02` | `h.db.transaction(…).immediate()` | Spy counting `.immediate()` calls; counter reset before pass | WIRED | Counter reset to 0 immediately before `consolidate()`; tied to `minted.c===1` + `listUnconsolidated().length===0`; asserts `immediateCallCount>=2`. Cannot pass vacuously. |

---

### Data-Flow Trace (Level 4)

Not applicable for this phase — all four guards are write-path integrity checks, not data-rendering components. No dynamic-data rendering paths were introduced.

---

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| HARD-02 test (both Phase-B paths) | `npx vitest run tests/consolidation.test.ts -t "HARD-02"` | 1 passed | PASS |
| HARD-04 tests pass | `npx vitest run tests/store.test.ts` | 49 passed | PASS |
| HARD-01/02 tests pass | `npx vitest run tests/consolidation.test.ts` | 47 passed | PASS |
| HARD-03 test passes | `npx vitest run tests/schema.test.ts` | 6 passed | PASS |
| Full suite no regression | `npm test` | 2391 passed / 3 skipped | PASS |

---

### Probe Execution

No probes declared in PLAN files; no `scripts/*/tests/probe-*.sh` found for this phase. Step 7c: SKIPPED.

---

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| HARD-01 | 48-02-PLAN | Close C-2 self-confirmation loop | SATISFIED | Guard at `consolidator.ts:1082`; HARD-01-labeled test at `consolidation.test.ts:1295`; D-17 fast path covered |
| HARD-02 | 48-02-PLAN | All Phase-B write txns use `.immediate()` | SATISFIED | Production code verified; regression test covers BOTH Phase-B paths (per-episode write + markSkipped) in single pass; assertion non-vacuous (tied to minted node + both-consolidated + `immediateCallCount>=2`) |
| HARD-03 | 48-02-PLAN | `initSchema` reads stored version first, throws on downgrade | SATISFIED | Guard at `schema.ts:607-623`; HARD-03-labeled test passes |
| HARD-04 | 48-01-PLAN | `embedding_model` stamped in meta, fail-closed on mismatch | SATISFIED | Guard at `semantic-store.ts:401-410`; jsdoc updated; three labeled regression tests pass |

---

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `tests/schema.test.ts` | 80, 93 | Comment says `// stamps SCHEMA_VERSION (8)` — actual version is 14 | Info | Pre-existing, not introduced by phase 48; flagged IN-01 in review |

No `TBD`, `FIXME`, or `XXX` markers found in phase-modified files.

---

### Human Verification Required

None. All prior human-verification items have been closed by remediation:

- **WR-01 (vacuous pass risk):** Counter reset to 0 immediately before `consolidate()`; assertion requires `immediateCallCount>=2` which cannot be satisfied by constructor-time transactions or unrelated callers. Evidence explicitly tied to `minted.c===1` + `listUnconsolidated().length===0`.
- **WR-02 (markSkipped path unexercised):** Now covered by a sub-threshold episode (salience=0.05 < consolSkipThreshold=0.2) in the same HARD-02 test. `listUnconsolidated().length===0` confirms the skipped episode was consolidated via markSkipped.
- **WR-03 (missing jsdoc):** `setEmbedding` jsdoc at `semantic-store.ts:376-382` now documents the HARD-04 embedding_model guard with explicit throw contract and caller guidance.

---

### Gaps Summary

No gaps. All four correctness hardening requirements are implemented and regression-tested. Phase goal achieved.

---

### Net-Zero Runtime Dependencies

Verified: `package.json` unchanged across all phase commits including remediation commit e73c490. No new runtime dependencies added.

---

### Commit Verification

| Commit | Hash | Status |
|--------|------|--------|
| `feat(48-01): stamp and assert embedding_model in setEmbedding (HARD-04 L-2)` | 5b43b7c | EXISTS |
| `test(48-01): add HARD-04 regression tests for embedding_model stamp/assert` | 923030c | EXISTS |
| `test(48-02): label HARD-01 and HARD-03 on existing regression tests` | e3a2d9b | EXISTS |
| `test(48-02): add HARD-02 M-5 IMMEDIATE-mode regression test` | 8752c5d | EXISTS |
| `test(48-02): strengthen HARD-02 test — cover both Phase-B paths, non-vacuous assertion` | e73c490 | EXISTS |

---

_Verified: 2026-06-27T23:10:30Z_
_Verifier: Claude (gsd-verifier)_
