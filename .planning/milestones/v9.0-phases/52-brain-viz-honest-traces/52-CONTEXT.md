# Phase 52: Brain Viz Honest Traces - Context

**Gathered:** 2026-06-29
**Status:** Ready for planning

<domain>
## Phase Boundary

Presentation-layer rework of `recense viz` trace firing so the brain animation is honest to the engine across both recall and ingestion.

**In scope:**
- Drive the recall animation from the real scored 1-hop payload the server already emits (`engine.ts:316`): pass the full SSE row (`seeds` + `hops`) into `applyTrace`, render seeds amber / hops cyan, brightness ∝ score. **Delete** the client-side 4-hop BFS in `trace.js`.
- Demote `MAX_HOPS` / `TRACE_FANOUT` / `TRACE_MAX_EDGES` from content generators to defensive safety caps.
- Honest-core + decay-tail glow (attack → hold → exponential fade) replacing the flat linear decay.
- Bridge ingestion events (`new_node` / `reconsolidation` / `oscillation`) onto the same `activation_trace` SSE stream via a nullable row-level `kind` column; fire-and-forget, never perturbs consolidation.
- Per-event color/motion vocabulary; reconsolidation = hero magenta belief-update-in-place.

**Out of scope (hard):**
- No retrieval/consolidation logic, scoring, or graph-traversal changes.
- No new SSE channel, websocket, or transport change.
- No multi-hop retrieval — the engine is 1-hop; honor it.
- No new runtime dependencies.

</domain>

<decisions>
## Implementation Decisions

### Ingestion bridge scope
- **D-01:** The `kind`-tagged ingestion bridge fires on **both** paths. The synchronous `recense remember` path streams its events live (≈1 event per curated fact — no flood risk). The hourly **sleep pass reuses the EXISTING `lightConsolidatedNodes` cascade** (`run-sleep-pass.ts`, `CASCADE_MAX=24` / `CASCADE_GAP_MS=300`), upgraded to emit the new `kind` column so consolidated nodes render with the correct per-event colors. This is the unified, flood-safe path — do NOT build a second throttled stream.
- **D-02:** This closes a spec-vs-code gap: the design spec frames the bridge around the `remember` path only, but the same `unrelated`/`contradict_reconcile`/`contradict_oscillation` events also fire from the background sleep-pass consolidator at tens-to-low-hundreds per pass, which would overflow the 50-row ring buffer (`RING_CAP=50`). Reusing the already-capped `lightConsolidatedNodes` cascade is the resolution. **The bridge must NOT stream raw sleep-pass events into `activation_trace` unthrottled.**

### Cascade filter / what lights during the sleep pass
- **D-03:** Keep the cascade lighting **all** consolidated nodes (preserve current ambient-activity behavior — the theater being killed is the recall-path BFS, not the post-pass cascade). Color the **3 hero kinds** (`new_node` green, `reconsolidation` magenta, `oscillation` orange) per the spec's vocabulary; give every other consolidation event type (`confirm`, `extend`, `schema_emitted`, `entity_merge`, `fact_merge`, `contradict_hold`, etc.) a **muted neutral encoding color**.
- **D-04:** The neutral color for non-hero cascade events MUST NOT be amber — amber is reserved for retrieval seeds (palette lock from Phase 34: amber = activation/hover ONLY; muted rose/slate/mauve at rest). Planner picks a muted neutral that reads as "background consolidation" without competing with the amber/cyan recall vocabulary.

### Reconsolidation hero motion
- **D-05:** Build the **full choreography** for v1 (not a phased flash-only version): incoming evidence (`candidate_id`) gets a brief subordinate green "arriving" blip that travels/merges into the **existing/updated** node, which error-flashes magenta (`#ff3b6b`) then settles back to normal. **No duplicate node spawns.** This moment sells the core differentiator (prediction-error updates the belief in place) and is worth the extra motion code.

### Decay tail / intensity
- **D-06:** Accept the spec's proposed envelope — **~140ms attack / ~600ms hold / ~2.5s exponential fade with a low floor** — as named tunable constants in `src/viz/modules/constants.js`. Tune visually at the founder checkpoint; the numbers only matter against the rendered feel. Replaces the current flat `node.__act -= dt * 0.6` (~1.6s linear) decay in `trace.js:167`.
- **D-07:** Seed intensity ∝ real retrieval `score`; edge brightness ∝ `score × edge.w`. When `score` is `null` (schema-recall path, WR-02), use a fixed mid intensity — do NOT invent a magnitude. Magnitude from the consolidation event modulates flash intensity for ingestion kinds the way `score` modulates recall.

### Verification
- **D-08:** Verify via **structural unit test + founder visual checkpoint** (not visual-only). Automate what's machine-checkable so the honesty guarantee can't silently regress:
  - A recall payload with N hop edges → `applyTrace` lights **exactly N edges matching `row.hops`**, no client BFS.
  - A `remember` contradiction → magenta on the existing node + **zero duplicate nodes spawned** (assertable at the data/event layer).
  - Founder visual checkpoint covers color/motion/decay feel + the full reconsolidation choreography.

### Migration mechanics (follow existing idiom)
- **D-09:** The nullable `kind` column on `activation_trace` follows the **established additive-migration idiom** already in `src/db/schema.ts` (e.g. the v3 `cwd` add at `schema.ts:251-253`): add the column to the `CREATE TABLE IF NOT EXISTS` body (`schema.ts:108-114`) for fresh DBs, AND a `PRAGMA table_info`-guarded `ALTER TABLE ... ADD COLUMN` for existing DBs. Nullable → no DEFAULT needed. Recall rows are `kind='recall'` or `NULL` (treated as recall for back-compat). Additive and reversible. Update the prepared INSERT in `activation-sink.ts:84-86` to carry `kind`.

### Claude's Discretion
- Exact neutral hex for non-hero cascade events (within D-04 constraint).
- Easing curves / interpolation for the decay envelope and the arriving-blip travel path.
- Whether the ingestion bridge lives in a new small adapter alongside `remember-cli.ts` / `ambient-recall.ts` or extends an existing module — follow the `SwitchableActivationTraceSink` gating pattern either way.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase contract (primary — read first)
- `docs/superpowers/specs/2026-06-29-brain-viz-honest-traces-design.md` — **the approved design contract.** Root-cause analysis, the full design (recall payload drive, decay tail, ingestion bridge, palette + motion vocabulary table), out-of-scope boundary, and success criteria. This phase has no REQUIREMENTS.md entry — this spec IS the requirements.

### Recall trace source-of-truth (server already emits the real payload)
- `src/retrieval/engine.ts:298-320` — main retrieval path; emits `activation_trace` at line 316. `seeds` = top-`SEED_K`(10) by base score; `hops` = real 1-hop spreading-activation neighbors tagged `hop:1` with real `score`.
- `src/recall/index.ts:514-527` — schema-resolution recall path; emits at 523, `hops` tagged `hop:1`, `score:null` (WR-02 refuses to fabricate a magnitude → D-07 mid-intensity fallback).

### Client trace plumbing (where the dishonesty lives)
- `src/viz/modules/hud.js:152` — SSE listener; currently calls `applyTrace(row.seeds || [])`, **discarding `row.hops`**. Fix: pass the full row.
- `src/viz/modules/trace.js:242-338` — `applyTrace(seedIds)` runs the client BFS over `ctx.adj` (260-289) up to `MAX_HOPS=4`. **Delete the BFS;** rewrite to animate server `hops`. Flat decay at `trace.js:167` → replace with D-06 envelope.
- `src/viz/modules/constants.js` — `MAX_HOPS`(186), `TRACE_FANOUT`(192), `TRACE_MAX_EDGES`(195) → demote to caps; add decay-tail constants + palette entries.

### Ingestion bridge (schema, sink, gating, throttle)
- `src/db/schema.ts:108-114` — `activation_trace` CREATE TABLE (columns: id, ts, query_id, seeds, hops). `schema.ts:251-253` — the additive-column ALTER idiom to mirror (D-09). `schema.ts:262-265` — v4 migration note.
- `src/viz/activation-sink.ts` — `RING_CAP=50`(33), prepared INSERT(84-86), ring-evict DELETE(88-103); `SwitchableActivationTraceSink` gating on `viz_trace_enabled`(130-163), `NoopActivationTraceSink`(110-115) fail-closed default.
- `src/viz/server.ts:60,368-411` — `POLL_MS=250`, read-only handle(180), monotonic cursor(379), SSE `trace` event(402-411). Rows polled once per process, physically evicted by writer at 51st row.
- `src/adapter/remember-cli.ts:235,260,303,337,364` — synchronous `remember` emits `unrelated`/`contradict_reconcile`/`contradict_oscillation` to the ConsolidationSink (NOT activation_trace today).
- `src/consolidation/consolidator.ts:1142,1166-1174,1221-1229,1250-1258,1416` — the SAME events fire from the background sleep pass (the flood source, D-02). `src/consolidation/sink.ts:53-65` — 12-event-type enum.
- `src/adapter/run-sleep-pass.ts:56-111` — **`lightConsolidatedNodes`**: existing post-pass replay of consolidation events into `activation_trace`, capped `CASCADE_MAX=24`, spaced `CASCADE_GAP_MS=300`. This is the function D-01 upgrades to carry `kind`.
- `src/adapter/ambient-recall.ts:115-131` — the `SwitchableActivationTraceSink` wiring the bridge mirrors.

### Project guards (load-bearing)
- `CLAUDE.md` (project) — palette lock (amber=activation/hover ONLY); `[keep]` Consolidator-is-sole-graph-writer guard (emits MUST be fire-and-forget, try/catch, never affect consolidation, mirror engine emit guard T-10-05).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `SwitchableActivationTraceSink` / `NoopActivationTraceSink` (`activation-sink.ts`): the exact gating-on-`viz_trace_enabled` + zero-cost-Noop-default pattern the ingestion bridge mirrors. No new transport needed.
- `lightConsolidatedNodes` (`run-sleep-pass.ts`): already bridges consolidation→`activation_trace` with a throttle — extend it for `kind` rather than building new (D-01).
- The additive-column ALTER idiom in `schema.ts` (v3 `cwd`): copy for the `kind` column (D-09).

### Established Patterns
- `activation_trace` is a persistent 50-row ring buffer (writer evicts at 51st row; server cursor-advances, never deletes). Any high-volume producer MUST self-throttle below POLL_MS=250 or rows get evicted unread — the reason D-01 reuses the existing cap instead of streaming raw.
- Recall rows carry both `seeds` and `hops` in one row; `kind` is row-level, not element-level (one recall row → seeds amber + hops cyan rendered client-side).

### Integration Points
- SSE `trace` event in `server.ts` → add `kind` to the `/events` payload `data`.
- `hud.js` SSE listener → `trace.js applyTrace` → branch on `row.kind` for color + motion.
- Ingestion bridge → `activation_trace` sink under the `viz_trace_enabled` flag.

</code_context>

<specifics>
## Specific Ideas

- Palette (from spec, founder-aligned): amber `#ffb866` retrieval-seed, cyan `#66d9ff` 1-hop association (subordinate/thinner/dimmer), green `#66ff99` new_node encoding, magenta `#ff3b6b` reconsolidation hero, orange `#ff7a1a` oscillation instability. Non-hero cascade events = muted neutral (planner's pick, non-amber).
- Reconsolidation hero is the signature moment — green evidence arrives, merges into the existing node, magenta error-flash, settles, no duplicate. Build it fully (D-05).
- Honesty is the through-line: every pulse true to an edge/node the engine actually touched. The structural test (D-08) is the regression guard for that promise.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within the spec's presentation-layer scope. No engine/scoring/traversal changes were entertained (out-of-scope boundary held).

</deferred>

---

*Phase: 52-brain-viz-honest-traces*
*Context gathered: 2026-06-29*
