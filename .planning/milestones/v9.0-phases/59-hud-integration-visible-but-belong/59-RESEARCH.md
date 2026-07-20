# Phase 59: HUD Integration — visible-but-belong overlay - Research

**Researched:** 2026-07-05
**Domain:** Frontend chrome/CSS design system (Liquid-Glass panels), vanilla-JS command palette, CSS custom-property token migration, idle/camera-driven UI motion — all inside `src/viz/` (the `recense viz` Electron/browser frontend)
**Confidence:** HIGH (live-source-grounded for all code-touchpoint claims; MEDIUM for the external design-reference claims, which are necessarily editorial/subjective)

## Summary

This phase reskins existing, working chrome — it does not invent new UI mechanics. Every decision in CONTEXT.md maps to a concrete, already-half-built seam in `src/viz/`: `#panel`'s current CSS (`rgba(26,18,32,.66)` + `blur(12px)` + hairline border) is already most of the Liquid-Glass recipe; `search.js`/`topics.js` already own the exact fetch/highlight logic the ⌘K palette's Nodes/Topics sections need; `settings.js`/`reader.js` already establish the show/hide + `documentElement` class + guarded-Escape-listener pattern the palette should copy; and Phase 57's `constants.js` + `tests/viz-activity-palette-invariants.test.ts` are the established single-source-of-truth + machine-lock pattern this phase must extend, not reinvent.

Two structural gaps exist that CONTEXT.md's decisions depend on but the current code does not yet expose: (1) `camera.js`'s in-flight state (`active`) is a private closure variable, never surfaced on `ctx` — D-08's "recede during camera flight" trigger needs a one-line `ctx.isCameraInFlight()` export; (2) `stats.js`'s `ctx.isIdle()` is a boolean gated by a single hardcoded 1200ms threshold already used for camera auto-drift — reusing it directly for chrome recede would make chrome vanish after 1.2s of stillness, not the "few seconds" CONTEXT.md intends, so a second, HUD-owned idle threshold reading the same `lastActiveTime` plumbing is needed, not a new mousemove listener (one already exists and already calls `markActive()` globally).

The founder's anti-slop mandate is well-served by what already exists: the codebase has an explicit, dated precedent of REJECTING backdrop-filter blur as "glassmorphism slop" on `#tooltip` (`styles.css` line ~67-72, "Contrast comes from OPACITY, not a frosted blur (the blur was the glassmorphism slop)"). D-12 now asks for the tooltip to receive the glass treatment. This is not a contradiction the planner can wave away — it must be resolved explicitly in the plan (see Common Pitfalls #1) by distinguishing structured Apple-Liquid-Glass construction (deliberate hairline specular + restrained blur radius + no gratuitous "everything is glass" sameness) from the generic pastiche the original comment was rejecting.

**Primary recommendation:** Formalize the existing `#panel` glass idiom into named tokens in `constants.js` (extending the Phase-57 single-source-of-truth pattern, source-parsed into a CSS custom-property block the same way `server.ts` source-parses scheduler scalars today), build the chip/rails/palette as new DOM additively alongside the deleted `#panel` internals, and reuse `search.js`/`topics.js`'s fetch and highlight logic verbatim inside the palette rather than rewriting it.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Glass panel visual language (chip/rails/palette/detail/settings/reader/tooltip) | Browser/Client (CSS) | — | Pure presentation; no server involvement; `styles.css` + `constants.js`-emitted CSS vars |
| ⌘K palette (input, matching, keyboard, rendering) | Browser/Client (vanilla JS module) | API/Backend (existing `/search?q=` BM25 endpoint, reused not rebuilt) | Node search stays server-side BM25 (LLM-free hot path); commands/topics are client-side data already in `ctx.allNodes`/`ctx.adj` |
| Auto-recede (idle timer, camera-in-flight, focus-deepen) | Browser/Client | — | Reads existing `ctx.isIdle()`-adjacent state + `camera.js` internals; pure client timing/opacity logic |
| CSS token emission from `constants.js` | Browser/Client (build-time or boot-time script) | — | Source-parse mechanism already proven for TS server consumption (Phase 57 D-10); this phase adds a CSS consumer of the same JS-authored source |
| Search/topics/settings absorption into palette | Browser/Client | API/Backend (`/search`, `/graph` payload, `/settings`, `/usage` — all pre-existing, read-only) | No new server routes; palette is a UI re-skin of existing client logic |
| Invariants (amber-exclusivity, no-foreign-ramp, motion-token locks) | Test tier (vitest, `tests/`) | — | Machine-checked via source-parse of `styles.css`/`constants.js`, following the exact Phase-57 `viz-activity-palette-invariants.test.ts` pattern |

## User Constraints (from CONTEXT.md)

### Locked Decisions

**Chrome inventory & placement**
- D-01: Footprint = chip (top-left: SSE dot + node count) + one vertical icon rail docked mid-right (reader, settings, corpus, recenter, search — absorbs both floating corner buttons) + slim collapsed topics rail on the left edge (expands on hover/click). Scene center stays clear.
- D-02: Dev tools demoted to palette. Event log + tombstone toggle become ⌘K commands ("Show event log", "Toggle tombstones"). Legend folds into the status chip (expand on hover). Hull credit stays (CC BY-SA attribution required) but drops to hairline opacity. Icon rail holds 4–5 core icons max.
- D-03: Search demoted but discoverable. One magnifier icon on the right rail opens the ⌘K palette in search mode; the old always-open search field + persistent results list are deleted. No second search surface.

**⌘K palette**
- D-04: One input, mixed sections (Nodes / Topics / Commands), Raycast/Linear-style, no prefix modes.
- D-05: Select = go. Node → close palette, damped `camera.js` fly-to + existing user-initiated highlight/pulse. Topic → same region highlight as topics rail. Command → executes immediately. No preview-on-arrow, no auto-opening detail panel.
- D-06: Palette works in all full-window views (brain, corpus, reader); commands adapt per view; node fly-to from corpus/reader switches back to brain view first. Tray compact popover stays glance-only — no palette there. Phase 60's "Open usage stats" command slots in later without structural change.
- D-07: Matching = BM25 for nodes (reuse debounced `/search?q=` endpoint), fuzzy/subsequence for commands+topics (client-side).

**Auto-recede**
- D-08: Triggers = idle timer + camera motion. Chrome recedes after a few seconds of no mouse movement AND whenever the camera is in flight (focus fly-to, corpus transition); any mouse move returns it instantly. Idle timeout is a named tunable constant.
- D-09: Recede style = fade to hairline ghosts (~0.10–0.15, named constant), never move — no layout shift, opacity-only transitions (consistent with the transition.js opacity-only lesson).
- D-10: Focus deepens recede. While a node is focused or the detail panel is open, rails drop to ghost state immediately. Live SSE trace activity does NOT force recede — mouse-idle alone decides.
- D-11: Shared motion tokens (Phase 58 deferred item lands here). Recede/return/palette/expand timings + easings are named values in the shared constants module, emitted as CSS custom properties — chrome eases derive from the same motion vocabulary as the damped canvas (soft ease-out, no bounces). Machine-checkable alongside the Phase-57 locks.

**Restyle reach & diegetic split**
- D-12: Glass language reaches ALL overlay surfaces this phase — chip, rails, palette, detail panel, settings panel, reader takeover, tooltip. Existing box-shadows removed per the no-drop-shadows-on-dark rule. Restyle only: internal layout/content of detail/settings/reader is untouched. Phase 60 inherits a complete panel vocabulary.
- D-13: Diegetic line = troika labels only. No other element pretends to be in the scene: tooltip, legend, topic feedback, palette, rails are flat screen-space glass. No CSS3D, no fake parallax.
- D-14: FULL exhaustive CSS token migration — every color literal in all ~1,343 lines of `styles.css` moves to CSS custom properties emitted from the shared constants module. An invariants test scans `styles.css` for amber-family color values and unknown color literals outside the token block — amber-exclusivity and no-foreign-ramp locks become machine-checked over the whole stylesheet.
- D-15: Single closing founder checkpoint on the live install: glass look + rails + palette + recede feel judged together. Evidence = screenshots + a short screen recording of recede/palette motion. No mid-phase gate.

### Claude's Discretion
- Glass recipe specifics: blur radii, hairline specular construction (border gradient vs inset highlight), aubergine tint values — within locked BG/TYPE palette family.
- Icon set/style for the rail (inline SVG expected; vendor-everything rule applies), rail sizing, chip typography (Phase-58 vendored mono is the intended face).
- Exact idle-timeout, ghost-opacity, and expand-behavior values — named tunable constants, tuned at the closing checkpoint.
- Palette internals: result caps per section, debounce value, empty-state contents, keyboard bindings beyond ⌘K (e.g. Escape/arrows; whether "/" also opens), section order.
- Token naming scheme and the emission mechanism from the shared constants module into CSS custom properties (build step vs runtime injection — planner picks, respecting the D-10/Phase-57 single-source rule).
- How topics-rail expand interacts with recede (hover-expand vs click-pin).
- Reduced-motion / reduced-transparency fallbacks if trivially cheap.

### Deferred Ideas (OUT OF SCOPE)
- Hull front/top jaggedness (`viz-search-and-hull-quality.md` item 2) — structural mesh work; todo stays pending.
- Full Option A corpus↔brain fly-through (`corpus-brain-3d-transition.md`) — stays pending.
- Label interactivity (click a troika schema label to focus/highlight its region) — not committed this phase.
- Palette preview-then-commit (arrow-key live camera preview of results) — rejected as camera-thrashy and over budget.
- Reduced-motion/transparency system-preference support — discretionary if trivially cheap; otherwise a follow-up polish item.
- Everything LOCKED by Phases 57/58 (activity palette + luminance band, amber exclusive to live activation, motion profiles, bloom/tone-mapping, node presentation, damped camera internals) — untouched.
- Phase 60's dashboards (consume this phase's output, not built here).
- Tray compact popover changes — stays glance-only, no palette, no new chrome.
- Engine/honesty mechanics — presentation layer only; viz server read-only.

## Standard Stack

No new runtime dependencies. This phase is vanilla JS + CSS only, per CLAUDE.md's net-zero-new-runtime-deps invariant and the explicit "~100 lines, no React dep" mandate. `[VERIFIED: package.json / repo]`

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| (none — vanilla JS ES modules) | n/a | ⌘K palette, recede logic, token emission | Matches every other `src/viz/modules/*.js` file (hud.js, search.js, topics.js, settings.js) — all hand-rolled ESM, zero framework, per the vendor-everything / net-zero-deps project rule `[VERIFIED: repo pattern, all 8 modules read]` |
| CSS custom properties (`--var`) | Native (all evergreen browsers + Electron/Chromium) | Token emission target for D-14 | Zero-dependency, already the emission format for the one existing var (`--index-width`, `styles.css:1190`) `[VERIFIED: styles.css:1190]` |
| `backdrop-filter: blur()` | Native CSS | Glass panel blur | Already used at 4 call sites (`#detail`, `#reader`, `#settings-panel`, `.toast`) `[VERIFIED: styles.css grep]` |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| existing `src/viz/vendor/fonts/JetBrainsMono-Regular.ttf` | vendored (Phase 58) | HUD typography (chip/rail labels, per Phase 58 D-04 intent) | Currently loaded ONLY by `labels.js` for troika SDF text (`new URL(...).href` passed to `text.font`), NOT wired as a CSS `@font-face` — this phase is the first consumer that needs it as a web font; add one `@font-face` rule pointing at the same vendored file (no new asset, no CDN) `[VERIFIED: labels.js:46, grep confirms zero @font-face in styles.css]` |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Hand-rolled fuzzy/subsequence matcher (~20-30 lines) for commands+topics | A vendored fuzzy-match library (e.g. fzf-for-js, fuzzysort) | Rejected: adds a dependency for a problem that's ~20 lines for a bounded (<200 item) client-side list; violates net-zero-deps and the "~100 lines total" budget signal |
| Vanilla palette DOM | A tiny modal/dialog library | Rejected: explicit CONTEXT.md mandate is "no React dep" / vanilla; native `<dialog>` element is viable in-budget but adds no real value over a plain `div` + one focus-trap loop given the existing reader/settings show/hide precedent already handles this without `<dialog>` |
| CSS var emission via a small Node build script | Runtime `<script>` that reads constants.js and injects a `<style>` tag with vars at boot | Both are viable and in-budget (planner's discretion per CONTEXT.md); the runtime-injection approach mirrors the existing `server.ts` regex-source-parse pattern more closely (no new build step, no risk of stale generated CSS in git) — recommend this unless a build-time step is trivially easier to keep in sync |

**Installation:**
```bash
# No installation — zero new packages this phase.
```

**Version verification:** Not applicable — no new packages. Existing vendored asset (`JetBrainsMono-Regular.ttf`) already lives in the repo from Phase 58; reused, not re-fetched.

## Package Legitimacy Audit

**Not applicable this phase.** Zero new packages are installed — the ⌘K palette is vanilla JS (~100-line budget, no React/framework dep), CSS custom properties are native, and the one font asset needed (JetBrains Mono) is already vendored in-repo from Phase 58 (`src/viz/vendor/fonts/JetBrainsMono-Regular.ttf`). This upholds CLAUDE.md's net-zero-new-runtime-dependencies invariant. `slopcheck`/registry verification steps were skipped as there is nothing to verify.

## Architecture Patterns

### System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│  Browser (src/viz/ static frontend, served by viz server)            │
│                                                                       │
│  mousemove/keydown ──► ctx.markActive() (stats.js, EXISTING)         │
│         │                     │                                     │
│         │                     ▼                                     │
│         │            lastActiveTime updated                          │
│         │                     │                                     │
│         │        ┌────────────┴─────────────┐                       │
│         │        ▼                          ▼                       │
│         │  ctx.isIdle() (1.2s,        NEW: ctx.isHudIdle()           │
│         │  scene camera-drift)        (few-sec, chrome recede)       │
│         │                                    │                       │
│  camera.js `active` (in-flight) ──► NEW: ctx.isCameraInFlight() ─────┤
│                                                    │                  │
│                                                    ▼                  │
│                                          hud-recede.js (NEW module)   │
│                                          opacity-only fade of         │
│                                          chip / rails / topics-rail   │
│                                                                       │
│  ⌘K keydown ──► palette.js (NEW module)                              │
│         │                                                             │
│         ├─► Nodes section  ──► GET /search?q=  (EXISTING, search.js  │
│         │                       fetch reused verbatim)                │
│         │                       ──► ctx.selectNode() (camera fly-to, │
│         │                           detail panel — EXISTING)          │
│         │                                                             │
│         ├─► Topics section ──► ctx.allNodes (EXISTING, in-memory)    │
│         │                       ──► ctx.selectNode(schemaNode)        │
│         │                           (EXISTING, region-highlight)      │
│         │                                                             │
│         └─► Commands section ─► direct function calls into           │
│                                  settings.js / reader.js / hud.js /   │
│                                  corpus.js / graph.js (all EXISTING   │
│                                  show()/hide()/toggle() entry points) │
│                                                                       │
│  constants.js (EXISTING, Phase 57 single-source-of-truth)             │
│         │                                                             │
│         ├─► ESM `import` ──► palette.js / hud-recede.js / hud.js     │
│         │                     (JS consumers, direct import — no      │
│         │                     change needed, EXISTING pattern)        │
│         │                                                             │
│         └─► NEW: source-parse or boot-time inject ──► CSS custom     │
│                    properties consumed by styles.css                  │
│                    (mirrors EXISTING server.ts regex-parse of         │
│                    scheduler scalars, Phase 57 D-10)                  │
└─────────────────────────────────────────────────────────────────────┘
```

### Recommended Project Structure
```
src/viz/modules/
├── constants.js       # EXTEND: HUD color/motion tokens, HUD_IDLE_TIMEOUT_MS,
│                       #   RECEDE_GHOST_OPACITY, palette timings — join existing
│                       #   Phase 57/58 discipline (named exports, JSDoc, no new file)
├── palette.js          # NEW: ⌘K module (~100-line budget) — input, matching,
│                       #   rendering, keyboard, command registry
├── hud-recede.js        # NEW (or fold into hud.js): idle+camera-flight opacity
│                       #   fade for chip/rails/topics-rail
├── hud.js               # MODIFY: SSE/log/tombstone logic re-homed as palette
│                       #   commands; chip status rendering
├── search.js            # MODIFY: keep the fetch/debounce/fly-to logic, strip
│                       #   the always-open input/results-list DOM (D-03);
│                       #   palette.js imports its exported fetch helper
├── topics.js            # MODIFY: keep region-highlight logic; palette.js reuses
│                       #   the same schema-list-building code (factor into a
│                       #   small shared helper if duplicated)
├── settings.js          # MODIFY: glass reskin only (CSS classes), open/close
│                       #   entry point joins palette command list
├── camera.js            # MODIFY (small): export ctx.isCameraInFlight()
├── stats.js             # MODIFY (small): expose elapsed-since-active (not just
│                       #   a single hardcoded-threshold boolean) so hud-recede.js
│                       #   can apply its OWN timeout distinct from the 1.2s
│                       #   camera-drift threshold
└── (index.html/styles.css — see Code to change below)
```

### Pattern 1: Liquid-Glass panel token (extend existing idiom)
**What:** `#panel`'s current construction is already ~80% of the target recipe — translucent aubergine-tinted background, blur, hairline border. The gap is the "specular highlight" (a subtle light-catching edge, not just a flat hairline) and formalizing the color/blur values into named tokens instead of inline literals.
**When to use:** Every restyled surface (chip, rails, palette, detail, settings, reader, tooltip) per D-12.
**Example:**
```css
/* Source: existing #panel recipe, styles.css:97-108 — the starting point to
   formalize into tokens, NOT replace: */
#panel {
  background: rgba(26, 18, 32, 0.66);
  border: 1px solid rgba(170, 150, 180, 0.12);
  border-radius: 11px;
  backdrop-filter: blur(12px);
}

/* Liquid-Glass addition: a specular hairline via a gradient border or inset
   box-shadow highlight (construction choice — Claude's Discretion). Two
   established CSS techniques for this, either is in-budget:
   (a) border-image / background-clip double-layer gradient border
   (b) inset box-shadow highlight on the top edge only, e.g.:
       box-shadow: inset 0 1px 0 rgba(255,255,255,0.06);
   Note: (b) technically adds a "shadow" property, but an INSET, near-white,
   top-edge-only highlight at very low alpha is the specular-edge effect
   itself, not the drop-shadow-on-dark the D-12 ban targets (a shadow cast
   BELOW/AROUND an element implying elevation). Distinguish these explicitly
   in the plan so the no-drop-shadow lock and the specular-highlight
   technique don't collide semantically or in a scanning invariants test. */
```

### Pattern 2: Vanilla ⌘K palette (Raycast/Linear reference)
**What:** Single input, mixed result sections with headers, keyboard-navigable, select-to-act.
**When to use:** D-04/D-05/D-06/D-07.
**Example:**
```javascript
// Source: pattern synthesized from Raycast/Linear cmd-K conventions
// (destiner.io "Designing a Command Palette"; manual.raycast.com) — no
// direct code lifted (both are closed-source apps), this is the standard
// shape independently re-derived, matching the existing repo's module style.
export function initPalette(ctx) {
  const state = { open: false, query: '', sections: { nodes: [], topics: [], commands: [] } };

  function open() { /* show overlay, focus input, reset query */ }
  function close() { /* hide overlay, clear query — mirrors settings.js hide() */ }

  document.addEventListener('keydown', e => {
    // Mirrors the EXISTING per-module guarded-Escape convention (reader.js:165,
    // detail.js:730, settings.js:63) — each listener checks ITS OWN open state,
    // so multiple independent `keydown` listeners coexist safely today. The
    // palette adds a fourth, following the same shape — no central refactor
    // needed (see Common Pitfalls #3).
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); state.open ? close() : open(); }
    if (e.key === 'Escape' && state.open) close();
  });

  // Nodes section: reuse search.js's exact debounced fetch shape (DEBOUNCE_MS=200,
  // MAX_ROWS=20, same /search?q= endpoint) — do not reimplement.
  // Topics section: reuse topics.js's schema-list + memberCount building.
  // Commands section: static registry array — { id, label, run(ctx) }.
}
```

### Pattern 3: Idle + camera-flight recede (extends existing idle plumbing)
**What:** Opacity-only fade driven by TWO signals: HUD-specific idle timeout (distinct from the existing 1.2s scene-drift timeout) and camera-in-flight state (currently unexposed).
**When to use:** D-08/D-09/D-10.
**Example:**
```javascript
// stats.js currently exposes only a single-threshold boolean:
//   ctx.isIdle = () => (performance.now() - lastActiveTime) > IDLE_TIMEOUT_MS; // 1200ms
// Reusing this directly for chrome recede would fade chrome after 1.2s of
// stillness — too aggressive for "a few seconds" (CONTEXT.md D-08). Minimal,
// additive fix: expose the raw elapsed time so hud-recede.js can apply its
// OWN named threshold without touching the existing 1.2s camera-drift value:
//   ctx.msSinceActive = () => performance.now() - lastActiveTime;
// hud-recede.js then does:
//   const idle = ctx.msSinceActive() > HUD_IDLE_TIMEOUT_MS; // new named const

// camera.js has NO ctx exposure of its `active` (in-flight) boolean today.
// One-line addition alongside the existing ctx.setCameraTarget assignment:
//   ctx.isCameraInFlight = () => active;
```

### Anti-Patterns to Avoid
- **Generic glassmorphism-template look:** uniform frosted cards floating with no hairline specular, no restraint on WHICH surfaces get blur (Apple's own HIG explicitly warns against glass-on-glass and glass outside the navigation layer — `[CITED: developer.apple.com/design/human-interface-guidelines/materials]`). Apply blur to surfaces that are genuinely floating chrome (chip/rails/palette/panels); the diegetic troika labels (D-13) must NEVER get any glass treatment — they are the one legitimately in-scene element.
- **Purple/indigo gradient clichés:** N/A by construction — the locked BG/TYPE palette family (aubergine `0x170f1d`, dusty-rose/slate/mauve) is NOT the AI-slop indigo-500-Tailwind-default; this phase must not accidentally drift toward a generic saturated purple when picking the "aubergine tint" for glass surfaces (stay within the existing muted `rgba(170,150,180,*)`/`rgba(139,112,144,*)` family already used pervasively in `styles.css`, not a new saturated violet).
- **Glow-on-everything:** No emissive/glow CSS on chrome — glow is reserved for the Three.js activation bloom (engine-tier amber/kind-color signal), never HTML chrome.
- **Bouncy/springy overshoot easings:** D-11 explicitly locks chrome motion to "soft ease-out, no bounces," matching the damped canvas grammar (`THREE.MathUtils.damp`, Phase 58) — CSS `transition-timing-function` for recede/palette/expand should use a cubic-bezier ease-out (the existing `cubic-bezier(0.22, 1, 0.36, 1)` already used for `#detail`'s slide-in, `styles.css:44-45`, is a good ease-out reference already in the codebase — reuse it as a named motion token rather than inventing a new curve).
- **Inter-font-default sameness:** N/A — the codebase already uses `system-ui` for UI chrome and a vendored JetBrains Mono for data/instrument-panel text; no Inter anywhere. Keep it that way; do not introduce a webfont CDN fetch.
- **Emoji-as-icons:** The existing rail/corner buttons already use inline SVG (book icon, crosshair icon, pushpin icon in `popover.ts`) — continue this; zero emoji.
- **Rounded-XL-everything / uniform 16px radii:** The existing radii are deliberately varied and small (`7px` buttons, `11px` panel, `12px` detail, `4-8px` small elements) — do NOT normalize everything to one large radius; that uniformity IS a slop tell. Keep the existing scale, formalize it into 2-3 named radius tokens (e.g. `--radius-sm: 6-7px`, `--radius-md: 11-12px`) rather than introducing a new bigger one.
- **Drop-shadow stacks on dark UI:** D-12 explicitly requires removing the 3 existing `box-shadow` instances (`styles.css:571, 869, 1203` — all `2px 0 24-28px rgba(0,0,0,0.35)`, cast on `#reader`/`#settings-panel`/`#index-panel`). Do not replace them with a softer drop-shadow — replace with border/hairline definition only, per the no-drop-shadow rule.
- **Gratuitous gradient text:** No gradient text anywhere in this phase — the palette is instrument-panel register, not marketing chrome.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Node search matching | A new BM25/text-search implementation for the palette | The existing `GET /search?q=` endpoint + `search.js`'s exact debounce/fetch/sequence-guard logic | Already LLM-free, already debounced (200ms), already caps at 20 (server `SEARCH_LIMIT`), already handles stale-response races via a sequence counter — reimplementing risks losing the race-guard and reintroducing a bug class |
| Topic region highlighting | New client-side logic to compute/highlight a schema's member region | `ctx.selectNode(schemaNode)` — already implemented in `topics.js`/`detail.js` (Plan 19-02), lights the schema + its `abstracts`-edge members as a cohesive region | Topic membership is engine-served (SC2 invariant) — a client approximation would violate the honesty invariant the rest of the codebase is careful to uphold |
| Camera fly-to for palette node selection | A new camera tween for the palette | `ctx.setCameraTarget` (camera.js, Phase 58's damped interruptible system) via the existing `ctx.selectNode` call | The whole point of Phase 58's camera system is that EVERY camera-driving caller routes through one damped target — a palette-specific tween would be a second animator fighting the first, the exact anti-pattern camera.js's header explicitly guards against |
| CSS-in-JS / a component framework for the palette | React/Preact/Vue + a component library | Plain `document.createElement` + `textContent` DOM building, matching every other module (`search.js`, `topics.js`, `settings.js` all do this today) | Explicit CONTEXT.md mandate: "~100 lines, no React dep"; net-zero-deps CLAUDE.md invariant |
| Fuzzy matching library | A vendored fuzzy-search package | A ~20-30 line subsequence/fuzzy scorer (standard "does query appear as a subsequence, scored by contiguity/position" algorithm) | Bounded input size (schema count + command count, both small, <200 items combined); a full library is disproportionate and adds a dependency for a solved-in-20-lines problem |
| CSS custom-property emission mechanism | A new build tool / CSS-in-JS token pipeline | Extend the EXISTING Phase-57 D-10 pattern: `server.ts` already does `readFileSync` + regex-parse of `constants.js` at boot to avoid a second source of truth for scheduler scalars — the identical technique (read `constants.js`, regex out the HUD token consts, inject as a `<style>` block or write a small generated CSS file at boot/build) is directly reusable | The single-source-of-truth problem this phase's D-14 raises is IDENTICAL in shape to the one Phase 57 already solved for TS/JS; inventing a different mechanism (e.g. a bespoke CSS preprocessor) would create TWO emission patterns in one codebase for the same underlying problem |

**Key insight:** Nearly everything this phase needs already exists in working form somewhere in `src/viz/modules/` — the work is consolidation, reskinning, and exposing 2-3 small pieces of previously-internal state (`camera.js`'s `active`, `stats.js`'s raw elapsed-idle-time), not building new subsystems.

## Common Pitfalls

### Pitfall 1: The tooltip's explicit anti-blur precedent contradicts D-12
**What goes wrong:** `styles.css` (`#tooltip` block, ~line 65-72) carries a dated, explicit comment: "Solid near-opaque backing for guaranteed contrast over nodes/field. Contrast comes from OPACITY, not a frosted blur (the blur was the glassmorphism slop) — a clean dark card, hairline border, no backdrop-filter." D-12 now asks for the tooltip to join the glass reskin. A plan that blindly applies `backdrop-filter: blur()` to `#tooltip` without addressing this prior, deliberate rejection risks literally reintroducing the exact thing a previous phase explicitly called "slop" — which is precisely the founder mandate's top concern (self-inflicted AI-slop regression).
**Why it happens:** CONTEXT.md's D-12 scope list ("chip, rails, palette, detail panel, settings panel, reader takeover, tooltip") was written as a flat inclusion list without cross-referencing this specific prior CSS comment.
**How to avoid:** The plan must explicitly reconcile the two: either (a) keep the tooltip mostly opaque (matching its contrast-first design intent) and apply ONLY the token/hairline-border/radius formalization — no `backdrop-filter` — documenting that this is a deliberate exception to "full glass reach," or (b) apply a genuinely restrained, low-radius blur (e.g. 4-6px, much lower than the panel's 12-14px) with the reasoning that a small tooltip over a busy 3D scene still needs contrast priority, and document why THIS blur is not the rejected "glassmorphism slop" (structured, minimal, contrast-preserving) vs. the generic pastiche the original comment rejected. Either way, this needs an explicit sentence in the plan, not silent overwrite of the old comment.
**Warning signs:** A diff that deletes the "no backdrop-filter" comment without a replacement rationale; a tooltip that becomes hard to read over a bright/haze-dense region of the scene.

### Pitfall 2: Reusing `ctx.isIdle()` directly for chrome recede
**What goes wrong:** `stats.js`'s `ctx.isIdle()` is gated by a SINGLE hardcoded `IDLE_TIMEOUT_MS = 1200` (1.2s), tuned specifically for resuming the ambient camera auto-drift quickly after a user stops interacting. If the palette/rails recede logic calls `ctx.isIdle()` directly, chrome will ghost-fade after 1.2s of stillness — far more aggressive than CONTEXT.md's "a few seconds," and any retune of the camera-drift timeout (a live, founder-tunable value) would silently also retune chrome recede.
**Why it happens:** `ctx.isIdle()` looks like exactly the right primitive (it already tracks the correct trigger sources — mousemove is already wired to `ctx.markActive()` globally in `app.js:257-264` — see Pitfall 4) and it's tempting to reuse it as-is.
**How to avoid:** Add a second, HUD-owned named constant (`HUD_IDLE_TIMEOUT_MS`, CONTEXT.md's own "named tunable constant" instruction) and a new `ctx.msSinceActive()` (or equivalent elapsed-time export) in `stats.js` so hud-recede logic computes its own threshold from the SAME underlying `lastActiveTime`, decoupled from the scene-drift threshold.
**Warning signs:** Chrome recede and camera auto-drift-resume visibly happen at the exact same moment during manual testing (they should NOT, since the two named constants should differ).

### Pitfall 3: Assuming a "single shortcut-map owner" refactor is required
**What goes wrong:** CONTEXT.md's Integration Points note flags "Keyboard handling must coexist with existing key listeners... one place should own the shortcut map" as an open concern. A plan might over-engineer this into a keyboard-event-bus refactor touching `reader.js`, `detail.js`, and `settings.js`.
**Why it happens:** The concern sounds like it implies existing conflict, but live-reading the code shows there is NO conflict today: `reader.js:165`, `detail.js:730`, and `settings.js:63` each independently register their OWN `document.addEventListener('keydown', ...)` for `Escape`, each guarded by a check of THEIR OWN open/visible state (`panel.classList.contains('open')`, `detailEl.style.display !== 'none'`). Multiple independent guarded listeners already coexist safely — this is the established repo convention, not a latent bug.
**How to avoid:** The palette should add a FOURTH such guarded listener (its own `Escape` check gated on `state.open`, plus the new `⌘K` binding), following the exact existing shape. No central refactor is required or in-budget for this phase; recommend against one unless testing surfaces an actual real conflict (e.g. two panels' Escape both wanting to fire — unlikely since only one is normally open at a time, and if the palette opens ON TOP of another panel, the palette's own Escape should close the palette first, which is the natural z-order/attention rule anyway).
**Warning signs:** A plan task titled "refactor keyboard handling into a central dispatcher" — this is scope creep beyond what D-04/D-06 require.

### Pitfall 4: Assuming a new global mousemove listener must be added for D-08
**What goes wrong:** A plan might add a brand-new `document.addEventListener('mousemove', ...)` specifically for chrome-recede, not realizing one already exists.
**Why it happens:** `app.js:257-264` already has a global `mousemove` listener, but its stated purpose (in its own comment) is "track position so the tooltip follows the cursor... resets the stats.js idle timer" — it's easy to miss that it ALREADY calls `ctx.markActive()` on every single mousemove, i.e., the "any mouse move returns it instantly" requirement (D-08) is already 90% wired, just feeding the wrong (1.2s) threshold today (see Pitfall 2).
**How to avoid:** Do not add a second mousemove listener. Extend `stats.js`'s existing `lastActiveTime` tracking (already fed by this listener) with the new elapsed-time export described in Pitfall 2's fix.
**Warning signs:** Two `mousemove` listeners in the diff doing conceptually the same "reset an idle clock" job.

### Pitfall 5: `constants.js` JSDoc says "do NOT add runtime behaviour here"
**What goes wrong:** `constants.js`'s file header explicitly states: "This file is the source-of-truth for the ctx contract... do NOT add runtime behaviour here." A plan that puts the CSS-var emission LOGIC (e.g. a function that builds a `<style>` string and injects it) directly inside `constants.js` would violate this established convention.
**Why it happens:** It's tempting to colocate "the constants" and "the code that turns constants into CSS vars" in the same file since they're topically related.
**How to avoid:** Keep `constants.js` as pure named `export const` declarations (as it is today, consumed by both direct ESM `import` and the `server.ts` regex-parse mechanism). Put the CSS-var emission/injection logic in a separate small module (e.g. a new tiny script or a few lines in `hud.js`/`app.js` boot sequence) that IMPORTS from `constants.js` and writes/injects the resulting CSS — mirroring how `server.ts` already keeps its `parseSchedulerScalars()` function OUTSIDE `constants.js` even though it reads from it.
**Warning signs:** A function definition added directly inside `constants.js`.

### Pitfall 6: Amber-hover-tint on chrome is an EXISTING sanctioned exception, not a new violation
**What goes wrong:** A naive D-14 CSS scan ("ban all amber-family values in styles.css outside a token block") would flag the ~15 existing legitimate uses of `rgba(217, 160, 92, *)` (amber-family) as hover/focus border tints on buttons, search results, topic rows, and the fact-ref link color — all of which are DELIBERATE, already-documented exceptions ("amber only as a focus/hover border tint... HTML chrome stays muted," `search.js` header comment) predating this phase.
**Why it happens:** The invariants test needs to distinguish "amber used as a hover/focus accent border" (sanctioned, existing, subtle) from "amber used as a fill/background/text color at material opacity" (the new violation class D-14 is actually trying to prevent — e.g. a new amber-tinted glass panel background, which WOULD compete with the engine's live-activation signal).
**How to avoid:** Design the D-14 invariants test to allow-list the specific existing hover/focus/active amber usages (or scope the ban to specific properties like `background`/`color` at higher opacity, excluding `border-color` hover states below some alpha threshold) rather than a blanket "no amber hex anywhere" regex, which would break on day one against pre-existing, founder-sanctioned code.
**Warning signs:** The new invariants test fails against the CURRENT, unmodified `styles.css` before any Phase-59 changes are even made — a sign the test is over-broad.

### Pitfall 7: Compact/popover mode gating must extend to the NEW chrome, not just old `#panel`
**What goes wrong:** The existing `@media (max-width: 500px), (max-height: 500px)` block explicitly hides `#panel` and its children for the tray's 300×300 popover. If the chip/rails/palette are built as NEW top-level DOM elements (not children of `#panel`), this existing media query will not automatically hide them, and CONTEXT.md is explicit that "Tray compact popover changes... stays glance-only, no palette, no new chrome" (out of scope, hard).
**Why it happens:** The new chip/rails structurally REPLACE `#panel`'s contents per D-01/D-02, so if they're new sibling elements rather than descendants of `#panel`, the existing selector `#panel { display: none }` and its child-selectors won't reach them.
**How to avoid:** Either keep the new chip/rails as descendants of a `#panel`-equivalent container that the existing compact media query already targets, OR add explicit new compact-mode hide rules for the new element IDs, mirroring the existing pattern exactly. Also gate the palette's global `⌘K` keydown listener itself behind a `.mode-window` check (or equivalent), matching the existing `.mode-window`-gated pattern for `#search-wrap`/`#topic-wrap`, so the keybinding doesn't even activate in the popover.
**Warning signs:** Opening the tray popover (or resizing the app window below 500px) still shows rail icons or lets ⌘K open the palette.

## Code Examples

### Existing glass idiom to formalize (not invent)
```css
/* Source: src/viz/css/styles.css:97-108 (current #panel) */
#panel {
  background: rgba(26, 18, 32, 0.66);
  border: 1px solid rgba(170, 150, 180, 0.12);
  border-radius: 11px;
  padding: 7px 12px;
  backdrop-filter: blur(12px);
  opacity: 0.45;
  transition: opacity 0.2s ease;
}
```

### Existing three box-shadow instances D-12 requires removing
```css
/* Source: src/viz/css/styles.css — all three are "elevation" drop-shadows
   on dark panels, exactly what the no-drop-shadow-on-dark rule targets. */
/* line 571  (#reader) */       box-shadow: 2px 0 28px rgba(0, 0, 0, 0.35);
/* line 869  (#settings-panel) */ box-shadow: 2px 0 28px rgba(0, 0, 0, 0.35);
/* line 1203 (#index-panel) */    box-shadow: 2px 0 24px rgba(0, 0, 0, 0.35);
```

### Existing search.js fetch shape to reuse verbatim in the palette's Nodes section
```javascript
// Source: src/viz/modules/search.js:32-33, 102-132 (DEBOUNCE_MS, MAX_ROWS, runSearch)
const DEBOUNCE_MS = 200;
const MAX_ROWS    = 20;   // mirrors server SEARCH_LIMIT=20
// GET /search?q=<value> → ids[] → resolve via ctx.idMap → matchNodes
// Sequence-guard pattern (mySeq === seq check) prevents stale-response races —
// copy this exactly; it is the one non-obvious correctness detail in the fetch.
```

### Existing module wiring order (app.js) — where the palette joins
```javascript
// Source: src/viz/modules/app.js:232-246
initStats(ctx);
initHud(ctx);
initLod(ctx);
initGraph(ctx);
initCamera(ctx);
initLabels(ctx);
initEffects(ctx);
initTrace(ctx);
initDetail(ctx);
initSearch(ctx);   // → palette.js needs ctx.selectNode, ctx.activate: init AFTER initDetail
initTopics(ctx);    // → palette.js's Topics section needs the same ctx.allNodes/adj this reads
initReader(ctx);
initCorpus(ctx);
initIndex(ctx);
initSettings(ctx);
// initPalette(ctx) should join here, LAST or near-last — it needs every other
// module's public ctx surface (selectNode, showToast, reader/settings show()
// hooks, hud.js's log/tombstone toggles) already wired.
```

### Full stacking-context map (for the palette overlay's z-index)
```
z:5   #corpus-graph        z:30  .toast, #stats-overlay
z:8   #index-panel         z:40  #reader
z:9   #backdrop            z:41  #settings-panel
z:10  #panel, #detail,     z:70  #btn-recenter, #btn-corpus,
      .legend, #hull-credit       tray-injected expand/pin/drag-strip/
z:20  #tooltip                    index-reopen
/* The ⌘K palette (D-06: must work above brain/corpus/reader/settings)
   needs a z-index > 41 (above settings-panel, the highest existing
   full-panel z) but does not need to exceed 70 (tray-injected controls
   never coexist with the palette per D-06's popover exclusion). z:50 is a
   safe, uncontested value; give its own backdrop a z just below it. */
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| Always-open search input + persistent results list in `#panel` | Demoted to one magnifier icon → opens ⌘K palette in search mode | This phase (D-03) | `#search-wrap`, `#search-results` DOM/CSS deleted; `search.js`'s fetch logic survives, re-homed into `palette.js` |
| Event log + tombstone toggle as always-visible buttons | ⌘K commands ("Show event log", "Toggle tombstones") | This phase (D-02) | `#btn-tombstones`, `#btn-log` DOM deleted from `index.html`; `hud.js`'s underlying logic (toggle state, log array) survives, invoked from the palette's command registry instead of a button click handler |
| Inline hex/rgba color literals scattered across `styles.css` (~150+ distinct values found via grep) | CSS custom properties emitted from `constants.js` | This phase (D-14) | Large mechanical migration; the ~150 unique literal values catalogued this research session are the scope baseline |
| No exposed camera-in-flight signal | `ctx.isCameraInFlight()` | This phase (new, small addition to `camera.js`) | Needed for D-08's second recede trigger |
| Single hardcoded 1.2s idle threshold shared by scene camera-drift | A second, HUD-owned named idle threshold reading the same underlying clock | This phase (new addition to `stats.js`) | Decouples chrome-recede feel from scene-drift feel — both independently tunable |

**Deprecated/outdated:**
- `#search-wrap`, `#search-results`, `#topic-wrap`'s always-visible list UI — replaced by the palette; the underlying data-fetch and highlight code is NOT deprecated, only its DOM presentation.
- Three `box-shadow` elevation declarations (D-12) — replaced by hairline-border-only definition.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Apple's "Liquid Glass" HIG material (WWDC 2025) is best summarized as blur + depth-based refraction + specular highlights that react to environment/light, reserved for the navigation layer, avoiding glass-on-glass | Architecture Patterns / Anti-Patterns | LOW — this is descriptive/editorial grounding from Apple's own developer documentation and newsroom post `[CITED: developer.apple.com, apple.com/newsroom]`; risk is only in exact technical replication nuance since Apple's native implementation uses real-time rendering unavailable to a CSS-only web construction — the plan should treat "Liquid Glass" as a REFERENCE for spirit (restraint, specular hairline, context-adaptive tint) not a literal API to port |
| A2 | The current AI-slop "tells" list (generic glassmorphism-template look, purple/indigo gradients, Inter font sameness, glow-on-everything, bouncy easings, emoji icons, rounded-XL uniformity) reflects 2025-2026 design-critique consensus | Anti-Patterns to Avoid | LOW-MEDIUM — sourced from multiple independent 2026 design-critique blog posts via WebSearch, cross-referencing shows strong agreement across sources, but these are opinion/trend pieces, not a canonical standard `[CITED: 925studios.co, superdesign.dev, prg.sh — see Sources]` |
| A3 | `backdrop-filter` blur has a real, documented compositing performance cost, worse in Safari, worse over transform/filter-bearing parents (breaks the backdrop root), and worse over an active WebGL canvas at large blur radii | Common Pitfalls / general perf guidance | MEDIUM — grounded in Chromium/Mozilla bug trackers (authoritative for the mechanism) but the SPECIFIC interaction with 3d-force-graph's WebGL canvas in THIS app was not empirically profiled this session — recommend the plan include an actual before/after fps measurement (mirroring Phase 58's D-16 perf-measurement precedent) rather than trusting this claim blindly `[CITED: bugzilla.mozilla.org, issues.chromium.org — see Sources]` |
| A4 | Recommending z-index 50 for the palette overlay (between settings-panel's 41 and the tray-injected 70 tier) is a safe, non-colliding choice | Code Examples | LOW — derived directly from the live-read z-index map in `styles.css`; low risk, purely a planner-discretion default that can be changed freely without other consequences |

**If this table is empty:** N/A — table populated above.

## Open Questions (RESOLVED)

*All three questions are functionally resolved by the plans — inline RESOLVED markers below; the recommendations were adopted.*

1. **Where exactly should the CSS-var emission code live, and is it a build step or a boot-time runtime injection?**
   - **RESOLVED (Plan 01, Task 2):** client-side ESM-import emission — a new `css-tokens.js` module imports the token consts from `constants.js` and injects a `<style id="hud-tokens">` block at boot (no server.ts change, no build step, single source of truth). The recommendation below was adopted.
   - What we know: Phase 57 already solved an analogous problem (TS server needing JS-authored constants) via `readFileSync` + regex-parse at server boot (`parseSchedulerScalars()` in `server.ts`), proven and tested (`viz-activity-palette-invariants.test.ts` "D-10 shared source of truth" suite).
   - What's unclear: Whether the CSS consumer should use the identical "parse at server boot, inject as a response header/inline `<style>` tag served with `index.html`" approach, or a client-side "import constants.js as ESM, build a `<style>` string, append to `<head>`" approach (no server involvement, works even if the static files are served by something other than the viz server, e.g. a future static host). Both are explicitly left to Claude's Discretion in CONTEXT.md.
   - Recommendation: Favor the client-side ESM-import approach — it requires zero server.ts changes (viz server stays purely "read-only, LLM-free" per CLAUDE.md, and doesn't need to know about CSS at all), is testable in isolation, and avoids adding a THIRD parsing mechanism (JS→JS import, JS→TS regex-parse, and now JS→CSS regex-parse) when a JS→CSS-via-JS-object approach needs no regex at all — `constants.js`'s values are already plain JS numbers/hexes, trivially formattable into `--var: value;` strings via a native `import`.

2. **Does the fuzzy/subsequence matcher need to rank commands+topics together, or run as two independent lists?**
   - **RESOLVED (Plan 03, Task 2):** independent per-section matching — each of Nodes/Topics/Commands is filtered, sorted, and capped separately (`filterSection(query, items, cap)`), matching the Raycast/Linear mixed-section model. The recommendation below was adopted.
   - What we know: D-04 says "one input filters everything at once," with results grouped by section headers; D-07 says fuzzy matching for "the rest" (commands + topics) as one category description.
   - What's unclear: Whether Commands and Topics get their own independent fuzzy-sort-and-cap, or a single merged fuzzy pass with a section-tag per result. CONTEXT.md's discretion list explicitly leaves "result caps per section... section order" to the planner.
   - Recommendation: Independent per-section matching (separate cap, separate sort) is simpler to implement, matches the "Nodes/Topics/Commands" mixed-SECTION mental model exactly (Raycast/Linear both rank within a section, not across), and avoids needing a cross-category relevance-normalization scheme.

3. **What is the actual current unique-color-literal count in `styles.css`, precisely, for D-14 scope estimation?**
   - **RESOLVED (Plan 02, Task 1):** dedup-grep-first — Plan 02 Task 1 runs the dedup pass to catalog every remaining literal into `constants.js` tokens (≥25 tokens asserted) before the styles.css migration in Task 2, so the exact count is established at execution time rather than guessed at plan time. The recommendation below was adopted.
   - What we know: This research session's grep found roughly 150 distinct `#hex`/`rgba(...)` literal occurrences across the 1,343-line file (see Code Examples' box-shadow list and the Standard Stack section's literal-count note).
   - What's unclear: The exact DEDUPLICATED count of distinct color VALUES (as opposed to occurrences) that need a named token — some values repeat dozens of times (e.g. `rgba(170, 150, 180, 0.1)`-family appears 10+ times) while others are one-off.
   - Recommendation: The planner should run a dedup pass (`grep -oE '#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)' styles.css | sort -u | wc -l`) as an early plan task to size the token-naming work accurately before committing to a wave structure — this research's manual grep is a good starting catalog but not an exhaustive dedup.

## Environment Availability

Skipped — this phase has no external tool/service/runtime dependencies beyond the existing Node/browser/Electron stack already running the `recense viz` frontend (no new packages, no new services, per the Package Legitimacy Audit section above).

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (existing, `[VERIFIED: vitest.config.ts present, tests/viz-activity-palette-invariants.test.ts uses `describe/it/expect` from `vitest`]`) |
| Config file | `vitest.config.ts` (repo root) |
| Quick run command | `npx vitest run tests/viz-activity-palette-invariants.test.ts` |
| Full suite command | `npm test` (runs `vitest run`, per `package.json` `"test": "vitest run"`) |

### Phase Requirements → Test Map
No formal REQUIREMENTS.md IDs are mapped to this phase (CONTEXT.md's phase description states "Requirements: TBD" — this is a viz/presentation phase tracked by ROADMAP.md decisions, not the v9.0 engine-milestone REQUIREMENTS.md). The decision-to-test map below substitutes for requirement IDs, following the same D-## traceability CONTEXT.md already uses:

| Decision | Behavior | Test Type | Automated Command | File Exists? |
|----------|----------|-----------|-------------------|-------------|
| D-14 (amber-exclusivity + no-foreign-ramp over full CSS) | `styles.css` contains zero color literals outside the token block; zero amber-family fill/background/text colors outside sanctioned hover exceptions | unit (source-parse) | `npx vitest run tests/viz-activity-palette-invariants.test.ts -t "D-14"` | ❌ Wave 0 — extend existing file with new `describe('D-14 ...')` blocks |
| D-11 (shared motion tokens, machine-checkable) | Recede/return/palette/expand timing constants exist in `constants.js`, exported, and match the CSS custom properties consuming them | unit (source-parse) | same file, new `describe('D-11 ...')` block | ❌ Wave 0 |
| D-10 (Phase-57 D-10 pattern extended: no second source of truth for CSS-var values) | If CSS values are also hardcoded anywhere outside the `constants.js`→CSS-var pipeline, test fails (mirrors the existing "WR-01 anti-duplication lock" shape) | unit (source-parse) | same file | ❌ Wave 0 |
| D-13 (diegetic split — no CSS3D/fake parallax on screen-space elements) | Static grep/source-check that no NEW `transform-style: preserve-3d` or CSS3D-object usage was introduced on HUD elements | unit (source-parse) or manual visual check | manual-only acceptable — this is a structural CSS property absence check, low risk of regression without a dedicated test given it's a one-time construction choice, not a tunable value | n/a |
| D-08/D-09 (recede triggers + opacity-only, no layout shift) | Idle timer + camera-flight both trigger recede; recede never changes `top/left/width/height`, only `opacity` | manual (founder checkpoint, D-15) + optional unit test asserting no non-opacity properties appear in the recede CSS class rule | manual-only — CONTEXT.md D-15 explicitly designates this a founder-eyeball checkpoint, not an automated pixel test (mirrors Phase 57's D-15 precedent rejecting automated visual assertions as flaky) | n/a |

### Sampling Rate
- **Per task commit:** `npx vitest run tests/viz-activity-palette-invariants.test.ts`
- **Per wave merge:** `npm test` (full suite — this phase touches shared `constants.js`, so running the full suite guards against breaking Phase 57/58's existing locks)
- **Phase gate:** Full suite green before `/gsd:verify-work`; founder checkpoint (D-15) is the qualitative gate on top of the automated suite.

### Wave 0 Gaps
- [ ] Extend `tests/viz-activity-palette-invariants.test.ts` with new `describe` blocks for D-14 (CSS literal scan), D-11 (motion-token existence + sync), and D-10-extended (no second source of truth for CSS values) — no new test FILE needed, this phase's canonical_refs already direct extension of the existing file.
- [ ] No new test framework install needed (Vitest already present and configured).
- [ ] Consider one new lightweight test file `tests/viz-hud-palette.test.ts` (or similarly named) if the palette's fuzzy-matcher/keyboard-map logic warrants unit tests independent of the CSS/constants invariants file — this is a planner judgment call, not a hard requirement, since D-15's evidence record is founder-eyeball, not automated behavior assertions.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No | Viz server is loopback-bind only, no user accounts, unchanged by this phase |
| V3 Session Management | No | No sessions introduced |
| V4 Access Control | No | No new access-controlled resources; palette commands operate on already-loaded client-side data or existing read-only endpoints |
| V5 Input Validation (output encoding) | Yes | `textContent`-only DOM rendering for ALL server/user-sourced strings — the established, repo-wide T-10-12/T-44-19 discipline (`hud.js`, `search.js`, `topics.js`, `settings.js` headers all document and enforce this). The palette MUST follow the identical rule: node labels, topic names, search result text all render via `textContent`, never `innerHTML`, exactly as `search.js`'s `renderResults()` and `topics.js`'s `render()` already do. |
| V6 Cryptography | No | Not applicable — no new crypto surface |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| DOM-based XSS via server-sourced node/topic values rendered as HTML | Tampering | `textContent` assignment only, never `innerHTML`/`insertAdjacentHTML` with dynamic data — already the enforced convention across every existing module; the palette's Nodes/Topics sections must inherit it verbatim (this is explicitly called out in CONTEXT.md's canonical_refs: "keep the textContent-only security discipline documented in its header") |
| New DOM-based XSS surface via a naive fuzzy-match highlight feature (e.g. wrapping matched substrings in `<mark>` via string concatenation + `innerHTML`) | Tampering | If match-highlighting is added (not required by CONTEXT.md, but a common command-palette embellishment), build the highlighted result via DOM `createElement`/`appendChild` fragments (splitting the text into pre-match/match/post-match `Text` nodes), never via string-concatenated `innerHTML` — this is a common command-palette implementation trap not present in the existing simpler `search.js`/`topics.js` renderers, so it needs explicit new discipline if built |
| Prototype pollution / unsafe merge from `/search` or `/graph` JSON responses | Tampering | Not a new risk this phase — inherits the existing fetch-and-index pattern (`ctx.idMap.get(id)` lookups against already-validated node objects), no new JSON-merging logic introduced |

## Sources

### Primary (HIGH confidence)
- Live source reads: `src/viz/index.html`, `src/viz/css/styles.css` (full grep + 3 targeted range reads), `src/viz/modules/{hud,search,topics,settings,constants,camera,stats,app,graph,corpus,labels}.js`, `apps/tray/src/popover.ts`, `tests/viz-activity-palette-invariants.test.ts`, `.planning/phases/{57,58,60}-*/CONTEXT.md`, `.planning/ROADMAP.md` (Phase 57-60 entries) — all read directly this session, not from planning-doc summaries.
- `developer.apple.com/design/human-interface-guidelines/materials` and `developer.apple.com/videos/play/wwdc2025/219/` — Apple's own Liquid Glass documentation (checked via WebSearch result summaries; construction claims A1 tagged accordingly).

### Secondary (MEDIUM confidence)
- Chromium/Mozilla bug trackers (`bugzilla.mozilla.org/show_bug.cgi?id=925025`, `issues.chromium.org/issues/414525204`) — backdrop-filter performance mechanism, cross-referenced across multiple independent bug reports and blog posts.
- `manual.raycast.com`, `destiner.io/blog/post/designing-a-command-palette` — command-palette UX convention (section headers, keyboard model), cross-referenced across 3+ independent sources agreeing on the same shape.

### Tertiary (LOW confidence)
- `925studios.co/blog/ai-slop-design-tells`, `superdesign.dev/blog/why-ai-design-looks-generic`, `prg.sh/ramblings/Why-Your-AI-Keeps-Building-the-Same-Purple-Gradient-Website`, `vibecodekit.dev/ai-slop-design` — 2026 design-critique opinion pieces on AI-slop tells; directionally consistent across sources (see A2) but editorial, not a formal standard. Used only to enumerate/corroborate tells, not as a source of technical construction detail.
- `/Users/vtx/.claude/design-corpus/lessons.json` (18 entries, checked for HUD/glassmorphism/command-palette relevance) — no directly on-topic lessons found (all 4 keyword-matching entries concern unrelated product-design work: brand-accent substitution, Tailwind-stock-color token escape, backbone-pattern differentiation collapse, and root-container full-bleed bugs). The Tailwind-stock-color-escaping-token-system lesson is weakly analogous to this phase's D-14 token-migration risk (a literal color value slipping in outside the token system) and is reflected in Pitfall 6 / the invariants-test design guidance, but is not a direct HUD/glass finding.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — zero new dependencies, fully verified against `package.json`/CLAUDE.md invariants and live repo grep.
- Architecture: HIGH for the existing-code-reuse claims (all read directly from live source this session); MEDIUM for the Liquid-Glass/Raycast-Linear external design-reference claims (editorial synthesis, not literal code ports).
- Pitfalls: HIGH — all 7 pitfalls are grounded in specific, cited line numbers/comments read directly from live source this session (not inferred or assumed).

**Research date:** 2026-07-05
**Valid until:** 2026-08-04 (30 days — this is stable, low-churn frontend/CSS territory with no fast-moving external dependency; the one time-sensitive external claim, Apple's Liquid Glass HIG detail (A1), should be re-checked if this research is reused much later than 30 days since Apple's HIG documentation continues to evolve post-WWDC).
