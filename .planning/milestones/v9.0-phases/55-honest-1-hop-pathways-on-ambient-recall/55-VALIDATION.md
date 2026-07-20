---
phase: 55
slug: honest-1-hop-pathways-on-ambient-recall
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-06-30
---

# Phase 55 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Honesty-critical engine emit change: machine guards cover the structural/honesty
> invariants (SC2, SC3) via `tests/activation-trace-wiring.test.ts`; the felt-quality
> criterion (SC1 — "pathways light on every recall") is founder-confirmed at the live
> visual checkpoint (Phase 52/54 idiom). Promoted from `55-RESEARCH.md` §Validation
> Architecture into this project's standalone-artifact convention (cf. `54-VALIDATION.md`).

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (4.x) |
| **Config file** | `vitest.config.ts` (root) |
| **Quick run command** | `npx vitest run tests/activation-trace-wiring.test.ts` |
| **Full suite command** | `npm test` (== `vitest run`) |
| **Estimated runtime** | ~10 seconds (quick) / ~60 seconds (full) |

No new test framework or fixture infrastructure needed — `MockActivationTraceSink`,
`makeRetrievalDeps`, and `seedThreeNodes` helpers already exist in the target file and cover
the needed shapes.

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run tests/activation-trace-wiring.test.ts`
- **After every plan wave:** Run `npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** ~10 seconds (quick command)

The Phase 52 honesty guards (RecallEngine curated-path block) and Phase 54 layer guards live in
the full suite; `npm test` after each wave is the live guard that no implementation step regresses
the no-fabricated-edges invariant (SC3).

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 55-01-01 | 01 | 1 | SC3 (honest emit) | T-55-01/02/03 | both emit sites emit real `kind==='relation'` top-N live out-edge hops (score:null) + real-score seeds; liveness-before-truncate; return value unchanged (D-08) | source-text guard + unit | `npx tsc -p . --noEmit && npx vitest run tests/activation-trace-wiring.test.ts -t "RecallEngine"` | ✅ curated-path guards exist; ❌ W1 new guards land in Task 3 | ⬜ pending |
| 55-01-02 | 01 | 1 | SC3 (D-06 shape) | — | two bare-string seed assertions updated to `{node_id, score}` object shape; no other assertion weakened | unit | `npx vitest run tests/activation-trace-wiring.test.ts -t "vizFloor"` | ✅ exists (updated in place) | ⬜ pending |
| 55-01-03 | 01 | 1 | SC3 (honesty lock) | T-55-03 | five guards: real-edge cross-check vs store, kind allowlist, liveness (tombstoned-high-weight case), top-N cap, seed-real / hop-null score split | unit (new `it()` blocks) | `npx vitest run tests/activation-trace-wiring.test.ts && npm test` | ✅ created here | ⬜ pending |
| 55-02-01 | 02 | 2 | SC1 (pathways light) | — | ordinary ambient recalls light real 1-hop pathway pulses; density acceptable at N=6 or tuned | manual (founder checkpoint) | `recense viz` (founder runs) | N/A manual | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*
*"File Exists ❌ W1" = the new machine guards for 55-01-01's behavior are authored in Task 3 (same file); until then the existing curated-path honesty guards + `tsc` cover it. All three 55-01 tasks are in Wave 1, so the guard file is green by end of wave.*

---

## Wave 0 Requirements

- [ ] No new test file. Guards are added as new `it()` blocks inside the existing
  `tests/activation-trace-wiring.test.ts` (`retrieveRanked vizFloor` describe block).
- [ ] Update the two breaking bare-string seed assertions (~lines 320, 333) to object shape —
  **required, not optional**, or the suite goes red on implementation (Task 55-01-02).
- [ ] Framework: vitest already installed — no install needed.

*This phase has no literal Wave 0; the new guards are authored in Task 3 of Wave 1 after the
Wave 1 implementation (Task 1) they guard, which is correct for source-text/behavior guards.
Sampling continuity holds because `tsc` + the existing curated-path honesty guards run after
Task 1, and the full honesty suite runs after Task 3.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Ordinary (ambient) recalls light real 1-hop spreading-activation pathways, not just seed flashes | SC1 | Felt-quality / perceptual — no automated test can confirm rendered "feels alive" pathway density | Founder pins `recense viz`, triggers several ordinary recalls, confirms cyan hop pulses spread from amber seeds; judges density at N=6 (asymmetric out-edge sparsity on object-heavy seeds is expected/honest, not a bug) |

*Structural/honesty halves (SC2, SC3 — real edges, score:null, liveness, top-N cap, no fabrication)
are machine-verified by Plan 55-01's Task 3 guard suite.*

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or are explicitly manual founder-checkpoint tasks
- [x] Sampling continuity: no 3 consecutive tasks without automated verify (tsc + curated-path guards after Task 1; full suite after Task 3)
- [x] Wave 0 / new-guard coverage covers all machine-checkable references (SC2/SC3)
- [x] No watch-mode flags (all `vitest run`, never `vitest` watch)
- [x] Feedback latency < 15s (quick command)
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-06-30
