---
phase: 28
slug: schema-anchored-corpus
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-06-19
---

# Phase 28 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Derived from `28-RESEARCH.md` §Validation Architecture (live-source grounded).

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (project standard — confirm via `package.json` / existing `tests/*.test.ts`) |
| **Config file** | existing project vitest config (no Wave 0 install needed) |
| **Quick run command** | `npx vitest run tests/corpus-promoter.test.ts` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~30–90 seconds (full suite; some tests need `sleep.env` sourced — see worktree caveat below) |

---

## Sampling Rate

- **After every task commit:** Run the relevant `npx vitest run tests/<file>.test.ts`
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd:verify-work`:** Full suite must be green on the MERGED tree with `sleep.env` sourced (env-dependent tests false-fail in a bare worktree)
- **Max feedback latency:** ~90 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| TBD | mass-gate | 1 | CORPUS-02 | — | gate returns 15–60 candidates, 0 model calls, deterministic for fixed snapshot | unit | `npx vitest run tests/corpus-promoter.test.ts` | ❌ W0 | ⬜ pending |
| TBD | mass-gate | 1 | CORPUS-02 | — | noise filter excludes schemas with noise_frac ≥ 0.5 | unit | same | ❌ W0 | ⬜ pending |
| TBD | ladder | 2 | CORPUS-03 | — | cosine+mass derivation yields ≥1 directed parent→child + reference edges between doc nodes only | unit | same | ❌ W0 | ⬜ pending |
| TBD | ladder | 2 | CORPUS-05 | D-43 | source schema `s`/`c`/edge-weights/members UNCHANGED after `promote()` (snapshot diff) — **BLOCKING** | unit | same | ❌ W0 | ⬜ pending |
| TBD | gather | 1 | CORPUS-01 | — | `gatherFactsForSchema()` returns ≥1 fact from schema's `abstracts` neighborhood; cited ref resolves | unit | `npx vitest run tests/doc-gather.test.ts` | ❌ W0 | ⬜ pending |
| TBD | gather | 1 | CORPUS-01 | — | existing scope-anchored `gatherFacts()` Phase-27 tests still pass (regression) | unit | same | ✅ | ⬜ pending |
| TBD | render/endpoint | 3 | CORPUS-04 | — | `/graph?type=doc` returns doc_containment + doc_reference (+ doc_link) edges, no doc_link-between-projects dependency | integration | `npx vitest run tests/viz-server.test.ts` | ❌ W0 | ⬜ pending |
| TBD | DDL | 1 | CORPUS-03/04 | T-FK | v12 migration idempotent + `PRAGMA foreign_key_check` empty after run | unit | `npx vitest run tests/schema.test.ts` (or migration test) | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky · Task IDs filled by planner.*

---

## Wave 0 Requirements

- [ ] `tests/corpus-promoter.test.ts` — covers CORPUS-02 (gate + noise), CORPUS-03 (cosine+mass ladder), CORPUS-05 (self-confirmation snapshot diff)
- [ ] `tests/doc-gather.test.ts` (new or extend) — covers CORPUS-01 schema-anchored gather
- [ ] `tests/viz-server.test.ts` (extend existing) — covers CORPUS-04 endpoint change

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Corpus renders as a legible forest (not a hairball); ≥1 parent→child nest visible; first render not dominated by dogfooding-noise | CORPUS-03/04 | Visual legibility + threshold calibration can't be asserted programmatically | Run `recense promote-corpus` on a WAL-safe copy of the canonical DB, open `recense viz`, toggle the corpus view; eyeball nesting + edge styling; tune cosine threshold if over-connected |
| Schema-doc prose quality (thesis = the schema's generalization) | CORPUS-01 | Prose quality is judge-tier subjective (Phase-27 D-05 pattern) | Generate one promoted schema-doc, spot-check the thesis framing + that citations resolve |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references (3 test files above)
- [ ] No watch-mode flags
- [ ] Feedback latency < 90s
- [ ] CORPUS-05 self-confirmation snapshot-diff test is marked BLOCKING
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
