# Phase 59: HUD Integration — visible-but-belong overlay - Context

**Gathered:** 2026-07-05
**Status:** Ready for planning

<domain>
## Phase Boundary

The overlay chrome (search, topics, buttons, controls, status) stops feeling out of place
and in the way: persistent but redesigned in the scene's own language.

**In scope:**
- **Liquid-Glass panel language** — blur + hairline specular, aubergine-tinted, NO drop
  shadows on dark — applied to ALL overlay surfaces: the new chip/rails/palette AND the
  existing detail panel, settings panel, reader takeover, and tooltip (restyle only; no
  layout/content rework of those panels).
- **Chrome consolidation** — the crammed top-left `#panel` is replaced by: a small status
  chip (top-left: SSE dot + node count, legend folds in on hover), ONE vertical icon rail
  docked mid-right (reader, settings, corpus, recenter, search magnifier — absorbs both
  floating corner buttons), and a slim collapsed topics rail on the left edge.
- **Vanilla-JS ⌘K palette** (~100 lines, no React dep) unifying node search / topics /
  commands behind one input with mixed sections; the old always-open search field, results
  list, log button, and tombstone button are deleted (log + tombstones become palette
  commands).
- **Auto-recede behavior** — chrome fades to hairline ghosts on mouse-idle + during camera
  flights; focus/detail-open deepens recede; opacity-only, no layout shift.
- **Token discipline extended to HUD CSS** — full exhaustive migration: every color literal
  in `styles.css` moves to CSS custom properties emitted from the shared constants module;
  motion timings join as shared motion tokens; invariants test protects amber-exclusivity
  and bans foreign palette ramps in CSS.
- **Strict diegetic/screen-space split** — troika schema labels (Phase 58) remain the only
  in-scene text; everything else is flat screen-space glass.
- Single closing founder checkpoint on the live install with screenshots + a short screen
  recording (recede/palette motion) as the evidence record.

**Out of scope (hard):**
- Everything LOCKED by Phases 57/58: activity palette + luminance band, amber exclusive to
  live activation, motion profiles, bloom/tone-mapping, node presentation (impostors,
  matcap, labels), the damped camera system's internals.
- Hull front/top jaggedness (structural mesh work — stays a pending todo).
- Full Option A corpus↔brain fly-through (`corpus-brain-3d-transition.md` stays pending).
- Detail/settings/reader internal layout or content redesign — glass reskin only.
- Phase 60's dashboards (they consume this phase's panel language + palette navigation).
- Tray compact popover changes — it stays glance-only, no palette, no new chrome.
- Engine/honesty mechanics untouched — presentation layer only; viz server read-only.

</domain>

<decisions>
## Implementation Decisions

### Chrome inventory & placement
- **D-01: Footprint = chip + icon rail + slim topics rail.** Status chip (SSE dot + node
  count) top-left; one vertical icon rail docked mid-right consolidating ALL action icons
  (reader, settings, corpus, recenter, search) and absorbing the two floating corner
  buttons; topics as a slim collapsed vertical rail on the left edge that expands on
  hover/click. The scene center stays clear.
- **D-02: Dev tools demoted to palette.** Event log and tombstone toggle lose their
  buttons — they become ⌘K commands ("Show event log", "Toggle tombstones"). The legend
  folds into the status chip (expand on hover). Hull credit stays (CC BY-SA attribution
  required) but drops to hairline opacity. Icon rail holds 4–5 core icons max.
- **D-03: Search demoted but discoverable.** One magnifier icon on the right rail opens
  the ⌘K palette in search mode; the old always-open search field + persistent results
  list are deleted. No second search surface.

### ⌘K palette
- **D-04: One input, mixed sections.** A single input filters everything at once; results
  grouped under section headers — Nodes (server BM25), Topics (schema regions), Commands
  (open settings / reader / corpus view / recenter / toggle tombstones / show log).
  Raycast/Linear-style. No prefix modes.
- **D-05: Select = go.** Node result → palette closes, damped `camera.js` fly-to + the
  existing user-initiated highlight/pulse (D-04-safe: not fake engine activity). Topic
  result → same region highlight as the topics rail. Command → executes immediately. No
  preview-on-arrow, no auto-opening the detail panel.
- **D-06: Palette works in all full-window views** (brain, corpus, reader); commands adapt
  per view, and node fly-to from corpus/reader switches back to the brain view first. The
  tray compact popover stays glance-only — no palette there. Phase 60's "Open usage
  stats" command slots in later without structural change.
- **D-07: Matching = BM25 for nodes, fuzzy for the rest.** Node section keeps the proven
  debounced LLM-free `/search?q=` endpoint; commands + topics filter client-side with
  simple subsequence/fuzzy matching.

### Auto-recede
- **D-08: Triggers = idle timer + camera motion.** Chrome recedes after a few seconds of
  no mouse movement AND whenever the camera is in flight (focus fly-to, corpus transition);
  any mouse move returns it instantly. Idle timeout value is a named tunable constant.
- **D-09: Recede style = fade to hairline ghosts.** Rails/chip fade to very low opacity
  (~0.10–0.15, named constant) but never move — no layout shift, opacity-only transitions
  (consistent with the transition.js opacity-only lesson).
- **D-10: Focus deepens recede.** While a node is focused or the detail panel is open,
  rails drop to ghost state immediately. Live SSE trace activity does NOT force recede —
  traces fire constantly; mouse-idle alone decides.
- **D-11: Shared motion tokens (Phase 58 deferred item lands here).** Recede/return/
  palette/expand timings + easings are named values in the shared constants module,
  emitted as CSS custom properties — chrome eases derive from the same motion vocabulary
  as the damped canvas (soft ease-out, no bounces). Machine-checkable alongside the
  Phase-57 locks.

### Restyle reach & diegetic split
- **D-12: Glass language reaches ALL overlay surfaces this phase** — chip, rails, palette,
  detail panel, settings panel, reader takeover, tooltip. Existing box-shadows are removed
  per the no-drop-shadows-on-dark rule. Restyle only: internal layout/content of
  detail/settings/reader is untouched. Phase 60 inherits a complete panel vocabulary.
- **D-13: Diegetic line = troika labels only.** No other element pretends to be in the
  scene: tooltip, legend, topic feedback, palette, rails are flat screen-space glass. No
  CSS3D, no fake parallax.
- **D-14: FULL exhaustive CSS token migration** (founder chose this over the lighter
  touched-surfaces-only option): every color literal in all ~1,343 lines of `styles.css`
  moves to CSS custom properties emitted from the shared constants module. An invariants
  test scans `styles.css` for amber-family color values and unknown color literals
  outside the token block — the amber-exclusivity and no-foreign-ramp locks become
  machine-checked over the whole stylesheet.
- **D-15: Single closing founder checkpoint** on the live install: glass look + rails +
  palette + recede feel judged together. Evidence record = screenshots + a short screen
  recording of recede/palette motion (extends the 57/58 evidence pattern). No mid-phase
  gate.

### Claude's Discretion
- Glass recipe specifics: blur radii, hairline specular construction (border gradient vs
  inset highlight), aubergine tint values — within locked BG/TYPE palette family.
- Icon set/style for the rail (inline SVG expected; vendor-everything rule applies),
  rail sizing, chip typography (Phase-58 vendored mono is the intended face).
- Exact idle-timeout, ghost-opacity, and expand-behavior values — named tunable constants,
  tuned at the closing checkpoint.
- Palette internals: result caps per section, debounce value, empty-state contents,
  keyboard bindings beyond ⌘K (e.g. Escape/arrows; whether "/" also opens), section order.
- Token naming scheme and the emission mechanism from the shared constants module into
  CSS custom properties (build step vs runtime injection — planner picks, respecting the
  D-10/Phase-57 single-source rule).
- How topics-rail expand interacts with recede (hover-expand vs click-pin).
- Reduced-motion / reduced-transparency fallbacks if trivially cheap.

### Folded Todos
- **`viz-search-and-hull-quality.md` — search-affordance part ONLY.** The founder ask
  ("finding a specific memory takes it to another level" + topic region access) is
  absorbed by the ⌘K palette (D-03/D-04). The hull front/top jaggedness item is NOT
  folded (structural mesh work, matches 57/58 review verdicts) — todo stays pending for
  the hull half.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase contract & carried decisions (read first)
- `.planning/ROADMAP.md` (Phase 59 entry, ~line 1193) — goal statement: Liquid-Glass
  panels, auto-receding rails, ⌘K palette, diegetic/screen-space split, token discipline,
  search demotion rationale.
- `.planning/phases/57-viz-activity-palette-redesign/57-CONTEXT.md` — LOCKED palette
  system: luminance band, amber-exclusivity (D-03b there), shared constants module (D-10),
  dedicated invariants-file pattern (D-12) that this phase's CSS/motion locks extend.
- `.planning/phases/58-node-presentation-motion-overhaul/58-CONTEXT.md` — vendored mono
  font intended for HUD typography (D-04 there), damped camera grammar (D-05), the
  deferred "HUD motion tokens" idea this phase lands, and the diegetic-labels precedent.
- `.planning/phases/60-settings-stats-depth/60-CONTEXT.md` — Phase 60 HARD-depends on this
  phase (D-01 there): dashboards built in this panel language, reached via this palette.
  The glass vocabulary and palette command list must be extensible to it.

### Folded todo
- `.planning/todos/pending/viz-search-and-hull-quality.md` — founder verbatim ask for the
  search affordance (item 1, folded here); hull quality (item 2) stays pending.

### Code to change
- `src/viz/index.html` — the `#panel` block (status row, actions row, search-wrap,
  topic-wrap, log), legend, `#btn-corpus`, `#btn-recenter`, `#hull-credit` — the DOM this
  phase restructures; `#detail`, `#settings-panel`, `#reader`, `#tooltip` get the glass
  reskin.
- `src/viz/css/styles.css` (~1,343 lines) — full token migration target (D-14); current
  glass-ish idiom at `#panel` (rgba aubergine + blur(12px)) and the box-shadows to remove
  (lines ~571, ~869, ~1203).
- `src/viz/modules/hud.js` — SSE status/log/toast/tombstone wiring to re-home into the new
  chip/palette structure (keep the textContent-only security discipline documented in its
  header).
- `src/viz/modules/search.js` — BM25 `/search` fetch + fly-to logic the palette's Nodes
  section absorbs; its fly-to already rides `camera.js` (Phase 58).
- `src/viz/modules/topics.js` — topic list + region-highlight calls the topics rail and
  palette Topics section reuse.
- `src/viz/modules/settings.js` — open/close plumbing joins the palette command list;
  panel gets glass reskin only (Phase 44 toggles untouched).
- `src/viz/modules/constants.js` — the shared constants module where HUD color/motion
  tokens and new named tunables live (Phase 57 D-10 discipline).
- `src/viz/modules/camera.js` — the damped interruptible camera the palette fly-to drives
  (do not modify its internals; consume it).
- Phase-57 invariants test file — the D-14 CSS scan lock and D-11 motion-token locks
  extend it.

### Project guards (load-bearing)
- `CLAUDE.md` (project) — faithfulness clause: viz is decorative chrome; engine mechanisms
  untouched; viz server read-only/LLM-free; net-zero new runtime deps (palette is vanilla
  JS, icons vendored inline).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `#panel`'s existing CSS (rgba(26,18,32,.66) + blur(12px) + hairline border) is already
  half the glass recipe — the phase formalizes it into tokens and adds the specular
  hairline; it's a refinement, not an invention.
- `search.js` already owns debounced BM25 fetch + fly-to + highlight (Phase 19, camera
  migrated in 58) — the palette's Nodes section is a re-skin of this logic, not a rewrite.
- `topics.js` owns region highlighting via engine-served `abstracts` edges — rail + palette
  both call it.
- `hud.js`'s toast, error-surfacing, and SSE wiring survive — only their DOM homes change.
- The Phase-57 shared constants module + invariants test file are the established homes
  for new tokens and locks.
- The reader/corpus takeover show/hide pattern is the precedent for palette open/close
  state handling across views.

### Established Patterns
- Named tunable constants + founder checkpoint on the live install (54/56/57/58) — every
  feel value (idle timeout, ghost opacity, blur, timings) follows it.
- textContent-only rendering for anything server-sourced (hud.js header, T-44-19) — palette
  result rendering MUST follow it.
- Vendor-everything (T-10-10): icons inline SVG or vendored; no CDN anything.
- Amber is the only warm signal — chrome is aubergine/slate glass; nothing in the HUD may
  compete with amber (machine-locked by D-14's CSS scan).
- Single shared constants source across TS server / ESM client (Phase 57 D-10) — the token
  emission mechanism must not re-introduce a second source of truth.

### Integration Points
- `index.js`/`app.js` wire module init — the palette joins as a new module alongside
  hud/search/topics; deleted buttons' listeners come out of hud.js.
- Keyboard handling must coexist with existing key listeners (Escape closes detail/reader;
  search input previously captured keystrokes) — one place should own the shortcut map.
- Recede state must read focus/detail-open state (detail.js) and camera-in-flight state
  (camera.js exposes the damp target activity) without new coupling into their internals.
- The corpus (2D) and reader views host the palette too — palette overlay must z-index
  above all three views and the backdrop.
- Tray compact popover (`apps/tray`) — verify the new rails/chip respect the compact LOD
  (popover is glance-only; no palette, no rails there if chrome is currently hidden in
  compact mode — verify what compact mode shows today).

</code_context>

<specifics>
## Specific Ideas

- The design register is "instrument panel on glass": Apple Liquid-Glass-style material
  (blur + hairline specular edge, aubergine-tinted) — but flat and quiet, no drop shadows
  on dark, nothing skeuomorphic.
- Palette feel reference: Raycast/Linear — one input, instant mixed results, section
  headers, select-and-go. ~100 lines of vanilla JS is the complexity budget signal, not a
  hard LOC cap.
- The recede philosophy: the scene gets the stage exactly when you're watching it (idle,
  camera in flight, node focused); chrome exists at full presence only while you're
  reaching for it.
- Chrome and canvas speak one motion vocabulary (Phase 58's damp grammar) and one type
  vocabulary (Phase 58's vendored mono) — the HUD should feel like the same instrument
  that renders the brain, not a web page floating over it.

</specifics>

<deferred>
## Deferred Ideas

- **Hull front/top jaggedness** (`viz-search-and-hull-quality.md` item 2) — structural
  mesh work; todo stays pending.
- **Full Option A corpus↔brain fly-through** (`corpus-brain-3d-transition.md`) — structural
  transition work; stays pending (now has both the damped camera AND the unified chrome to
  build on).
- **Label interactivity** (click a troika schema label to focus/highlight its region) —
  Phase 58 deferred candidate; not committed this phase, natural palette/topics follow-up.
- **Palette preview-then-commit** (arrow-key live camera preview of results) — rejected
  for now as camera-thrashy and over budget; revisit if select-and-go feels blind.
- **Reduced-motion/transparency system-preference support** — discretionary if trivially
  cheap this phase; otherwise a follow-up polish item.

### Reviewed Todos (not folded)
- `corpus-brain-3d-transition.md` — corpus↔brain camera fly-through: structural viz work,
  not HUD chrome; stays pending.
- `content-hardening-deferred.md` — engine-side ingestion hardening; keyword-match noise
  for a viz phase; stays pending.

</deferred>

---

*Phase: 59-hud-integration-visible-but-belong*
*Context gathered: 2026-07-05*
