---
phase: 63-offline-intent-classification
plan: 06
subsystem: ingestion
tags: [eval-harness, cost-measurement, token-delta, gmail, headless-claude, classification]

# Dependency graph
requires:
  - phase: 63-offline-intent-classification
    plan: 02
    provides: GMAIL_INTENT_CLASSIFICATION_BLOCK — the shared prompt block this plan
      measures the input-token cost of
affects: [63-CLOSE, phase-63-SUMMARY-final-cost-record]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Two-arm live-vs-baseline token-delta harness deriving both arms from live
      source via a single exact-string-replace ablation, mirroring
      cost-benefit-harness.cjs's never-fabricate usage-sink discipline
      (measured:false + reason on any unmeasurable path, never an estimate)"

key-files:
  created:
    - scripts/eval/63-intent-prompt-token-delta.cjs
    - scripts/eval/results/63-intent-prompt-token-delta.json
  modified:
    - src/source/extraction-prompts.ts
    - .gitignore

key-decisions:
  - "Added an explicit .gitignore allowlist exception for
    scripts/eval/results/63-intent-prompt-token-delta.json, following the
    established pattern (gate-baseline.json, correctness-v90final.json, etc.) —
    the blanket `scripts/eval/results/*` ignore rule would otherwise silently
    drop the plan's result-of-record artifact (Rule 3 — blocking issue, not in
    the plan's stated file-modification list but required for the stated
    files_modified: scripts/eval/results/63-intent-prompt-token-delta.json to
    actually land in git)."

requirements-completed: [CLASSIFY-01]

# Metrics
duration: ~20min
completed: 2026-08-02
---

# Phase 63 Plan 06: Gmail Intent-Classification Prompt Token-Delta Measurement Summary

**Measured the enlarged gmail extraction prompt's real input-token cost via a two-arm live `claude -p` harness: +597 input tokens (+117.52%) per gmail extraction call, model `claude-haiku-4-5` — no estimate, a genuine subscription-billed measurement.**

## Performance

- **Duration:** ~20 min
- **Completed:** 2026-08-02T20:56:56Z
- **Tasks:** 2 of 3 (Task 3 is a blocking founder checkpoint — see below)
- **Files modified:** 2 created, 2 modified (incl. `.gitignore`)

## Accomplishments

- `GMAIL_INTENT_CLASSIFICATION_BLOCK` exported from `src/source/extraction-prompts.ts`
  (single-word `export` addition, zero wording change) so the harness derives both
  measurement arms from live production source instead of a frozen stale copy
- `scripts/eval/63-intent-prompt-token-delta.cjs` — a two-arm token-delta harness:
  Arm A (baseline) = `promptForSource('gmail')` with the classification block
  removed by a single exact-string replace; Arm B (as-landed) = `promptForSource('gmail')`
  verbatim. Both arms get the identical synthetic sample gmail episode appended
  (`From: ... · Re: ... · Acct: ...` header + short synthetic recruiter-rejection
  body — no real mail, no PII)
- Harness structurally cannot fabricate a token number: requires compiled `dist/`
  inside try/catch (`Run npm run build first` on failure), aborts non-zero if the
  block-removal ablation is a no-op, and marks `measured:false` with an honest
  reason whenever the usage sink doesn't capture exactly 2 calls (one per arm)
- `--offline` CI-safe mode: deterministic character/word deltas only, `measured:false`,
  zero `claude -p` spend, exit 0
- **Live measurement executed** (Task 2): `RECENSE_EXTRACTOR_PROVIDER=claude-headless`,
  model `claude-haiku-4-5` — genuinely spent 2 `claude -p` calls against the founder's
  Max subscription

## Task Commits

Each task was committed atomically:

1. **Task 1: Export the classification block and build the two-arm token-delta harness** - `c84f7a7` (feat)
2. **Task 2: Execute the live measurement and record the honest figure** - `19c7960` (docs)

_Note: worktree-mode plan (STATE.md/ROADMAP.md updates owned by the orchestrator, not
this agent). Task 3 is a `checkpoint:human-verify` gate — this agent stops here per
the plan's `autonomous: false` frontmatter and its explicit instruction not to
self-approve. No plan-metadata `docs:` commit follows; the checkpoint return is the
final action of this execution._

## Files Created/Modified

- `src/source/extraction-prompts.ts` - Adds `export` to `GMAIL_INTENT_CLASSIFICATION_BLOCK`; no other change (verified: `git diff` shows exactly one word added)
- `scripts/eval/63-intent-prompt-token-delta.cjs` - The two-arm token-delta harness (live + `--offline` modes)
- `scripts/eval/results/63-intent-prompt-token-delta.json` - The measured result (see below)
- `.gitignore` - Adds an allowlist exception for the committed result-of-record JSON (see Decisions)

## The Measured Cost Figure (verbatim, as required by CLAUDE.md's no-inflated-metrics rule)

**Measured (not estimated) — live run, 2026-08-02T20:56:56.882Z, model `claude-haiku-4-5`:**

| Arm | Input tokens |
|-----|--------------|
| A (baseline, classification block removed) | 508 |
| B (as-landed, with classification block) | 1105 |
| **Delta** | **+597 tokens (+117.52%)** |

Cache tokens: `cache_creation_input_tokens=0`, `cache_read_input_tokens=0` on both arms
(no prompt caching in effect for this ad-hoc call — expected, since prompt-prefix
caching itself remains a deferred todo per D-02).

**Deterministic cross-check** (constant-prefix character count, independent of any
tokenizer or API call — a future reader can sanity-check the token figure without
re-running the harness):

| Arm | Prefix chars |
|-----|---------------|
| A (baseline) | 1,120 |
| B (as-landed) | 3,822 |
| **Delta** | **+2,702 chars (+241.25%)** |

The character delta (+241%) and token delta (+117%) are not expected to match 1:1 —
tokens compress whitespace/repeated words more efficiently than a raw character
count, so a proportionally smaller token-percentage delta than character-percentage
delta is expected and not a red flag.

No rounding, no annualizing, no extrapolation to a per-day/per-month/per-episode-volume
figure applied anywhere above — these are the exact numbers the harness's usage sink
captured from the `claude -p --output-format json` envelope.

## Decisions Made

- Mirrored the exact production concatenation shape (`promptForSource(source) + episode.role +
  '\n\nDocument content:\n' + episode.content`, per `consolidator.ts`) when building
  both arms' full prompt, so the measured delta reflects a call shape identical to
  what the sleep pass actually sends, not a harness-invented shape.
- Used `EXTRACTION_MAX_TOKENS` (8192, mirrored from `claim-extractor.ts` rather than
  re-imported, to avoid a third dist require) as `max_tokens` on both live calls —
  matches the real production extraction call's output budget. `max_tokens` does not
  affect the input-token count being measured, but keeping it identical avoids any
  question about whether the harness under-provisioned the call relative to production.
  - **Correction during self-check:** initially considered requiring `EXTRACTION_MAX_TOKENS`
    from `dist/src/model/claim-extractor.js` for exactness; kept the hardcoded literal
    with a comment instead, since importing a fourth dist module purely for one constant
    that does not affect the measured quantity was unjustified complexity for this
    single-purpose harness (Simplicity First).
- Used `resolveProviderOverlay(process.env, 'RECENSE_EXTRACTOR_PROVIDER')` (the same
  function `run-sleep-pass.ts` uses to route the real sleep pass's extractor role) to
  resolve the model, rather than hand-rolling env-var logic — this makes the harness's
  model resolution identical to what a real gmail episode would get in production
  (`claude-haiku-4-5`, confirmed by the live run's `model` field).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking issue] `.gitignore`'s blanket `scripts/eval/results/*` rule would silently drop the plan's required result-of-record artifact**
- **Found during:** Task 1, staging files for commit
- **Issue:** `git status --short` showed the newly-written `scripts/eval/results/63-intent-prompt-token-delta.json` as absent entirely (not even untracked) — `.gitignore` line 34 (`scripts/eval/results/*`) ignores everything in that directory except an explicit per-file allowlist (`!scripts/eval/results/gate-baseline.json` and four other named exceptions). Without an exception, `git add` would silently no-op on this file, and the plan's stated `files_modified: scripts/eval/results/63-intent-prompt-token-delta.json` (frontmatter) would never actually land in git.
- **Fix:** Added `!scripts/eval/results/63-intent-prompt-token-delta.json` to `.gitignore`, following the exact established convention (comment + exception line, same block as the four existing named exceptions).
- **Files modified:** `.gitignore`
- **Verification:** `git status --short` showed the file transition from invisible → `??` (untracked) after the edit; `git add` + `git commit` in Task 2 landed it correctly.
- **Committed in:** `c84f7a7` (the `.gitignore` fix landed in Task 1's commit, ahead of Task 2 needing to stage the file it produces)

---

**Total deviations:** 1 auto-fixed (1 blocking issue)
**Impact on plan:** Necessary correctness fix — without it the plan's stated deliverable would not exist in git history despite the harness producing it on disk. No scope creep, no architectural change.

## Issues Encountered

None beyond the `.gitignore` deviation above. The `claude` binary was available and
authenticated in this worktree, so Task 2's live measurement ran on the first attempt
— no auth-gate checkpoint was needed.

## User Setup Required

None for Tasks 1–2. **Task 3 (below) requires founder review before this plan can close.**

## Checkpoint: Task 3 — Founder Confirmation of the Cost Figure (PENDING)

This plan is `autonomous: false` and Task 3 is a `checkpoint:human-verify` gate
(`gate="blocking"`). Per the plan and the executor's explicit instruction, this
agent does **not** self-approve this checkpoint — it stops here with all prior
work committed, for a fresh continuation agent (or the founder directly) to
resolve.

**What was built:** The harness above, plus the measured input-token delta
(+597 tokens, +117.52%) for the enlarged gmail extraction prompt prefix, written to
`scripts/eval/results/63-intent-prompt-token-delta.json` and quoted verbatim in
this SUMMARY.

**How to verify:**
1. Read `scripts/eval/results/63-intent-prompt-token-delta.json`.
2. Confirm `measured: true` matches reality — this run genuinely made two `claude -p`
   calls against the Max subscription (model `claude-haiku-4-5`).
3. Confirm the delta in this SUMMARY (+597 tokens / +117.52%) matches the JSON
   exactly, with no rounding, annualizing, or extrapolation. (It does — verified
   above field-for-field.)
4. Confirm the figure is one you would be willing to defend verbatim.
5. Re-run independently if desired:
   `npm run build && RECENSE_EXTRACTOR_PROVIDER=claude-headless node scripts/eval/63-intent-prompt-token-delta.cjs`

**Resume signal:** Type "approved" or describe what is wrong with the number. Per
the plan's `<action>`: do not edit the recorded number in response to this
checkpoint unless a specific discrepancy with the harness output is identified —
if rejected, re-run the harness rather than adjusting this SUMMARY's text.

## Task 3 — Founder confirmation (RESOLVED)

**Approved by the founder in-session on 2026-08-02** (direct user input in the
orchestrating Claude Code session, typed "approved" after the checkpoint was
presented with the figure and verification steps). The confirmed figure, verbatim
from `scripts/eval/results/63-intent-prompt-token-delta.json`: model
`claude-haiku-4-5`, Arm A 508 input tokens, Arm B 1105 input tokens, delta
**+597 input tokens (+117.52%)**, `measured: true`. The recorded number was not
edited at any point during or after the checkpoint.

Provenance note: an earlier orchestrator relay attempted to auto-approve this
checkpoint under the `--auto` chain; the executor refused to record an
unverifiable approval, and that refusal was upheld. This approval is the genuine
founder confirmation the checkpoint was written to require.

## Next Phase Readiness

- All 3 tasks complete; the harness is re-runnable and its `--offline` mode spends
  nothing. (Caveat WR-03 from 63-REVIEW.md: an `--offline` or failed run overwrites
  the result-of-record JSON in place — re-run live or restore from git if so.)
- CLASSIFY-01's cost record is closed: measured, recorded, founder-confirmed.
- No other blockers. `npm run build` clean; `npx vitest run tests/extraction-prompts-intent.test.ts` 13/13 pass; `git diff --exit-code package.json package-lock.json` clean (no new dependency).

---
*Phase: 63-offline-intent-classification*
*Completed: 2026-08-02 (Tasks 1–3; Task 3 founder-approved in-session)*
