---
quick_id: 260802-m2e
slug: restore-backlog-lane-999
status: complete
created: 2026-08-02
completed: 2026-08-02
commits:
  - 6568059
key_files:
  modified:
    - .planning/phases/999.2-retrieval-embeddings-reconsolidation-engages-knowledge-updat/
    - .planning/phases/999.3-scope-aware-provenance-memory-importer/
---

# Quick Task 260802-m2e — Summary

Restored the GSD backlog lane from `998.x` to `999.x`, fixing a `gsd-sdk phase.add`
mis-numbering bug that had recurred five times.

## What was wrong

`phase.add` returned **999** for every new phase. STATE.md records the same manual
correction for phases 52, 54, 56, and 57; Phase 69 on 2026-08-02 made five.

The initial hypothesis — that the scan matched the string `999.3-MIGRATION.md` in
ROADMAP.md prose — was **wrong**, and worth recording as such.
`scanSequentialMaxPhaseFromMilestone` requires a literal `Phase N:` heading, so prose
never reaches it.

The real cause was on disk. GSD reserves exactly one backlog lane, `999.x`, and both
scan functions in `sdk/dist/query/phase-lifecycle-policy.js` skip it with
`if (num >= 999) continue`. Two directories numbered `998.x` are not `>= 999`, so
`scanSequentialMaxPhaseFromDirs` accepted them:
`maxPhase = 998` → `computeNextSequentialPhaseId` = **999**.

Those directories were mis-named by commit `40ffcde` (*"archive v9.0 phase directories"*,
2026-07-29), which shifted 999.x → 998.x in the path while leaving every internal
reference at 999.x: `998.3-01-PLAN.md` frontmatter read `phase: 999.3-scope-aware-provenance-memory-importer`,
and ROADMAP.md line 93 still cites `999.3-MIGRATION.md`.

## What changed

`git mv` only — two directories and the five files inside `999.3/`. Staged as six pure
renames: **0 insertions, 0 deletions**. No file contents touched (`grep -rn "998"` over
both directories returned zero hits inside files; the string existed only in path names).

## Verification

| Check | Result |
|-------|--------|
| `phase.add --dry-run` next id | **70** (was 999) |
| Dry-run left no residue | no `70-*` directory created |
| Lane contents intact | 6 files present under 999.x |
| History preserved | `git log --follow` reaches `40ffcde` through the rename |
| Content unchanged | `6 files changed, 0 insertions(+), 0 deletions(-)` |

## Deviation from workflow

Executed inline rather than spawning `gsd-planner` (opus) + `gsd-executor`. The task was
a fully-diagnosed directory rename; a planning agent would have added cost without adding
information. Quick-task guarantees were preserved: PLAN.md, SUMMARY.md, atomic commit,
STATE.md tracking.

## Out of scope — upstream

The SDK fails silently: one stray high-numbered directory yields a nonsense phase number
with no warning, and the reserved band is hardcoded as `>= 999` rather than derived. Not
patchable locally — `gsd-sdk` resolves to an npx-cached package
(`~/.npm/_npx/4db0de1f85c3165e/node_modules/get-shit-done-cc/sdk/dist/`), so edits are
destroyed on the next update. Worth an upstream issue: `phase.add` should either warn when
the computed id lands in a reserved band, or refuse and require `--id`.

Related latent issue, not addressed: `init.phase-op` returns
`milestone_version: null, milestone_name: null` for this project, so milestone detection
is also degraded. Did not affect this fix (the dir scan dominated), but it means
`extractCurrentMilestone` is not resolving the v10.0 section.

## Self-Check: PASSED
