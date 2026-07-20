# Phase 29: Survey Quality Spike - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-19
**Phase:** 29-survey-quality-spike
**Areas discussed:** Survey target, Go/no-go judgment method

**Mode note:** Invoked `--auto`. Per the founder's standing rule that experiment design is human-as-architect (agents implement well but ideate badly — never auto-decide a spike's design), the two load-bearing experiment-design gray areas were surfaced for confirmation rather than auto-picked. All remaining (on-distribution) mechanics were auto-decided and recorded as Claude's-discretion defaults in CONTEXT.md.

---

## Survey target

| Option | Description | Selected |
|--------|-------------|----------|
| usage | CLI + local dashboard, ~673 files. Fastest spike, cleanest genuine-vs-noise judgment, distinct from recense. | ✓ |
| stitch | Browser-only video editor, ~1559 files. Richer architecture, more schema signal, more to judge. | |
| tonos | Early recense client, ~2034 files. Well-documented but collision risk with existing brain content. | |
| conway | Portfolio/distribution surface, ~2391 files. Mid-size. | |

**User's choice:** usage
**Notes:** Smallest/most self-contained real repo, founder knows it well enough to judge fact quality, no collision with customer-zero brain content. Scope slug derives to `usage`.

---

## Go/no-go judgment method

| Option | Description | Selected |
|--------|-------------|----------|
| Founder manual inspection | Read facts via `recense recall`, judge genuine-vs-noise by eye. Simplest, no harness. | |
| LLM-judge tally + spot-check | Judge pass scores each fact genuine/noise → per-area tally; founder spot-checks. More rigorous/repeatable, disposable harness. | ✓ |

**User's choice:** LLM-judge tally + spot-check
**Notes:** Provides a repeatable per-area tally against Success Criterion 2 (≥5 genuine facts/area); founder spot-checks the verdicts. Judge harness is throwaway.

---

## Claude's Discretion

Auto-decided (recommended defaults; founder may override at plan time), captured as D-03–D-08 in CONTEXT.md:
- Survey agent transport = existing `claude -p` headless (net-zero new deps), throwaway script not a SourceAdapter
- Episode emission via `IngestionPipeline.recordEvent` (origin=`observed`, source=`project-survey`, cwd=`/Users/vtx/usage` for scope tagging)
- Isolation on a scratch DB + `RECENSE_LOCK_PATH` override
- Surveyed areas = architecture, conventions, decisions, current state, gotchas
- Quality-gate definition + summarization prompt shape (both also calibration deliverables)

## Deferred Ideas

- Full `ProjectSurveyAdapter` + `recense ingest-project <dir>` → Phase 30
- Idempotent re-ingest + per-project cursor + doc ingest → Phase 31
- Scoped project recall + auto-corpus → Phase 32
- Todo matches `content-hardening-deferred.md` and `viz-search-and-hull-quality.md` reviewed; both false keyword matches, not folded.
