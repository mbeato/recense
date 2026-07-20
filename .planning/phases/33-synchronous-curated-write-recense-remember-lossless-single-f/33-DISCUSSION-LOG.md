# Phase 33: Synchronous Curated Write (recense remember) - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-20
**Phase:** 33-synchronous-curated-write-recense-remember-lossless-single-f
**Areas discussed:** In-place update UX, Curated-fact authority, Native cutover blast radius, Migration verify gate

---

## In-place update UX

| Option | Description | Selected |
|--------|-------------|----------|
| Auto-apply + report | Apply the in-place update, then print what changed; trusts the eval-backed judge, no friction (~2–5s explicit write). | ✓ |
| Confirm before overwrite | Show old vs new, ask y/N before tombstoning; safer but adds a prompt to every contradicting remember. | |
| Silent store | Terse 'stored' line, no reconsolidation detail; hides the differentiator. | |

**User's choice:** Auto-apply + report (approved the exact `updated: "<prev>" → "<now>"` preview format).
**Notes:** A `--confirm` flag may be a future opt-in (D-02); default is auto-apply.

---

## Curated-fact authority

| Option | Description | Selected |
|--------|-------------|----------|
| Curated is authoritative | Hard origin-guard: observed can NEVER tombstone asserted_by_user; explicit remember always wins. | |
| High-resistance seeding only | No new guard; seed curated facts high `s`/`c` so PE routing makes them hard (not impossible) to passively overwrite. | ✓ |
| Decay-exempt only, symmetric routing | Only decay protection; PE magnitude alone decides both directions. | |

**User's choice:** High-resistance seeding only — deliberately rejected a hard origin-guard as over-engineering.
**Notes:** Triggered a follow-up on the explicit-correction tension (resolved below).

### Follow-up — Force update on explicit contradiction

| Option | Description | Selected |
|--------|-------------|----------|
| Explicit write forces reconcile | An explicit remember flagged as contradiction always at least reconciles; high-resistance still shields the passive direction. | ✓ |
| Normal PE routing both ways | Explicit remember could HOLD against a high-resistance fact; correction silently not-applied. | |
| Seed lower resistance instead | Don't force; seed moderate so both directions route normally — reopens the passive-overwrite risk. | |

**User's choice:** Explicit write forces reconcile.
**Notes:** Resolves the tension that high-resistance seeding would otherwise drop explicit corrections (D-03 + D-04 asymmetry).

---

## Native cutover blast radius

| Option | Description | Selected |
|--------|-------------|----------|
| Global ~/.claude/CLAUDE.md | Directive applies to every project; fully closes the replaces-MEMORY.md promise across customer-zero. | ✓ |
| brain-memory project CLAUDE.md only | Scoped/safe, but other projects still leak to .md files. | |
| Global + project reinforcement | Both, belt-and-suspenders. | |

**User's choice:** Global ~/.claude/CLAUDE.md (D-06).

### Follow-up — settings.json kill-switch posture

| Option | Description | Selected |
|--------|-------------|----------|
| Investigate + apply if real | Research a real native-memory disable switch; set it if it exists, else directive carries it + document. | ✓ |
| Hard requirement | Must mechanically block native memory (PreToolUse-deny hook if no setting); could over-block. | |
| Directive only | Skip the investigation; rely on the global directive. | |

**User's choice:** Investigate + apply if real (D-07).

---

## Migration verify gate

| Option | Description | Selected |
|--------|-------------|----------|
| Per-file node-exists by hash | Deterministic value/value_hash check that the fact landed before archiving that file; not cosine-dependent. | ✓ |
| Per-file recall round-trip | Confirm via `recense recall`; cosine-gated, unreliable as a delete gate. | |
| Batch count delta | Migrate all, confirm count rose, delete all; weakest (metric-artifact risk). | |

**User's choice:** Per-file node-exists by hash (D-08).

### Follow-up — Disposition + scope

| Option | Description | Selected |
|--------|-------------|----------|
| Archive + scope=brain-memory | Move verified .md to a backup dir (safety net); all 12 scoped brain-memory (cwd-derived). | ✓ |
| Hard-delete + scope=brain-memory | rm each file after its check; no backup. | |
| Archive + hand-scope cross-project ones | Archive + manually broaden scope on the ~3–4 cross-project memories. | |

**User's choice:** Archive + scope=brain-memory (D-09/D-10). MEMORY.md index archived too as part of cutover.

---

## Claude's Discretion

- `remember-cli.ts` shape + dispatcher wiring (require vs spawnScript).
- How the synchronous mini-pass reuses the consolidation machinery (one-candidate path through `applyDecision` vs thinner bespoke loop over the same pure routing + sink).
- Embedder + top-k neighbor retrieval params (`k`, cosine floor) for the write.
- Lock scope / interaction with a concurrent hourly sleep pass.
- Concrete seeded `s`/`c` resistance values for curated facts (D-03 planner flag).
- Whether `origin='asserted_by_user'` alone is the decay/eviction shield or a node column is needed (D-05).

## Deferred Ideas

- `--confirm` confirm-before-overwrite flag (future opt-in).
- Per-file hand-scoping of cross-project memories.
- Heavyweight PreToolUse-deny hook (only if no real settings.json switch exists).
- Multi-fact input splitting (would reintroduce lossy extraction — out of scope).
