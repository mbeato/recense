---
status: partial
phase: 60-settings-stats-depth
source: [60-VERIFICATION.md]
started: 2026-07-11T21:40:00Z
updated: 2026-07-11T21:40:00Z
---

## Current Test

[awaiting human testing]

## Tests

### 1. Open via rail button
expected: Click the histogram button in the right-edge rail (between corpus and recenter) — the brain is replaced full-window by the stats surface on the Usage tab. The settings panel no longer has a usage link (moved to rail, quick task 260714-g0s). (Server at http://127.0.0.1:7810; relaunch if not running.)
result: [pending]

### 2. Usage tab content
expected: Burn chart is the focal anchor; cost-event dashed markers appear at the known dates (2026-07-03 thinking-off, Phase-42 skip-threshold) and hovering one shows a before/after avg-burn delta; per-feature and per-model splits render; retail-$ headline reads `API-retail equivalent (subscription-billed: $0 marginal)`.
result: [pending re-verify after gap closure] — original issue (stretching + low-value chart-first layout) closed by 60-07/60-08/60-09: the tab now leads with a 5-tile stat row (today/week/30d/avg-day/retail-$), a "vs your typical" framing block with trend arrow + heaviest day, a visible Cost levers table (before/after/%-saved per event), one collapsed Usage-breakdown card, and the demoted burn chart; all charts render at measured width and re-render on resize

### 3. Range pills and refresh
expected: 7d/30d/90d/all-time pills rescope the charts; all-time shows weekly buckets with parseable dates; clicking refresh updates the `as of {HH:MM:SS}` stamp.
result: [pending]

### 4. Brain Health tab
expected: All six metric groups render in identity hues (reconsolidation magenta, tombstone coral, judge cyan, node-growth sage); node-growth approximation caption present; judge activity shows fires only (escalation honestly unavailable); last-sleep-pass tile shows an honest status, never a fabricated success.
result: [pending]

### 5. Design-language conformance
expected: No amber anywhere on either tab; surface is flat (not glass); charts read as Phase-59-native.
result: [pending]

### 6. Close behavior
expected: Escape / × closes back to the brain; if the corpus view was open before, its HUD chrome is not clobbered.
result: [pending]

### 7. Palette entry
expected: ⌘K → `Open stats` opens the takeover; the command hides while the dashboard is already open.
result: [pending]

### 8. Compact/tray LOD
expected: Nothing from the stats surface leaks into the compact/tray popover LOD.
result: [pending]

## Summary

total: 8
passed: 6
issues: 2
pending: 0
skipped: 0
blocked: 0

Founder re-walk 2026-07-14: "rest looks fine" — all checks pass except the two
new gaps below (GAP-3 scrollbar, GAP-4 tab visual design).

## Gaps

### GAP-1: Charts stretch instead of rendering responsively
status: resolved (60-07 — measured-width rendering + debounced resize re-render; awaiting founder re-walk)
severity: major
details: Every chart is a fixed `viewBox="0 0 760 H"` SVG at `width:100%` with no max-width on `#stats-body` — widening the window scales the whole SVG like an image (blown-up text, fat strokes). Founder decision (2026-07-11): fix with TRUE RESPONSIVE RE-RENDER — measure the chart card's real pixel width, render charts at that width, and re-render on window resize (debounced). Applies to both tabs. Text/strokes must stay at their designed sizes at any window width.

### GAP-2: Usage tab redesign — glanceable and decision-oriented, not chart-first
status: resolved (60-08 data layer + 60-09 redesign — stat tiles, vs-typical framing, levers card, collapsed breakdown; awaiting founder re-walk)
severity: major
details: Founder verdict (2026-07-11): the Usage tab is "not really useful or informative." Four locked decisions for the redesign:
  (a) LEAD WITH BIG NUMBERS — a stat-tile row at the top: today's tokens, this-week tokens, 30d tokens, avg tokens/day, retail-$ equivalent. Charts demoted below the tiles. (Reuse the existing `.stats-headline-tile` Display-28px treatment.)
  (b) SUBSCRIPTION-LIMIT FRAMING — burn framed against the founder's own baseline: share vs typical day/week, trend arrows (up/down vs prior period), heaviest day this week. Answers "is this normal?" All computable from token_usage_ledger with LLM-free SQL.
  (c) SURFACE THE SAVINGS STORY — pull the before/after cost-lever deltas OUT of hover tooltips into a visible "levers" card: one row per COST_EVENT with before-avg, after-avg, and %-saved, honest labeling. The burn-chart hover markers can stay, but the card is the primary surface.
  (d) CUT LOW-VALUE CHARTS — collapse the per-feature and per-model bar charts into one compact stacked bar or simple table; they are near-static and don't justify two full chart cards.
Constraints unchanged: LLM-free prepared statements on the read-only handle, textContent-only rendering, no amber, zero new deps, Phase-59 design language.

### GAP-3: Styled scrollbar must be global
status: failed
severity: minor
details: The Usage tab (and any scrollable surface) shows the default OS scrollbar.
The muted-mauve styled scrollbar already exists but is applied per-container
(`.detail-page #detail` at styles.css ~621, `#reader` at ~726). Founder decision
(2026-07-14): set it GLOBALLY — one global rule set (html/`*` level:
`scrollbar-width: thin; scrollbar-color: var(--scrollbar-thumb) transparent` plus
the `::-webkit-scrollbar*` set) replacing the duplicated per-container blocks.
Amber stays activation-only (thumb is mauve).

### GAP-4: Usage/Brain-Health tabs read as AI-slop — design overhaul
status: failed
severity: major
details: Founder verdict (2026-07-14): "obviously ai slop style need to do a better
design on those." Diagnosis (against the dataviz method + Phase-59 recessive-chrome
idiom): everything is an identical bordered box (5 tiles + framing + levers +
breakdown + every chart all wear .chart-card), five equal 28px numbers compete with
no hero, trend arrows are text glyphs (▲▼→), single-series charts carry pointless
legend boxes, marks/grid are heavier than the thin-mark spec. Locked design
direction for the overhaul:
  (a) DE-BOX — kill the uniform card grid. Plots and tables sit directly on the flat
      #stats-view surface. Structure comes from Phase-59's section idiom: 10px
      uppercase letter-spaced muted section headers + hairline dividers + generous
      whitespace rhythm, NOT bordered containers. (.chart-card chrome retired on
      these tabs; UI-SPEC "chart-card" contract superseded by this founder decision.)
  (b) HERO + SUPPORTING FIGURES — exactly one hero figure per tab (Usage: today's
      tokens, ~40-48px JetBrains Mono HUD). Other stats (week / 30d / avg-day /
      retail-$) become a quiet supporting row: 10px uppercase label over a
      ~16-18px mono value, no boxes, hairline-separated. Retail-$ shows 2 decimals
      ($X.XX) with the subscription-billed framing as a muted footnote line, not a
      tile label.
  (c) INTEGRATE FRAMING INTO FIGURES — the "vs your typical" prose block dissolves
      into deltas on the figures themselves (dataviz stat-tile contract: signed
      delta vs a named period, color = direction; down-usage = positive green,
      up = neutral mauve). Replace ▲▼→ glyphs with plain signed text (+18% / −12%)
      or a small inline SVG chevron consistent with the rail icon language.
      Heaviest-day stays as one muted line under the supporting row.
  (d) CHART MARK SPECS (both tabs, in charts.js/render calls): 2px lines with round
      join; bars capped ≤24px thick with 4px rounded data-end + square baseline;
      2px surface gaps between adjacent/stacked bars (no strokes around marks);
      gridlines/axes solid hairlines one step off surface, recessive; area fills
      ~10% opacity wash; NO legend box on single-series charts (burn, node growth,
      recon, tombstones — the section header names the series); legends stay on
      true multi-series charts (kind mix, judge, episodes); selective direct
      labels only (endpoint/extreme), never a value on every point.
  (e) TABLES (levers, breakdown) — quiet: 10px uppercase muted column headers,
      hairline row separators, no outer border/box; %-saved is the one emphasized
      value per lever row (mono, green when positive).
  (f) BRAIN HEALTH — same de-boxing; the six metric groups become sections under
      the header idiom with consistent chart heights (small-multiples feel);
      last-sleep-pass becomes a one-line muted readout (label + mono value +
      honest status), not a card.
  Constraints unchanged: Phase-57 identity hues for activity series / neutral ramp
  for non-activity; amber forbidden; textContent-only; zero new deps; LLM-free;
  responsive re-render (GAP-1) and all Phase-60 data honesty rules preserved.
