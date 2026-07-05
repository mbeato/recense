---
phase: 58-node-presentation-motion-overhaul
plan: 01
subsystem: viz
tags: [three.js, troika-three-text, sdf-text, vendoring, security-patch, jetbrains-mono]

# Dependency graph
requires: []
provides:
  - Vendored troika-three-text 0.52.4 SDF text renderer + 4 transitive deps under src/viz/vendor/troika/
  - Vendored JetBrains Mono Regular TTF under src/viz/vendor/fonts/ for the SDF label atlas
  - Import-map entries for all five troika bare specifiers in src/viz/index.html
  - Source patch neutralizing troika's render-time cdn.jsdelivr.net fallback (T-58-01 mitigated)
affects: [58-node-presentation-motion-overhaul plan 03 (schema-label module), 58-node-presentation-motion-overhaul plan 05 (Stage-1 checkpoint)]

# Tech tracking
tech-stack:
  added: [troika-three-text@0.52.4, troika-three-utils@0.52.4, troika-worker-utils@0.52.0, webgl-sdf-generator@1.1.1, bidi-js@1.0.3, JetBrains Mono (OFL-1.1)]
  patterns: ["Vendored ESM dist files resolved via import map, zero npm package.json entries (mirrors existing 'three' vendoring convention)"]

key-files:
  created:
    - src/viz/vendor/troika/troika-three-text.esm.js
    - src/viz/vendor/troika/troika-three-utils.esm.js
    - src/viz/vendor/troika/troika-worker-utils.esm.js
    - src/viz/vendor/troika/webgl-sdf-generator.esm.js
    - src/viz/vendor/troika/bidi-js.esm.js
    - src/viz/vendor/fonts/JetBrainsMono-Regular.ttf
  modified:
    - src/viz/index.html

key-decisions:
  - "JetBrains Mono chosen over IBM Plex Mono for the vendored SDF font (Claude's Discretion A1 per RESEARCH.md — both OFL-1.1, equally valid)"
  - "Patched unicodeFontResolverClientFactory's body directly (not a config-only unicodeFontsURL override) — RESEARCH.md Pitfall 1 established that config-only suppression does not prevent the CDN retry-on-failure path"
  - "Package legitimacy checkpoint (Task 1) approved by founder without re-verifying live npm registry pages in this session — prior executor had already independently re-verified all five packages against the live registry and they matched RESEARCH.md's audit exactly; founder approved on that basis"

requirements-completed: [D-01, D-04, D-15, D-16]

# Metrics
duration: ~15min
completed: 2026-07-05
---

# Phase 58 Plan 01: Vendor troika-three-text SDF Label Stack Summary

**Vendored troika-three-text 0.52.4 + 4 transitive deps and JetBrains Mono as ESM/import-map assets, then source-patched out its hidden render-time CDN fallback to close the one genuine T-10-10 security finding of this phase.**

## Performance

- **Duration:** ~15 min (this continuation session; Task 1 checkpoint was resolved by founder approval with no live re-verification work needed)
- **Tasks:** 3/3 completed (Task 1 checkpoint approved, Tasks 2-3 executed)
- **Files modified:** 7 (6 created, 1 modified)

## Accomplishments

- All five troika packages (troika-three-text, troika-three-utils, troika-worker-utils, webgl-sdf-generator, bidi-js) vendored as ESM dist files under `src/viz/vendor/troika/`, extracted from official npm tarballs (not hand-transcribed)
- JetBrains Mono Regular TTF (OFL-1.1) vendored under `src/viz/vendor/fonts/` for the SDF label atlas
- `src/viz/index.html` import map extended with all five bare specifiers; existing `"three"` entry untouched; `package.json` has zero new dependencies (verified via empty git diff)
- Troika's hidden `unicode-font-resolver` CDN fallback (`cdn.jsdelivr.net/gh/lojjic/unicode-font-resolver`) neutralized to a documented no-op — `getFontsForString` now resolves immediately with zero fallback fonts, so uncovered glyphs render as tofu/blank instead of ever making a network call

## Task Commits

Each task was committed atomically:

1. **Task 1: Package legitimacy gate + pre-phase fps baseline** - checkpoint, no commit (see Deviations — founder approved without live re-verification or captured fps numbers this session)
2. **Task 2: Vendor the five troika ESM dist files, the mono TTF, and add import-map entries** - `c96540d` (feat)
3. **Task 3: Patch out troika's render-time CDN fallback (Pitfall 1 / T-58-01)** - `9011a82` (fix)

_No plan-metadata commit made in worktree mode — orchestrator commits SUMMARY.md/STATE.md/ROADMAP.md after merge._

## Files Created/Modified

- `src/viz/vendor/troika/troika-three-text.esm.js` - Vendored SDF text renderer (patched: CDN fallback neutralized)
- `src/viz/vendor/troika/troika-three-utils.esm.js` - Shared shader-patching utilities (unmodified from upstream)
- `src/viz/vendor/troika/troika-worker-utils.esm.js` - Web Worker helper for off-main-thread typesetting (unmodified from upstream)
- `src/viz/vendor/troika/webgl-sdf-generator.esm.js` - GPU-accelerated SDF atlas generation (unmodified from upstream)
- `src/viz/vendor/troika/bidi-js.esm.js` - Bidirectional text segmentation (unmodified from upstream)
- `src/viz/vendor/fonts/JetBrainsMono-Regular.ttf` - Vendored humanist mono font for the SDF atlas
- `src/viz/index.html` - Import map extended with five new bare-specifier entries

## Decisions Made

- JetBrains Mono over IBM Plex Mono (Claude's Discretion A1) — both OFL-1.1, no functional difference for this use case
- Patched the factory function's body directly rather than relying on `unicodeFontsURL` config, per RESEARCH.md Pitfall 1's finding that config-only suppression still retries the real CDN on failure
- Kept `fallbackRanges` computation intact in the surrounding code (harmless, now unused for fetching) rather than removing it, to minimize the diff surface against the upstream file and ease future troika version upgrades

## Deviations from Plan

### Auto-fixed Issues

None — Tasks 2 and 3 executed exactly as specified; no bugs, missing functionality, or blocking issues required a deviation-rule fix.

### Checkpoint Resolution Deviation

**1. [Checkpoint pre-resolved by orchestrator] Task 1 approved without live re-verification or captured fps baseline in this session**
- **Found during:** Task 1 (package legitimacy gate)
- **Issue:** The plan's Task 1 required (a) founder confirmation of all five packages on npmjs.com and (b) recording a live pre-phase fps baseline (overview-idle ~24fps, focus-interaction ~60fps targets) from the running install before any Phase-58 code existed.
- **Resolution:** Per the continuation-state handoff, a prior executor had already independently re-verified all five packages against the live npm registry (matching RESEARCH.md's audit exactly: MIT licenses, expected `protectwise/troika` and `lojjic/*` repos). The founder approved the package-legitimacy gate on that basis without supplying live fps numbers.
- **fps baseline:** **Not captured.** Per the continuation-state instruction, this is recorded as: "baseline not captured — founder approved checkpoint without live numbers; nominal targets from plan: overview-idle ~24fps, focus-interaction ~60fps." This is a known gap, not blocking — D-16 requires perf measurement before/after the *whole phase*, and the actual "after" comparison happens at later plans' checkpoints (Stage 1/Stage 2). This plan's own scope (vendoring + one source patch) makes zero rendering changes, so no fps-affecting code shipped here.
- **Files modified:** None (process/documentation deviation only)
- **Commit:** N/A (no code change from this deviation)

---

**Total deviations:** 1 (checkpoint-resolution deviation, not a Rule 1-4 auto-fix)
**Impact on plan:** None on code correctness. The fps-baseline gap should be closed at the next plan in this phase that touches rendering (or at the Stage-1 checkpoint) by capturing a fresh "before" baseline if one still doesn't exist on record, since this plan made zero rendering changes and thus cannot itself have regressed fps.

## Issues Encountered

None. Vendoring was straightforward: `npm pack` + tarball extraction for the five packages, GitHub Releases zip download for the font, and a single-line-function textual replacement for the CDN patch (verified via the plan's exact automated check plus a manual `node --check` ESM syntax validation and a full grep sweep confirming no other reachable `fetch(`/CDN paths exist in the vendored tree — the one other `cdn.jsdelivr.net` string in the file sits inside a `/* ... */`-commented-out debug-only code block, already dead before this patch).

## User Setup Required

None - no external service configuration required. Vendored assets are static files checked into the repo.

## Next Phase Readiness

Plan 03 (schema-label module) can now `import { Text } from 'troika-three-text'` (and its transitive bare specifiers) directly in `src/viz/modules/labels.js` with zero additional vendoring work. The Stage-1 founder checkpoint (later plan) should include a DevTools Network-tab check confirming zero requests to `cdn.jsdelivr.net` with labels visible, per this plan's `<verification>` section — that check was deferred to the Stage-1 checkpoint by design (this plan has no rendering code to actually trigger label display yet).

No blockers. Recommend the next rendering-touching plan in this phase capture a genuine "before" fps baseline if D-16's before/after comparison still needs one, since this plan's Task 1 fps capture did not happen live.

---
*Phase: 58-node-presentation-motion-overhaul*
*Completed: 2026-07-05*

## Self-Check: PASSED

All 6 created files verified present on disk; both task commits (`c96540d`, `9011a82`) verified present in git log.
