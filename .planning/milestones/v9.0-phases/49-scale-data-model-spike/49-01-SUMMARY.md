---
phase: 49-scale-data-model-spike
plan: "01"
subsystem: bench-dependencies
tags: [spike, scale, ANN, HNSW, devDependency, SCALE-01, D-02, D-02b]
dependency_graph:
  requires: []
  provides: [ann_lib_provisioned, ann_loadability_verdict]
  affects: [package.json, package-lock.json]
tech_stack:
  added: [hnswlib-node@3.0.0 (devDep), vectorlite@0.2.0 (devDep)]
  patterns: [bench-only devDependency isolation, early loadability smoke-test, unmeasured-here honesty discipline]
key_files:
  created: []
  modified:
    - package.json
    - package-lock.json
decisions:
  - "Human-approved (supply-chain gate, Task 1): install BOTH hnswlib-node AND vectorlite — orchestrator presented npm registry facts; neither is a typosquat"
  - "Both libs installed under devDependencies ONLY — production dependency tree untouched (D-02)"
  - "Loadability verified EARLY before any harness work (D-02b): BOTH load + build a tiny dim=1536 HNSW index and add/query OK on this machine (darwin-arm64)"
  - "vectorlite ships a prebuilt @1yefuwang1/vectorlite-darwin-arm64 binary and loads as a better-sqlite3 extension — UNLIKE sqlite-vec in Phase 41, it is measurable here; no unmeasured-here fallback was needed"
metrics:
  duration: "~5 minutes"
  completed: "2026-06-28"
  tasks_completed: 2
  files_modified: 2
---

# Phase 49 Plan 01: Provision ANN HNSW devDependency + Early Loadability Verdict

## What was built

Provisioned the approximate-nearest-neighbor (HNSW) measurement arm for the SCALE-01 crossover
benchmark as **bench-only devDependencies**, and verified their loadability on this machine
**before** any harness code is written (D-02b — fail fast, never fabricate later).

**Task 1 — Package-legitimacy gate (blocking-human, approved).** No RESEARCH.md legitimacy-audit
table exists for this phase, so both candidate packages were `[ASSUMED]` and required human
verification. The orchestrator pulled npm registry facts and presented them; the human approved
installing **both**:

| Package | Version | Weekly dl | License | Role |
|---------|---------|-----------|---------|------|
| `hnswlib-node` | 3.0.0 | ~96,000 | Apache-2.0 | native node-addon HNSW (the D-02b fallback, most likely to give real numbers) |
| `vectorlite` | 0.2.0 | ~388 | Apache-2.0 | SCALE-01's named primary — sqlite loadable-extension HNSW |

**Task 2 — Install + early loadability smoke-test.** Installed both via `npm install --save-dev`.
Confirmed placement: both under `devDependencies`, neither under `dependencies` (D-02 satisfied —
production tree untouched). Ran a per-lib smoke test (require → build a dim=1536 index → add+query
one point):

| Lib | Loads | Builds | Query | Verdict |
|-----|-------|--------|-------|---------|
| `hnswlib-node` 3.0.0 | ✓ | ✓ (native node-gyp addon) | ✓ | **measurable here** |
| `vectorlite` 0.2.0 | ✓ | ✓ (loaded as better-sqlite3 extension via prebuilt `@1yefuwang1/vectorlite-darwin-arm64`) | ✓ (knn_search virtual table) | **measurable here** |

## Notable result

Both ANN candidates are loadable+measurable on this machine. This is **better than the Phase-41
precedent**, where `sqlite-vec` would not load at all and was recorded `unmeasured-here`. Here,
`vectorlite` (also a sqlite loadable extension) DOES load because it ships a prebuilt darwin-arm64
binary. Consequence for Plan 02: the harness can measure BOTH `vectorlite` (the requirement's named
primary) and `hnswlib-node`, rather than falling back to a single arm. No `unmeasured-here` fallback
was needed at provisioning time — but the harness must still retain the honest fail-path per D-02b.

## Key files
- `package.json` — `hnswlib-node@^3.0.0` and `vectorlite@^0.2.0` added under `devDependencies`.
- `package-lock.json` — lockfile updated (4 packages added).

## Self-Check: PASSED
- Both libs present in `devDependencies`, absent from `dependencies` (D-02). ✓
- Early loadability honestly recorded — both load+build+query at dim=1536 (D-02b); no fabricated success. ✓
- Production dependency tree unchanged (deps still: better-sqlite3/openai/zod/etc). ✓
