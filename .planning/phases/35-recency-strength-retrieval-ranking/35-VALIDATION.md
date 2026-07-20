---
phase: 35
slug: recency-strength-retrieval-ranking
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-06-20
---

# Phase 35 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest ^4.1.8 |
| **Config file** | none — `vitest run` via `npm test` |
| **Quick run command** | `npm test -- tests/fts-retrieval.test.ts` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~30–60 seconds (unit); LME eval is minutes + paid API |

---

## Sampling Rate

- **After every task commit:** Run `npm test -- tests/fts-retrieval.test.ts`
- **After every plan wave:** Run `npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 60 seconds (unit). RANK-02 eval is a manual, out-of-band measurement (paid API) — not part of the per-commit loop.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| mechanism | 01 | 1 | RANK-01 | — | parameterized `json_each` pool query; no user string reaches SQL | unit | `npm test -- tests/fts-retrieval.test.ts -t "rrfFuse"` | ✅ extend | ⬜ pending |
| dark-default | 01 | 1 | RANK-01 | — | w=0 reproduces exact `[cosine, bm25]` ranking (no behavior change at merge) | unit | `npm test -- tests/fts-retrieval.test.ts -t "strengthWeight=0"` | ❌ W0 | ⬜ pending |
| pool-only (D-02) | 01 | 1 | RANK-01 | — | high-strength node outside cosine/BM25 pool never appears | unit | `npm test -- tests/fts-retrieval.test.ts -t "pool"` | ❌ W0 | ⬜ pending |
| tombstone (D-10) | 01 | 1 | RANK-01 | — | tombstoned high-strength node never surfaces via strength list | unit | `npm test -- tests/fts-retrieval.test.ts -t "tombstone"` | ⚠️ extend | ⬜ pending |
| no-self-strengthen | 01 | 1 | RANK-01 | — | retrieval uses pure `effectiveStrength`; `last_access` never mutated by a read | unit | `npm test -- tests/fts-retrieval.test.ts -t "last_access"` | ❌ W0 | ⬜ pending |
| harness-fix | 02 | 2 | RANK-02 | — | KU harness passes `queryText` → strength fusion actually exercised | manual eval | `node scripts/eval/replay-ku-harness.cjs` | ✅ fix | ⬜ pending |
| w-sweep | 02 | 2 | RANK-02 | — | sweep reports winning `w`; no regression + token or precision win | manual eval | sweep script over {0,0.25,0.5,1.0,2.0} | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/fts-retrieval.test.ts` — add T1..T5 (rrfFuse weights, hybridTopk strength-list-from-pool, w=0 regression, D-02 pool enforcement, D-10 tombstone-via-strength, no-self-strengthen)
- [ ] `scripts/eval/35-strength-sweep.cjs` (or shell loop) — w-sweep harness for RANK-02

*Existing vitest infrastructure covers the unit surface; no framework install needed.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Token-saving OR precision win (D-06) | RANK-02 | Requires paid LLM-judge run on KU/LongMemEval-S dataset (not committed); run-to-run judge variance | Run KU harness baseline (w=0) and sweep; for LME, `--probe --hybrid` then scorer at `--topk 5` and `--topk 10`. Report winning `w` + headline metric. Pass if EITHER token-saving or precision clears the ~1–2pt noise band (D-07). |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s (unit loop)
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
