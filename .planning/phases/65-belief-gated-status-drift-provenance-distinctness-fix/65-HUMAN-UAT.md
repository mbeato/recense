---
status: partial
phase: 65-belief-gated-status-drift-provenance-distinctness-fix
source: [65-VERIFICATION.md]
started: 2026-08-03T05:20:00Z
updated: 2026-08-03T05:20:00Z
---

## Current Test

[awaiting human testing]

## Tests

### 1. DRIFT-05 enablement decision (65-10 Task 3 — the D-14 gate)
expected: Founder exports a sample of real multi-email status threads as JSONL outside the repo (e.g. `~/drift05-inbox.jsonl`, one `{from, thread_id, date, body}` per line — never committed), runs `npm run eval:drift05 -- --inbox ~/drift05-inbox.jsonl --out scripts/eval/results/drift-05-<date>.json`, reviews distinctness/farming/residual-threshold/accuracy sections, then records **ENABLE** (flip `provenanceDistinctnessEnabled` in `src/lib/config.ts` + update `tests/runtime-config.test.ts` in the same commit) or **HOLD** (keep false, name the blocking observation) verbatim in a revision of `65-10-SUMMARY.md`. WR-01 below must be resolved before an ENABLE.
result: [pending]

### 2. WR-01 — farming bar is one-domain + N-threads (65-REVIEW.md)
expected: Before any ENABLE decision: accept, mitigate, or re-design around the fact that Gmail threadIds are sender-mintable, so the composed `(domain, threadId)` key lets one mailbox mint N distinct provenances with N fresh emails. Confirmed real by the reviewer via execution; non-blocking while the knob stays dark.
result: [pending]

### 3. WR-03 — stripQuotedForwarded contract violations (65-REVIEW.md)
expected: Decide whether to fix before ENABLE: 4-space-indented `>` quotes break documented idempotence, and a boundary line indented by ≥1 space leaks the quoted body into the residual (over-count direction — partially reopens the Pitfall-3 duplication vector). Boundary regexes lack the ` {0,3}` tolerance `QUOTE_LINE_RE` has. Confirmed real by the reviewer via execution; non-blocking while the knob stays dark.
result: [pending]

## Summary

total: 3
passed: 0
issues: 0
pending: 3
skipped: 0
blocked: 0

## Gaps
