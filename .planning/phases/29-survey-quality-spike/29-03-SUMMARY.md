---
phase: 29-survey-quality-spike
plan: 03
subsystem: ingestion
tags: [spike, survey, calibration, go-no-go, quality-gate, scope-tagging, ingest-03]
status: complete  # founder selected GO at the decision checkpoint, 2026-06-20

# Dependency graph
requires:
  - phase: 29-survey-quality-spike
    plan: 01
    provides: "exact final D-08 survey prompt + measured survey results (71 episodes / 166 facts / 16 schemas on /tmp/recense-spike.db)"
  - phase: 29-survey-quality-spike
    plan: 02
    provides: "exact D-07 JUDGE_PROMPT + per-area genuine/noise tally + schema-induction count + root-cause analysis"
provides:
  - ".planning/phases/29-survey-quality-spike/29-CALIBRATION.md — the four Phase-30 calibration inputs (prompt shape, summarization level, quality gate, scope-tagging) + Results-vs-Success-Criteria table + founder-pending GO draft"
affects: [30-ingest-project, 31-reingest, 32-scoped-recall]

# Tech tracking
tech-stack:
  added: []  # pure documentation plan — no code, no deps
  patterns:
    - "Calibration deliverable: both verbatim prompts (survey D-08 + judge D-07) pasted into the calibration doc so Phase 30 carries exact text, not a paraphrase"

key-files:
  created:
    - .planning/phases/29-survey-quality-spike/29-CALIBRATION.md
  modified: []

key-decisions:
  - "Draft verdict = GO, explicitly marked AWAITING FOUNDER SIGN-OFF — the go/no-go is the blocking checkpoint:decision (D-02 founder-owned); the executor does not select"
  - "Two documented shortfalls carried as Phase-30 fixes (decisions retry-on-access-failure; gotchas prompt tightening) rather than blocking GO — both are narrow and upstream of the proven pipeline"

requirements-completed: []  # INGEST-03 closes when the founder records the go/no-go at this checkpoint

# Metrics
duration: 6min
completed: 2026-06-20
---

# Phase 29 Plan 03: Survey Quality Spike — Calibration Notes Summary

**Pure-documentation plan. Wrote `29-CALIBRATION.md`: the four Phase-30 calibration inputs (final D-08 survey prompt verbatim, summarization level, D-07 JUDGE_PROMPT verbatim, scope-tagging convention) + a Results-vs-Success-Criteria table citing the measured spike numbers + a draft GO recommendation awaiting the founder's go/no-go. No code; `.planning/` is gitignored (no commit).**

## Status: AWAITING-CHECKPOINT (founder go/no-go — blocking checkpoint:decision)

Task 1 (auto, write `29-CALIBRATION.md`) is complete and verified. Task 2 is the blocking
`checkpoint:decision` — the founder selects go / no-go-adjust / no-go-stop. The executor does
NOT decide (D-02 founder-owned). STATE.md advanced (sequential mode); ROADMAP/phase NOT marked
complete (decision pending).

## The four calibration inputs (in brief — full verbatim text in 29-CALIBRATION.md)

1. **Final summarization prompt shape (D-08):** the `buildSurveyPrompt(area)` text WITH the
   "~15 most important / hard ceiling 20" cap, pasted verbatim. Load-bearing phrasings: "Write
   WHY, NOT WHAT", the explicit MUST-NOT-contain list (maps 1:1 to D-07 noise categories), the
   curation cap (prevents the 407-gotchas-episode blowup), one-belief-per-line standalone
   sentences, empty-on-nothing-genuine.
2. **Summarization level:** one belief-line per episode; ~15 curated why-level beliefs/area
   (hard cap 20 in prompt, 25 in `splitObservations` backstop). 15 episodes/area for the four
   healthy areas; 71 episodes → 166 facts → 16 schemas.
3. **Quality-gate definition (D-07):** the `JUDGE_PROMPT` (genuine = why-level semantic; noise
   = raw code / structural trivia / import-dependency lists / boilerplate / config dumps),
   pasted verbatim. Headless judge tier, per-fact at max_tokens 64, lenient verdict parse,
   empty→unknown fail-safe.
4. **Scope-tagging convention (D-04):** `cwd=<project root>` → `cwdToScope` → `[scope]`
   (verified /Users/vtx/usage → usage; 166 facts carry scope='usage'). **Caveat: schemas carry
   NO node_scope row** (count schemas without the scope join). Phase-30 adapter sets cwd=project
   root, source='project-survey', origin='observed', externalId=contentExternalId(relPath,
   content). Operational notes: OPENAI_API_KEY for the embedder, pinned node bin (ABI), tsx not
   ts-node, RECENSE_LOCK_PATH override.

## Measured results vs success criteria (from 29-01 / 29-02, founder runs 2026-06-20)

| # | Criterion | Bar | Outcome | Verdict |
|---|-----------|-----|---------|---------|
| SC1 | net-zero-dep survey completion | no new deps | reused headless client + runConsolidation; package.json unchanged; 71 ep → 166 facts → 16 schemas | PASS |
| SC2 | ≥5 genuine facts/area | ≥5/area | architecture 45 / conventions 47 / decisions 0 / current-state 39 / gotchas 5 → 4/5 PASS; 82% genuine overall (136/166) | PASS in 4/5 + 82% |
| SC3 | ≥1 induced schema | ≥1 | 16 schemas | PASS |
| SC4 | written calibration notes | exists | 29-CALIBRATION.md | PASS |

## Draft verdict: GO (awaiting founder sign-off)

All four SCs met in substance. Two documented shortfalls carried as Phase-30 fixes:
1. **decisions FAIL = agent tool-access flake, not a signal gap** — its 2 "facts" were a tool
   apology that got ingested. Fix: detect access-failure/refusal responses and retry-or-skip.
2. **gotchas noise-heavy (13/18)** — prompt elicited structural "what" trivia. Fix: tighten the
   gotchas-area framing toward why-level. (The gate caught the noise correctly; the fix is
   upstream at the prompt.)

## What Phase 30 carries forward

- The exact D-08 survey prompt + the ~15/area curation level.
- The exact D-07 quality gate + headless judge wiring.
- The cwd→scope mechanic + source='project-survey'/origin='observed'/externalId tags + the
  schemas-have-no-scope-row caveat + the operational env notes.
- The two fixes above, applied before/around the survey call.

## Self-Check: PASSED

- `.planning/phases/29-survey-quality-spike/29-CALIBRATION.md` — FOUND (Task 1 verify command returned PASS: contains "summarization prompt", "quality.gate", "scope-tag", "go/no-go").
- No code / no commit expected — `.planning/` is gitignored by design (objective: do not `git add -f`).
- Numbers match the injected measured results exactly (no inflation).

---
*Phase: 29-survey-quality-spike*
*Status: awaiting-checkpoint (founder go/no-go — blocking checkpoint:decision)*
*Updated: 2026-06-20*
