---
phase: 52-brain-viz-honest-traces
plan: 06
type: execute
status: gap
outcome: punch-list
verified_by: founder (live, packed app)
date: 2026-06-29
---

# 52-06 — Founder Visual Verification — SUMMARY

## Outcome: VERIFIED-WITH-PUNCH-LIST (not clean sign-off)

The Phase 52 honest-traces **code is verified correct end-to-end**. The founder visual
review surfaced **one presentation gap** (node-flash prominence) that is being routed to a
fast-follow fix. This is **not a Phase 52 logic defect** — the engine, bridge, server SSE
pipe, kinds, colors, choreography, and decay envelope are all correct and machine-verified.

## What was confirmed working (live, against the founder's real DB + packed app)

Verification was driven by inserting real `activation_trace` rows and observing the live
`recense viz` (packed Electron app, pid-9237/14606 viz server on 127.0.0.1:7810).

- **Engine writes correct `kind` rows** — `new_node`, `reconsolidation`, `oscillation`,
  `consolidate` all land in `activation_trace` with the right shape (verified in DB).
- **Server SSE pipe works** — `SELECT … WHERE id > cursor` poll + broadcast delivers newly
  committed rows to connected clients. Proven by direct synthetic-row insert streaming to a
  connected SSE client on BOTH a fresh server instance AND the live server (curl confirmed
  100% delivery across every test batch).
- **Client renders received traces** — `spawnPulse` edge wavefronts render visibly; the
  founder saw the green arriving-evidence pulse of the reconsolidation choreography.
- **WAL cross-process visibility is fine** — long-lived AND fresh readonly connections both
  observe writes committed by separate writer processes (tested, rejected as a cause).

## The gap (punch-list item)

**Node-activation flashes are imperceptible at overview zoom in the dock.**

Root cause (code-traced, not guessed):
- In the ~2,700-node overview, nodes are **haze instances** (`InstancedMesh`, `__hazeIdx`),
  not individual meshes.
- `activate(node, level, kindColor)` (`trace.js:208`) and `revealTrace` (`lod.js:229–237`)
  light a haze node by **tinting a single instance's color** via `setColorAt` for ~1–2s.
  They do NOT enlarge the node or promote it to a prominent glow mesh.
- One tiny point briefly shifting color among thousands is invisible at overview scale in the
  small dock/popover — whereas `spawnPulse` edge wavefronts (bright additive lines spanning
  the graph) are visible. Hence "saw green [edge pulses], never the magenta [node flash]."
- Matches the founder's prior observation: *"hard to tell there are 3 colors on the trace in
  the dock — only visible at large sizes."*

### Two confounds that masked verification during the live session (NOT bugs)
1. **Sleep-lock contention** — a consolidation pass held the write lock for most of the
   session (`recense remember: Lock held by another process`), so live recall/remember
   triggers wrote **no** `activation_trace` rows → nothing to render. (Known issue, in
   founder memory.) Diagnostic traces were inserted directly via `sqlite3` to bypass this.
2. **Off-graph node references** — synthetic probes and sleep-pass `consolidate` rows
   referenced node ids not in the current view; `applyTrace` correctly no-ops on those
   (`ctx.idMap.get → return`), so no visible pulse. Fixed by retargeting probes at the
   highest-degree hub node (`ce2ed7a4… "recense"`, degree 206).

## Fast-follow (the punch-list)

**FIX-52A — node-flash prominence.** Make node activations legible at overview zoom. Candidate
approaches (decide in plan):
- Boost haze-instance activation magnitude (larger per-instance brightness / additive bloom),
  and/or temporarily scale the lit instance.
- Promote trace seed/hero nodes to a short-lived prominent glow mesh for the activation window
  (esp. the `reconsolidation` magenta hero), then demote on fade.
- Verify `hazeMesh.instanceColor.needsUpdate` + bloom interaction actually surface the tint.

Scope note: presentation-only; must not touch the (verified) activation_trace data path,
kind mapping, or choreography logic.

## Status
- Plans 52-01…52-05: complete + machine-verified (2,442 tests green).
- Plan 52-06: **gap / punch-list** — code verified, visual sign-off deferred to FIX-52A.
