---
phase: 58-node-presentation-motion-overhaul
reviewed: 2026-07-06T00:27:08Z
depth: standard
files_reviewed: 22
files_reviewed_list:
  - scripts/gen-matcap.mjs
  - src/viz/index.html
  - src/viz/modules/app.js
  - src/viz/modules/camera.js
  - src/viz/modules/constants.js
  - src/viz/modules/detail.js
  - src/viz/modules/graph.js
  - src/viz/modules/labels.js
  - src/viz/modules/lod.js
  - src/viz/modules/transition.js
  - src/viz/vendor/troika/troika-three-text.esm.js
  - src/viz/vendor/troika/troika-three-utils.esm.js
  - src/viz/vendor/troika/troika-worker-utils.esm.js
  - src/viz/vendor/troika/bidi-js.esm.js
  - src/viz/vendor/troika/webgl-sdf-generator.esm.js
  - tests/viz-activity-palette-invariants.test.ts
  - tests/viz-camera-damp.test.ts
  - tests/viz-detail-focus-camera.test.ts
  - tests/viz-haze-activation.test.ts
  - tests/viz-haze-selection.test.ts
  - tests/viz-labels-selection.test.ts
  - tests/viz-seed-determinism.test.ts
findings:
  critical: 1
  warning: 4
  info: 6
  total: 11
status: issues_found
---

# Phase 58: Code Review Report

**Reviewed:** 2026-07-06T00:27:08Z
**Depth:** standard
**Files Reviewed:** 22
**Status:** issues_found

## Summary

Reviewed the Phase 58 node-presentation/motion overhaul: the damped camera system (camera.js), SDF label layer (labels.js), haze billboard impostor + focus matcap + damped hover (graph.js/detail.js), constants additions, wiring (app.js/lod.js/transition.js), the offline matcap generator (gen-matcap.mjs), the five vendored troika ESM files (tamper + CDN-patch verification only), and the seven new/modified tests.

**Vendored troika verification (scope note):** the deliberate `unicodeFontResolverClientFactory` patch (troika-three-text.esm.js:453-471) does prevent all network fetches — the only remaining `cdn.jsdelivr.net` reference (line 1944) is inside a commented-out debug block, workers are blob-URL local, and the patched factory is stringified into the worker with its dependency list so the neutralization applies there too. The covered-glyph local-font path is intact (empty `fallbackRanges` → `allDone()` directly). However, the patch's *uncovered-glyph* path is broken in a way its own comment mispredicts — see CR-01. No other tampering signs found in the five vendored files.

The first-party phase-58 code is generally solid: the camera interrupt logic, hover damp, haze impostor/raycast-proxy design, and seeding determinism all check out against their tests and against the vendored three.js/3d-force-graph behavior (verified: `cameraPosition()` no-arg getter does return `{x,y,z,lookAt}`; `Raycaster` ignores `material.visible`/`object.visible`, so the invisible sphere proxy is sound). Remaining findings are one Critical in the vendored patch and four Warnings around focus-dim consistency, matcap uniform timing, and asset-serving fragility.

## Critical Issues

### CR-01: Neutralized troika font-fallback never completes — labels with any glyph outside JetBrains Mono silently never render

**Status:** fixed in cb52bc6 — second patch point added in resolveFallbacks' `.then` continuation (empty `fontUrls` → map fallback chars to font 0, load primary font if nothing resolved, `allDone()`); factory comment updated to note both sites; both sites pinned by `tests/viz-troika-fallback-patch.test.ts`.

**File:** `src/viz/vendor/troika/troika-three-text.esm.js:463-471` (patch) and `:678-712` (unpatched consumer)
**Issue:** The patched `getFontsForString` resolves with `{ fontUrls: [], chars: new Uint8Array(text.length) }`. The upstream consumer `resolveFallbacks` (lines 698-707) only ever calls `allDone()` from inside the `loadFont` callbacks of its `fontUrls.forEach(...)` loop:

```js
let loadedCount = 0;
fontUrls.forEach((url, i) => {
  loadFont(url, fontObj => {
    ...
    if (++loadedCount === fontUrls.length) {
      allDone();
    }
  });
});
```

With `fontUrls = []`, the `forEach` body never runs and `allDone()` is **never called**. So for any label text containing a codepoint not covered by JetBrains Mono (emoji, CJK, Hebrew/Arabic, etc.), typesetting stalls forever: the label silently never renders (no error, no tofu), and that `Text` instance's sync pipeline is wedged — subsequent `.sync()` calls queue behind the never-completing one. The patch comment's promised behavior ("a genuinely uncovered glyph renders as tofu/blank via the primary font") does not happen.

Two compounding problems even if `allDone()` were reached: (a) the fallback ranges' `charResolutions` are assigned `chars[charIdx++] + fontIndexOffset` = `fontResolutions.length` — an index one past the end of `fontResolutions` (undefined font → would crash typesetting downstream); (b) the comment "Schema names are engine-derived ASCII/Latin" is optimistic — schema `node.value` strings are LLM-extracted from arbitrary user memory content (labels.js:84 renders `String(node.value || node.id)` verbatim), so non-Latin text is reachable in normal operation.

**Fix:** Extend the patch one level up, into `resolveFallbacks`'s `.then` handler (this is vendored code, so patching it is consistent with the existing patch discipline). When `fontUrls` is empty, map the fallback ranges back to the primary font and finish:

```js
}).then(({fontUrls, chars}) => {
  // PATCHED continuation (T-10-10): the neutralized client returns no fallback
  // fonts — resolve every fallback char to font 0 (primary; renders as tofu)
  // and complete immediately instead of waiting on zero loads.
  if (!fontUrls.length) {
    fallbackRanges.forEach(range => {
      for (let i = range[0]; i <= range[1]; i++) charResolutions[i] = 0;
    });
    allDone();
    return;
  }
  ... // original body unchanged
```

(Also update the patch comment at line 453 to note the second patch point for future troika upgrades.)

## Warnings

### WR-01: Schema selection silently reverts the D-07 fog tightening and haze recede

**Status:** fixed in dd76003 — haze dim + fog tightening re-applied after the schema membership-dim loop.

**File:** `src/viz/modules/detail.js:618-649`
**Issue:** `selectNode` calls `applyFocusDim(node)` (dims node materials + `ctx.hazeMat` + tightens `fog.near` to `FOCUS_FOG_NEAR`), but the schema branch then calls `clearFocusDim()` (line 643) to swap neighborhood-dim for membership-dim — which *restores* `hazeMat.opacity` to `_baseOpacity` and `fog.near` to the resting value, then re-dims **only node materials** (lines 645-649). Net result: selecting a schema node gets neither the haze recede nor the D-07 fog depth cue that every other selection gets. Focus depth is one of this phase's two headline "focus" changes, so the inconsistency is user-visible on exactly the most prominent node class (schema super-nodes).
**Fix:** After the membership-dim loop in the schema branch, re-apply the haze dim and fog tightening (or refactor `applyFocusDim` to accept a keep-set so both branches share one code path):

```js
if (ctx.hazeMat) { ctx.hazeMat.opacity = FOCUS_DIM_OPACITY; ctx._hazeDimmed = true; }
const fog = ctx.Graph && typeof ctx.Graph.scene === 'function' ? ctx.Graph.scene().fog : null;
if (fog) { if (ctx._fogBaseNear == null) ctx._fogBaseNear = fog.near; fog.near = FOCUS_FOG_NEAR; }
```

### WR-02: Matcap fade never applies to members revealed by the same click (uniform not yet compiled)

**Status:** fixed in 70dfa57 — activeMatcap stores target-only entries; the tick resolves the uniform lazily (pending until the material compiles; target-0 entries with no uniform dropped).

**File:** `src/viz/modules/detail.js:157-162` (setMatcapTarget), `src/viz/modules/graph.js:153-173` (onBeforeCompile)
**Issue:** `mat.userData.matcapMixUniform` is created inside `onBeforeCompile`, which three.js runs at the material's **first render**. On a schema drill-in click, graph.js adds the member meshes via `Graph.graphData(...)` and then `ctx.selectNode(node)` runs synchronously in the same handler — before the next frame renders. `setNodeMatcap` → `setMatcapTarget(neighbor, 1)` finds no `matcapMixUniform` on those freshly-created materials and silently drops them (line 161 `if (!uniform) return;`). Every 1-hop member revealed by the click therefore misses the "lit glass bead" treatment for that selection. The D-10 "silent no-op" comment covers haze nodes with *no mesh*; this case is real member nodes that will have the uniform one frame later.
**Fix:** Store the entry even when the uniform is missing and resolve it lazily in the matcap tick:

```js
function setMatcapTarget(node, target) {
  if (!node) return;
  activeMatcap.set(node, { target });
}
// in the tick:
for (const [node, entry] of activeMatcap) {
  const uniform = node.__mat && node.__mat.userData && node.__mat.userData.matcapMixUniform;
  if (!uniform) { if (entry.target === 0) activeMatcap.delete(node); continue; }
  uniform.value = ctx.THREE.MathUtils.damp(uniform.value, entry.target, MATCAP_MIX_LAMBDA, dt);
  ...
}
```

### WR-03: Label font URL is document-relative, not module-relative — works only by accident at the origin root

**Status:** fixed in 5ae2fbe — FONT_URL now resolved to an absolute URL via `new URL('../vendor/fonts/...', import.meta.url).href` (robust under any serving subpath, stronger than the suggested document-relative form); comment corrected.

**File:** `src/viz/modules/labels.js:38-39`
**Issue:** `FONT_URL = '../vendor/fonts/JetBrainsMono-Regular.ttf'` is commented "relative to this module", but troika resolves font URLs against the **document**, not the importing module (`toAbsoluteURL` uses an `<a>` element — troika-three-text.esm.js:2013-2020 — because the actual fetch happens inside a blob-URL worker where module-relative resolution is impossible). It currently resolves to `/vendor/fonts/...` only because index.html is served at `/`, where the leading `../` collapses against the origin root. If the viz were ever served under a subpath (`/viz/`), labels' font would 404 while every other asset (all referenced as `./vendor/...`, e.g. graph.js:65's matcap) keeps working — a confusing partial breakage guaranteed by the wrong comment.
**Fix:** `const FONT_URL = './vendor/fonts/JetBrainsMono-Regular.ttf';` and correct the comment to "document-relative (troika resolves against the page URL, not this module)".

### WR-04: Viz server serves the new .png/.ttf assets as text/plain

**Status:** fixed in 944c11a — mime map extended with `.png → image/png` and `.ttf → font/ttf`.

**File:** `src/viz/server.ts:192-197` (serveFile mime map); consumers `src/viz/modules/graph.js:65`, `src/viz/modules/labels.js:39`
**Issue:** Phase 58 adds the first two non-JS/CSS/HTML assets served through `/vendor/*` (`focus-matcap.png`, `JetBrainsMono-Regular.ttf`), and `serveFile`'s mime map falls through to `text/plain` for both. The font survives because troika XHRs it as `arraybuffer` (mime ignored); the matcap survives only because `THREE.TextureLoader` → `<img>` decoding sniffs content regardless of `Content-Type`. That's two loads relying on browser leniency: adding `X-Content-Type-Options: nosniff` (a natural future hardening for this loopback server, and already the kind of header this codebase's threat-model work adds) would silently blank the matcap.
**Fix:** Extend the mime map:

```ts
ext === '.png' ? 'image/png' :
ext === '.ttf' ? 'font/ttf' :
```

## Info

### IN-01: clearFocusDim's haze restore fallback can no-op onto the dimmed value

**File:** `src/viz/modules/detail.js:240-245`
**Issue:** The fallback branch `: ctx.hazeMat.opacity; // already correct if never saved` is logically wrong: if `_hazeDimmed` is true but `_baseOpacity` was never saved, the current opacity is the *dimmed* `FOCUS_DIM_OPACITY`, and "restoring" it writes the dim value back permanently. Unreachable today only because `buildHazeLayer` (graph.js:618) always sets `_baseOpacity` before any focus can occur.
**Fix:** Drop the fallback (`if (ctx.hazeMat._baseOpacity != null) ctx.hazeMat.opacity = ctx.hazeMat._baseOpacity;`) and fix the comment.

### IN-02: Hover damp and trace activation both write mesh.scale each frame on a clicked node

**File:** `src/viz/modules/graph.js:691-723` (hover tick), `src/viz/modules/trace.js:480` (activation envelope)
**Issue:** Every click activates the node (`ripple` → `ctx.activate(node, 1.0)`), and the clicked node is usually hovered. For ~3.2s (attack+hold+fade) trace.js writes `scale = __baseR * (1 + a * ACT_SCALE_GAIN)` per frame while the hover tick damps toward `HOVER_SCALE`; trace's tick registers later, so it wins the final write, the hover grow is suppressed, and the node can sit in `_hoverSettling` doing dead writes until the envelope ends. Pre-existing interplay (the old snap-hover was also overwritten), but the new per-frame damp makes the contention continuous.
**Fix:** Skip the hover damp write while `node.__act > 0`, or compose (hover factor × activation factor) in one owner.

### IN-03: gen-matcap --check depends on cross-platform floating-point identity

**File:** `scripts/gen-matcap.mjs:79-108, 281-285`
**Issue:** The `--check` mode compares decoded committed pixels against a fresh `renderPixels()` byte-for-byte. Comparing pixels-after-inflate (not PNG bytes) correctly avoids zlib-version drift — good design — but `computeBrightness` uses `Math.pow`/`Math.sqrt`/`Math.hypot`, and `Math.pow` is not guaranteed bit-identical across JS engines/platforms. A future Node/V8 or architecture change could make `--check` fail spuriously with a misleading "has drifted" message.
**Fix:** Allow a ±1 per-byte tolerance in the drift comparison (grayscale lock is already checked separately), or note the constraint in the error message.

### IN-04: Dead disposal-tracking arrays in viz-haze-selection.test.ts

**File:** `tests/viz-haze-selection.test.ts:29-30`
**Issue:** `_disposedGeometries` / `_disposedMaterials` are declared but never used — superseded by the `globalThis.__testDisposedGeos/__testDisposedMats` mechanism inside the mock factory (lines 103-106).
**Fix:** Delete the two dead declarations.

### IN-05: Schema labels render node.value untruncated

**File:** `src/viz/modules/labels.js:84`
**Issue:** `text.text = String(node.value || node.id || '')` renders the full value as a single line. Hover tooltips truncate at 48 chars via `truncLabel`; a long schema value becomes a scene-width SDF banner on approach.
**Fix:** Apply the same word-boundary truncation (import or duplicate `truncLabel(s, 48)`).

### IN-06: Haze proximity-fallback click can select hidden or behind-camera nodes

**File:** `src/viz/modules/graph.js:1166-1188`
**Issue:** The 10px screen-space fallback projects every entry of `hazeInstanceMap` without checking (a) that the node is in front of the camera (`Vector3.project` mirrors NDC for behind-camera points, so a click can select a node behind the viewer) or (b) that the instance is currently hidden (zero-scaled promoted instances and cap-suppressed haze remain in the map). Low frequency — fires only when the exact raycast misses — but the selection lands on something invisible.
**Fix:** Skip candidates with `_proxPt.z > 1` (or w<0 pre-divide via `.applyMatrix4`), and skip `ctx.focusedHaze.has(node.id)` / `ctx.suppressedHaze?.has(node.id)` entries.

---

_Reviewed: 2026-07-06T00:27:08Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
