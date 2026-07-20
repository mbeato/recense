# Phase 28: Schema-Anchored Corpus - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-19
**Phase:** 28-schema-anchored-corpus
**Areas discussed:** Ladder enrichment (Req 3), Promotion gate + noise (Req 2), Corpus edges (Req 4), Gather re-anchoring (Req 1)

---

## Ladder enrichment (Req 3)

### Primary signal for the parent→child ladder

| Option | Description | Selected |
|--------|-------------|----------|
| Shared-evidence containment | A is child of B when A's abstracts-evidence is subsumed by B's; directional (bigger set = parent); LLM-free over existing 985+422 abstracts edges | ✓ |
| Re-tune existing centroid-cosine | Lower SREL-01 threshold + tune SREL-02 cut; cheapest but undirected topical signal, needs a separate parent/child rule | |
| Super-schema hierarchy as-is | Render SREL-02 tree deeper; minimal code but nests under synthetic `super:` stub nodes | |

**User's choice:** Shared-evidence containment.
**Notes:** Centroid-cosine demoted to tie-breaker — it can't give direction; containment gives parent/child for free and reuses edges already in the DB.

### Edge-formation rule + multi-overlap handling

| Option | Description | Selected |
|--------|-------------|----------|
| High ratio = containment tree; mid ratio = reference | ratio ≥0.7 + directional → containment (single strongest parent = forest); ≥N shared / ratio 0.2–0.7 → undirected reference; min-evidence floor ≥4 | ✓ |
| Strict full-subset only | ratio ≥0.9; very clean but risks under-shooting the "exceed ~95 baseline" target | |
| Moderate multi-parent DAG | ratio ≥0.5, multiple parents; richer but tangled in the flat graph | |

**User's choice:** High ratio = containment tree; mid ratio = reference.
**Notes:** Both Req-3 and Req-4 edges fall out of one shared-evidence query.

### Where to materialize the derived relations

| Option | Description | Selected |
|--------|-------------|----------|
| On the doc nodes only | parent-doc → child-doc edges; source schemas gain 0 edges → Req-5 holds by construction | ✓ |
| Also write schema↔schema edges | Literal Req-3 wording but adds edges incident to source schemas; extra Req-5 invariant + test surface | |

**User's choice:** On the doc nodes only.
**Notes:** Req-5 self-confirmation guard satisfied by construction; each doc 1:1 with a schema so "relations exceed ~95" holds via doc-projected relations.

### Where the offline promote+derive+stub+wire step runs

| Option | Description | Selected |
|--------|-------------|----------|
| Dedicated idempotent CLI command | One transaction, run on demand; controllable; avoids per-pass thrash | (clarified) |
| Ride the sleep-pass Phase C | Automatic refresh next to SchemaRelationDeriver; thrash risk | (clarified) |

**User's choice:** *Clarified — not mutually exclusive.* Build as one idempotent function packaged as a CLI command (free for manual/test) AND wire it into the sleep pass for automatic refresh. Auto-refresh is the chosen production mode.
**Notes:** User asked "if we do the CLI does that mean it'll be manual? if yes then ride along with the sleep pass." Resolved: CLI = packaging, sleep-pass = caller; do both.

### Prevent doc-node thrash at the threshold

| Option | Description | Selected |
|--------|-------------|----------|
| Hysteresis band | Promote ≥12, demote <8; flickering schemas keep their doc; two constants in the gate | ✓ |
| Never auto-demote | Zero flap but accumulates stale docs, needs manual prune | |
| Single threshold, accept flap | Simplest, but borderline schemas churn their doc nodes pass-to-pass | |

**User's choice:** Hysteresis band.

---

## Promotion gate + noise (Req 2)

### What "evidential mass" counts

| Option | Description | Selected |
|--------|-------------|----------|
| Distinct evidence-member count | `COUNT(DISTINCT dst)` over abstracts edges; same set the containment derivation uses | ✓ |
| Member count weighted by s/c | Slightly better quality signal, marginally more SQL; artifact-facts often aren't low-confidence | |
| Raw incident-edge count (all kinds) | Broadest but mixes schema_rel/relation edges into importance; double-counts | |

**User's choice:** Distinct evidence-member count.
**Notes:** Gate and ladder share one computation.

### Keeping dogfooding-meta out

| Option | Description | Selected |
|--------|-------------|----------|
| Member-shape token penalty | Down-rank when members are non-prose tokens (hashes/paths/ids/urls/timestamps) or label matches meta keywords; LLM-free | ✓ |
| Provenance / scope filter | Demote schemas dominated by the Claude-Code turn-capture source; blunt — real dogfooding insights share that provenance | |
| Ship pure-mass, denylist reactively | No filter in v1, inspect, add denylist; honest MVP but first render is noise-heavy | |

**User's choice:** Member-shape token penalty.
**Notes:** Scope-diversity explicitly rejected — meta-noise is ubiquitous across projects, so a diversity signal would BOOST it. A token-dominated schema also generates poor prose, so this protects quality too.

---

## Corpus edges (Req 4)

### Rendering the two edge types + the degenerate scope docs

| Option | Description | Selected |
|--------|-------------|----------|
| Distinct styling, scope-doc joins via reference | Containment solid/directed (hierarchy spine), reference faint/dashed; scope-doc woven in via reference overlap | ✓ |
| Single edge style, scope-doc isolated | Simpler but hierarchy doesn't read and the project doc looks orphaned | |
| You decide (planner picks within corpus.js) | Capture as Claude's discretion | |

**User's choice:** Distinct styling, scope-doc joins via reference.

---

## Gather re-anchoring (Req 1)

### How the gather re-roots from scope-slug to schema

| Option | Description | Selected |
|--------|-------------|----------|
| Evidence spine + centroid-seeded semantic + re-rooted hop | Spine = abstracts-evidence; semantic = hybridTopk(member centroid); entity-hop re-rooted at the schema's entities | ✓ |
| Evidence spine + label-embed semantic | Same spine but embeds the induced label; labels often short/fallback → weak query vector | |
| Evidence-set only (no semantic breadth) | Tightest faithfulness but loses the breadth that made Phase-27 docs read well | |

**User's choice:** Evidence spine + centroid-seeded semantic + re-rooted hop.
**Notes:** Centroid is the faithful semantic center and is already computed by SchemaRelationDeriver — no reliance on weak induced labels, no extra embed call.

## Claude's Discretion

- Concrete threshold values (containment ratio ~0.7, reference shared-min N ~3, min-evidence floor ~4, hysteresis ~12/~8, token-fraction cutoff ~0.6) — set against live brain.
- New doc-corpus edge `kind`s + DDL/CHECK extension; whether to retire `doc_link`.
- Corpus graph endpoint shape (`/graph?type=doc`).
- CLI command name for the promote pass.
- Schema-thesis generation-prompt framing (reuse Phase-27 generator).
- Sleep-pass Phase C wiring point.

## Deferred Ideas

- Entity-anchored docs (SPEC-deferred, v1 = schema + scope only).
- Section-level / partial regen (inherited Phase-27 deferral).
- Centroid-cosine as a real secondary blend signal (if containment-only under-shoots depth).
- LLM-derived ladder (rejected for v1; revisit only if structural containment can't reach depth).
