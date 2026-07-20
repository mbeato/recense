---
phase: 29-survey-quality-spike
plan: 02
subsystem: ingestion
tags: [spike, survey, claude-headless, judge, quality-gate, schema-induction, ingest-03]
status: complete

# Dependency graph
requires:
  - phase: 29-survey-quality-spike
    plan: 01
    provides: "populated scratch DB at /tmp/recense-spike.db (71 episodes, 166 facts, 16 schemas) + the D-08 survey prompt"
provides:
  - "scripts/spike/genuine-noise-judge.ts — read-only throwaway harness: per-fact genuine/noise judge over the 166 [usage] facts + per-area tally + ≥5-genuine bar + schema-induction inspection"
  - "The exact D-07 JUDGE_PROMPT text (recorded below verbatim — Plan 03 calibration input)"
  - "The pinned-node founder run command for the subscription-billed measurement"
affects: [29-03-calibration-notes, 30-ingest-project]

# Tech tracking
tech-stack:
  added: []  # net-zero new runtime deps (Success Criterion 1) — reuses the headless judge transport
  patterns:
    - "Read-only spike harness pattern: new Database(scratchDbPath, { readonly: true }) — query-only, never writes (T-29-05)"
    - "Fact→area mapping: join node → consolidation_event(node_id) → episode(episode_id), parse 'project-survey:usage:<area>' from session_id"
    - "Schema-induction inspection counts type='schema' WITHOUT a node_scope='usage' join (schemas carry no scope row); #facts-generalized via outgoing abstracts/schema_rel edges"

key-files:
  created:
    - scripts/spike/genuine-noise-judge.ts
  modified: []

key-decisions:
  - "Both auto tasks (per-fact judge + schema inspection) live in one file, committed as one feat commit — same single-artifact precedent as Plan 01"
  - "Facts use the node_scope='usage' join (166 rows, scoped — finding #3); schemas do NOT (16 schemas, 0 match scope='usage' — finding #1)"
  - "node has no created_at column (finding #2) → ORDER BY n.rowid"
  - "Verdict parser is lenient: matches the word `genuine`/`noise` anywhere in a short reply (the one-word contract is instructed but not assumed); empty reply → 'unknown' (timeout/failure fail-safe)"

requirements-completed: []  # INGEST-03 spans the whole phase; closed at Plan 03 go/no-go

# Metrics
duration: 14min
completed: 2026-06-20
---

# Phase 29 Plan 02: Survey Quality Spike — Genuine/Noise Judge Summary

**Throwaway read-only `scripts/spike/genuine-noise-judge.ts` that judges each of the 166 `[usage]` facts in the scratch DB `genuine | noise` via the existing headless judge tier (net-zero new deps), reports a per-area tally with the ≥5-genuine bar (Success Criterion 2 / D-02) plus every per-fact verdict line for founder spot-check, and inspects the induced schemas (count + labels + #facts-generalized) for the ≥1-schema bar (Success Criterion 3). Awaiting the founder's subscription-billed run.**

## Status: COMPLETE (founder-approved checkpoint, 2026-06-20)

Both `auto` tasks built + committed; the founder ran the subscription-billed judge and
approved on 2026-06-20.

## Measured Results (founder judge run, 2026-06-20)

| Area | Genuine | Noise | Unknown | ≥5 bar |
|------|---------|-------|---------|--------|
| architecture | 45 | 7 | 0 | PASS |
| conventions | 47 | 1 | 0 | PASS |
| **decisions** | **0** | 2 | 0 | **FAIL** |
| current-state | 39 | 7 | 0 | PASS |
| gotchas | 5 | 13 | 0 | PASS |
| **OVERALL** | **136** | **30** | 0 | **82% genuine** |

`SCHEMAS INDUCED: 16 (need >= 1) — PASS`. Several generalize large fact clusters (16, 15,
11 facts): "Next.js 15 Dashboard App", "Claude Code plugins hooks", "JSONL logging strategy
tradeoffs", "Plugin Hook Architecture", "Thin API Route Layer", etc.

**Root-cause analysis of the two shortfalls (carry to Plan 03 / Phase 30):**
1. **decisions FAIL is an agent tool-access flake, NOT a signal gap.** Its only two facts are
   *"Read, Grep, and Glob tools cannot access /Users/vtx/usage"* and *"No genuine observations
   available about the codebase at /Users/vtx/usage"* — the survey agent's file tools failed on
   that one (16s) call and it returned an apology that got ingested as facts. Fix for Phase 30:
   detect access-failure / refusal responses and **retry or skip them** (do not ingest). A re-run
   of just `decisions` would almost certainly clear ≥5.
2. **gotchas is noise-heavy (13/18 noise)** — its prompt elicited structural "what" trivia
   ("lib contains shared logic", "lib/db.js uses SQLite via better-sqlite3"). The gotchas-area
   framing needs tightening for Phase 30 (push harder on why-level, or source gotchas differently).

The other 4 areas average ~90% genuine; conventions is 47/48. Overall 82% genuine + 16 real
schemas → the go/no-go leans GO with the two documented fixes (Plan 03 records the founder call).

## What was built

`scripts/spike/genuine-noise-judge.ts` (271 lines, commit `cd19f25`):

- **Task 1 — per-fact genuine/noise judge + per-area tally.** Opens the scratch DB
  `{ readonly: true }` (T-29-05). Loads the 166 facts via the `node_scope.scope='usage'`
  join (facts ARE scoped — finding #3), mapping each fact to its INGEST-03 area by joining
  through `consolidation_event → episode.session_id` (`project-survey:usage:<area>`); all
  166 resolve an area, falling back to an `unmapped` bucket if the join were empty. The
  judge is built via `createClaudeHeadlessClient({ ...DEFAULT_CONFIG, dbPath, ...resolveProviderOverlay(process.env,'RECENSE_JUDGE_PROVIDER') })`
  (D-02 — reuse the existing judge tier, net-zero deps), called per fact at `max_tokens: 64`;
  the reply is trimmed/lowercased, the `genuine`/`noise` word matched leniently, and an
  empty reply guarded as `unknown` (timeout/failure fail-safe — never throws). Output: every
  per-fact verdict line (verdict, area, id-prefix, value-prefix) for the D-02 spot-check, the
  per-area tally with the `≥5 genuine: PASS/FAIL` marker, and overall totals.

- **Task 2 — schema-induction inspection.** `reportSchemas(db)` counts/labels the
  `type='schema' AND tombstoned=0` nodes **WITHOUT** a `node_scope='usage'` join (schemas
  carry no scope row — finding #1: 16 schemas exist, 0 match a `scope='usage'` join). For
  each schema it reports the number of facts it generalizes via outgoing
  `abstracts`/`schema_rel` edges (`edge.src = schemaId`), then prints
  `SCHEMAS INDUCED: <n> (need >= 1)` with PASS/FAIL. Reported, not gated — the founder makes
  the go/no-go call.

**Isolation / billing (load-bearing):** read-only DB open (cannot corrupt the spike data),
judge built via `createClaudeHeadlessClient` (strips `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`
→ subscription billing; `--setting-sources project` → no self-ingestion loop). No raw
`claude` argv. Not added to `package.json bin`. No new npm dependency.

## Wave-1 findings honored (from 29-01-SUMMARY, verified against /tmp/recense-spike.db)

1. **Schemas carry no `node_scope='usage'` row** — confirmed (16 schemas, 0 via the scope
   join). Task 2 counts schemas WITHOUT the scope join → reports 16, not 0.
2. **node has no `created_at` column** — confirmed via PRAGMA; the harness orders by
   `n.rowid`, not `created_at` (which would error).
3. **Facts ARE scoped** — confirmed: the `node_scope.scope='usage'` join returns 166. Used
   for FACTS only.
4. **Area mapping** — confirmed all 166 facts resolve an area via
   `consolidation_event → episode.session_id`. `decisions` had only 1 episode, so it is
   expected to fall short of the ≥5-genuine bar — that is a reportable finding, not a
   harness bug (Phase-30 per-area prompt tuning).

## Exact JUDGE_PROMPT (D-07 quality gate — Plan 03 needs this VERBATIM)

`{{FACT}}` is replaced with the fact's value text:

```
You are auditing the quality of a fact extracted from an automated survey of a code
repository. Classify the fact as exactly one of two categories.

GENUINE = summarized, why-level semantic knowledge a senior engineer would tell a new
teammate: architecture rationale, conventions and the reasons behind them, design
decisions and their tradeoffs, the current state of the project, or a gotcha. It
explains WHY or captures a non-obvious insight.

NOISE = a raw code line or snippet, structural trivia ("file X imports Y", "module A
calls module B"), a dependency or import list, boilerplate, or a config dump. It states
WHAT the code literally is without why-level insight.

Fact to classify:
"""
{{FACT}}
"""

Answer with EXACTLY one word, lowercase, no punctuation: genuine OR noise.
```

## Founder run command (pinned node + tsx — copy-paste-safe single line)

```
RECENSE_LOCK_PATH=/tmp/recense-spike.lock RECENSE_JUDGE_PROVIDER=claude-headless /Users/vtx/.nvm/versions/node/v25.5.0/bin/node node_modules/.bin/tsx scripts/spike/genuine-noise-judge.ts --db /tmp/recense-spike.db
```

(No `OPENAI_API_KEY` needed — this harness embeds nothing and writes nothing; the judge is
claude-headless / subscription-billed. `RECENSE_JUDGE_PROVIDER=claude-headless` IS required
so the judge routes to the headless transport. The pinned node bin avoids the better-sqlite3
ABI mismatch under an nvm-default Node 22 shell.)

## Self-Check: PASSED

- `scripts/spike/genuine-noise-judge.ts` — FOUND (271 lines).
- commit `cd19f25` — FOUND in `git log`.
- `npx tsc --noEmit` — no errors for the file.
- `git status package.json` — clean (net-zero new deps).

---
*Phase: 29-survey-quality-spike*
*Status: awaiting-checkpoint (founder runs the subscription-billed judge — D-02)*
*Updated: 2026-06-20*
