# Phase 59: HUD Integration — visible-but-belong overlay - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-05
**Phase:** 59-hud-integration-visible-but-belong
**Areas discussed:** Todo folding, Chrome inventory & placement, ⌘K palette behavior, Auto-recede behavior, Restyle reach & diegetic split

---

## Todo Folding

| Option | Description | Selected |
|--------|-------------|----------|
| viz-search (search part only) | Fold the search-affordance ask into the ⌘K palette; hull jaggedness stays pending | ✓ |
| viz-search incl. hull quality | Also pull hull front/top jaggedness into this phase | |
| corpus-brain-3d-transition | Full Option A fly-through — structural, not HUD | |
| content-hardening-deferred | Engine-side hardening — keyword-match noise | |

**User's choice:** viz-search (search part only) — the recommended split.

---

## Chrome Inventory & Placement

### Q1: Persistent footprint at rest

| Option | Description | Selected |
|--------|-------------|----------|
| Status chip + icon rail | Chip + one rail; search/topics/log all palette-only | |
| Chip + rail + slim topics rail | Same plus a persistent collapsed topics edge rail | ✓ |
| Near-zero: single chip only | Everything ⌘K-only | |

**Notes:** Founder chose MORE topic discoverability than the recommendation — topics keep a persistent collapsed rail (region-highlighting is a browsing behavior).

### Q2: Docking

| Option | Description | Selected |
|--------|-------------|----------|
| Top-left chip, right icon rail, left topics | Chip top-left; one vertical mid-right icon rail (absorbs corner buttons); topics left edge | ✓ |
| Everything on one edge | Single left control edge | |
| Top strip layout | macOS-toolbar-like horizontal strip | |

### Q3: Minor/dev-ish elements

| Option | Description | Selected |
|--------|-------------|----------|
| Demote dev tools to palette | Legend into chip; log + tombstones become ⌘K commands; hull credit hairline | ✓ |
| Keep dev tools on the rail | 6–7 icon rail | |
| Kill the legend outright | Delete legend entirely | |

### Q4: Search entry point

| Option | Description | Selected |
|--------|-------------|----------|
| Magnifier icon on the rail | Icon opens palette in search mode; old field deleted | ✓ |
| ⌘K-only, no icon | No persistent search affordance | |
| Collapsed field in the chip | Inline expanding field (two search surfaces) | |

---

## ⌘K Palette Behavior

### Q1: Scope & organization

| Option | Description | Selected |
|--------|-------------|----------|
| One input, mixed sections | Single input filters Nodes/Topics/Commands at once, Raycast/Linear style | ✓ |
| Prefix-mode palette | '>'/'#' prefixes switch modes | |
| Commands-first, search on enter | Two-step search | |

### Q2: On select

| Option | Description | Selected |
|--------|-------------|----------|
| Fly-to via damped camera | Select = go; camera.js fly-to, topic highlight, or command execution | ✓ |
| Preview-then-commit | Arrow-key live preview before enter | |
| Fly-to + open detail panel | Also opens detail on node select | |

### Q3: Reach

| Option | Description | Selected |
|--------|-------------|----------|
| All full-window views | Brain, corpus, reader; tray popover stays glance-only | ✓ |
| Brain view only | Palette over 3D graph only | |
| Everywhere incl. tray popover | Also in compact popover | |

### Q4: Matching

| Option | Description | Selected |
|--------|-------------|----------|
| BM25 for nodes, fuzzy for the rest | Keep /search endpoint; client-side fuzzy for commands/topics | ✓ |
| Uniform simple substring | Plain substring everywhere | |
| Client-side fuzzy over everything | Preload all node names locally | |

---

## Auto-Recede Behavior

### Q1: Trigger

| Option | Description | Selected |
|--------|-------------|----------|
| Idle timer + camera motion | Recede on mouse-idle AND during camera flights; any move returns | ✓ |
| Camera motion only | Recede only during flights | |
| Proximity-based | Rails materialize near cursor (auto-hide-Dock style) | |

### Q2: Recede style

| Option | Description | Selected |
|--------|-------------|----------|
| Fade to hairline ghosts | ~0.1–0.15 opacity, never moves, opacity-only | ✓ |
| Slide off-edge dock | Rails slide off leaving a glass lip | |
| Hybrid: fade rails, slide topics | Two behaviors | |

### Q3: Interaction-state coupling

| Option | Description | Selected |
|--------|-------------|----------|
| Focus deepens recede | Node focus / detail open → immediate ghost; traces never force recede | ✓ |
| No state coupling | Pure idle/camera driven | |
| Traces also recede chrome | SSE activity fades chrome | |

### Q4: Motion tokens (Phase 58 deferred item)

| Option | Description | Selected |
|--------|-------------|----------|
| Shared motion tokens in constants | Named values in shared constants module → CSS custom properties; machine-checkable | ✓ |
| CSS-only tokens | --motion-* directly in styles.css (re-opens mirror drift) | |
| Hardcode reasonable values | No tokenization | |

---

## Restyle Reach & Diegetic Split

### Q1: Restyle reach

| Option | Description | Selected |
|--------|-------------|----------|
| All overlay surfaces | Glass language on chip/rails/palette AND detail/settings/reader/tooltip; restyle only | ✓ |
| Core HUD only, panels later | Two panel languages coexist | |
| Full redesign incl. panel layouts | Also rework panel internals (scope warning given) | |

### Q2: Diegetic line

| Option | Description | Selected |
|--------|-------------|----------|
| Scene = labels only; all else screen-space | Troika labels stay the only diegetic text | ✓ |
| Tooltip goes diegetic too | In-scene hover labels | |
| Topic highlight gets in-scene halo | Region boundary geometry | |

### Q3: CSS token discipline

| Option | Description | Selected |
|--------|-------------|----------|
| Tokenize + machine-lock (recommended) | Tokens + invariant scan; legacy rules migrate opportunistically | |
| Full exhaustive migration | Every color literal in all ~1,343 lines moves to tokens | ✓ |
| Tokens for new chrome only | Literals stay in legacy CSS | |

**Notes:** Founder chose the heavier option over the recommendation — complete tokenization of styles.css this phase, making the amber/foreign-ramp locks machine-checkable over the whole stylesheet.

### Q4: Checkpoint structure

| Option | Description | Selected |
|--------|-------------|----------|
| Single closing checkpoint | One founder gate: look + behavior together, screenshots + recording | ✓ |
| Two-stage: look then behavior | 57/58 precedent | |

---

## Claude's Discretion

- Glass recipe specifics (blur radii, specular construction, tint values within locked palette)
- Icon set/style, rail sizing, chip typography (Phase-58 vendored mono intended)
- Idle-timeout / ghost-opacity / expand-behavior values — named tunables, checkpoint-tuned
- Palette internals: result caps, debounce, empty state, keyboard bindings beyond ⌘K, section order
- Token naming + emission mechanism (build step vs runtime injection)
- Topics-rail expand vs recede interaction (hover-expand vs click-pin)
- Reduced-motion/transparency fallbacks if trivially cheap

## Deferred Ideas

- Hull front/top jaggedness — structural mesh work, todo stays pending
- Full Option A corpus↔brain fly-through — todo stays pending
- Label interactivity (click troika label → focus region) — future candidate
- Palette preview-then-commit — rejected as camera-thrashy; revisit if select-and-go feels blind
- Reduced-motion/transparency support — discretionary or follow-up polish
