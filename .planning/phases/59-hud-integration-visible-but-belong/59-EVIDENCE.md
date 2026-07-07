---
phase: 59-hud-integration-visible-but-belong
plan: 06
requirement: D-15
status: approved
---

# Phase 59 — D-15 Evidence Record

Closing founder checkpoint for the HUD Integration phase: the glass panel language,
consolidated chip/rail/topics-rail footprint, ⌘K palette, and auto-recede feel judged
together on the live `recense viz` install.

## Automated Gate (Task 1 — objective floor before the qualitative gate)

Run 2026-07-06.

| Check | Command | Result |
|---|---|---|
| Full vitest suite | `npm test` | **PASS** — 2640 passed / 3 skipped (176 test files passed, 1 skipped) |
| Phase-specific test files | `npx vitest run tests/viz-activity-palette-invariants.test.ts tests/viz-hud-palette.test.ts` | **PASS** — 55/55 passed (2 test files) |
| Anti-slop (a): glass confined to D-12 selector list | D-14-C describe block in `tests/viz-activity-palette-invariants.test.ts` — asserts every `backdrop-filter` rule block's selector is in `{#hud-chip, #hud-rail, #topics-rail, #palette, #detail, #settings-panel, #reader, .toast}`, and that `#tooltip` carries zero `backdrop-filter` | **PASS** (part of the 55/55 above) — manual grep of `src/viz/css/styles.css` cross-checked: all 9 non-comment `backdrop-filter:` declarations map to `#palette`/`#hud-chip`/`#hud-rail`/`#topics-rail`/`#detail`/`#settings-panel`/`#reader`/`.toast`; `#tooltip`'s own rule block has `backdrop-filter: none` explicitly |
| Anti-slop (b): zero emoji/pictographic chars in chrome DOM | `grep -nP "[\x{1F000}-\x{1FAFF}\x{2600}-\x{27BF}]" src/viz/index.html` | **PASS** — zero matches. Additionally hand-checked `src/viz/modules/*.js` UI-string-bearing files with a wider pictographic/arrow range for due diligence; the only hits were `→`/`←`/`↔`/`⇄` characters inside **code comments** (architecture notes, not rendered DOM chrome strings) — not a violation of anti-slop item 6 |

**Environment note:** the plan's literal verify one-liner runs `grep -nP` inside a `bash -c '...'` subshell. On this machine that subshell resolves to `/bin/bash` → `/usr/bin/grep` (BSD grep, no `-P` support), which errors on the `-P` flag and is swallowed by the script's `|| true`, so the script still prints `ok` — but via a no-op rather than a genuine PCRE scan. The interactive shell's `grep` (aliased to `ugrep`, which does support `-P`) was used directly to perform the real scan above and confirmed zero matches independently of the subshell quirk. Documented here rather than "fixed" since it is a pre-existing environment/tooling artifact, not a defect in this plan's files, and the real check was performed and is green.

**Objective floor: PASS.** Suite green, both anti-slop machine checks green. Ready for the qualitative founder gate below.

## Founder D-15 Checkpoint (Task 2 — resolved)

**Approved live on the packed `recense viz` app install, 2026-07-07.**

The founder judged the combined glass + rails + palette + recede feel directly on the
running install rather than from static media. No screenshot or recording files were
attached to this evidence record — the record of what was judged is the checkpoint's
live tuning cycle itself: the founder's feedback, the four fix commits it produced, and
the automated-gate results above. This is recorded honestly rather than inventing
screenshot paths or recording links that don't exist.

### Checkpoint cycle (live tuning → 4 fix commits → approval)

1. **Reader icon removed from the rail** (`861da79`) — founder judged a standalone
   reader-open icon in the mid-right icon rail as useless chrome; the reader is already
   reachable from the corpus view and the ⌘K palette's "Open reader" command. Rail
   dropped from 5 icons to 4 (settings / corpus / recenter / search). `reader.js`'s
   `#btn-reader` lookup made optional (null-guarded) so `ctx.openReader`/`closeReader`/
   `isReaderOpen` and the corpus/palette/detail entry points are unaffected.
2. **Palette glass made more transparent** (`1f2cb10`) — founder chose transparency over
   repositioning: the shared "focused" glass tier (`glass-bg-focused` 0.90 alpha /
   `glass-blur-md` 14px, still used by `#detail`/`#settings-panel`/`#reader`) covered the
   scene too heavily for a centered ⌘K overlay. New palette-only tokens added to
   `HUD_CSS_TOKENS` in `constants.js`: `glass-bg-palette` = `rgba(26, 18, 32, 0.42)`
   (roughly half the focused-tier alpha) and `glass-blur-palette` = `8px` (down from
   14px). `#palette` now references these instead of the shared focused-tier tokens.
   Stays within the D-12 backdrop-filter allow-list (no new blurred surface, same
   `#palette` selector).
3. **Idle rotation wedge, first attempt** (`fd8f224`) — founder reported: after focusing
   a node then unfocusing, idle auto-rotation never resumed on its own (a manual drag
   "nudged" it back to life). Root cause found: `stats.js`'s idle camera drift gated only
   on `ctx.isIdle()`, never on `ctx.isCameraInFlight()` — a still-in-flight programmatic
   camera move (focus fly-to / unfocus recenter) routinely outlasts the 1200ms idle
   timeout, so drift started writing `cam.position` on top of `camera.js`'s own damp
   tick, and the two writers fighting every frame meant the flight's `settled()` check
   never converged. Fix gated `updateIdleDrift` on `!ctx.isCameraInFlight()` too.
4. **Idle rotation wedge, real root cause** (`064a4a6`) — founder retested on a fresh
   launch: **still reproduced**. Deeper root cause found via reading the vendored
   `3d-force-graph.min.js` source directly: the no-arg `Graph.cameraPosition()` read
   accessor synthesizes its `lookAt` field as a fixed-length-1000 point projected along
   the camera's current facing direction (`camera.position + 1000*forwardUnitVector`),
   NOT the real `controls.target` that the write path sets. Because actual flight
   targets sit at a different true distance (node-focus dolly ~321 units, recenter
   ~1012 units), `camera.js`'s settle check could never converge within
   `CAM_SETTLE_EPS`, so `isCameraInFlight()` never cleared on its own — fd8f224's gate
   was correct but was waiting forever on a flag that structurally could never clear.
   Fix: `camera.js`'s tick now reads the real current gaze point from
   `ctx.Graph.controls().target` directly instead of the synthetic `cur.lookAt`,
   falling back to `cur.lookAt` only when `controls`/`target` is unavailable. Founder
   confirmed fixed on retest.

### Anti-slop checklist (D-15)

- [x] Anti-slop checklist line — glass confined to D-12 element list (eyeball-confirmed
  on live install, backed by the Task 1 automated D-14-C machine check): **PASS**
- [x] Anti-slop checklist line — zero emoji/pictographic characters anywhere in DOM
  chrome (eyeball-confirmed on live install, backed by the Task 1 automated grep
  machine check): **PASS**

### Ratcheted tunables (actual shipped values, read from `src/viz/modules/constants.js`)

- `HUD_IDLE_TIMEOUT_MS`: provisional 4000 → **locked at 4000** (unchanged — founder
  raised no idle-timing complaints during the live session)
- `RECEDE_GHOST_OPACITY`: provisional 0.12 → **locked at 0.12** (unchanged — founder
  raised no recede-opacity complaints during the live session)
- Shared glass blur radii (`glass-blur-sm`/`glass-blur-md`): provisional 8px/14px →
  **unchanged at 8px/14px** for `#hud-chip`/`#hud-rail`/`#topics-rail`/`#detail`/
  `#settings-panel`/`#reader`/`.toast`
- Palette-only glass tier (new, added at this checkpoint per item 2 above):
  `glass-bg-palette` = `rgba(26, 18, 32, 0.42)`, `glass-blur-palette` = `8px`
- Motion timings / topics-rail expand feel: unchanged from the UI-SPEC Motion Tokens
  table — no live-tuning changes requested beyond the palette transparency and rail
  icon-count items above

### Founder approval

**Approved.** "approved" (2026-07-07), following the live checkpoint cycle above.
