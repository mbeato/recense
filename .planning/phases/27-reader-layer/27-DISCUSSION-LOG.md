# Phase 27: Reader Layer - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-18
**Phase:** 27-reader-layer
**Areas discussed:** Gather strategy, Generation model & cost, Reader entry & corpus graph, Staleness surfacing UX

---

## Gather strategy

### How to gather facts for a doc

| Option | Description | Selected |
|--------|-------------|----------|
| Scope + semantic union | node_scope.scope='<slug>' ∪ Phase-26 semantic gather; drop lexical | ✓ |
| Scope-based only | node_scope only — clean but risks incompleteness | |
| Keep slice's lexical+entity | proven gather, but skews to literal name matches | |

**User's choice:** Scope + semantic union.

### Generation trigger / lifecycle

| Option | Description | Selected |
|--------|-------------|----------|
| Manual CLI, per-project | `recense gen-doc <project>` on demand | |
| CLI with batch-all | per-project + `--all` (rejected before answer) | |
| Auto on scope change | regen on fact change via sleep-pass | |

**User's choice:** Neither as posed — user proposed an **in-between lazy/on-access model**: store each project, generate/update on access, worried about compute-on-access; suggested a loading bar or per-project generate button.
**Notes:** Reformulated into the cache-backed lazy model (CONTEXT D-02): first view generates + caches as the doc node; later views serve cached instantly LLM-free; stale views serve cached + regen affordance. Compute only on first-gen + explicit regen — resolves the compute-on-access worry and folds into READER-03.

### First-view behavior (no doc yet)

| Option | Description | Selected |
|--------|-------------|----------|
| Auto-generate + loading bar | generate on first open, cache after | |
| Show a Generate button | explicit, zero surprise spend | |
| You decide | pick based on gen speed | ✓ |

**User's choice:** You decide — tied to model speed.
**Notes:** Resolved in CONTEXT D-03 to auto-generate + honest loading bar, single path (no speed-detection branching), consistent with the "fewer levers" preference from the model decision.

---

## Generation model & cost

| Option | Description | Selected |
|--------|-------------|----------|
| API Sonnet | slice-proven prose, fast, pennies at lazy volume | |
| DeepSeek V4 | cheap-strong, separate balance, needs prose validation | |
| Local stack (qwen 35b) | $0/offline, prose unvalidated, slow | |

**User's choice (free text):** "probably match the judge model set in the env makes most sense unless we want another var but less levers for devs… don't see much use out of having a specific model just for prose gen."
**Notes:** Decision (D-04): no new `docModel` var — doc gen reuses the configured judge-tier model from env. D-05 caveat: slice proved Sonnet prose; spot-check if env judge is local 35b / `/no_think`.

---

## Reader entry & corpus graph

| Option | Description | Selected |
|--------|-------------|----------|
| Corpus graph is home | viz opens to doc→doc graph | |
| Brain-first, doc on demand | brain home, corpus secondary | (basis) |
| Doc index list | flat list entry | |

**User's choice (free text):** "keep the brain viz visible on open (one of the strongest things about this project); doc→doc graph is a good secondary, explicit button to swap views, but only in the expanded view — not in the tray (would clutter it)."
**Notes:** Captured as D-07. Then the reader-entry fork was asked:

### How to open the prose reader

| Option | Description | Selected |
|--------|-------------|----------|
| Both entry points | brain entity → open doc AND corpus doc-node → open | ✓ |
| From the brain only | brain entity is the only launcher | |
| From the corpus graph only | requires brain → swap → corpus → doc hop | |

**User's choice:** Both entry points (D-08).

---

## Staleness surfacing UX

| Option | Description | Selected |
|--------|-------------|----------|
| Banner + inline markers | top banner + regen CTA + inline change/tombstone markers + diff in atom panel | ✓ |
| Banner only | summary + regen, no per-ref decoration | |
| Inline markers only | per-ref marks, no global CTA | |

**User's choice:** Banner + inline markers (D-10).

---

## Claude's Discretion

- v11 schema migration (`node.type`→`doc`, `edge.kind`→`cites`/`doc_link`).
- Consolidator doc-write path (vs guarded sibling) with lifecycle exemption.
- Dedicated `generated_at` column (vs reusing `last_access`).
- `/graph?nodeIds=` server-filter vs client-side `lod.js` focus.
- `doc_link` edge derivation from `recense://doc/` refs in prose.
- First-view auto+loading-bar (derived from the "fewer levers" preference).

## Deferred Ideas

- Section-level regen (READER-05, v2).
- Scheduled/auto regen on `last_access` advance (READER-06, v2).
- Soft cwd recall boost (SCOPE-05, v2).
- `viz-search-and-hull-quality` todo — reviewed, not folded (distinct viz feature).
- `content-hardening-deferred` todo — reviewed, not folded (ingestion hardening).
