# 30-03 SUMMARY — Live SC2/SC3/INGEST-02 re-validation on the committed transport

**Plan:** 30-03 · **Phase:** 30-core-ingest-command · **Completed:** 2026-06-20
**Requirements:** INGEST-01, INGEST-02, INGEST-04 (re-validated end-to-end)

## What this validated

Re-measured the three success criteria on the **real committed transport** (`recense ingest-project`, Plans 01-02) — the first time SC2 has been measured on shippable code. RESEARCH Pitfall 2 established the Phase-29 82%-genuine number was measured on a path that does not exist in committed code (the committed transport had `--tools none → NO_TOOLS`); that number is now replaced with measured evidence.

Target repo: `/Users/vtx/usage` (`@mbeato/contextscope`), scope `usage`. Full evidence in `30-03-VALIDATION.md`.

## Execution

- **Task 1 (`7cc15ae`):** assembled the live-run + verification recipe, built the dist (`recense ingest-project` dispatches; launcher pins node v25.5.0 / better-sqlite3 ABI), recorded the pre-run schema baseline (275), no live write.
- **Task 2 (blocking-human checkpoint):** the subscription-billed live run was **founder-initiated** (dry-run → real ingest → sleep pass, completed 16:44:44Z). The founder then **delegated autonomous execution of the read-only verification** ("run these… I want it done autonomously"); measurement + write-up below were done autonomously. No customer-zero mutation occurred during verification (ambient-recall demo ran against a WAL-safe copy).

## Results (GO)

| Criterion | Bar | Measured | Verdict |
|-----------|-----|----------|---------|
| SC2 genuine facts/area | ≥5 | arch 42 · conv 55 · dec 34 · current-state 59 · gotchas 58 (248 total) | ✅ |
| INGEST-02 `[scope]` recall | correct prefix | 233 facts scoped `usage`; live `ambientRecall` renders `[usage]` (5/5 on `.disabled` query) | ✅ |
| SC3 schema induction | ≥1 | 23 schemas abstract over `usage` facts; 2 fresh schema docs this pass | ✅ |
| SC4 quality | no raw code | why-level facts; 1 preamble artifact (non-blocking) | ✅ |

**Key finding:** the plan's prescribed SC3 metric (post-run schema count − baseline) is **unsound** — it read `−2` because it's a brain-wide net confounded by concurrent schema falsification elsewhere. The correct measure is schemas with `abstracts` edges to `usage`-scoped facts (= 23). Recorded as a follow-up so future onboarding validations don't reuse the delta metric.

## Follow-ups (non-blocking)

1. `splitObservations` preamble filter (drops "Here are the … observations:" type lines).
2. Replace the SC3 baseline-delta check with the abstracts-edge query in any future onboarding validation.

## Self-Check: PASSED

- SC2/SC3/INGEST-02 all met on the committed transport with live evidence.
- No customer-zero mutation during verification (read-only + DB copy).
- `30-03-VALIDATION.md` records per-area counts, recall samples, schema evidence, GO decision.
