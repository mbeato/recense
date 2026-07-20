---
phase: quick-260720-nup
plan: "01"
subsystem: infra
tags: [ci, github-actions, regression-gate, eval, branch-protection]

requires:
  - phase: 50
    provides: gate-runner.cjs deterministic override-mode comparison + gate-baseline.json thresholds
provides:
  - Tracked recorded-metric fixtures (locomo-d41d5c8.json, gate-latency-run.json, gate-injection-run.json, 46-recon03-ku-bm25on.json)
  - npm run gate:ci — fully offline, override-mode gate invocation (no harness spawn, no build, no DB)
  - .github/workflows/ci.yml gate job wired into CI on every push/PR
  - scripts/setup-branch-protection.sh updated to require the gate check (not yet applied — needs admin)
affects: [ci-pipeline, branch-protection, gate-01-requirement]

tech-stack:
  added: []
  patterns: ["CI regression gate reads only committed recorded-metric JSONs via override flags; zero harness spawn, zero API spend, zero DB in CI"]

key-files:
  created: []
  modified:
    - .gitignore
    - package.json
    - scripts/eval/results/locomo-d41d5c8.json
    - scripts/eval/results/gate-latency-run.json
    - scripts/eval/results/gate-injection-run.json
    - scripts/eval/results/46-recon03-ku-bm25on.json
    - .github/workflows/ci.yml
    - scripts/setup-branch-protection.sh
    - .planning/REQUIREMENTS.md

key-decisions:
  - "gate:ci script omits `npm run build &&` prefix — override mode reads only committed JSON via fs/path/child_process built-ins, so pulling in the better-sqlite3 native compile would be pure waste."
  - "gate job in ci.yml runs on a single OS (ubuntu-22.04, no matrix) since the gate is deterministic JSON comparison, not platform-dependent."
  - "Checkpoint (branch-protection application) left PENDING — requires repo-admin gh auth Claude does not hold."

patterns-established:
  - "Regression-gate CI jobs should default to override/offline mode in CI; harness-spawning invocations reserved for local/manual runs only."

requirements-completed: [GATE-01]

duration: 3min
completed: 2026-07-20
---

# Quick Task 260720-nup: Wire Regression Gate into CI Merge Block Summary

**Wired the existing deterministic gate-runner.cjs into GitHub Actions as an offline `gate:ci` job (zero harness spawn, zero build, zero DB, sub-second) and updated branch-protection script contexts — actual enforcement pending maintainer admin action.**

## Performance

- **Duration:** ~3 min (17:16:05 → 17:18:24 commit timestamps)
- **Started:** 2026-07-20T17:16:05-04:00
- **Completed:** 2026-07-20T17:18:24-04:00
- **Tasks:** 2 of 3 completed (Task 3 is a blocking checkpoint:human-action, left pending)
- **Files modified:** 9

## Accomplishments
- Un-ignored and committed the four recorded-metric JSON fixtures the gate reads (previously untracked/gitignored — would have failed "cannot read" on any fresh CI checkout)
- Added `gate:ci` npm script invoking `gate-runner.cjs` with all four override flags (`--locomo`/`--latency`/`--injection`/`--contradicts`), guaranteeing zero harness spawn in CI
- Added a dedicated `gate` job to `.github/workflows/ci.yml` (checkout + setup-node only — no `npm ci`/build) that runs `npm run gate:ci`
- Updated `scripts/setup-branch-protection.sh` to include `"gate"` in `required_status_checks.contexts`
- Closed the GATE-01 requirement row in `.planning/REQUIREMENTS.md` (checkbox + status table)

## Task Commits

Each task was committed atomically:

1. **Task 1: Commit gate input fixtures + add offline gate:ci script** - `c114b5b` (feat)
2. **Task 2: Add merge-blocking gate CI job + branch-protection context + close GATE-01 row** - `6812ecd` (feat)
3. **Task 3: checkpoint:human-action** - NOT executed (see Checkpoint section below)

## Files Created/Modified
- `.gitignore` - Added 4 negation lines un-ignoring the gate's recorded-metric input JSONs
- `package.json` - Added `gate:ci` script (all-override, no build prefix)
- `scripts/eval/results/locomo-d41d5c8.json` - Now tracked (recorded LoCoMo R@K scores, byte-identical to prior on-disk copy, not regenerated)
- `scripts/eval/results/gate-latency-run.json` - Now tracked (recorded warm p50/p95 latency, byte-identical, not regenerated)
- `scripts/eval/results/gate-injection-run.json` - Now tracked (recorded injected-token point estimate, byte-identical, not regenerated)
- `scripts/eval/results/46-recon03-ku-bm25on.json` - Now tracked (recorded judge-fire contradiction count, byte-identical, not regenerated)
- `.github/workflows/ci.yml` - New `gate` job (ubuntu-22.04, checkout + setup-node + `npm run gate:ci`)
- `scripts/setup-branch-protection.sh` - `"gate"` appended to required contexts; summary echo lines updated
- `.planning/REQUIREMENTS.md` - GATE-01 checkbox `[x]`, status row `Done`

## Decisions Made
- Kept `gate:ci` free of `npm run build &&` since override mode never touches `dist/` or native modules — confirmed by measured runtime (see verification below).
- Single-OS `gate` job (no matrix) — the gate is a pure JSON comparison, platform-independence is a given.
- Left `gate` / `gate:baseline` / `gate:accuracy` scripts and the `test` job entirely untouched, per plan.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixture files missing from this worktree checkout**
- **Found during:** Task 1 (before editing anything)
- **Issue:** The plan asserts the four recorded-metric JSONs "already exist on disk" — true in the main repo working tree, but this executor runs in an isolated git worktree, and since the files were untracked/gitignored, `git worktree add` did not carry them over. `scripts/eval/results/` in this worktree had only 5 files, missing all four gate inputs.
- **Fix:** Copied the four files byte-for-byte from the main repo checkout (`/Users/vtx/brain-memory/scripts/eval/results/`) into this worktree's `scripts/eval/results/`, then verified with `diff -q` that each copy was byte-identical to the source before staging. No values were regenerated, recomputed, or edited — satisfies the no-fabricated-metrics hard rule.
- **Files affected:** `scripts/eval/results/{locomo-d41d5c8,gate-latency-run,gate-injection-run,46-recon03-ku-bm25on}.json`
- **Verification:** `diff -q` clean on all four before staging; `npm run gate:ci` passes using the copied files; post-negative-test restore also verified byte-identical via `diff`.
- **Committed in:** c114b5b (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking — missing worktree files, resolved via verified byte-identical copy, not regeneration)
**Impact on plan:** No scope creep; the underlying file contents match exactly what the plan's baseline was derived from.

## Issues Encountered
None beyond the deviation above.

## Verification (Task 1 — real output)

```
$ node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))" && echo "JSON-OK"
JSON-OK

$ time npm run gate:ci
> recense@0.1.0 gate:ci
> node scripts/eval/gate-runner.cjs --run --locomo scripts/eval/results/locomo-d41d5c8.json --latency scripts/eval/results/gate-latency-run.json --injection scripts/eval/results/gate-injection-run.json --contradicts scripts/eval/results/46-recon03-ku-bm25on.json

GATE PASS
npm run gate:ci 2>&1  0.08s user 0.03s system 46% cpu 0.228 total

$ git ls-files --error-unmatch scripts/eval/results/locomo-d41d5c8.json scripts/eval/results/gate-latency-run.json scripts/eval/results/gate-injection-run.json scripts/eval/results/46-recon03-ku-bm25on.json
scripts/eval/results/46-recon03-ku-bm25on.json
scripts/eval/results/gate-injection-run.json
scripts/eval/results/gate-latency-run.json
scripts/eval/results/locomo-d41d5c8.json
```

Sub-second runtime, "GATE PASS", no "Running ... harness" lines — confirms pure offline comparison of committed JSON with zero harness spawn, zero DB, zero network.

**Negative-check (optional/manual verification item from plan):** temporarily set `locomo-d41d5c8.json`'s `scores.rAtK.r5` to `0.01`, re-ran `npm run gate:ci`:
```
GATE FAIL: locomo_r5 0.01 < floor 0.7527
EXIT=1
```
Confirms the gate actually gates. Restored the fixture via `git checkout --` immediately after; `diff` against the original pre-edit backup showed byte-identical restoration; `npm run gate:ci` re-confirmed "GATE PASS" afterward. This negative check was NOT committed (working tree left clean).

## Verification (Task 2)

```
grep -q "npm run gate:ci" .github/workflows/ci.yml            # OK
grep -q "^  gate:" .github/workflows/ci.yml                     # OK
grep -q '"gate"' scripts/setup-branch-protection.sh             # OK
grep -q "GATE-01.*Done" .planning/REQUIREMENTS.md               # OK
grep -q "\[x\] \*\*GATE-01" .planning/REQUIREMENTS.md            # OK
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"  # YAML-VALID
```

## Checkpoint (PENDING — human action required)

**Task 3** is a `checkpoint:human-action` (`gate="blocking"`) that requires a repo-admin-authenticated `gh` CLI session — Claude does not hold admin credentials on `mbeato/recense`, and per this execution's explicit constraint, the script was NOT run.

**What's built:** `.github/workflows/ci.yml` now has a `gate` job running `npm run gate:ci` on every push/PR. `scripts/setup-branch-protection.sh` lists `"gate"` in `required_status_checks.contexts`. The job runs automatically, but GitHub will not treat it as merge-blocking until branch protection is re-applied.

**How to verify / resolve (maintainer action):**
1. Ensure `gh auth status` shows admin auth on `mbeato/recense`.
2. Run: `bash scripts/setup-branch-protection.sh`
3. Confirm the script's output lists the `gate` check among required checks with no API error.
4. Optional: open a throwaway PR and confirm `gate` appears among required checks.

**Resume signal:** Type "approved" once branch protection is applied, or describe any error so the script's contexts can be corrected.

**Status:** PENDING — not yet run. GATE-01 code/CI wiring is complete and committed; only the branch-protection API call remains outstanding.

## User Setup Required

**External service requires manual configuration** (repo-admin gh auth):
- Run `bash scripts/setup-branch-protection.sh` with an admin-authenticated `gh` CLI session on `mbeato/recense` to make the `gate` check merge-blocking on `main`. See Checkpoint section above for full steps.

## Next Phase Readiness
- GATE-01 code/CI side is fully wired and verified (sub-second offline gate, correctly fails on regression, correctly passes on the real committed baseline).
- Merge-blocking enforcement is one manual `gh api` call away — no further code changes needed once the maintainer runs the updated `scripts/setup-branch-protection.sh`.
- No blockers for other work; this is a narrow, isolated CI/infra change with no runtime dependency additions.

## Self-Check: PASSED

All 10 files verified present on disk; both task commits (c114b5b, 6812ecd) verified present in git log.

---
*Phase: quick-260720-nup*
*Completed: 2026-07-20*
