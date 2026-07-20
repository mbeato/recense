# Phase 32: Project Recall + Auto-Corpus - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-20
**Phase:** 32-project-recall-auto-corpus
**Areas discussed:** Recall scope semantics, Corpus anchoring, Trigger timing, Promotion gating, Bypass scope, Deferred-path signal

---

## Recall scope semantics (RECALL-01)

| Option | Description | Selected |
|--------|-------------|----------|
| Project-only, strict | Only node_scope == slug; excludes other projects AND global | |
| Project + global | Project-scoped facts plus 'global'; excludes other named projects only | ✓ |
| Project-only, fall back to global if empty | Strict, widen to global only on empty result | |

**User's choice:** Project + global
**Notes:** A project view should carry shared/global knowledge; SC1 satisfied by excluding *other named* projects. Filtering stays post-retrieval (preserves D-S1, scope never feeds ranking).

---

## Corpus anchoring (RECALL-02)

| Option | Description | Selected |
|--------|-------------|----------|
| One project-overview doc | New scope-anchored doc, schemas as thesis sections; no per-schema docs | |
| Per-schema docs (existing model) | Reuse schema-anchored promoter; graph is the overview | |
| Both: per-schema chapters + project landing doc | Existing chapters AS-IS + thin project-root landing doc linking them | ✓ |

**User's choice:** Both: per-schema chapters + project landing doc
**Notes:** Single coherent project-overview entry point (landing doc, slug = project scope, via existing project-scope generateDoc()) backed by detailed per-schema chapters.

---

## Trigger timing (RECALL-02)

| Option | Description | Selected |
|--------|-------------|----------|
| Deferred to sleep pass only | Auto-promote+generate offline; browsable after next hourly pass | |
| Also inline on --consolidate | Plus run promote+generate under the lock when --consolidate is passed | ✓ |

**User's choice:** Also inline on --consolidate
**Notes:** Deferred default unchanged (D-01); inline path makes the project browsable the instant ingest-project --consolidate returns.

---

## Promotion gating (RECALL-02)

| Option | Description | Selected |
|--------|-------------|----------|
| Scope-anchored always-promote | Promote project corpus regardless of global mass gate | ✓ |
| Trust existing mass gate | Thin projects simply don't promote yet | |

**User's choice:** Scope-anchored always-promote
**Notes:** A freshly-onboarded project that silently fails the mass gate (no corpus) is the failure mode being designed out.

---

## Bypass scope (follow-up to promotion gating)

| Option | Description | Selected |
|--------|-------------|----------|
| Project landing doc + its schema chapters only | Bypass mass gate for the onboarded project only; global/conversation schemas keep mass-hysteresis | ✓ |
| Project landing doc only | Landing doc day-one; chapters still wait for mass gate (risk of dangling links) | |

**User's choice:** Project landing doc + its schema chapters only
**Notes:** Bypass strictly bounded to the onboarded scope — no polluting the organic/global corpus with thin schemas; landing doc has no dangling chapter links.

---

## Deferred-path force-promotion signal (follow-up to trigger timing)

| Option | Description | Selected |
|--------|-------------|----------|
| Pending-promotion marker in meta | ingest-project writes marker; next sleep pass consumes+clears it | |
| Derive from node_scope at promote time | Promote any scope with facts but no landing doc; no marker | |
| Let Claude/research decide | Defer mechanism to planner/researcher, meta marker as leading candidate | ✓ |

**User's choice:** Let Claude/research decide
**Notes:** Meta marker (`pending-corpus-promotion:<scope>`) recorded in CONTEXT.md as the recommended/leading candidate (reuses cursor/meta plumbing, crash-safe).

---

## Claude's Discretion

- Deferred-path force-promotion signal mechanism (meta marker leading candidate — D-05).
- Landing-doc → chapter edge model (doc_containment parent→child likely fit).
- Where scope filtering sits in RecallEngine; empty-result handling for {scope, global}.
- Whether ambientRecall (session-start inject) also gains a scope filter (not a deliverable).

## Deferred Ideas

- Scope-filtered session-start ambient inject.
- Derive-from-DB force-promotion (weaker than meta marker).
- Mass-gate bypass for non-onboarding scopes — explicitly rejected.
