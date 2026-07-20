---
phase: 56-spontaneous-1-hop-idle-activation
reviewed: 2026-07-02T16:09:11Z
depth: standard
files_reviewed: 8
files_reviewed_list:
  - apps/tray/src/tray-icon.ts
  - src/retrieval/engine.ts
  - src/retrieval/honest-trace.ts
  - src/viz/modules/constants.js
  - src/viz/modules/trace.js
  - src/viz/server.ts
  - tests/honest-trace.test.ts
  - tests/spontaneous-idle-activation.test.ts
findings:
  critical: 0
  warning: 7
  info: 4
  total: 11
status: issues_found
---

# Phase 56: Code Review Report

**Reviewed:** 2026-07-02T16:09:11Z
**Depth:** standard
**Files Reviewed:** 8
**Status:** issues_found

## Summary

Reviewed the Phase-56 spontaneous 1-hop idle activation surface: the extracted shared
honest-trace builder, the read-only SSE spontaneous emitter, the client render branch +
constants, tray pulse suppression, and the two guard tests. Both guard test files pass
(9/9, verified by running vitest).

**Phase invariants — verified directly:**

- **Viz server stays read-only:** the spontaneous region (server.ts:513–573) uses only two
  prepared SELECTs over the existing `{ readonly: true }` handle; no `new Database()`, no
  `INSERT INTO activation_trace`, no `.run(`, and the `/events` `cursor` is never read or
  assigned. HOLDS.
- **SPONT_DIM < REPLAY_DIM:** 0.3 < 0.4 in constants.js. HOLDS numerically — but the
  invariant has no regression lock, unlike Phase 54's REPLAY_DIM < 1 test (WR-02).
- **Emitter teardown:** `clearInterval(spontaneousInterval)` present in `server.on('close')`
  (server.ts:1312), alongside poll/replay intervals; `.unref()` applied. HOLDS.
- **No drift between engine and viz callers:** engine passes `this.store` (SemanticStore);
  the server reader's SQL (`SELECT dst, rel, w, kind FROM edge WHERE src = ?` /
  `SELECT tombstoned FROM node WHERE id = ?`) matches `stmtGetOutEdgesWithRel` and the
  helper's `getNode` needs exactly (semantic-store.ts:178–180). Extraction confirmed verbatim
  against the pre-extraction Phase-55 body (`git show 7b90ea8`). HOLDS for retrieveRanked —
  but a third engine emitter bypasses the helper entirely (WR-07), and the test-side mirror
  of SPONT_HOP_TOPN has already drifted (WR-01).

Key concerns: constant drift between the regression test and the server it claims to lock,
a documented pool guarantee the code does not implement, two tray state-machine defects
(one pre-existing, surfaced by this file's review), the global trace-fade clobber the new
branch copies from replay, and the retrieveCueless emitter contradicting the D-07
"single source of truth" claim.

Note (out of scope, observed in `git status`): an untracked `apps/tray/tray-icon.js` sits
at the tray app root — looks like a stray build artifact beside `apps/tray/src/tray-icon.ts`;
worth deleting or gitignoring.

## Warnings

### WR-01: Test's SPONT_HOP_TOPN mirror has drifted from the server (6 vs 3)

**File:** `tests/spontaneous-idle-activation.test.ts:33-35`
**Issue:** The test hardcodes `const SPONT_HOP_TOPN = 6` with the comment "Mirrors
src/viz/server.ts SPONT_HOP_TOPN". The server value was founder-tuned 6→3 at 56-05
(server.ts:76, mirrored in constants.js:388), so the mirror claim is now false and the
regression lock's top-N truncation assertion (`seedAHops.length === 6`,
line 147) no longer exercises the deployed value. This is exactly the guard-set-drift
failure the phase's own "keep in sync" comments warn about — the drift happened within
the phase that introduced the constant.
**Fix:** Update the test constant to 3 and adjust the fixture assertion
(`expect(seedAHops.map(h => h.node_id).sort()).toEqual(['r1','r2','r3'])`), or better,
export `SPONT_HOP_TOPN` from server.ts (like `pickSpontaneousSeeds` already is) and import
it in the test so the mirror cannot drift again:
```ts
export const SPONT_HOP_TOPN = 3; // server.ts
import { pickSpontaneousSeeds, SPONT_HOP_TOPN } from '../src/viz/server'; // test
```

### WR-02: No regression lock for the SC3 machine invariant SPONT_DIM < REPLAY_DIM

**File:** `src/viz/modules/constants.js:378-380` (invariant declared at 396)
**Issue:** constants.js states "the SC3 machine invariant lives on SPONT_DIM < REPLAY_DIM
(node activations)" and the SPONT_DIM doc says "MUST be < REPLAY_DIM (0.4)". Phase 54
locked its equivalent invariant (`REPLAY_DIM < 1`) with a numeric source-parse test
(viz-ambient-liveliness.test.ts:482-485). Phase 56 ships no equivalent test: nothing fails
if a future tuning pass raises SPONT_DIM to 0.5. Given both values are explicitly
"founder-tunable at checkpoint", an unlocked ordering invariant between two tunables is
the most likely future regression.
**Fix:** Add to the spontaneous test file (mirroring the Phase-54 pattern):
```ts
const src = fs.readFileSync(path.resolve(__dirname, '../src/viz/modules/constants.js'), 'utf8');
const spont  = parseFloat(src.match(/export\s+const\s+SPONT_DIM\s*=\s*([\d.]+)/)![1]);
const replay = parseFloat(src.match(/export\s+const\s+REPLAY_DIM\s*=\s*([\d.]+)/)![1]);
expect(spont).toBeLessThan(replay);
```

### WR-03: Eligible-seed pool guarantee ("a tick never comes up empty") is not implemented

**File:** `src/viz/server.ts:513-533`
**Issue:** The pool comment claims the DISTINCT SELECT "guarantees every sampled seed has
≥1 honest edge, so a tick never comes up empty (D-02)". The eligibility query checks the
SRC node's liveness and (in JS) PRED_SET membership, but never checks that any edge's
**dst** is live. A seed whose only PRED_SET out-edges point at tombstoned dsts is
pool-eligible yet yields zero hops in `buildHonestOneHopTrace` (liveness-before-slot), and
the tick is silently dropped at `if (hops.length === 0) return;` (line 563). With
SPONT_SEED_COUNT=2, a corpus region with heavy tombstoning produces silent spontaneous
ticks — the documented D-02 guarantee does not hold. Related: when only one of the two
picked seeds has live hops, the payload still ships both seeds, so a hop-less seed lights
with no pathway.
**Fix:** Enforce dst liveness in the pool SQL so the guarantee is real:
```sql
SELECT DISTINCT e.src AS src, e.rel AS rel
FROM edge e
JOIN node n ON n.id = e.src AND n.tombstoned = 0
JOIN node d ON d.id = e.dst AND d.tombstoned = 0
WHERE e.kind = 'relation'
```
or weaken the comment to "eligible seeds have ≥1 PRED_SET out-edge; a tick may still skip
if all dsts are tombstoned" and accept the skip.

### WR-04: Tray clears the dim FLAG on replay/spontaneous traces without restoring the icon/tooltip

**File:** `apps/tray/src/tray-icon.ts:164`
**Issue:** The `trace` listener sets `isDim = false` for every trace ("proves the server is
alive — clear any dim state regardless"), but for `replay: true` / `kind: 'spontaneous'`
rows it returns before `pulse()`, so nothing repaints the icon or tooltip. If the icon is
dim when a non-pulsing trace arrives — e.g. the main process drove `handle.setDim()` from a
child-down signal (documented use, line 12), or the post-resume window — the tray keeps the
dim image and the "brain — server offline" tooltip while internal state says at-rest. The
resume-path gate at line 221 (`isDim && ... readyState === OPEN → setRest()`) then also
skips its repaint because `isDim` was already cleared, leaving the icon stuck dim until the
next live pulse or `open` event. Flag, image, and tooltip go out of sync.
**Fix:** Restore the base state instead of just flipping the flag:
```ts
if (isDim) setRest();   // replaces bare `isDim = false;`
```

### WR-05: powerMonitor 'resume' listener leaks past dispose() and runs without a disposed guard

**File:** `apps/tray/src/tray-icon.ts:211-225, 229-241`
**Issue:** `initTrayIcon` registers `powerMonitor.on('resume', ...)` but `dispose()` never
removes it. After dispose, a system wake still runs the handler: `setDim()` calls
`tray.setImage(...)` unguarded (only `connectSSE` and the inner 3s timeout check
`disposed`), which throws in the Electron main process if the Tray has been destroyed. If
`initTrayIcon` is ever called again (tray recreation), stale listeners accumulate, each
closing over a dead `es`/`tray`.
**Fix:**
```ts
const onResume = () => {
  if (disposed) return;
  log('powerMonitor resume — reconnecting SSE');
  setDim();
  connectSSE();
  ...
};
powerMonitor.on('resume', onResume);
// in dispose():
powerMonitor.removeListener('resume', onResume);
```

### WR-06: Spontaneous fade timeout globally clears traceNodes, clobbering a concurrent live trace

**File:** `src/viz/modules/trace.js:766-771` (pattern shared with 692-697 and 865-870)
**Issue:** The spontaneous branch schedules `ctx.traceNodes.clear(); ctx.traceLinks.clear()`
~1.2 s after firing (`DECAY_ATTACK_MS + DECAY_HOLD_MS + 500`). These are **global** sets.
Spontaneous fires every SPONT_CADENCE_MS (2.5 s) throughout idle, and a live recall is
precisely the event that ends idle — so a live trace arriving inside any spontaneous fade
window has its just-added `traceNodes` entries wiped by the spontaneous timeout, and the
subsequent `revealTrace(spontPathNodes, [])` delta-sync can hide the live pathway's
LOD-revealed nodes mid-animation. The pattern is copied from the Phase-54 replay branch,
but Phase 56 materially raises the collision frequency: previously the clobber needed two
rows within ~1.2 s; now every idle→live transition races a pending spontaneous fade.
**Fix:** Make fades own-trace-scoped — delete only the ids this trace added instead of
clearing the shared sets:
```js
const addedIds = pathNodes.map(n => n.id);
setTimeout(() => {
  addedIds.forEach(id => ctx.traceNodes.delete(id));
  if (ctx.revealTrace) ctx.revealTrace(pathNodes, []);
}, fadeMs);
```
(Apply to all three branches, or at minimum the spontaneous one.)

### WR-07: retrieveCueless trace emission bypasses buildHonestOneHopTrace — third emitter drift

**File:** `src/retrieval/engine.ts:306-332`
**Issue:** honest-trace.ts declares itself "the single source of truth for the honest 1-hop
filter — both engine ambient recall and the Phase-56 spontaneous emitter import this
function, so the filter can never drift" (honest-trace.ts:4-8). But `retrieveCueless`'s
trace emission is a third emitter that does not use the helper: it emits every out-edge of
each seed via `getOutEdges` — no `kind === 'relation'` filter, no PRED_SET filter (so
structural `extends`/`links_to` and doc-graph edges are emitted; the helper's own comment
says structural edges are ~83% of kind='relation' edges), no dst-liveness re-check (every
live node already has a base score, so `scores.get(edge.dst)` passes for any live dst
regardless of the spread loop's tombstone skip), no `src` attribution, and **numeric**
hop scores from the internal scores map (violating the WR-02 rank-only/score:null rule the
helper enforces). This is mostly latent because cueless/session-start callers are wired
with the Noop sink — but any non-Noop caller of `retrieve()`/`retrieveCueless()` emits
exactly the dishonest hops the phase's D-07 spine exists to prevent.
**Fix:** Route the cueless emit through the shared helper:
```ts
const seedPayload = seeds.map(([id, score]) => ({ node_id: id, score }));
const { hops } = buildHonestOneHopTrace(seedPayload, this.store, AMBIENT_HOP_TOPN);
this.traceSink.emit({ query_id: newId(), seeds: seedPayload, hops });
```
If the divergence is intentional (cueless hops meant to show raw spread), document it in
honest-trace.ts so the "never drift between the two callers" claim stops being misleading.

## Info

### IN-01: honest-trace liveness check treats a MISSING dst node as live

**File:** `src/retrieval/honest-trace.ts:55`
**Issue:** `if (reader.getNode(edge.dst)?.tombstoned === 1) continue;` skips only when the
node exists AND is tombstoned. A missing node (`null`/`undefined` — both allowed by the
`HonestTraceReader` interface, and what the server's `stmtSpontGetNode.get()` returns for
an absent id) passes the guard, emitting a hop for a nonexistent node_id and consuming a
top-N slot that could have gone to a real live edge. FKs are enforced
(`db.pragma('foreign_keys = ON')`, schema.ts:219) so dangling edges shouldn't exist in
practice — but the engine's own spread loop uses the stricter `!neighbor || tombstoned`
form (engine.ts:284), and the helper interface invites readers that can return undefined.
**Fix:** `const n = reader.getNode(edge.dst); if (!n || n.tombstoned === 1) continue;`

### IN-02: pickSpontaneousSeeds indexes out of bounds if rng() returns exactly 1.0

**File:** `src/viz/server.ts:93`
**Issue:** `const j = i + Math.floor(rng() * (shuffled.length - i))` yields
`j === shuffled.length` when `rng()` returns exactly 1.0 — `shuffled[j]!` is `undefined`,
corrupting the shuffle and emitting an `undefined` node_id. `Math.random` is strictly < 1
so production is safe, but the injected-rng contract is just `() => number`, and the test's
LCG (`s / 0x7fffffff` where `s ≤ 0x7fffffff`) can mathematically hit 1.0.
**Fix:** `const j = i + Math.min(shuffled.length - i - 1, Math.floor(rng() * (shuffled.length - i)));`
or document the contract as rng ∈ [0, 1).

### IN-03: Spontaneous applyTrace branch is a ~60-line near-copy of the replay branch

**File:** `src/viz/modules/trace.js:706-773` (vs 630-699)
**Issue:** Seed resolution, hop resolution, markAnimating, reveal, activate loops, and the
fade timeout are duplicated between the replay and spontaneous branches (and echo the
recall path) with only the dim factor, colors, and seed-intensity base differing. Three
copies of the same reveal/fade choreography is where the next SC3 fix gets applied to one
branch and missed in another.
**Fix:** Extract a shared `renderTraceLayer(row, { dimFactor, seedBase, hopBase, seedColor, hopColor, pulseColor })`
used by both idle branches.

### IN-04: SPONT_CADENCE_MS / SPONT_HOP_TOPN are dead client exports (documentation mirrors)

**File:** `src/viz/modules/constants.js:384, 388`
**Issue:** Neither constant is imported by any client module (verified by grep) — they
exist only to mirror the server-authoritative values, per the Phase-54 REPLAY_* precedent.
Hand-maintained mirrors are exactly what drifted in WR-01. Acceptable per established
convention, but each new mirror widens the drift surface.
**Fix:** Consider dropping the unused exports and keeping the sync note as a comment
pointing at server.ts, or add a source-parse sync test like the Phase-54 constants guards.

---

_Reviewed: 2026-07-02T16:09:11Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
