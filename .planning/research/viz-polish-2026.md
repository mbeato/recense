# recense viz — Premium Polish Research (July 2026)

**Researched:** 2026-07-04
**Domain:** three.js / 3d-force-graph "second brain" visualization, Electron tray app
**Confidence:** HIGH on codebase facts (read from live source), MEDIUM-HIGH on ecosystem claims (web-verified, dates noted), LOW where flagged

## Verified codebase baseline (read 2026-07-04, live source — not planning docs)

- three.js **r171** vendored (`src/viz/vendor/three.core.js:6`), WebGL2 via `WebGLRenderer`, ES modules + import map, **no build step**. 3d-force-graph UMD vendored.
- Nodes: one shared `SphereGeometry(1,16,16)` + per-node `MeshBasicMaterial`, **onBeforeCompile fresnel rim already injected** (`graph.js:125-136`, single shared compiled program). Haze = one `InstancedMesh` (`graph.js:449`). Overview cap `OVERVIEW_NODE_CAP = 3000` (~2,700 live).
- Post: `UnrealBloomPass(0.6, 0.4, 0.72)` + `OutputPass` on the 3d-force-graph composer (`effects.js:158-165`). `toneMapping = NoToneMapping`, exposure 1 — **LOCKED, founder-approved 2026-07-03** (`graph.js:668-683`).
- Linear fog matched to bg (`graph.js:692`), aubergine `BG_COLOR 0x170f1d`, palette luminance-band **LOCKED** [170, 228] Rec.709 Y (`constants.js` D-02), amber = live-only (D-04).
- Four-layer motion-profile system (live/replay/spontaneous/twinkle: attack/halo/thickness) — **LOCKED** at Stage-2 (57-07).
- HUD: plain DOM ("receding chrome"), `search.js`, `topics.js`, `settings.js`, SSE dot, event log. Compact (≤500px) + full-window viewports.

**Hard constraints honored throughout:** honesty invariant (no fabricated engine activity), LOCKED palette + bloom + tone mapping + motion profiles, 15-17k nodes @ M-series/Electron floor, no heavyweight runtime deps.

---

## 1. Node presentation

### The bar in July 2026

The reference class (Cosmograph/cosmos.gl million-node graphs, Codrops WebGPU particle pieces, Nomic-Atlas-style embedding maps) has converged on: **instanced impostors or custom-shaded instanced meshes** (never default lit orbs), **depth cueing via fog + size attenuation + soft alpha** rather than AO, **SDF text for in-scene labels** (troika-three-text is the standard), and **restrained threshold-gated bloom on a designed luminance hierarchy** — which recense already has, and which most "AI-generated three.js scene" output does not. Cosmos.gl (rendering ported to luma.gl/WebGL2, 2025) confirms WebGL2 remains the production norm at this scale — nobody needs WebGPU for 17k nodes. [Cosmograph concept docs](https://cosmograph.app/docs-general/), [cosmos.gl](https://github.com/cosmosgl/graph), accessed 2026-07-04.

The honest assessment: recense's node rendering is **already above median** — shared-program fresnel rim, luminance-banded palette, instanced haze, fog recession. The remaining gap to "premium" is (a) haze softness, (b) labels, (c) focus-tier material richness. It is NOT tone mapping or AO.

### Techniques, ranked impact/effort

1. **Soft-sprite haze impostors (high impact / medium effort).** The haze `InstancedMesh` currently renders 2k+ tiny opaque-ish polygon spheres at 0.12–0.16 opacity — at that size and opacity they read as dim geometry, not atmosphere. Replace the haze layer's shared sphere geometry with **instanced camera-facing quads carrying a radial-falloff fragment shader** (procedural `smoothstep(0.5, 0.0, dist)` alpha — no texture needed, no new dep). Additive-ish blending means no sort needed ("additive particles do not need sorting — the math is commutative", [tigerabrodi particle write-up](https://tigerabrodi.blog/particle-systems-in-games-with-threejs-and-tricks-to-make-them-look-good)). Full depth-buffer soft particles (read scene depth, fade on intersection — [three.js forum soft-particles thread](https://discourse.threejs.org/t/points-transparent-textures-depth-artifacts-soft-particles/5927)) are **not needed** here: haze nodes rarely intersect solid geometry; the radial falloff alone gets 90% of the look for 10% of the cost. Keep the existing raycast path (raycast against invisible proxy spheres or keep the proximity fallback at `graph.js:976`). This is the single biggest "default three.js orbs → crafted" upgrade available.

2. **Occlusion-aware SDF labels for schema super-nodes only (high impact / medium effort, one dep).** Nothing says "premium graph product" like crisp in-scene names on the anchor nodes. **troika-three-text** — SDF atlas generated on-the-fly in a web worker, GPU-accelerated, the de-facto standard ([troika-three-text](https://protectwise.github.io/troika/troika-three-text/), [npm](https://www.npmjs.com/package/troika-three-text), MIT). Scope discipline: schema names only (~tens, not 17k — the [instanced-labels forum thread](https://discourse.threejs.org/t/instanced-labels-with-troika-three-text/72117) shows thousands-of-labels is possible but unnecessary here), distance-faded, `depthTest: true` so the hull/nodes occlude them naturally, colored from the LOCKED palette (slate `0xaab3c4` at ~0.7 alpha, never amber). This is the one justified new dep in this doc: it's vendorable ESM, zero transitive runtime deps of consequence, and there is no credible hand-rolled alternative (SDF atlas generation is a Don't-Hand-Roll item). Fallback if dep-aversion wins: keep labels screen-space HTML (area 3) and skip diegetic labels entirely — defensible, less cinematic.

3. **Focus-tier material richness via matcap mix (medium impact / low effort).** On drill-in/selection, the focused node + 1-hop neighbors (bounded set, regular meshes already) get a **grayscale matcap sampled in the existing onBeforeCompile injection, multiplied by the node's own palette color** — a "lit glass bead" read that stays 100% on-palette (matcap contributes only luminance shaping, hue stays the node's own; D-04 safe). Do NOT apply to the overview tiers — the overview's flat+rim look is part of the quiet-ghost-brain identity. License note in area 5 (generate your own matcap; don't ship nidorx blindly).

4. **Focus-node geometry upgrade (low impact / trivial effort).** A second shared `SphereGeometry(1, 32, 32)` used only for the selected node + HOVER_SCALE state — 16×16 silhouettes read faintly faceted at 1.8× scale up close. One extra geometry object total, zero extra draw calls beyond what exists.

5. **Tone mapping: change nothing (negative recommendation, HIGH confidence).** AgX is the better 2026 default for *new* scenes ([three.js #27362](https://github.com/mrdoob/three.js/issues/27362), [tone mapping overview, three.js forum](https://discourse.threejs.org/t/tone-mapping-overview/75204)) and both AgX and ACES desaturate — but recense's entire D-02 luminance band, the 0.72 bloom threshold margin analysis, and the founder's Stage-2 sign-off were all calibrated against `NoToneMapping` (`graph.js:668-683`, LOCKED 2026-07-03). Retrofitting a tone curve would silently re-grade every LOCKED hue and invalidate the palette-invariant tests. Any future exposure push goes through a founder checkpoint, not a polish pass.

### Do not do (node slop list)

- **No AO pass** — unlit MeshBasic orbs have no surface shading for AO to reveal; it's a pure fillrate tax that would read as dirt.
- **No per-node emissive-HDR bloom hack** (color > 1.0 to force glow) — it bypasses the threshold-gated luminance hierarchy that keeps amber the only flare.
- **No icosahedron/box/cone "geometry per kind"** — semantic kinds are already encoded in the LOCKED color vocabulary; mixed primitive silhouettes at 2–3px is visual noise, and per-kind geometry breaks the shared-geometry draw-call discipline.
- **No node textures/sparkle maps** — texture fetch per fragment across 3k nodes for a detail nobody sees at overview zoom.

---

## 2. Motion grammar

### The bar in July 2026

Two patterns dominate credible three.js interaction work: **frame-rate-independent exponential damping** (a value forever chasing a retargetable target — the `maath/easing.damp` model popularized through the pmndrs ecosystem, [maath](https://sudeeptobose.medium.com/basic-3d-camera-movement-with-react-three-fiber-and-maath-library-4b060bfe7c5c)) and **promise-sequenced camera choreography** (yomotsu [camera-controls](https://github.com/yomotsu/camera-controls) v3: `await rotateTo(); await dollyTo(); await fitToSphere()`). Fixed-duration tweens that can't be interrupted mid-flight are the tell of junior work; the premium feel is "everything is a spring/damp toward a target that can move at any frame" ([smooth camera movement, three.js forum](https://discourse.threejs.org/t/how-can-i-achieve-smooth-camera-movement/36844)). Motion.dev (ex-Framer Motion) ships real spring math for vanilla JS ([motion.dev](https://motion.dev/)) but is aimed at DOM; inside a render loop you want ~15 lines of math, not a library.

recense's *activity* motion grammar (attack/hold/fade envelopes, per-layer salience ordering) is already designed and LOCKED — the gap is **interaction** motion: hover, selection, camera.

### Techniques, ranked impact/effort

1. **Damped hover/selection scale (high impact / low effort, zero deps).** If hover currently snaps to `HOVER_SCALE = 1.8`, replace with a critically-damped spring or `THREE.MathUtils.damp(current, target, lambda, dt)` in the existing `registerTick` loop — grow with a slight overshoot (~1.05× of target, one oscillation max), settle; shrink with no overshoot (asymmetric feel = crafted). ~15 lines. Frame-rate independence matters here because the app runs 24fps idle / 60fps active (`IDLE_FPS`/`FULL_FPS`) — `damp` handles the dt swing; a duration tween would visibly change speed across tiers.

2. **Two-phase camera focus choreography (high impact / medium effort).** Current node-focus flight (3d-force-graph `cameraPosition(pos, lookAt, ms)`) is a single straight tween. The premium pattern: **orbit-then-dolly** — phase 1 rotates the camera to put the target on-axis (short, ~300ms, ease-out), phase 2 dollies in (longer, ~600ms, ease-in-out), optionally with a 3–5% initial pull-back (anticipation). Implement over the existing camera (drive `Graph.cameraPosition` per-frame from a damped target, or sequence two `cameraPosition` calls) — do **not** swap in yomotsu camera-controls: 3d-force-graph owns its controls via three-render-objects and replacing them is invasive surgery for a feel win achievable in-place. camera-controls is the reference for *what it should feel like* (`smoothTime`/`restThreshold` damping, [docs](https://yomotsu.github.io/camera-controls/classes/CameraControls)), not a dep to add.

3. **Interruptibility as a rule (medium impact / low effort).** Codify in `constants.js`-adjacent docs: every interaction animation must be retargetable mid-flight (damp-toward-target model). Clicking node B while flying to node A redirects smoothly — never queues, never jumps. This is the single behavioral property that separates Linear-grade feel from tween soup.

4. **Motion tokens for the DOM side (medium impact / trivial effort).** The design-corpus lesson "Inline cubic-bezier motion bypasses project motion vocabulary" (2026-05-10) applies directly: `constants.js` is already the motion token file for the scene; mirror it with 3–4 CSS custom properties (`--rv-dur-fast: 140ms; --rv-dur: 240ms; --rv-ease: cubic-bezier(.3,.7,.3,1)`) in `css/styles.css` and forbid inline transition literals in HUD modules. One vocabulary across canvas and chrome.

5. **DOF focus-pull: skip (negative recommendation).** BokehPass-style DOF ([three.js dof2 example](https://threejs.org/examples/webgl_postprocessing_dof2.html)) is a full-screen depth-driven pass stacked on top of bloom — real fillrate risk at the 60fps active tier on integrated M-series graphics, and recense already has a cheaper, more legible focus-pull: detail.js's non-neighbor dim + haze-material dim + linear fog. Deepen that (slightly stronger dim, slightly tightened fog near-plane during focus) before ever considering optical blur.

### Do not do (motion slop list)

- No fixed-duration `TWEEN.Easing.Quadratic.InOut` everything — the uniform-easing scene is the motion equivalent of Inter-plus-purple-gradient.
- No motion.dev/Framer/GSAP runtime dep for in-loop 3D motion — springs are 15 lines; libraries fight the render loop's ownership of time (and violate the no-heavy-deps constraint).
- No camera drift/wobble idle "cinematic" fakery beyond the existing idle autoRotate — idle motion vocabulary is LOCKED (shimmer + twinkle + replay), and unmotivated camera wobble reads as screensaver.
- No animation that implies engine activity that didn't happen (honesty invariant) — motion polish applies to *interaction response* and *decorative chrome* only.

---

## 3. HUD / overlay

### The bar in July 2026

Linear's 2025 "Liquid Glass, ProKit philosophy" is the reference: a Gaussian-blur base layer, a subtle gradient for structure, a specular hairline highlight — "precise blurs, masking, and lighting … depth without losing clarity" ([Linear on Liquid Glass](https://linear.app/now/linear-liquid-glass), 2025-11). On dark surfaces, depth is carried by a **surface ladder + hairline borders, not drop shadows** ([Linear UI redesign pt. II](https://linear.app/now/how-we-redesigned-the-linear-ui)). Command-palette-first is table stakes — ⌘K with **subsequence (not substring) fuzzy match** is the pattern shipped by Linear/Vercel/Raycast ([cmdk pattern breakdown](https://philipcdavis.com/writing/command-palette-interfaces), [60-line vanilla rebuild](https://dev.to/dev48v/i-rebuilt-the-cmd-k-command-palette-in-60-lines-of-javascript-3a1l), 2026-06). For 3D scenes specifically: controls are screen-space and recede; only scene semantics (labels on things) go diegetic.

### Techniques, ranked impact/effort

1. **⌘K command palette as the unifying entry point (high impact / medium effort, zero deps).** recense already has search.js, topics.js, settings toggles, tombstone toggle, corpus view toggle — scattered across buttons. Fold them into one palette: type-to-search nodes (existing search), `>` prefix or plain listing for commands ("show tombstones", "open corpus view", "replay last recall"). Subsequence match, keyboard-first, `Esc` dismisses. Vanilla JS ~100–150 lines — do NOT add cmdk (React-only) to a no-framework codebase. In an Electron tray app the palette also solves the compact-viewport problem: one affordance instead of a button row that doesn't fit at ≤500px.

2. **Linear-grade glass on existing panels (high impact / low effort).** Recipe for detail panel / palette / topics rail, per Linear's construction: `background: rgba(23,15,29,0.72)` (the BG_COLOR aubergine, not gray — brand cohesion), `backdrop-filter: blur(12px) saturate(1.1)`, **1px inset hairline** `rgba(255,255,255,0.08)` top edge slightly brighter (`0.12`) as the specular cue, **no drop shadows**. `backdrop-filter` over a WebGL canvas is compositor-accelerated in Chromium/Electron but forces an extra composite of the canvas region — keep glass panels small and few (2–3 max on screen), never full-window. Design-corpus lesson fold-in: define `--rv-on-dark-text/-muted/-border` tokens now (the "white-on-dark fell back to inline rgba" lesson, 2026-05-26) instead of scattering `rgba(255,255,255,…)` literals.

3. **Edge-docked auto-receding rails (medium impact / low effort).** The "receding chrome" direction in hud.js is right — finish it: topics/log dock to an edge, collapse to a 24px tab strip after N seconds of scene interaction, reopen on hover/⌘K. The scene is the product; chrome earns pixels only while being used. (Raycast/Linear both treat panels as summonable, not resident.)

4. **Diegetic vs screen-space split (medium impact / bundled with area 1 #2).** Rule: **scene facts get diegetic labels** (schema names via troika, occluded naturally by geometry), **app affordances stay screen-space** (search, toggles, SSE status). Never float HTML labels that pretend to be in the scene (untracked lag during orbit is an instant amateur tell) and never put buttons inside the 3D world.

5. **Typography with intent (low impact / low effort).** One distinctive face for the HUD — a humanist mono (e.g., system SF Mono in Electron, or a vendored open face) for data readouts + node counts, matching the "instrument panel for a brain" register. Avoid Inter-by-default (the #1 AI-slop tell per every 2026 slop guide). Type scale: 2 sizes + 1 weight change, no more.

### Do not do (HUD slop list)

- No full-window glassmorphism wash, no gradient-stroke borders, no glow-on-everything — glass is for 2–3 summonable surfaces, period.
- No drop shadows on the dark UI (Linear's rule; shadows on near-black read as smears).
- No resident sidebar eating 25% of a *visualization* product's viewport.
- No stock-blue focus rings / MUI-default anything (design-corpus lesson: "embedded child component injects MUI-default blue into monochrome canvas", 2026-05-26) — every focus/hover/active state derives from the LOCKED palette tokens.

---

## 4. Anti-AI-slop

### The bar

2026 slop guides converge on the same diagnostics: Inter + purple-blue gradient + rounded-xl cards + generic glassmorphism + gradient blobs + uniform 0.3s ease = "no human decided this" ([925studios slop guide](https://www.925studios.co/blog/ai-slop-web-design-guide), [vibecodekit fix guide](https://vibecodekit.dev/ai-slop-design), 2026). The inverse — the craft signature — is a small number of **opinionated, locked decisions enforced everywhere**: recense already has this in unusual depth (luminance-banded palette with tests, amber-exclusivity rule, four-layer motion salience ordering, honesty invariant). The polish round's job is to *extend that discipline to the interaction/HUD surface*, not to add new aesthetics.

### Principles for this codebase

1. **One warm signal.** Amber flares only for real retrieval (D-04). Every polish addition must pass: "does this compete with amber?" If yes, kill it. This single rule is worth more than any technique in this document.
2. **Tokens everywhere, both sides of the canvas.** Scene constants live in `constants.js` with tests; the CSS side currently doesn't have the same rigor. Port the discipline (color + motion custom properties, grep-able, no inline literals). Direct fold-in of three design-corpus lessons: inline cubic-bezier bypass (2026-05-10), foreign palette ramps when no token exists (2026-05-10), white-on-dark rgba fallback = token-gap signal (2026-05-26).
3. **Subordination through motion/scale, never darkness.** The 56-05 lesson (saturated indigo Y≈138 vanished on the dark bg; pastel lavender Y≈193 survived) is already generalized into the D-02 band — apply the same reasoning to any new HUD element: on `0x170f1d`, hierarchy comes from alpha/size/motion, not darker hues.
4. **Edges are where slop hides.** Design-corpus lessons (2026-05-14, 2026-05-26): non-full-bleed dark roots leak light app chrome; faint glows straddling a boundary render as hard discs. For the Electron frameless tray window: verify the dark root fills every pixel at both viewport sizes, and test every additive glow near window edges and the hull silhouette.
5. **Decorative chrome must be legibly decorative.** The hull, shimmer, and twinkle are fine *because* they never mimic the activity grammar (different scale, no per-node semantics, no amber). Any new ornament must be visually disjoint from the four activity layers — if a decoration could be mistaken for a recall, it's a fabricated semantic and violates the honesty invariant.
6. **Asymmetry and restraint as craft markers.** Asymmetric ease (overshoot in, no overshoot out), an intentionally quiet 95% of the screen, one distinctive type choice — these read as decided. Uniform symmetry and even distribution of visual interest read as generated.

### Do not do (meta-slop list)

- Purple→blue gradients anywhere (doubly so — the bg is already aubergine; a gradient over it is the literal 2026 cliché).
- Generic particle "starfield" backdrops behind the brain — the fog + haze IS the atmosphere; a second particle layer is noise.
- Animated gradient blobs, lens flares, chromatic aberration, film grain, vignette stacking — the False-Earth-style post chain ([Codrops, 2026-04](https://tympanus.net/codrops/2026/04/21/false-earth-from-webgl-limits-to-a-webgpu-driven-world/)) is right for a cinematic demo and wrong for an all-day resident instrument.
- "More bloom" as a polish lever — bloom values are LOCKED and the threshold margin analysis (`effects.js:139-156`) is load-bearing.
- Any polish that adds fake liveliness (random node flickers, fabricated pulses). The existing twinkle layer is the ceiling for non-semantic ambient motion.

---

## 5. Assets & the WebGPU/TSL question

### Assets (license-noted)

| Source | What | License | Verdict |
|---|---|---|---|
| [Poly Haven](https://polyhaven.com/license) | HDRIs, textures | **CC0**, explicit commercial-OK, no attribution | Safe. But note: recense's scene is unlit `MeshBasicMaterial` — an HDRI only becomes useful if the focus-tier matcap/env idea (area 1 #3) evolves into env-mapped materials. Grab-bag, not a need. |
| [nidorx/matcaps](https://github.com/nidorx/matcaps) | ~600 matcap PNGs | **Mixed/unverified** — repo aggregates from various sites, "not possible to maintain the relationship with the original authors" | **Not safe for a commercial product.** Use as a browsing catalog only. |
| Self-generated matcap | Render a studio-lit sphere in Blender (10 min) | Yours | **Recommended path** for area 1 #3 — deterministic, on-palette (author it as grayscale), zero license exposure. |
| LUT packs (FilterGrade etc.) | .cube color grades | Varies, mostly commercial-OK no-redistribution | **Skip entirely** — a LUT pass is a tone-mapping change by another name; conflicts with the LOCKED NoToneMapping/D-02 calibration (area 1 #5). |
| Existing brain STL | Nevit Dilmen scan | CC BY-SA, attribution shipped (`#hull-credit`), smoothed derivative under same license | Already handled correctly (`effects.js:95-105`); any new derivative keeps BY-SA + credit. |

### WebGPU / TSL in July 2026: mature, and still the wrong move here

**State of the ecosystem (MEDIUM-HIGH confidence, cross-verified):** WebGPU is baseline in every major browser — Chrome/Edge 113+ (2023), Firefox 141 (2025), Safari 26 on macOS Tahoe (Sept 2025) ([web.dev](https://web.dev/blog/webgpu-supported-major-browsers), [MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API)). `WebGPURenderer` + TSL are production-usable in current three.js releases, with TSL compiling to both WGSL and GLSL ([Threlte WebGPU guide](https://threlte.xyz/docs/learn/advanced/webgpu/), [Maxime Heckel's TSL field guide](https://blog.maximeheckel.com/posts/field-guide-to-tsl-and-webgpu/)); Electron 32+ ships it without flags ([migration checklist, utsubo 2026](https://www.utsubo.com/blog/webgpu-threejs-migration-guide) — note this source misdates r171 to Sept 2025; r171 shipped late 2024, treat its version-dating loosely). Codrops' 2026 front-page pieces are predominantly WebGPU/TSL ([Gommage effect, 2026-01](https://tympanus.net/codrops/2026/01/28/webgpu-gommage-effect-dissolving-msdf-text-into-dust-and-petals-with-three-js-tsl/)).

**Verdict for recense: stay WebGL2.** Reasons, in order:

1. **The dependency chain blocks it.** 3d-force-graph → three-render-objects owns renderer construction, the composer, and controls; the composer chain (`UnrealBloomPass` GLSL, `OutputPass`), the `onBeforeCompile` GLSL rim injection, and the custom GLSL wavefront/fresnel shaders are all WebGL-path code. A WebGPU move means replacing or forking the graph library plus rewriting every shader in TSL — the "1–2 weeks for large apps" migration estimate is optimistic when the core dep doesn't support it.
2. **There is no performance problem to solve.** 17k nodes with a 3k overview cap, one instanced haze mesh, ≤80 trace edges, and an adaptive-quality tier system is comfortably inside WebGL2 on M-series. WebGPU's wins (compute-shader force layouts, million-node scenes — the cosmos.gl territory) start an order of magnitude beyond this corpus.
3. **The re-adoption trigger is data-driven, not aesthetic:** revisit only if (a) corpus growth makes GPU force simulation attractive (cosmos.gl-style compute layout at 100k+ nodes), or (b) 3d-force-graph itself ships a WebGPU path. Neither is a polish-round concern.

### Do not do (assets/platform slop list)

- No nidorx matcaps shipped in the product (license roulette).
- No LUT/color-grade pass (silent palette re-grade of LOCKED values).
- No speculative "TSL rewrite for future-proofing" — that's a rewrite wearing a polish costume.
- No CDN-loaded assets — the codebase's vendor-everything rule (T-10-10, `effects.js:15`) applies to fonts, matcaps, and any troika addition too.

---

## Suggested sequencing (impact-per-effort, respecting locks)

1. Damped hover/selection + interruptible camera focus choreography (area 2 #1–#3) — pure feel, zero deps, zero lock conflicts.
2. Soft-sprite haze impostors (area 1 #1) — biggest visual-read upgrade.
3. ⌘K palette + glass recipe + CSS tokens (area 3 #1–#2, area 4 #2) — product-grade chrome.
4. Schema-node SDF labels via troika (area 1 #2) — the one new dep; gate behind a founder checkpoint given the no-heavy-deps constraint.
5. Focus-tier matcap mix + 32-seg focus geometry (area 1 #3–#4) — dessert.

Everything above holds the LOCKED palette/bloom/tone-mapping/motion-profile values untouched and adds no fabricated activity.

## Sources

**Primary (official docs / vendor):** [Linear – Liquid Glass](https://linear.app/now/linear-liquid-glass) · [Linear – UI redesign pt. II](https://linear.app/now/how-we-redesigned-the-linear-ui) · [troika-three-text](https://protectwise.github.io/troika/troika-three-text/) · [camera-controls (yomotsu)](https://github.com/yomotsu/camera-controls) · [Poly Haven license](https://polyhaven.com/license) · [three.js WebGLRenderer.toneMapping](https://threejs.org/docs/#api/en/renderers/WebGLRenderer.toneMapping) · [web.dev – WebGPU in major browsers](https://web.dev/blog/webgpu-supported-major-browsers) · [MDN WebGPU](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API) · [cosmos.gl](https://github.com/cosmosgl/graph) · [Cosmograph concept](https://cosmograph.app/docs-general/) · [motion.dev](https://motion.dev/) · [nidorx/matcaps](https://github.com/nidorx/matcaps)

**Secondary (community/expert, cross-checked):** [three.js AgX issue #27362](https://github.com/mrdoob/three.js/issues/27362) · [Tone Mapping Overview – three.js forum](https://discourse.threejs.org/t/tone-mapping-overview/75204) · [Khronos PBR Neutral announcement](https://www.khronos.org/news/press/khronos-pbr-neutral-tone-mapper-released-for-true-to-life-color-rendering-of-3d-products) · [soft particles – three.js forum](https://discourse.threejs.org/t/points-transparent-textures-depth-artifacts-soft-particles/5927) · [particle tricks – tigerabrodi](https://tigerabrodi.blog/particle-systems-in-games-with-threejs-and-tricks-to-make-them-look-good) · [smooth camera – three.js forum](https://discourse.threejs.org/t/how-can-i-achieve-smooth-camera-movement/36844) · [maath damping walkthrough](https://sudeeptobose.medium.com/basic-3d-camera-movement-with-react-three-fiber-and-maath-library-4b060bfe7c5c) · [command palette interfaces – Philip Davis](https://philipcdavis.com/writing/command-palette-interfaces) · [60-line vanilla ⌘K](https://dev.to/dev48v/i-rebuilt-the-cmd-k-command-palette-in-60-lines-of-javascript-3a1l) · [sphere impostors – Ben Golus](https://bgolus.medium.com/rendering-a-sphere-on-a-quad-13c92025570c) · [Codrops False Earth (2026-04)](https://tympanus.net/codrops/2026/04/21/false-earth-from-webgl-limits-to-a-webgpu-driven-world/) · [Codrops Gommage/TSL (2026-01)](https://tympanus.net/codrops/2026/01/28/webgpu-gommage-effect-dissolving-msdf-text-into-dust-and-petals-with-three-js-tsl/) · [Maxime Heckel – TSL field guide](https://blog.maximeheckel.com/posts/field-guide-to-tsl-and-webgpu/) · [Threlte WebGPU guide](https://threlte.xyz/docs/learn/advanced/webgpu/) · [instanced troika labels – forum](https://discourse.threejs.org/t/instanced-labels-with-troika-three-text/72117)

**Tertiary (single-source, flagged):** [utsubo WebGPU migration guide](https://www.utsubo.com/blog/webgpu-threejs-migration-guide) (misdates r171; version claims LOW confidence) · [925studios AI-slop guide](https://www.925studios.co/blog/ai-slop-web-design-guide) · [vibecodekit slop guide](https://vibecodekit.dev/ai-slop-design)

**Local:** `~/.claude/design-corpus/lessons.json` (18 lessons; 7 folded in — motion-token bypass, foreign palette ramps, on-dark token gaps, full-bleed root, edge-straddling glows, embedded-default-blue, competitor-accent classification) · live source: `src/viz/modules/{constants,graph,effects,trace,hud,lod,detail}.js`, `src/viz/index.html`, `src/viz/vendor/three.core.js`

**Valid until:** ~2026-08-15 for ecosystem claims (WebGPU/three.js move fast); codebase facts valid until next viz phase merges.
