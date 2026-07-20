# Phase 61: Corpus Chrome — index column + project browsing - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-14
**Phase:** 61-corpus-chrome-index-column-project-browsing
**Areas discussed:** Live defect walkthrough, Index column redesign, Project browsing model, Leftover chrome cleanup

---

## Live defect walkthrough

Freeform — founder walked the live install's corpus view and narrated (verbatim fragments):

1. "just feels hard to navigate like all the projects and sub docs are laid out yes they
   are indented but for the most part its just a huge thing of text not really easy to
   navigate"
2. "mm not sure clicking a project feels okay"
3. "lots of clutter all the labels on top of eachother but dont hate it its just very
   busy plus hovering and just seeing they yellow higlight feels flat"
4. Reader round-trip lands where expected: "yes"

**Notes:** Reframed the phase — the fix is hierarchy + focus, not broken navigation
actions. Code observation confirmed during walkthrough: sidebar-row hover highlights the
containment subtree but direct graph hover lights only the single node — part of the
"flat" feeling.

---

## Index column redesign

| Option | Description | Selected |
|--------|-------------|----------|
| Collapsible tree | Obsidian/VS-Code style: projects collapsed by default (chevron + name + count), expand inline | ✓ |
| Drill-down column | iOS/Finder-column: one level visible at a time with back header | |
| Flat tree, stronger hierarchy | Keep everything visible, pure visual restructure | |

| Option | Description | Selected |
|--------|-------------|----------|
| Glass, like rails/palette | backdrop-filter blur + hairline specular + aubergine tint; joins D-14 allow-list | ✓ |
| Flat, like stats view | Near-opaque flat surface (Phase 60 stats-view precedent) | |

| Option | Description | Selected |
|--------|-------------|----------|
| Focus project in graph | Name-click → graph zooms to cluster, brightens its nodes, dims rest; tree expands too | ✓ |
| Expand/collapse only | Name click = chevron click; graph doesn't react | |
| Open hub doc in reader | Current behavior — click hijacks navigation into a takeover | |

**User's choice:** Collapsible tree + glass material + name-click focuses project in graph.
**Notes:** Remaining index details (typography, counts, filter auto-expand, tint dots)
deferred to Claude's discretion within 59 conventions.

---

## Project browsing model

| Option | Description | Selected |
|--------|-------------|----------|
| Dim others + click-away exit | Non-focused projects fade to low opacity; exit via empty-canvas click / Esc / another project | ✓ |
| Hide others + back button | Non-focused projects disappear; back affordance added | |
| Zoom only, no dimming | Camera frames cluster; everything stays full presence | |

| Option | Description | Selected |
|--------|-------------|----------|
| Subtree + dim others | Graph hover matches index hover (amber subtree) AND dims non-related nodes | ✓ |
| Subtree parity only | Subtree highlight, no dimming | |
| Keep single-node hover | Leave as-is | |

| Option | Description | Selected |
|--------|-------------|----------|
| Tiered by hierarchy | Hub labels always; subject labels past zoom threshold or on focus/hover; chapter labels on direct hover | ✓ |
| Declutter by collision | Dynamic overlap-hiding with hub priority | |
| Labels on hover/focus only | No labels at rest | |

**User's choice:** Dim-others focus, subtree+dim hover parity, hierarchy-tiered labels.
**Notes:** Zoom thresholds, dim opacities, Esc coexistence with reader/palette left as
named tunables at Claude's discretion.

---

## Leftover chrome cleanup

| Option | Description | Selected |
|--------|-------------|----------|
| Automatic via focus | Kill the toggle; chapters render only when their project is focused/expanded | ✓ |
| Index column control | Toggle moves into the index column, styled in 59 tokens | |
| ⌘K palette command | "Toggle chapter docs" joins palette commands | |

| Option (multi-select) | Description | Selected |
|--------|-------------|----------|
| Reopen handle → glass | The ▶ index-reopen button gets the 59 glass/token treatment | ✓ |
| Corpus loading/empty states | Restyle status overlays into glass vocabulary | |
| Nothing else | Keep the diff surgical | |

**User's choice:** Chapter visibility becomes focus-driven (toggle deleted); index-reopen
handle glassed. Loading/empty overlays untouched.

---

## Claude's Discretion

- Index typography (vendored mono expected), count badges, scope-tint dots, row density
- Filter auto-expand mechanics in the collapsed tree
- Zoom threshold, dim opacities, focus timings — named tunables, tuned at checkpoint
- Esc-key shortcut ownership; tree expand-state persistence
- Focus ↔ reader round-trip interplay (D4 flow must not regress)
- Whether the index tree needs read-only server payload additions

## Deferred Ideas

- None new. Todos reviewed and not folded: corpus-brain-3d-transition (structural),
  viz-search-and-hull-quality hull half (3D brain), content-hardening-deferred (engine),
  cache-constant-judge-extraction-prompt-prefix (engine).
