# Phase 54: Viz Ambient Liveliness and Replay Traces — Research

**Researched:** 2026-06-30
**Domain:** recense viz presentation layer — Three.js animation, Node.js SSE server
**Confidence:** HIGH — all findings verified against live source code

---

## Summary

Phase 54 adds three layers of ambient activity to `recense viz` without touching the engine,
retrieval logic, or data model. The APPROVED design contract
(`docs/superpowers/specs/2026-06-30-viz-ambient-liveliness-replay-traces-design.md`) is the
source of truth; this document grounds it in the live code so the planner can write precise,
low-risk tasks.

The three files in scope are `src/viz/modules/trace.js`, `src/viz/server.ts`, and
`src/viz/modules/constants.js`. The test harness (vitest, browser-ESM imports with a
THREE mock) is the same as Phase 52/53. All integration points have been read at exact
line numbers.

**Primary recommendation:** Implement in wave order — constants first (Wave 0), then
Layer 1 (amplification), Layer 2 (replay), Layer 3 (twinkle) — so each layer is
independently verifiable and the honesty invariant can be tested after each wave.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Live recall amplification | Browser / Client (trace.js) | — | Per-frame render is client-side; scale/color constants tuned at checkpoint |
| Replay echo scheduling | API / Backend (server.ts) | Browser / Client (trace.js) | Server decides when/what to replay; client renders the softer echo |
| Ambient twinkle | Browser / Client (trace.js) | — | Per-frame tick registered in master rAF loop; purely decorative |
| New tunable constants | Browser / Client (constants.js) | — | Single source of truth shared across modules |

---

## Project Constraints (from CLAUDE.md)

- **Tech stack:** TypeScript engine; viz is browser ESM (plain JS modules, Three.js from
  CDN/vendor, `import * as THREE from 'three'`).
- **Faithfulness rule governs ENGINE only:** viz presentation layer is explicitly allowed
  decorative chrome. The load-bearing invariant here is **honesty** (no fabricated
  edges/activity) not neuro-faithfulness.
- **Viz server stays read-only:** `new Database(dbPath, { readonly: true })` — never a
  write-enabled handle. This is a hard invariant (T-10-08, T-27-11).
- **Online paths stay LLM-free:** no embed/LLM/provider in the viz server or render path.
- **Net-zero new runtime dependencies:** no new npm packages; Three.js and better-sqlite3
  are already present.
- **Phase 52 honest-traces invariant must not regress:** pulses/halos on real hops only;
  no fabricated edges; replay reuses real hops; twinkle fabricates no edges.
- **Phase 53 layout untouched:** Halton seed, locked anchors, BRAIN_SCALE=460 — not in scope.

---

## Layer 1 — Live Recall Amplification: Exact Integration Points

### Regular (non-instanced) node render path — `trace.js` lines 399–402 [VERIFIED: live source]

```javascript
// trace.js lines 399-402 (inside tick() → for (const node of [...active]))
const a = Math.max(0, node.__act) * (node.__actGain || 1);
if (node.__base) node.__mat.color.copy(node.__base).lerp(node.__actColor || HOT_COLOR, a * 0.8);
node.__mat.opacity = Math.min(1, (node.__baseOp || 0.85) + a * 0.4);
node.__mesh.scale.setScalar((node.__baseR || 1) * (1 + a * 0.35));
```

The spec change is the scale multiplier: `1 + a * 0.35` → `1 + a * ACT_SCALE_GAIN`. The
spec also adds a brightness gain (`a * 0.4` opacity → `a * ACT_BRIGHTEN_GAIN`).

`__actGain` is pre-set by `graph.js` line 148 at node init:
`node.__actGain = node.__cat === 'schema' ? 1.2 : 1.0;`
So schemas already pulse 1.2× brighter; the new gain multiplies on top.

### Haze (InstancedMesh) color-only path — `trace.js` lines 362–367 [VERIFIED: live source]

```javascript
// trace.js lines 362-367 (inside tick() haze branch)
const a = Math.max(0, node.__act);
const activationColor = node.__hazeBase.clone().lerp(node.__actColor || HOT_COLOR, a * 0.8);
ctx.hazeMesh.setColorAt(node.__hazeIdx, activationColor);
ctx.hazeMesh.instanceColor.needsUpdate = true;
```

**Perf invariant confirmed:** `setColorAt` only; `setMatrixAt` is never called in this
branch. The InstancedMesh matrix buffer stays untouched. The spec says strengthen color
lerp (`a * 0.8` → higher). No size change, no `setMatrixAt` — this invariant is
structural (the haze hover/reveal code confirms it is in `graph.js` separately).

### Decay envelope constants — `constants.js` lines 115–129 [VERIFIED: live source]

```javascript
export const DECAY_ATTACK_MS = 140;  // fast ramp (ms)
export const DECAY_HOLD_MS   = 600;  // peak hold (ms)
export const DECAY_FADE_MS   = 2500; // exponential fade (ms)
export const DECAY_FLOOR     = 0.04; // floor fraction at tail end
```

`evalEnvelope(now, t0, peak)` in `trace.js` lines 186–206 implements: linear attack →
hold → exponential fade (`Math.exp(-ratio * 4)`, k=4, gives ~0.018 at the tail).
The spec allows shortening `DECAY_ATTACK_MS` for a snappier pop; this is just a
constant change.

### Halo spawn — `trace.js` lines 261–300 [VERIFIED: live source]

Halos are spawned from `activate()` unconditionally before the `__mat/__hazeIdx`
guard. They live in `ctx.pulseGroup`. A replay branch can suppress halos or spawn
a dimmer one by passing a scaled `level` parameter to `activate()`.

---

## Layer 2 — Replay Echo: Exact Integration Points

### SSE `/events` handler — `server.ts` lines 538–548 [VERIFIED: live source]

```typescript
if (url === '/events') {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
  });
  res.write('retry: 2000\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
  return;
}
```

`clients` is a `Set<http.ServerResponse>` at module scope inside `startVizServer`.

### Live polling interval — `server.ts` lines 384–419 [VERIFIED: live source]

```typescript
const pollInterval = setInterval(() => {
  if (clients.size === 0) return;
  const fresh = stmtTrace.all(cursor) as Array<{...}>;
  if (!fresh.length) return;
  cursor = fresh[fresh.length - 1]!.id;  // cursor only moves FORWARD
  for (const row of fresh) {
    // ... parse seeds/hops ...
    const payload = `event: trace\ndata: ${JSON.stringify({...})}\n\n`;
    for (const res of clients) { res.write(payload); }
  }
}, POLL_MS);  // POLL_MS = 250ms
```

### Cursor initialization — `server.ts` line 381 [VERIFIED: live source]

```typescript
let cursor = (db.prepare(
  'SELECT COALESCE(MAX(id), 0) AS m FROM activation_trace'
).get() as { m: number }).m;
```

`cursor` starts at the current max id so historical rows are NOT replayed on first
connect (WR-01 invariant). It is a closure-local variable; only `pollInterval`
writes it.

### T-10-11 cursor invariant confirmed [VERIFIED: live source]

The replay scheduler MUST NOT move `cursor` backward. The correct implementation
is a **side-channel**: maintain a separate `replayBuffer` (ring of the last
`REPLAY_HISTORY_N` rows populated by the live poll) and a separate idle timer.
The replay scheduler reads from `replayBuffer`; it never touches `cursor`.

### Read-only boundary confirmed — `server.ts` line 180 [VERIFIED: live source]

```typescript
const db = new Database(dbPath, { readonly: true });
```

This is the only `new Database()` call in the file. The replay scheduler has
access to `db` and `stmtTrace` (compiled once at init, line 370). It can
re-query recent rows directly via `db.prepare('SELECT ... WHERE id > ? ORDER BY id DESC LIMIT ?').all(...)` using a separate prepared statement — or use the `replayBuffer` populated by the live poll.

**Recommended implementation:** populate `replayBuffer` inside the live
`pollInterval` callback (when new rows arrive, push to buffer and trim to
`REPLAY_HISTORY_N`). The replay `setInterval` reads from this in-memory buffer —
zero extra DB reads.

### `applyTrace(row)` slot for `row.replay === true` — `trace.js` lines 510–592 [VERIFIED: live source]

```javascript
function applyTrace(row) {
  if (Array.isArray(row)) { row = { seeds: row, hops: [] }; }

  const kind = row.kind ?? null;
  if (kind && kind !== 'recall') {
    _applyIngestion(row, kind);
    return;
  }
  // ... recall path follows ...
}
```

The `row.replay` branch slots in **before** the kind dispatch, right after the
back-compat guard. The replay path calls `activate(node, intensity * REPLAY_DIM)`
with the same seeds/hops but reduced intensity, and conditionally skips halo spawn
(pass `null` as `kindColor` or a dimmed color; or skip the `pulseGroup` halo by
passing a level below the halo-spawn threshold — actually the halo is always
spawned from `activate()`, so the cleanest approach is to not call `activate()`
for replay-only nodes and instead call a reduced inner path, OR pass a level ×
`REPLAY_DIM` which naturally produces a dimmer halo).

**Simpler approach confirmed:** calling `activate(node, level * REPLAY_DIM)` is
sufficient because the halo intensity is `h.level` (set from the `level` param).
The halo will be proportionally dimmer. No structural change to halo spawn needed.

---

## Layer 3 — Ambient Twinkle: Exact Integration Points

### Master rAF loop — `stats.js` lines 219–266 [VERIFIED: live source]

**CRITICAL FINDING — the spec's flagged integration risk is RESOLVED:**

The master loop **does NOT sleep when idle.** When idle (`ctx.isIdle()` returns
true) and no animation deadline (`performance.now() >= animUntil`), it fires at
`~IDLE_FPS` (24 fps) via `setTimeout(..., delay) + requestAnimationFrame(frame)`.
The loop only stops when `document.visibilityState === 'hidden'` (tab not visible).

```javascript
// stats.js lines 223-233
function scheduleFrame() {
  if (!loopRunning) return;
  if (ctx.isIdle() && performance.now() >= animUntil) {
    // Throttle to ~IDLE_FPS — still runs, just throttled
    const delay = Math.max(0, 1000 / IDLE_FPS - (performance.now() - lastFrame));
    setTimeout(() => { if (loopRunning) requestAnimationFrame(frame); }, delay);
  } else {
    requestAnimationFrame(frame);
  }
}
```

**No keep-alive is needed.** Twinkle registers a tick via `ctx.registerTick(fn)` (same
pattern as the existing trace tick) and it will be called at 24 fps when idle, 60 fps
when active. The spec's "confirm or add a low-rate keep-alive" check is: **confirm only,
no addition needed.**

### `ctx.registerTick` — `stats.js` line 45 [VERIFIED: live source]

```javascript
ctx.registerTick = fn => { callbacks.push(fn); };
```

`callbacks` is an array of functions; all are called each frame in `frame()` lines
244–253, wrapped in try/catch that surfaces errors once per unique message (D-14).

### Node bucketing for twinkle subset — `lod.js` (runtime `__cat` field) [VERIFIED: live source]

```javascript
// lod.js line 83 (initLod, classification):
n.__cat = 'haze';      // default — everything not schema or member
// n.__cat = 'schema'; // schema super-nodes
// n.__cat = 'member'; // member nodes (hidden until drill-in)
```

Haze nodes (all with `__hazeIdx != null`) form the bulk of the visible cloud at
overview zoom. The twinkle subset should be selected from `ctx.allNodes` filtered
to `n.__cat === 'haze' && n.__hazeIdx != null` (or from `ctx.hazeMesh`-addressable
nodes). For non-haze schema nodes, twinkle via `n.__mat` (the regular path). But
given the spec says "weighted toward haze so the whole brain shimmers," haze-only
is the simpler first implementation; schema twinkle can be added trivially.

**Bounded cost:** twinkle touches only `TWINKLE_COUNT` nodes per frame
(≈ 0.5–1% of `~15k` = 75–150 nodes max), each via `ctx.hazeMesh.setColorAt` +
one `instanceColor.needsUpdate = true`. This is the same call path as live
activation decay — confirmed safe.

---

## Constants Export Pattern — `constants.js` [VERIFIED: live source]

All constants use:
```javascript
export const CONSTANT_NAME = value;  // JSDoc comment above
```

No namespacing, no `default` export, no object grouping. New tunables must match
this pattern exactly. Existing export set:

- Palette: `TYPE_COLOR`, `BG_COLOR`, `TOMBSTONE_COLOR`, `HOT`, `KIND_COLOR`
- Decay: `DECAY_ATTACK_MS` (140), `DECAY_HOLD_MS` (600), `DECAY_FADE_MS` (2500), `DECAY_FLOOR` (0.04)
- Sizing: `MAX_FAN_OUT`, `nodeRelSize`, `HOVER_SCALE`, `BRAIN_SCALE` (460), `CONTAIN_STRENGTH`
- Density: `DENSITY_FILL_BELOW`, `DENSITY_FILL_TARGET`, `DENSITY_THIN_START`, `DENSITY_THIN_FULL`, `HAZE_DENSE_SCALE`, `OVERVIEW_NODE_CAP`
- Settle: `SETTLE_BUDGET_MS`
- Hull: `HULL_ROT_X`, `HULL_ROT_Y`, `HULL_ROT_Z`
- Trace (defensive caps only): `MAX_HOPS`, `HOP_MS`, `TRACE_FANOUT`, `TRACE_MAX_EDGES`, `PULSE_MS`
- FPS: `IDLE_FPS` (24), `FULL_FPS` (60), `DEGRADE_FPS` (45)

**New constants for Phase 54:**

```javascript
// Layer 1 — live recall amplification
export const ACT_SCALE_GAIN    = 0.9;   // tune at checkpoint (spec: 0.8–1.0)
export const ACT_BRIGHTEN_GAIN = 0.55;  // opacity boost (spec: raise from 0.4)
export const ACT_HAZE_LERP     = 0.95;  // haze color lerp factor (spec: raise from 0.8)

// Layer 2 — replay echo
export const REPLAY_IDLE_GAP_MS  = 5000; // ms of no new rows before replay starts (spec: 4000–6000)
export const REPLAY_CADENCE_MS   = 4000; // ms between replay broadcasts (spec: 3000–5000)
export const REPLAY_DIM          = 0.5;  // intensity multiplier vs. live (spec: 0.4–0.6)
export const REPLAY_HISTORY_N    = 20;   // recent rows to keep in replay buffer

// Layer 3 — ambient twinkle
export const TWINKLE_COUNT      = 80;    // nodes in the rotating twinkle subset (~0.5% of 15k)
export const TWINKLE_PERIOD_MS  = 2000;  // sine breathe period (spec: 1500–2500)
export const TWINKLE_AMP        = 0.15;  // brightness amplitude (spec: 0.12–0.18)
```

All starting values are spec midpoints; founder tunes at checkpoint.

---

## Architecture Patterns

### System Architecture Diagram

```
SSE /events (server.ts)
  │
  ├── live poll (setInterval 250ms)
  │     ├── reads activation_trace WHERE id > cursor (read-only DB)
  │     ├── updates cursor (forward only, T-10-11)
  │     ├── populates replayBuffer (ring, REPLAY_HISTORY_N rows)
  │     └── broadcasts to SSE clients → hud.js → applyTrace(row)
  │
  └── idle replay (setInterval, REPLAY_CADENCE_MS)
        ├── triggered only when (now - lastLiveRow) > REPLAY_IDLE_GAP_MS
        ├── picks row from replayBuffer (weighted toward recency)
        ├── broadcasts row WITH replay:true flag to SSE clients
        └── → applyTrace({...row, replay:true}) → dimmed render

trace.js (client):
  applyTrace(row)
    ├── [row.replay === true] → activate seeds/hops at level * REPLAY_DIM, no extra halos
    ├── [kind === ingestion]  → _applyIngestion (unchanged)
    └── [recall path]        → seeds + real hops (unchanged, Phase 52)

  twinkleTick (ctx.registerTick):
    ├── rotate subset of haze nodes (TWINKLE_COUNT, weighted toward haze)
    ├── per-node: sin brightness breathe over TWINKLE_PERIOD_MS, amp TWINKLE_AMP
    ├── neutral/cool tint only (never HOT amber, never KIND_COLOR palette)
    └── only setColorAt (never setMatrixAt); one instanceColor.needsUpdate per tick
```

### Recommended Project Structure

No new files/directories needed. Phase 54 touches only:

```
src/viz/
├── modules/
│   ├── constants.js     — add 10 new exported constants
│   └── trace.js         — amplify Layer 1; add row.replay branch; add twinkleTick
└── server.ts            — add idle-replay scheduler (replayBuffer + setInterval)
tests/
└── viz-ambient-liveliness.test.ts  — new test file for Phase 54 guards
```

### Anti-Patterns to Avoid

- **Replay moving the cursor backward:** The `cursor` variable in server.ts is
  forward-only. Replay picks from `replayBuffer` — it NEVER calls
  `stmtTrace.all(cursor - N)` or modifies `cursor`.
- **Twinkle using the HOT/KIND_COLOR palette:** The twinkle is decoration; it must
  use a neutral/cool tint that reads as ambient, not as an event (no amber, no
  magenta, no cyan).
- **`setMatrixAt` in haze twinkle/replay paths:** Only `setColorAt` touches haze
  nodes in the tick — the matrix buffer staying untouched is the perf invariant.
- **replay escalating above live:** `activate(node, level * REPLAY_DIM)` must never
  produce a higher level than `activate(node, level)`. `REPLAY_DIM` is always < 1.
- **Twinkle fabricating edges or halos:** No `spawnPulse`, no halo, no `ctx.revealTrace`
  calls from the twinkle tick. Pure color breathe only.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Sine oscillator for twinkle | Custom stateful oscillator | `Math.sin(now / TWINKLE_PERIOD_MS * 2 * Math.PI)` | One line, stateless, correct |
| Per-node twinkle phase offset | Separate per-node timer | `Math.sin((now + node.__hazeIdx * offset) / ...)` | Hash the instance index for visual spread |
| Idle detection on server | Custom event tracker | Reuse `cursor` last-update timestamp inside `pollInterval` | Already tracking new-row arrival |
| Replay buffer | Separate DB query | In-memory push to `replayBuffer[]` inside live poll | Zero extra DB reads |
| Weighted-random selection | Custom sampling | `replayBuffer[Math.floor(Math.random() * Math.min(replayBuffer.length, REPLAY_HISTORY_N))]` | Simple, sufficient |

---

## Common Pitfalls

### Pitfall 1: Replay broadcasts while live event is in-flight

**What goes wrong:** A real row arrives during a replay interval. The client sees a
dimmed replay echo immediately followed by the same row at full live intensity — the
contrast is confusing.

**Why it happens:** The replay `setInterval` fires on its own cadence; the live poll
fires on its own cadence. They can collide within the same 250ms window.

**How to avoid:** In the live poll, when a new row arrives, reset the idle timer
(`lastLiveRow = Date.now()`). In the replay scheduler, check `Date.now() - lastLiveRow
< REPLAY_IDLE_GAP_MS` before broadcasting. Since `pollInterval` runs at 250ms and
`REPLAY_CADENCE_MS` is 3000–5000ms, a race is very unlikely but must be guarded.

**Warning signs:** Founder sees a dim flash immediately followed by a bright flash for
the same nodes.

---

### Pitfall 2: Twinkle subset rebuilding per-frame vs. lazy rotation

**What goes wrong:** Rebuilding the twinkle subset on every tick by filtering
`ctx.allNodes` for `__cat === 'haze'` is O(N) per frame (~15k nodes). At 24fps idle
this is acceptable but wasteful.

**Why it happens:** Naively selecting from all nodes each frame.

**How to avoid:** Build the twinkle subset once at `initTrace` time (after `ctx.allNodes`
is populated) and rotate through it with a pointer. Re-select randomly from the full
haze set every `TWINKLE_COUNT` frames (lazy rotation). A simple `twinkleSubset`
array + `twinklePtr` index suffices.

**Warning sign:** stats overlay shows unexpected CPU usage at idle.

---

### Pitfall 3: Replay rows without seeds/hops (empty activation_trace rows)

**What goes wrong:** The `activation_trace` table may contain rows with `seeds=[]` or
`seeds=null` (e.g. rows emitted before Phase 52 with the old shape). Replaying these
produces a `applyTrace({seeds:[], hops:[]})` that returns early with no visible effect
but still suppresses the idle timer.

**Why it happens:** The ring buffer may contain stale schema-recall rows or very old
recall rows where seeds were not populated.

**How to avoid:** When populating `replayBuffer`, filter to rows where `seeds` parses
to a non-empty array. Skip empty/malformed rows.

**Warning sign:** Replay fires (idle timer resets) but nothing moves on screen.

---

### Pitfall 4: `ACT_SCALE_GAIN` too high causes nodes to overlap

**What goes wrong:** At peak activation (`a=1 × __actGain=1.2` for schemas),
`baseR * (1 + a * 1.2)` = `baseR * 2.2`. Large schema nodes are already 3–8 world
units radius; at 2.2× they can overlap neighbors.

**Why it happens:** The spec says `ACT_SCALE_GAIN ≈ 0.8–1.0` for regular nodes; the
schema's `__actGain = 1.2` multiplies on top.

**How to avoid:** The founder tunes at the visual checkpoint. The planner should note
this in the checkpoint task so the founder specifically checks dense schema neighborhoods.
`ACT_SCALE_GAIN = 0.7` is a safer starting value than `0.9` if in doubt.

**Warning sign:** Two bright schemas appear to merge during activation.

---

## Phase 52 Honesty Invariants (must not regress)

The following machine-checkable guards exist in `tests/trace-honest-recall.test.ts`
and must still pass after Phase 54 changes:

| Guard | Test name | What it checks |
|-------|-----------|----------------|
| D-08 #1 no-BFS | `lights exactly N hop nodes from row.hops, ignoring ctx.adj` | `traceEdgesFromHops` returns only `row.hops.length` even with 22-node ctx.adj |
| D-07 score intensity | `seed intensity tracks score: higher-score seed → higher intensity` | `a.__actPeak > b.__actPeak` for score 0.9 vs 0.3 |
| WR-02 null score | `score:null seed renders at fixed mid intensity — not 0` | `__actPeak > 0.01 && < 1.0` |
| Back-compat | `bare-string seeds still work` | legacy shape works |

Phase 54 adds to `applyTrace` but must not change any of these paths. The
`row.replay === true` branch routes BEFORE the recall path and returns — the recall
path code is untouched.

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest |
| Config file | `vitest.config.ts` (root) |
| Quick run command | `npx vitest run tests/viz-ambient-liveliness.test.ts` |
| Full suite command | `npx vitest run` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SC1 — alive at idle | twinkle tick registered and calls setColorAt | unit | `npx vitest run tests/viz-ambient-liveliness.test.ts` | Wave 0 |
| SC2 — events pop | scale is `(1 + a * ACT_SCALE_GAIN)` not `(1 + a * 0.35)` | source-text guard | same | Wave 0 |
| SC3 — honest hierarchy | replay never escalates above live (REPLAY_DIM < 1) | source-text guard | same | Wave 0 |
| SC3 — no fabricated edges | existing `trace-honest-recall.test.ts` guards still pass | unit (existing) | `npx vitest run tests/trace-honest-recall.test.ts` | Exists |
| SC5 — constants exported | all 10 new constants in constants.js export | source-text guard | same | Wave 0 |
| SC5 — replay flag plumbed | `replay: true` appears in server.ts broadcast path | source-text guard | same | Wave 0 |

### Sampling Rate

- **Per task commit:** `npx vitest run tests/viz-ambient-liveliness.test.ts tests/trace-honest-recall.test.ts tests/viz-layout-guards.test.ts`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `tests/viz-ambient-liveliness.test.ts` — new file; covers SC1–SC3, SC5 machine guards
- [ ] Framework: no new framework needed; vitest already installed

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | — |
| V3 Session Management | no | — |
| V4 Access Control | no | — |
| V5 Input Validation | yes (replay row selection) | Server-side: replay rows come from the internal `replayBuffer` (already-parsed, already-validated rows from the live poll); no user input; no injection surface |
| V6 Cryptography | no | — |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Replay scheduler opens second write DB handle | Tampering | Use existing `db` handle (read-only, already opened); add only a second prepared statement via `db.prepare(...)` |
| Replay forging arbitrary rows | Spoofing | Replay buffer is populated ONLY from rows returned by the live poll (`stmtTrace.all(cursor)`) — rows come from the actual DB, not from user input |
| Twinkle nodes fabricating edges | Tampering/Repudiation | Twinkle tick must NOT call `spawnPulse` or `ctx.revealTrace` — confirmed by source-text guard in test |

---

## Sources

### Primary (HIGH confidence)

- `src/viz/modules/trace.js` (read in full) — exact lines for all three integration points
- `src/viz/modules/constants.js` (read in full) — export style, all existing constants
- `src/viz/modules/stats.js` (read in full) — master rAF loop, idle behavior, `registerTick`
- `src/viz/modules/hud.js` (read in full) — SSE listener, `applyTrace` call site
- `src/viz/server.ts` (read in full) — SSE handler, poll interval, cursor, read-only DB
- `docs/superpowers/specs/2026-06-30-viz-ambient-liveliness-replay-traces-design.md` (read in full)
- `docs/superpowers/specs/2026-06-29-brain-viz-honest-traces-design.md` (read in full)
- `tests/trace-honest-recall.test.ts` (read in full) — existing Phase 52 honesty guards
- `tests/viz-haze-activation.test.ts` (read in full) — THREE mock pattern for headless tests
- `tests/viz-layout-guards.test.ts` (read in full) — source-text guard pattern (Phase 53)
- `src/viz/modules/lod.js` (grepped) — `__cat` classification, haze node bucketing
- `src/viz/modules/graph.js` (grepped) — `__actGain` init, InstancedMesh haze setup

### Secondary (MEDIUM confidence)

- `src/viz/modules/app.js`, `effects.js`, `detail.js` — not read but referenced in ctx typedef;
  no integration surface for Phase 54

---

## Assumptions Log

> All claims in this research were verified against live source. No ASSUMED claims.

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| — | (none) | — | — |

---

## Open Questions (RESOLVED)

1. **Twinkle node set initialization timing**
   - What we know: `ctx.allNodes` is populated by `app.js` before `initTrace` is called
     (the module init order in app.js is: graph → lod → trace → effects → hud → stats,
     per the ctx typedef comment in constants.js).
   - What's unclear: whether `ctx.hazeMesh` and `__hazeIdx` are set BEFORE or AFTER
     `initTrace` is called (haze is built in `buildHazeLayer()` which runs inside
     `initGraph(ctx)` after `seedNodePositions`).
   - RESOLVED: Initialize the twinkle subset lazily on first tick; guard ctx.hazeMesh != null.
     (check `ctx.hazeMesh != null && ctx.allNodes.length > 0`, not at `initTrace` time)

2. **Replay scheduler and SSE client backpressure**
   - What we know: replay writes to all `clients` in the `Set<http.ServerResponse>`.
   - What's unclear: if a client is slow and its write buffer fills, `res.write` may
     block. The live poll already has this exposure.
   - RESOLVED: No special handling — same exposure as the existing live poll; acceptable
     for a single local viewer.

---

## Environment Availability

Step 2.6: SKIPPED (no new external dependencies — Three.js and better-sqlite3 already
present; all changes are to existing files).

---

## Metadata

**Confidence breakdown:**

| Area | Level | Reason |
|------|-------|--------|
| Layer 1 integration points | HIGH | Read exact lines; verified spec claim matches live code |
| Layer 2 server replay | HIGH | Read all server.ts in full; cursor/boundary verified |
| Layer 3 master rAF behavior | HIGH | Read stats.js in full; idle-throttle behavior confirmed |
| Test infrastructure | HIGH | Read test files; confirmed THREE mock pattern |
| Starting constant values | MEDIUM | Spec gives ranges; founder tunes at checkpoint |

**Research date:** 2026-06-30
**Valid until:** 2026-07-30 (stable codebase; Phase 52/53 are the last changes to these files)
