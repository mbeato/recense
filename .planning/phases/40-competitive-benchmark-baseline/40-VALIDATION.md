---
phase: 40
slug: competitive-benchmark-baseline
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-06-22
---

# Phase 40 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (existing) |
| **Config file** | vitest.config.ts (existing) |
| **Quick run command** | `npm run build && node scripts/eval/locomo-harness.cjs --dry-run` |
| **Full suite command** | `npm run test && npm run build && node scripts/eval/locomo-harness.cjs --dry-run` |
| **Estimated runtime** | ~30 seconds (dry-run; excludes real-API probe) |

---

## Sampling Rate

- **After every task commit:** Run `npm run build && node scripts/eval/locomo-harness.cjs --dry-run`
- **After every plan wave:** Run `npm run test && npm run build && node scripts/eval/locomo-harness.cjs --dry-run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds (dry-run path; the cost-gated real-API probe is a separate phase gate, not a per-task sample)

---

## Per-Task Verification Map

> Planner fills this from PLAN.md tasks. Reference: RESEARCH.md §Validation Architecture → Phase Requirements → Test Map.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 40-01-01 | 01 | 0 | BENCH-01 | — | N/A | smoke | `test -f scripts/eval/locomo10.json` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `scripts/eval/locomo10.json` — acquire LoCoMo-10 dataset (git clone snap-research/locomo; add to .gitignore)
- [ ] `scripts/eval/fixtures/locomo-mini.json` — 1-conversation dry-run fixture (hand-trim to ~5 QA pairs)
- [ ] Unit test stubs for category-5 filtering + R@K session-hit logic (BENCH-01)

*vitest framework already installed — no framework install needed.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| D-01 cost probe → budget % vs `/usage` weekly meter | BENCH-02 | Reads live subscription `usage` envelope + Claude Code `/usage` meter; consumes real budget | Run `node scripts/eval/locomo-harness.cjs --probe` on the median-length conversation; read `total_cost_usd` / `usage` from envelope; extrapolate ×10; confirm projected % against `/usage` before any full run |
| Official baseline run on frozen v7.0 tag | BENCH-02 | Must run against the v7.0-tagged SUT (post-39.1-05), schedulable pre-reset; not a CI sample | After v7.0 tag, run full harness; capture commit + config snapshot in results JSON |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references (locomo10.json, dry-run fixture)
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s (dry-run path)
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
