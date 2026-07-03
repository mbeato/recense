# Phase 57: viz activity-palette redesign - Context

**Gathered:** 2026-07-02
**Status:** Ready for planning

<domain>
## Phase Boundary

Redesign the viz activity color system so **hue carries IDENTITY and salience comes from
motion/scale/density** — never from brightness-scaling saturated hues. The current model
(saturated hue × dim factor on a dark additive-blended background) has required founder rescue
three times (Phase 54 replay, Phase 55 hops, Phase 56 spontaneous): every "subordinate" layer
trends toward invisible because dimming a saturated hue drives it below the perceptual floor.

**In scope:**
- Luminance-equalized identity palette covering ALL activity kinds — the 7 `KIND_COLOR`
  entries (recall_seed, recall_hop, new_node, reconsolidation, oscillation, neutral,
  spontaneous) PLUS a new replay identity hue (ice-cyan direction) replacing today's
  "live colors × REPLAY_DIM" — every hue inside a machine-tested luminance band.
- SC3 salience ordering (live > replay > spontaneous > twinkle) re-expressed as **full
  per-layer motion profiles** (attack sharpness, halo size, pulse thickness, cadence, density)
  with machine-checkable monotonic ordering on the salient channels; brightness demoted to a
  bounded secondary cue (hard test-enforced dim floors).
- One **global** bloom/tone-mapping calibration pass (composer params + renderer
  exposure/tone-mapping) against the real hull backdrop.
- WR-06 fix (56-REVIEW): own-trace-scoped fades in all three `trace.js` branches (live,
  replay, spontaneous) — no more global `traceNodes`/`traceLinks` clears clobbering
  concurrent traces.
- Single shared source of truth for the new constants (kills the WR-01 client/server
  mirror-drift class); one dedicated invariants test file (subsumes the never-written
  WR-02 lock).
- Two-stage founder checkpoint: mid-phase palette sign-off, closing full-system tune.

**Out of scope (hard):**
- Honesty/engine mechanics untouched — presentation layer only (faithfulness clause: viz
  chrome is free). No change to what is emitted, stored, or retrieved; no regression of
  Phase 52/54/55/56 honesty guards.
- Resting-tissue look locked: `TYPE_COLOR` rose/slate/mauve, `BG_COLOR 0x170f1d`, hull
  material — untouched.
- No per-layer selective bloom (structural render-pipeline change; second salience system).
- No trace-material blending-mode changes (additive stays).
- Structural viz work (hull quality, in-app search, corpus↔brain 3D transition) — separate
  tracked todos, not this phase.

</domain>

<decisions>
## Implementation Decisions

### Palette scope & derivation
- **D-01: All activity kinds in scope.** All 7 `KIND_COLOR` entries get luminance-equalized
  identity hues; replay stops rendering as dimmed live colors and gets its OWN identity hue
  (ice-cyan starting direction); the twinkle tint is included in the system. One coherent
  palette, no coexisting color systems.
- **D-02: Colorimetric band + hand-tuned hues.** Each identity hue is hand-picked (founder
  taste rules; roadmap starting directions: live amber-gold, replay ice-cyan, spontaneous
  lavender, ingestion greens/magenta), but a machine test asserts every palette entry's
  computed luminance falls inside a named band. The 56-05 lesson generalized: saturated
  indigo (Y≈138) vanished; pastel lavender (Y≈193) survived — the band is a real constraint,
  not vibes.
- **D-03: Old founder locks carry forward.** (a) Resting tissue (`TYPE_COLOR`), bg, hull —
  untouched; this phase is activity colors only. (b) D-04 amber-exclusivity stands: amber
  stays reserved for live retrieval/hover — which is exactly what makes amber-gold work as
  the live identity. No other activity kind may use an amber-family hue (note: existing
  oscillation burnt-amber `0xc9824e` must be checked/moved during redesign).
- **D-04: Semantic hue families allowed.** Related activities may deliberately share a hue
  family — replay ice-cyan reading as "a cooler echo of live-hop cyan" is semantically right;
  motion/scale carries the live-vs-replay distinction. Only unrelated kinds need clear
  separation. Founder checkpoint is the judge; no machine hue-angle test.

### Salience channel mapping
- **D-05: Brightness bounded, not retired.** Dim factors (successors of `REPLAY_DIM`/
  `SPONT_DIM`/`SPONT_PULSE_SCALE`) survive as a gentle secondary ordering cue, but every dim
  factor gets a hard perceptual FLOOR (≈ ≥0.6; exact value ratcheted at checkpoint per D-09)
  enforced by test — band-luminance hue × floor must stay visible on the dark bg.
  Motion/scale/density become the PRIMARY ordering channels.
- **D-06: Full per-layer motion profiles.** Each layer (live, replay, spontaneous, twinkle)
  gets a named constants block — attack ms, halo scale, pulse thickness, cadence, density —
  forming a designed "character" (live: sharp+big; replay: soft echo; spontaneous: slow
  drift; twinkle: micro-breathe). SC3 ordering must hold **monotonically on the salient
  channels (attack sharpness, halo/scale)**; cadence and density may vary freely for feel.
- **D-07: Twinkle stays neutral-hued but joins the profile system.** No identity hue for
  twinkle (it represents nothing — giving it an activity hue would fake meaning), but its
  breathe parameters become a motion profile so the SC3 bottom position is machine-checkable
  alongside the other layers.
- **D-08: Live layer re-homed, values preserved.** Live's founder-tuned constants
  (`ACT_SCALE_GAIN 1.05`, `ACT_BRIGHTEN_GAIN 0.95`, `ACT_HAZE_LERP 0.95`, decay envelope)
  migrate INTO the profile structure as the top profile — pixel-equivalent going in, no
  intended behavior change — so subordinate profiles are invariant-checked AGAINST live.
  Checkpoint may still tune.

### Machine-checkable invariants
- **D-09: Invariant numbers ratchet from the checkpoint.** Plans ship provisional band
  bounds/floors; the founder-approved values at the visual checkpoint (± small tolerance)
  become the locked band, and the test ratchets thereafter. Numbers trace to what actually
  read right on the real hull backdrop (54-05/56-05 pattern, now with a lock).
- **D-10: Single shared source of truth for constants.** The per-layer profiles (hues, dim
  floors, cadences, densities) live in ONE module consumed by both the TS viz server and the
  ES-module client — kills the WR-01 mirror-drift class structurally. Planner picks the
  idiomatic mechanism for the TS/ESM boundary.
- **D-11: WR-06 fixed in-phase, all three branches.** Fades become own-trace-scoped (each
  trace deletes only the ids it added) in the live, replay, AND spontaneous branches of
  `trace.js` — the phase rewrites fade mechanics anyway and must not inherit the known
  idle→live clobber race.
- **D-12: One dedicated invariants test file** owns all palette/motion locks: luminance-band
  membership per entry, dim floors, per-channel monotonic SC3 ordering, shared-source sync.
  Existing scattered locks (e.g. `REPLAY_DIM < 1` in viz-ambient-liveliness.test.ts) migrate
  in as their constants migrate; the never-written WR-02 lock is subsumed by the new ordering
  invariants.

### Bloom/tone-mapping calibration
- **D-13: Calibration may touch bloom composer params (threshold/strength/radius) AND
  renderer exposure/tone-mapping.** Bg color, hull material, tissue palette stay locked;
  trace-material blending modes stay additive (untouched).
- **D-14: Global bloom only.** One composer, global settings — per-layer selective bloom is
  rejected as a second salience system and a structural pipeline change.
- **D-15: Verification = founder eyeball + captured evidence.** Judged live on the real
  install at the checkpoint; the phase captures per-layer screenshots (each layer firing over
  the hull) as the durable approval record. No automated pixel/contrast assertions.
- **D-16: Two-stage founder checkpoint.** Stage 1 (mid-phase): palette-on-screen hue
  sign-off — all identity hues rendered over the hull before motion work builds on them.
  Stage 2 (closing): full-system tuning (motion profiles + bloom/exposure + final ratchet
  lock per D-09).

### Claude's Discretion
- Exact luminance metric (relative Y vs OKLCH L) and provisional band bounds — pick one,
  document it, ratchet at checkpoint (D-09).
- Mechanism for the shared constant module across the TS-server / ESM-client boundary (D-10).
- Which channels beyond attack/halo get per-layer values, and profile-block naming/shape
  (mirror the existing layer-constants style).
- Exact hue hexes for the non-roadmap-named kinds (new_node, reconsolidation, oscillation,
  neutral, recall_hop) — starting directions proposed in plans, tuned at Stage-1 checkpoint.
  Oscillation needs a non-amber-family home per D-03(b).
- How replay's per-kind pre-dimmed color construction in `trace.js` is restructured once
  replay has its own identity hue.
- Tolerance width on the D-09 ratchet.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase contract & carried findings (read first)
- `.planning/ROADMAP.md` (Phase 57 entry) — goal, 4-part approach, named starting hues,
  SC3 ordering, WR-02/WR-06 carry-forward note.
- `.planning/phases/56-spontaneous-1-hop-idle-activation/56-REVIEW.md` — **WR-02** (missing
  `SPONT_DIM < REPLAY_DIM` regression lock; subsumed by D-12) and **WR-06** (global
  `traceNodes`/`traceLinks` clear in fade timeouts clobbers concurrent live traces; fixed
  in-phase per D-11, fix sketch included in the finding). Also WR-01 (mirror drift) as the
  motivation for D-10.
- `.planning/phases/56-spontaneous-1-hop-idle-activation/56-CONTEXT.md` — the Phase 56
  decisions this phase generalizes (SPONT_DIM subordination, named-tunables pattern, founder
  checkpoint precedent).
- `.planning/phases/55-honest-1-hop-pathways-on-ambient-recall/55-CONTEXT.md` — WR-02
  `score: null` mid-intensity render rule (untouched by this phase) and the honest-trace
  invariants that must not regress.
- `docs/superpowers/specs/2026-06-29-brain-viz-honest-traces-design.md` — Phase 52 design
  contract (palette, motion vocabulary, honesty through-line) that this phase revises on the
  color side.

### Code to change (single sources of truth today)
- `src/viz/modules/constants.js:84-106` — `TYPE_COLOR` (LOCKED), `BG_COLOR` (LOCKED),
  `HOT` amber.
- `src/viz/modules/constants.js:108-129` — the live decay envelope (attack/hold/fade/floor)
  that becomes the live motion profile's timing core (D-08).
- `src/viz/modules/constants.js:148-173` — `KIND_COLOR`, the 7-entry map being redesigned;
  includes the 56-05 pastel-lavender rationale comment (the thesis this phase generalizes).
- `src/viz/modules/constants.js:329-400` — the Phase 54/55/56 layer-constants block
  (`ACT_*`, `REPLAY_*`, `TWINKLE_*`, `SPONT_*`) that restructures into per-layer motion
  profiles (D-06) in the shared module (D-10).
- `src/viz/modules/trace.js:236-253` — `KIND_COLORS` consumption + the pre-dimmed
  replay-hop color construction that D-01 replaces with a replay identity hue.
- `src/viz/modules/trace.js:692-697, 766-771, 865-870` — the three global-clear fade
  timeouts (WR-06 / D-11).
- `src/viz/server.ts` (replay scheduler ~450-479, spontaneous emitter + its constants) —
  server-side authoritative copies (`REPLAY_CADENCE_MS`, `SPONT_CADENCE_MS`,
  `SPONT_HOP_TOPN`, `SPONT_SEED_COUNT`) that fold into the shared constant source (D-10).
- Phase-15 bloom composer + renderer setup (locate in `src/viz/modules/` — the UnrealBloom
  pass and tone-mapping/exposure settings) — the D-13 calibration surface.
- Existing invariant tests to migrate: `REPLAY_DIM < 1` source-parse test
  (`viz-ambient-liveliness.test.ts:482-485`) and the Phase-56 spontaneous guard tests —
  fold into the dedicated invariants file (D-12).

### Project guards (load-bearing)
- `CLAUDE.md` (project) — faithfulness clause: viz is decorative chrome, engine mechanisms
  untouched; viz server read-only/LLM-free; graph is source of truth. This phase is
  presentation-only by contract.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- The 56-05 pastel-lavender migration (`0x8a7fff → 0xc9b8ff`, comment at
  `constants.js:167-171`) is the proven template for every hue in this redesign: keep hue
  identity, move luminance into the visible band, let non-color channels carry subordination.
- The named-tunable + founder-checkpoint pattern (54-05, 56-05) extends directly to the
  two-stage checkpoint (D-16).
- The Phase-54 source-parse invariant test pattern (`viz-ambient-liveliness.test.ts:482-485`)
  seeds the dedicated invariants file (D-12) — though D-10's shared module may allow direct
  imports instead of regex parsing.
- WR-06's fix sketch in 56-REVIEW.md (own-trace-scoped `addedIds` deletion) is directly
  implementable (D-11).

### Established Patterns
- SC3 layer hierarchy (live > replay > spontaneous > twinkle) is the load-bearing ordering —
  this phase changes its EXPRESSION (color → motion/scale), never its truth.
- Replay and spontaneous never co-render (spontaneous fires only on empty replay buffer), so
  per-pixel line-vs-line subordination between those two is not load-bearing — the invariants
  live on layer constants, not composited pixels (per the SPONT_PULSE_SCALE comment).
- Server-side authoritative copies of scheduler constants (cadence, history N) exist because
  GUI/client and server both need them — D-10 replaces the copy convention with one source.
- All founder-facing tuning happens on the live install against the real hull backdrop.

### Integration Points
- `constants.js` exports → consumed by `trace.js` (trace render), `lod.js` /haze (twinkle,
  density), `hud.js`, and mirrored in `server.ts` (schedulers) — the shared module (D-10)
  must serve all of these.
- The bloom composer + tone mapping sit in the Phase-15 render setup; calibration (D-13)
  touches only global settings there.
- The tray icon (`apps/tray`) consumes SSE trace events but not colors — no tray changes
  expected; verify no color assumptions leak there.

</code_context>

<specifics>
## Specific Ideas

- The core thesis, in the founder's own tuning history: "subordination to live/replay comes
  from SPONT_DIM + density, not from a dark hue" (56-05). Phase 57 makes that the rule for
  every layer instead of a per-layer rescue.
- Layer characters as design intent: live = sharp attack + big halo (the event); replay =
  soft echo; spontaneous = slow calm drift; twinkle = micro-breathe. Ordering invariants
  formalize this; the checkpoint tunes the feel.
- Roadmap starting hues: live amber-gold, replay ice-cyan, spontaneous lavender (already
  landed at `0xc9b8ff`), ingestion greens/magenta — all within one bounded luminance band.
- The approved Stage-2 screenshots become the durable "what right looks like" record — the
  first time viz approval leaves artifacts (D-15).

</specifics>

<deferred>
## Deferred Ideas

- **Per-layer selective bloom** (render-layer bloom separation) — rejected for this phase as
  a second salience system (D-14); revisit only if global calibration provably cannot balance
  the four layers.
- **Trace-material blending-mode changes** (additive → normal per layer) — excluded from the
  calibration surface (D-13); a future option if additive compositing remains the floor
  problem's root after this redesign.
- **Automated screenshot contrast assertions** — rejected as flaky (D-15); revisit if manual
  regression of the approved look actually recurs.

### Reviewed Todos (not folded)
- `viz-search-and-hull-quality.md` — hull front/top jaggedness + in-app search: structural
  viz work, not palette; stays pending.
- `corpus-brain-3d-transition.md` — corpus↔brain camera fly-through: structural transition
  work, not palette; stays pending.
- `2026-06-23-cache-constant-judge-extraction-prompt-prefix-via-system-pro.md` and
  `content-hardening-deferred.md` — engine-side todos; keyword-match noise, no viz relevance.

</deferred>

---

*Phase: 57-viz-activity-palette-redesign*
*Context gathered: 2026-07-02*
