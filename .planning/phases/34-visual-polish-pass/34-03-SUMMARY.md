---
phase: 34-visual-polish-pass
plan: "03"
subsystem: viz
tags: [dist-rebuild, guard-checks, visual-checkpoint, founder-fixes]
requires: [34-01, 34-02]
provides: [dist-rebuilt, viz-polish-03-guards-verified, founder-visual-checkpoint]
affects: []
tech_stack:
  added: []
  patterns: []
key_files:
  created:
    - .planning/phases/34-visual-polish-pass/34-03-SUMMARY.md
  modified:
    - src/viz/css/styles.css
    - src/viz/modules/corpus.js
decisions:
  - "All three VIZ-POLISH-03 guards verified green: net-zero deps, no amber at rest, structural-only diff"
  - "Corpus button glyph swap implemented via inline ICON_BOOK/ICON_BRAIN constants in corpus.js (net-zero deps)"
  - "Corpus centering force implemented as plain JS d3-force-protocol object (no d3 import needed)"
  - "Corpus<->brain transition animation deferred to a separate phase (structural change: bridges 2D canvas and 3D brain)"
metrics:
  duration: "~20 min (Task 1 + 3 founder fixes)"
  completed: "2026-06-21"
  tasks_completed: 1
  files_changed: 2
---

# Phase 34 Plan 03: Rebuild dist + VIZ-POLISH-03 Guards + Founder Visual Checkpoint

Rebuild dist from the wave-1/wave-2 viz edits, run all three VIZ-POLISH-03 guards, then apply
three founder-requested post-checkpoint fixes and present for re-verification.

## Tasks Completed

| # | Name | Commit | Files |
|---|------|--------|-------|
| 1 | Rebuild dist + VIZ-POLISH-03 guard greps | 872e453 | dist/src/viz/ rebuilt (gitignored) |
| F1 | Fix: sticky reader × top breathing room | bdd3a17 | src/viz/css/styles.css |
| F2 | Fix: corpus button book→brain icon swap | b7467f5 | src/viz/modules/corpus.js |
| F3 | Fix: compact corpus force layout | 04fa578 | src/viz/modules/corpus.js |
| F1b | Round 2: relocate × into the sticky kicker row | 6a65080 | src/viz/css/styles.css, src/viz/index.html |
| F2b | Round 2: drop corpus-active border + side-view brain glyph | e6098c9 | src/viz/css/styles.css, src/viz/modules/corpus.js |
| F3b | Round 2: loosen corpus spread for label legibility | e9bf420 | src/viz/modules/corpus.js |
| 2 | Founder visual checkpoint | AWAITING HUMAN-VERIFY (3rd pass) | — |

## Task 1: Guard Results (initial pass — commit 872e453)

### Guard 1 — Net-Zero Runtime Dependencies

```
git diff --stat package.json → (empty)
```

**PASS.** `package.json` `dependencies` block unchanged across all of Phase 34.

### Guard 2 — Build

```
npm run build
→ tsc (exit 0)
→ postbuild: chmod +x dist/src/adapter/recense.js && node scripts/copy-viz-assets.cjs
   copy-viz-assets: copied index.html + vendor + css + modules → dist/src/viz/
```

**PASS.** Build clean. All wave-1 (styles.css, index.html R1/B2/detail) and wave-2
(corpus.js B3/C1/C2/state-coverage, styles.css C1/corpus-status, index.html C1) edits
are live in `dist/src/viz/`.

### Guard 3 — No Amber at Rest

```bash
git diff b3c2b9c HEAD src/viz/css/styles.css src/viz/modules/corpus.js src/viz/index.html \
  | grep '^+' | grep -v '^+++' | grep -iE 'd9a05c|rgba\(217'
# → (no output)
```

**PASS.** Zero added lines contain `#d9a05c` or any `rgba(217, …)` amber variant on a rest selector.

New palette additions confirmed muted:
- `#reader-head` background: `rgba(20, 14, 26, 0.97)` — dark aubergine
- `#topic-wrap` border: `rgba(140, 150, 165, 0.08)` — muted slate
- `.mode-window #btn-corpus` background: `rgba(26, 18, 32, 0.7)` — dark aubergine
- `.mode-window #btn-corpus.corpus-active` border: `rgba(156, 112, 128, 0.55)` — muted rose
- `.corpus-status` color: `#6b5f73` — muted mauve
- `.corpus-status code` color: `#8b7090` — muted mauve

### Guard 4 — No Structural / 3D-Density Change

```bash
git diff b3c2b9c HEAD --name-only | grep -v '^dist/' | grep -v '^\.planning/'
# →
#   src/viz/css/styles.css
#   src/viz/index.html
#   src/viz/modules/corpus.js
```

**PASS.** Exactly three viz presentation files changed. No brain.js, haze.js, graph.js, or any
other 3D engine module touched. Founder-locked haze instancing and density anchor untouched.

## Founder Post-Checkpoint Fixes (re-verified after fixes)

### F1 — Sticky reader × top breathing room (bdd3a17)

**Problem (founder verbatim):** "the sticky x needs a little top padding otherwise is fine."

**Fix in `src/viz/css/styles.css`:**
- `#reader-head` `padding-top`: 20px → 24px (+4px — xs token breathing room above the ×)
- `#reader-close` `top`: -2px → 4px (sits naturally within the expanded head padding)
- Palette unchanged: muted mauve at rest, slate on hover, no amber.

### F2 — Corpus button book→brain icon swap (b7467f5)

**Problem:** `#btn-corpus` always showed a book SVG — only `aria-label` swapped, not the visible glyph.

**Fix in `src/viz/modules/corpus.js`:**
- Added `ICON_BOOK` and `ICON_BRAIN` inline SVG constants (no new deps — net-zero rule)
- `showCorpus()`: `corpusBtn.innerHTML = ICON_BRAIN` (corpus active → button reads "go back to brain")
- `showBrain()`: `corpusBtn.innerHTML = ICON_BOOK` (brain active → button reads "go to corpus")
- `returnToCorpus()`: `corpusBtn.innerHTML = ICON_BRAIN` (reader closes back to corpus → brain icon)
- `index.html` unchanged — book SVG remains the correct default (loaded before any JS runs)
- Muted-rose active border kept, no amber.

### F3 — Compact corpus force layout (04fa578)

**Problem (founder verbatim):** "even with few nodes the placement is very sparse the nodes
shouldnt be placed so far away from each other even if they arent related the lack of edges
does the job just fine rather than spreading them so far."

**Root cause:** charge=-80 repulsion with few/unlinked nodes scattered them across the canvas;
fitAndClamp then zoomed out to fit the spread.

**Fix in `src/viz/modules/corpus.js`:**
- `charge.strength`: -80 → -20 (light repulsion — nodes barely pushed apart)
- `link.distance`: 50 → 40 (tighter edge framing)
- Added inline centering force implementing d3-force protocol: `Object.assign(fn, { initialize })`.
  Pulls each node toward the canvas centre at `k = 0.08 * alpha` — no d3 import, net-zero deps.
- `fitAndClamp` and `MAX_ZOOM=2.5` unchanged; compact cluster means fit zooms to a legible scale,
  not a sparse edge-scatter zoom-out.

## Founder Round-2 Refinements (after 2nd re-verify)

### F1b — Relocate × into the sticky kicker row (6a65080)

**Problem (founder verbatim):** "just put it in the same row as the deep-dive /uuid row cause
thats already sticky as well and the spacing is perfect." The round-1 padding bump didn't pass.

**Fix in `src/viz/index.html` + `src/viz/css/styles.css`:**
- Wrapped kicker+title in a `#reader-meta` span; moved `<button id="reader-close">` to the end
  of `#reader-head` in DOM order.
- `#reader-head`: `display:flex; align-items:center` — the × is pushed to the right edge via
  `margin-left:auto`, sitting on the **same baseline** as "deep-dive · <title>".
- Dropped `#reader-close` absolute positioning (`position:absolute; top/right`) entirely.
- Reverted the round-1 `padding-top` bump (24px → 20px) — the × now inherits the kicker row's
  existing (founder-approved "perfect") spacing.
- `#reader-meta` ellipsis-truncates so a long title can't push the × off-row.
- `#reader-head` stays sticky. Palette unchanged (muted mauve rest, slate hover, no amber).

### F2b — Drop corpus-active border + side-view brain glyph (e6098c9)

**(a)** Founder: "remove the border around the brain in corpus view." Deleted
`border: 1px solid rgba(156,112,128,0.55)` from `.mode-window #btn-corpus.corpus-active`.
Active state now = opacity 1 + brightened color `#c8bcd0` only, no border.

**(b)** Founder: "i want more of a side view brain crossection glyph not head on like it is now."
Replaced the head-on two-lobe `ICON_BRAIN` with a **sagittal side-profile cross-section**:
cerebrum in profile facing left, two internal gyri folds, a cerebellum/brainstem nub at the
lower-back. Same inline-SVG style (`viewBox 0 0 24 24`, stroke-width 2, round caps/joins) —
net-zero deps. `ICON_BOOK` unchanged (brain-active state).

### F3b — Loosen corpus spread for label legibility (e9bf420)

**Problem (founder verbatim):** "better maybe a touch more spread out its not bad necessarily
now but hard to read some of the labels this close."

**Fix in `src/viz/modules/corpus.js`:**
- `charge.strength`: -20 → -35 (modestly more repulsion).
- Centering force `k`: 0.08 → 0.05 (softer centre pull — looser, still contained).
- Added an inline **collision force** (d3-force protocol, no d3 import): single-pass separation
  with `COLLIDE_R = NODE_R * 4` (~20 units) so node+label footprints don't overlap.
- Net-zero deps; still a centred, contained cluster — just with legible label spacing.

## Re-Verified Guards (after BOTH fix rounds)

All guards re-run after the round-2 fix commits (6a65080, e6098c9, e9bf420):

| Guard | Command | Result |
|-------|---------|--------|
| Net-zero deps | `git diff --stat package.json package-lock.json` | **PASS** — empty |
| Build | `npm run build` | **PASS** — tsc exit 0, copy-viz-assets ran |
| No amber at rest | diff grep `#d9a05c\|rgba(217` on `+` lines (styles/corpus/index) | **PASS** — zero matches |
| 3D engine untouched | `git diff b3c2b9c HEAD --name-only \| grep -E 'brain\|haze\|graph\.js'` | **PASS** — none |
| My-commit file scope | per-commit `git show --name-only` for all 6 fix commits | **PASS** — only styles.css, corpus.js, index.html |

> Note: a `git diff b3c2b9c HEAD --name-only` over the whole branch lists unrelated phase-35
> source files (config.ts, engine.ts, topk.ts, decay.ts, eval harnesses) — these landed in
> interleaved **phase-35** commits on the shared branch, NOT in any 34-03 fix commit. The
> per-commit scope check above confirms every 34-03 fix touched only the three viz files.

## Tracked-Deferred: Corpus↔Brain Transition Animation

The founder chose a full 3D camera fly-through transition as a **deferred, separate follow-up
phase**. It bridges the 2D-canvas corpus and the 3D brain — a structural change well outside
the CSS+state-only scope of this polish pass. The insta-swap (hide/show) remains for now.
This is tracked for the follow-up phase.

## Deviations from Plan

Two rounds of founder-requested post-checkpoint fixes applied (outside the original Task 1 scope):

Round 1:
- **F1**: Reader × padding bump — superseded by F1b (founder rejected the padding approach)
- **F2**: Corpus book→brain icon swap — JS inline SVG swap on existing state transitions
- **F3**: Corpus force layout — reduced charge + inline centering force

Round 2:
- **F1b**: Reader × relocated into the sticky kicker row (flex, same baseline) — replaces F1
- **F2b**: Corpus-active border removed + ICON_BRAIN replaced with a side-view cross-section glyph
- **F3b**: Corpus spread loosened (charge -35, k 0.05, inline collision force) for label legibility

No architectural changes. No new deps. Guards re-verified green after both rounds.

## Threat Flags

None — all changes are CSS presentation and 2D canvas JS only. No new endpoints, no new
attack surface. package.json unchanged confirmed.

## Known Stubs

None.

## Self-Check: PASSED (re-verified after both fix rounds)

- `npm run build` exited 0 and reported viz-asset copy to `dist/src/viz/` — confirmed.
- `git diff --stat package.json package-lock.json` empty — confirmed.
- Amber guard grep clean across all added lines (round-1 + round-2 changes) — confirmed.
- Per-commit scope: all six fix commits touch only styles.css, corpus.js, index.html — confirmed.
- No 3D engine files (brain.js/haze.js/graph.js) in any fix commit — confirmed.
- Six fix commits exist: bdd3a17, b7467f5, 04fa578 (round 1); 6a65080, e6098c9, e9bf420 (round 2).

## Founder Visual Checkpoint (Task 2) — AWAITING 3RD PASS

The founder must re-verify the three round-2 surfaces (× in kicker row, side-view brain glyph
with no active border, looser corpus spacing). See CHECKPOINT REACHED output for exact steps.
