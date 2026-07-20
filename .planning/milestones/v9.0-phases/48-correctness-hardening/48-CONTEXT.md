# Phase 48: Correctness Hardening - Context

**Gathered:** 2026-06-27
**Status:** Ready for planning

> Generated in `--auto` mode (single pass, recommended defaults selected and logged). Review before planning.

<domain>
## Phase Boundary

Close four correctness gaps from the ARCH-REVIEW, each backed by a regression test that reproduces the exact failure mode:

- **HARD-01 (C-2):** assistant output captured `origin:'observed'` must not strengthen a fact without a judge (uphold the never-let-inferred/self-output-strengthen invariant).
- **HARD-02 (M-5):** all write transactions run `db.transaction().immediate()` so a lost WAL upgrade race no longer aborts the whole sleep pass on `SQLITE_BUSY_SNAPSHOT`.
- **HARD-03 (M-9):** `initSchema` reads the stored `schema_version` first and throws on `stored > compile-time` (no silent re-stamp by a stale binary).
- **HARD-04 (L-2):** embedding **model + dims** are stamped in meta at first embed and asserted on write/decode (a dims/model change fails closed instead of silently producing NaN cosines).

**Independent of Phases 46/47.** Engine invariants hold: single-tenant, graph is source of truth, vector index a derived cache, online paths LLM-free, no accuracy regression traded for the hardening, net-zero new runtime deps.

**Out of scope:** the other ARCH-REVIEW findings (M-4 SDK timeouts, L-6 hard-keep pinning, H-2/H-4) — not in this phase's four-item boundary.
</domain>

<decisions>
## Implementation Decisions

> **CRITICAL framing — verify-first, not greenfield.** Live-source grep (2026-06-27) shows three of the four guards are *already implemented in code* with explicit M-5/M-9/C-2 comments, and the fourth is half-done. The ARCH-REVIEW and REQUIREMENTS.md (which list these as "Pending") drifted behind the code. **Live code wins.** Phase 48 is overwhelmingly an *audit-then-close-gaps + add-the-mandated-regression-test* phase, NOT a build-from-scratch phase. The single genuine code gap is the embedding **model** stamp (HARD-04). The researcher MUST establish current coverage per item against live code before the planner writes any build task — do not re-implement guards that already exist.

### D-01 — Per-item: audit current coverage, then close only the real gap (recommended default)
For each of HARD-01..04, the plan is: (1) confirm the existing guard against the cited live-code anchor, (2) build only if a genuine gap remains, (3) add the regression test the requirement mandates. Current findings:
- **HARD-01 / C-2 — guard EXISTS.** `consolidator.ts:1079-1082` already structurally blocks strengthen for assistant-role episodes (`if (decision.episodeRole !== 'assistant')`), the chosen ARCH-REVIEW fix ("restrict confirm→strengthen to user-role episodes"). `episodeRole` is threaded through the decision struct (`consolidator.ts:161,730,824,907`). **Work = audit airtightness (incl. the exact-match D-17 fast path and the extend/unrelated mint path the review flagged) + regression test.** Note the review allows assistant claims to *extend/append*, only never *strengthen* — so an assistant-origin minting an `observed` node via extend is by-design, not a bug.
- **HARD-02 / M-5 — guard EXISTS.** `.immediate()` is on `txUpsertNode` (`semantic-store.ts:288-295`) and the sleep-pass writers (`schema-relations.ts`, `insight-reflector.ts`, `doc-writer.ts`, `decay.ts:218-230`). **Work = audit that every consolidator Phase-B write txn is `.immediate()` + regression test.**
- **HARD-03 / M-9 — guard EXISTS, looks complete.** `schema.ts:607-623` reads stored version first, throws on `stored > SCHEMA_VERSION`, stamps only on fresh/upgrade. **Work = regression test proving the throw fires (likely test-only).**
- **HARD-04 / L-2 — PARTIAL, the one real build.** `semantic-store.ts:374-391` stamps/asserts `embedding_dims` (fail-closed on mismatch); read-side dim guard at `topk.ts:337,407`. The **model name is NOT stamped/asserted** — the requirement says "model + dims." **Work = extend the `setEmbedding` meta-guard to also stamp+assert `embedding_model`, fail-closed mirroring the dims path + regression test.**

### D-02 — HARD-04 model-stamp shape: mirror the existing dims path (recommended default)
Add `embedding_model` to meta on first embed and assert on subsequent writes, exactly mirroring the `embedding_dims` stamp/assert at `semantic-store.ts:386-391` (throw on mismatch, fail closed). Single new meta key, same code shape, same single-writer (`setEmbedding`) site. No new config surface. Source of the model string: the embedder's configured model name (`src/model/embedder.ts`).

### D-03 — Regression-test style: per-item, colocated, reproduces the exact failure (recommended default)
Each requirement gets a focused regression test in the existing vitest suite, colocated with the unit under test (schema, semantic-store, consolidator). Each test reproduces the named failure mode:
- HARD-01: feed an assistant-role `origin:'observed'` echo of an injected fact through the confirm path; assert node strength does **not** increase (and no judge-bypass strengthen).
- HARD-02: assert the consolidator Phase-B / `txUpsertNode` write txn runs in IMMEDIATE mode (prefer asserting `.immediate()` is the call path over a flaky real-concurrency race — see D-04).
- HARD-03: open a DB stamped to `SCHEMA_VERSION+1`, call `initSchema`, assert it throws (no re-stamp).
- HARD-04: call `setEmbedding` with a mismatched model (and separately mismatched dims); assert it throws fail-closed.

### D-04 — HARD-02 concurrency test: assert IMMEDIATE mode, not a live race (recommended default)
A deterministic WAL upgrade-race test is flaky. Prefer a test that asserts the write transactions are opened `.immediate()` (e.g., spy/assert on the transaction wrapper, or a focused two-connection test that confirms the sleep-pass write does not throw `SQLITE_BUSY_SNAPSHOT` while a concurrent episode append holds a shared lock). Avoid timing-dependent flakiness; correctness of the lock discipline is what's under test.

### Claude's Discretion
- Exact test file placement and naming, and whether HARD-03's test extends an existing schema test vs. a new file — planner/executor's call.
- Whether HARD-01's audit surfaces a residual gap in the D-17 exact-match fast path that needs a code change vs. test-only — researcher decides from the live trace.

### Reviewed Todos (not folded)
The phase-matcher surfaced four todos by keyword overlap; **none were folded** — all are false positives against this phase's correctness scope:
- `content-hardening-deferred.md` — content-ingestion items (transcript speaker roles, PDF extraction, gmail prompt, threshold tuning); unrelated to HARD-01..04.
- `cache-constant-judge-extraction-prompt-prefix.md` — prompt-prefix caching; cost, not correctness.
- `corpus-brain-3d-transition.md` / `viz-search-and-hull-quality.md` — viz; unrelated.
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Locked requirements (read first)
- `.planning/REQUIREMENTS.md` §"HARD — Correctness hardening (from ARCH-REVIEW)" — HARD-01..04 are the locked, authoritative requirement statements + status table.

### Authoritative finding source (defines C-2/M-5/M-9/L-2)
- `.planning/ARCH-REVIEW.md` — rows **C-2** (line ~60), **M-5** (~81), **M-9** (~85), **L-2** (~95): each row gives the original file:line anchors, the failure mechanism, and the recommended fix. The single source of truth for *why* each guard exists and what "closed" means. (Note: file:line anchors in the review predate the current guards — verify against live code below.)

### Live-code anchors (current state — verify here, the review's anchors are stale)
- `src/consolidation/consolidator.ts:1079-1082, :161, :93, :730, :824, :907` — C-2 assistant-role strengthen block + `episodeRole` threading (HARD-01).
- `src/db/semantic-store.ts:288-295` — `txUpsertNode` `.immediate()` wrapper (HARD-02).
- `src/consolidation/{schema-relations,insight-reflector,doc-writer}.ts`, `src/strength/decay.ts:218-230` — other `.immediate()` sleep-pass writers (HARD-02).
- `src/db/schema.ts:607-623` — read-first `schema_version` downgrade guard (HARD-03).
- `src/db/semantic-store.ts:374-391` — `embedding_dims` stamp/assert; **`embedding_model` stamp is the gap** (HARD-04).
- `src/retrieval/topk.ts:337, :407` — read-side dim guard (HARD-04).
- `src/model/embedder.ts` — source of the embedding model name string (HARD-04 build).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`setEmbedding` meta stamp/assert pattern** (`semantic-store.ts:374-391`): the `embedding_dims` fail-closed guard is the exact template for the new `embedding_model` guard — copy its shape (getMeta → if absent setMeta, else throw-on-mismatch).
- **`getMeta`/`setMeta`** on the store: the meta key/value plumbing already exists (used by dims + schema_version).
- **`.immediate()` transaction wrapper idiom**: established across the sleep-pass writers — any newly-touched write txn should match it.

### Established Patterns
- **Single-writer discipline**: `setEmbedding` is the ONLY writer of `node.embedding`; the model/dims guard lives there by construction (no other write site to also guard).
- **Fail-closed on meta mismatch**: dims and schema_version both throw rather than silently proceed — HARD-04's model guard must match (no warn-and-continue).
- **`episodeRole` carried through the decision struct**: C-2's strengthen gate keys off `decision.episodeRole`, set from `episode.role` at every `applyDecision` call site.

### Integration Points
- HARD-04 change is confined to `setEmbedding` + one meta key; no migration (meta is key/value, fresh key on first write).
- HARD-01/02/03 are expected to be test-only or audit-only unless the researcher finds a residual code gap.

</code_context>

<specifics>
## Specific Ideas

- No accuracy regression is acceptable for these guards (engine invariant) — HARD-01's strengthen block and HARD-04's fail-closed assert must not change clean-case behavior; regression tests should also assert the happy path still passes (matching model/dims → no throw; user-role confirm → still strengthens).
- "Each with a regression test" is a hard requirement from the roadmap line, not optional — a guard without its reproducing test does not count as closed.

</specifics>

<deferred>
## Deferred Ideas

- ARCH-REVIEW findings **M-4** (SDK timeouts + recall lock-narrowing), **L-6** (hard-keep pinning excludes inferred origin), **H-2** (poison-episode isolation), **H-4** (lockfile hardening) — explicitly out of Phase 48's four-item scope; candidates for a future hardening pass.
- Content-ingestion hardening (`content-hardening-deferred.md`: transcript speaker roles, Obsidian PDF extraction, gmail episodic-variant prompt, LongMemEval threshold re-tuning) — separate concern, own phase.

</deferred>

---

*Phase: 48-correctness-hardening*
*Context gathered: 2026-06-27*
