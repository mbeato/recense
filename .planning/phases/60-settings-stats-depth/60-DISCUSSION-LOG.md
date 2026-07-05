# Phase 60: Settings Stats Depth — usage + brain-health - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-04
**Phase:** 60-settings-stats-depth
**Areas discussed:** Placement & Phase-59 ordering, Chart rendering approach, Cost dashboard framing, Brain-health scope & data

---

## Todo Cross-Reference

| Option | Description | Selected |
|--------|-------------|----------|
| None — all noise | Record all 4 keyword matches as reviewed-not-folded | ✓ |
| viz-search-and-hull-quality | Roadmap routes this to Phase 59 | |
| corpus-brain-3d-transition | Structural viz work, unrelated | |
| judge prompt-prefix caching | Engine work, not a stats surface | |

**User's choice:** None — all noise (same 4 that Phase 57 reviewed and didn't fold).

---

## Placement & Phase-59 ordering

The initial placement question (tabs-in-settings vs new panel vs takeover) was interrupted by
the founder to clarify: "i feel like either a new panel or full window takeover so should we
do 58/59 first". Claude confirmed Phase 59 redesigns exactly the chrome this phase adds to
(Liquid-Glass language, cmd-K palette), while Phase 58 never touches the settings surface.
Questions were reformulated around that.

| Option | Description | Selected |
|--------|-------------|----------|
| Yes — 59 before 60 | Upgrade soft dependency to hard; build in 59's language; 58 stays irrelevant | ✓ |
| Yes — and 58 too | Strict 58 → 59 → 60 order as deliberate rule | |
| No — 60 can go first | Build now in today's idiom, accept restyle | |

| Option | Description | Selected |
|--------|-------------|----------|
| Full-window takeover | Route-level surface like reader/corpus view; most room; cmd-K destination | ✓ |
| Dedicated stats panel | Side panel parallel to settings | |
| Decide during Phase 59 | Container-agnostic until 59 lands | |

| Option | Description | Selected |
|--------|-------------|----------|
| Replace with link | Settings panel keeps toggles; readout block → "View usage stats →" link | ✓ |
| Keep both | Compact readout + deep takeover | |
| Move settings in too | Fold settings panel into the takeover | |

| Option | Description | Selected |
|--------|-------------|----------|
| One scrolling page | Both dashboards in one scroll | |
| Two tabs | Usage \| Brain Health, full width each | ✓ |
| You decide | Planner picks | |

**Notes:** The founder's own instinct ("new panel or takeover, so 58/59 first?") drove the
sequencing lock; Claude's contribution was separating 58 (irrelevant) from 59 (real dependency).

---

## Chart rendering approach

| Option | Description | Selected |
|--------|-------------|----------|
| Hand-rolled SVG | In-repo SVG helpers; crisp, token-styleable, zero deps | ✓ |
| Canvas 2D | Blurry on zoom, manual hit-testing | |
| Vendor a micro-lib | Foreign code style | |

| Option | Description | Selected |
|--------|-------------|----------|
| Big numbers + real charts | Stat cards + proper charts (was Recommended) | |
| Numbers + sparklines only | Minimal | |
| Full analytics polish | Axes, tooltips, legends, time-range scrubbing | ✓ |

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, simple hover | Nearest-point date + value | ✓ |
| No — static charts | | |
| You decide | | |

| Option | Description | Selected |
|--------|-------------|----------|
| Reuse identity hues | Activity-kind series use Phase-57 hues; neutral ramp otherwise; amber off-limits | ✓ |
| Neutral chart ramp only | | |
| You decide | | |

**Notes:** Founder chose a higher polish tier (full analytics) than recommended — the
dashboards are a first-class surface, not a debug readout.

---

## Cost dashboard framing

| Option | Description | Selected |
|--------|-------------|----------|
| Stored total_cost_usd | Sum envelope-reported per-call figure; honest subscription label | ✓ |
| Tokens × pricing table | Needs price-map maintenance | |
| Both | Cross-check line | |

| Option | Description | Selected |
|--------|-------------|----------|
| Event-marker deltas | Dated markers (thinking-off flip, skip-threshold) + live before/after avg burn | ✓ |
| Period-over-period only | Generic 30d-vs-prior-30d | |
| Static annotation | Pasted A/B numbers | |

| Option | Description | Selected |
|--------|-------------|----------|
| 30d daily, selectable | Default 30d daily; 7d/30d/90d/all switcher; all-time weekly | ✓ |
| All-time by default | | |
| You decide | | |

| Option | Description | Selected |
|--------|-------------|----------|
| Constants in code | COST_EVENTS array in shared constants module | ✓ |
| settings.json | Would need whitelist extension | |
| Derived from ledger | Statistical change-point detection — overkill | |

---

## Brain-health scope & data

| Option | Description | Selected |
|--------|-------------|----------|
| From consolidation_event | Reconstruct creations from event log; zero schema change; labeled approximation | ✓ |
| Add created_at migration | v16 migration + backfill — heavy for a chart | |
| Daily stats snapshot table | New write path; no pre-ship history | |

| Option | Description | Selected |
|--------|-------------|----------|
| All six must-have | Growth, kind mix, recon+tombstones/day, judge activity, episode backlog, last sleep-pass | ✓ |
| Trim to core four | | |
| All six + extras | Oscillations, falsifications, merges as secondary breakdown | |

| Option | Description | Selected |
|--------|-------------|----------|
| On open + manual | Fetch on open + refresh button + "as of" timestamp | ✓ |
| Auto-refresh timer | | |
| Live via SSE | Couples dashboards to trace plumbing | |

---

## Claude's Discretion

- Endpoint shape (extend `/usage` vs new `/stats/*` routes) and prepared-statement design
- Per-feature vs per-model slicing presentation within the Usage tab
- SVG helper API, axis/tick formatting, time-range-scrubbing mechanics
- Empty-DB / sparse-ledger empty states
- Authoritative source for last sleep-pass time/duration/status
- Compact-popover (tray) behavior — expected full-window-only

## Deferred Ideas

- None new — scope stayed within the two dashboards. Four keyword-matched todos reviewed
  and not folded (see Todo Cross-Reference above).
