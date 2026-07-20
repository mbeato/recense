# Phase 60: Settings Stats Depth — usage + brain-health - Context

**Gathered:** 2026-07-04
**Status:** Ready for planning

<domain>
## Phase Boundary

The settings surface grows two real dashboards replacing the bare Phase-44 usage readout:

1. **Cost/usage dashboard** — daily token burn, per-feature split (extract/judge/corpus_gen/
   schema_abstract), per-model split, retail-$ equivalent, and before/after savings framing —
   all queried from `token_usage_ledger` (the 2026-07 thinking-off analysis rendered live
   instead of hand-queried).
2. **Brain-health dashboard** — node growth over time, kind mix (facts/schemas/entities/docs/
   insights), reconsolidations + tombstones per day, judge activity (fires, escalation rate),
   episodes pending vs consolidated, last sleep-pass time/duration/status.

**Hard constraints:** LLM-free queries only (online-path invariant); viz server keeps its
read-only DB handle; net-zero new runtime dependencies; loopback bind + existing security
guards (DNS-rebinding 403, textContent-only rendering) extend to new routes/views.

**Sequencing (locked this discussion):** Phase 59 (HUD Integration) runs BEFORE Phase 60 —
upgraded from the roadmap's soft dependency to a hard one. The dashboards are built in
Phase 59's panel/HUD design language and reached through its navigation (e.g. the cmd-K
palette). Phase 58 remains irrelevant to this phase.

**Out of scope:** engine/consolidation changes; new write paths into the DB (dashboard is
read-only); real-time/SSE data coupling; any change to what the ledger or event log records.

</domain>

<decisions>
## Implementation Decisions

### Placement & navigation
- **D-01: Phase 59 before Phase 60 — hard dependency.** The dashboards render in 59's
  Liquid-Glass panel language and are reached via its navigation. Do not build in the
  pre-59 panel idiom.
- **D-02: Full-window takeover surface.** Like the reader/corpus view: a route-level stats
  surface that replaces the graph while open. Not a side panel — charts need the room.
- **D-03: Two tabs inside the takeover** — Usage | Brain Health — each getting full width.
- **D-04: Settings panel readout replaced by a link.** The Phase-44 panel keeps its
  cost-control toggles; the 30d/all-time number block is removed and replaced by a
  "View usage stats →" jump into the takeover. One source of truth for numbers.

### Chart rendering
- **D-05: Hand-rolled SVG chart helpers.** Small in-repo helpers emitting inline SVG
  (bars, lines, sparklines) — no chart library, no vendored code (net-zero deps). Styleable
  via the design-token CSS; dynamic values rendered textContent-safe per T-44-19 discipline.
- **D-06: Full analytics polish.** Axes, hover tooltips, legends, and time-range scrubbing —
  the founder explicitly chose the highest polish tier over big-numbers+charts.
- **D-07: Simple nearest-point hover** showing date + value on every over-time chart.
- **D-08: Chart series colors reuse Phase-57 identity hues** where a series IS an activity
  kind (reconsolidations/day → magenta, new nodes → ingestion green, etc.), sourced from the
  shared constants module. Non-activity series (tokens, models, features) get a neutral
  desaturated ramp in the aubergine family. **Amber stays exclusive to live activation**
  (Phase 57 D-03(b)) — no amber-family hue anywhere in the dashboards.

### Cost dashboard framing
- **D-09: Retail-$ = summed stored `total_cost_usd`.** Use the envelope-reported per-call
  figure already in the ledger; no per-model pricing table to maintain. Label honestly:
  "API-retail equivalent (subscription-billed: $0 marginal)". Tokens are the primary
  headline; $ is the translation (per the project's subscription cost-model constraint).
- **D-10: Before/after savings = live event-marker deltas.** The burn-over-time chart
  carries dated markers for known cost events (MAX_THINKING_TOKENS=0 flip 2026-07-03,
  Phase-42 consolSkipThreshold) and computes avg daily burn before vs after each marker
  live from the ledger — the "rendered live instead of hand-queried" requirement.
- **D-11: COST_EVENTS lives as a constants array in code** (date + label) in the shared
  constants module, beside the other founder-tuned values. New events = one-line change.
- **D-12: Default window = last 30 days, daily buckets,** with a range switcher
  (7d / 30d / 90d / all-time); all-time renders in weekly buckets to stay readable.

### Brain-health scope & data
- **D-13: Node growth derived from `consolidation_event`.** Reconstruct node creations from
  the existing event log (ts + node_id per birth event) with pure SQL — zero schema change,
  no new write path. Where old events were pruned, the chart labels the approximation.
- **D-14: All six roadmap metric groups are must-have:** node growth, kind mix,
  reconsolidations + tombstones per day, judge activity (fires + escalation rate), episodes
  pending vs consolidated, last sleep-pass time/duration/status. Escalation rate comes from
  the ledger's `model` column on `feature_tag='judge'` rows (share on Sonnet).
- **D-15: Refresh = on open + manual refresh button,** with an "as of" timestamp. Simple
  request/response endpoints; no SSE coupling, no auto-refresh timer.

### Claude's Discretion
- Endpoint shape (extend `GET /usage` vs new `/stats/*` routes) and prepared-statement
  design — mirror the existing 44-05 patterns.
- Per-feature vs per-model slicing presentation within the Usage tab (stacked vs
  side-by-side charts).
- Exact SVG helper API, axis/tick formatting, and time-range-scrubbing mechanics.
- Empty-DB / sparse-ledger empty states (fresh installs must not render broken charts).
- Source for last sleep-pass time/duration/status (meta table / consolidation checkpoint /
  event log — researcher to locate the authoritative record).
- Compact-popover (tray) behavior: dashboards are expected to be full-window-only; verify
  nothing leaks into the compact LOD.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase contract & sequencing
- `.planning/ROADMAP.md` (Phase 60 entry) — goal, the two dashboard definitions, LLM-free
  constraint, "no research gate" note.
- `.planning/ROADMAP.md` (Phase 59 entry) — the HUD design language (Liquid-Glass panels,
  edge-docked rails, cmd-K palette, constants.js token discipline for HUD CSS) that this
  phase's surfaces MUST be built in (D-01). Phase 59's outputs become canonical refs for
  Phase 60 planning once 59 lands.

### Existing substrate to extend (Phase 44)
- `src/viz/server.ts:413-440` — `/usage` prepared statements (30d + all-time by
  feature_tag) — the query pattern new stats endpoints mirror (read-only handle, compiled
  once, T-44-18).
- `src/viz/server.ts:1264-1305` — `GET /usage` handler — response-shape and error-handling
  precedent (empty ledger → zeroed aggregates, not error).
- `src/viz/server.ts:1141+` — `GET/POST /settings` (44-05, D-03) — key-whitelist and
  security-guard patterns (T-44-15/16) that new routes inherit.
- `src/viz/modules/settings.js` — the Phase-44 panel this phase modifies (D-04 link
  replacement); T-44-19 textContent-only discipline for all server-sourced values.

### Data sources (schema)
- `src/db/schema.ts:182-192` — `token_usage_ledger` (ts, feature_tag, model, 4 token
  columns, total_cost_usd) — sole source for the Usage tab.
- `src/db/schema.ts:90-102` — `consolidation_event` — source for node growth (D-13),
  reconsolidations/tombstones/day, and judge-outcome activity. Known event_types in code:
  confirm, extend, unrelated, contradict_hold, contradict_reconcile, contradict_append_new,
  contradict_force_destabilize, contradict_oscillation, entity_merge, fact_merge,
  schema_emitted, schema_falsified.
- `src/db/schema.ts:39-65` — `node` (type CHECK gives the kind-mix categories; **no
  created_at** — growth must derive per D-13) and `edge`.
- `src/db/schema.ts:23-38` — `episode.consolidated` flag — pending-vs-consolidated backlog.

### Design-language locks (Phase 57)
- `src/viz/modules/constants.js` — TYPE_COLOR / BG_COLOR / palette locks; the Phase-57
  shared constants module where identity hues (D-08) and COST_EVENTS (D-11) live.
- `.planning/phases/57-viz-activity-palette-redesign/57-CONTEXT.md` — amber-exclusivity
  (D-03(b)) and identity-hue rationale the chart palette must respect.

### Project guards (load-bearing)
- `CLAUDE.md` (project) — online paths LLM-free; viz server read-only; graph is source of
  truth; net-zero new runtime deps; subscription cost model (tokens primary, retail-$ as
  translation).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- Phase-44 `/usage` + `/settings` routes and `settings.js` panel: open/close plumbing,
  non-fatal fetch pattern, prepared-statement style, and the whole security posture
  (loopback 403 guard, textContent-only) transfer directly to the new endpoints/views.
- The reader/corpus view is the working precedent for a full-window route-level takeover
  (D-02) — reuse its show/hide + documentElement-class pattern.
- `token_usage_ledger.total_cost_usd` is already populated per call by the claude-headless
  transport — retail-$ (D-09) is a SUM, not a computation.
- Phase-57's shared constants module is the single home for identity hues (D-08) and the
  new COST_EVENTS array (D-11).

### Established Patterns
- Viz server compiles prepared statements once at startup on a read-only handle; new stats
  queries follow that shape.
- Feature toggles map 1:1 to ledger feature_tags (Phase 44 D-09) — the per-feature burn
  split inherits that vocabulary (extract/judge/corpus_gen/schema_abstract).
- All founder-facing visual tuning happens on the live install; Phase 59's conventions
  will govern panel chrome, so Phase 60 plans should treat visual specifics as
  59-conventions-dependent.

### Integration Points
- New stats routes join `src/viz/server.ts` beside `/usage` (same guards).
- The takeover view joins `src/viz/modules/` as a new module wired in `index.js`/`app.js`
  like reader.js; entry point comes from Phase 59's navigation (cmd-K palette).
- `settings.js` gets the D-04 link edit (readout block removed).

</code_context>

<specifics>
## Specific Ideas

- The Usage tab is the 2026-07 thinking-off A/B analysis made permanent: dated event
  markers on the daily-burn chart with live before/after avg-burn deltas — the founder
  should never have to hand-query the ledger to see whether a cost lever worked (D-10).
- Dashboards speak the brain's own color language: a reconsolidation series is magenta
  because reconsolidation IS magenta in the viz (D-08).
- Honest labeling carries through: retail-$ is an "equivalent, subscription-billed $0
  marginal" framing, and derived node-growth history discloses its approximation (D-09/D-13
  — same no-inflated-metrics posture as the README benchmarks).

</specifics>

<deferred>
## Deferred Ideas

- None new from this discussion — scope stayed within the two dashboards.

### Reviewed Todos (not folded)
- `viz-search-and-hull-quality.md` — hull quality + in-app search: routed to Phase 59 by
  the roadmap; not stats work.
- `corpus-brain-3d-transition.md` — corpus↔brain camera fly-through: structural viz work,
  unrelated to dashboards.
- `2026-06-23-cache-constant-judge-extraction-prompt-prefix-via-system-pro.md` — engine-side
  token optimization; thematically adjacent to the cost dashboard but engine work, stays
  pending.
- `content-hardening-deferred.md` — engine-side hardening; keyword-match noise for this
  phase.

</deferred>

---

*Phase: 60-settings-stats-depth*
*Context gathered: 2026-07-04*
