# Phase 24: Foundational Store - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-17
**Phase:** 24-foundational-store
**Mode:** `--auto` (recommended option auto-selected per gray area; no interactive prompts)
**Areas discussed:** FK-fix verification, Hourly-agent re-enable, Migration flow, Verification sampling, Source retirement, Budget gate

---

## FK-fix verification (SCOPE-01 gate)

| Option | Description | Selected |
|--------|-------------|----------|
| Manual sleep pass on LIVE DB | Run on live DB; assert no FK error + dirty sentinel cleared + `PRAGMA foreign_key_check` empty | ✓ |
| Throwaway copy first | Verify on a DB copy before touching live | |

**Auto choice:** Live DB. **Notes:** SCOPE-01 explicitly requires the gate "on the live DB"; a copy would not satisfy the requirement wording.

---

## Hourly-agent re-enable

| Option | Description | Selected |
|--------|-------------|----------|
| Re-enable after clean pass + survive one cycle | Bootstrap only after a clean manual pass, then confirm one full hourly cycle survives | ✓ |
| Re-enable immediately on bootstrap success | Treat `bootstrap` success as sufficient | |

**Auto choice:** After clean pass + survive one cycle. **Notes:** Agent is currently `bootout`ed to stop a crash loop; re-enabling before the fix is verified risks re-entering it.

---

## Migration flow

| Option | Description | Selected |
|--------|-------------|----------|
| Runbook D-S7 with adapters disabled | `RECENSE_ENABLED_SOURCES=` for both import and sleep-pass, per `docs/import-memory.md` | ✓ |
| Import with adapters live | Let normal adapters run alongside the import | |

**Auto choice:** Runbook D-S7, adapters disabled. **Notes:** Keeps the import the only thing entering the graph that cycle (clean attribution + clean verification).

---

## Verification sampling

| Option | Description | Selected |
|--------|-------------|----------|
| ≥3 facts/project across ≥3 projects | Recall returns the fact with the correct `[scope]` prefix | ✓ |
| Spot-check one project | Minimal verification | |

**Auto choice:** ≥3 facts/project across ≥3 projects. **Notes:** Matches SCOPE-04 acceptance criterion exactly.

---

## Source retirement

| Option | Description | Selected |
|--------|-------------|----------|
| Move (never delete), founder-gated | Move migrated fact files to a dated archive dir after sign-off; leave MEMORY.md + policy bundles | ✓ |
| Delete after verification | Remove source files once verified | |

**Auto choice:** Move, founder-gated. **Notes:** D-S7 safety order — never delete a source before its facts are verified; retirement is a separate human-confirmed step.

---

## Budget gate

| Option | Description | Selected |
|--------|-------------|----------|
| Confirm cost, then proceed | State the ~$1–2 embedding cost against ~$14–15 budget before the real run | ✓ |
| Skip the cost check | Run without confirming | |

**Auto choice:** Confirm then proceed. **Notes:** Within budget; per the API-budget-cap discipline, projected $ is stated before any paid run.

---

## Claude's Discretion

- Exact recall verification query strings (per project).
- Archive directory date/naming within the `~/.claude/projects-memory-archive-<date>/` convention.

## Deferred Ideas

- Entity dedup (8+ "brain-memory" fragments) → Phase 25.
- Sub-0.7 cosine retrieval fix → Phase 26.
- Reader layer productization → Phase 27.
- Soft cwd recall boost / hard project filtering → deferred by D-S6.
- Cross-project bleed scoping question → open, not resolved here (retrieval stays global).
