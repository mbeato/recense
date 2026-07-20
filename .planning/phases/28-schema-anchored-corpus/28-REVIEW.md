---
phase: 28-schema-anchored-corpus
reviewed: 2026-06-19T00:00:00Z
depth: standard
files_reviewed: 14
files_reviewed_list:
  - src/db/schema.ts
  - src/lib/types.ts
  - src/reader/doc-gather.ts
  - src/reader/doc-generator.ts
  - src/consolidation/corpus-promoter.ts
  - src/consolidation/corpus-generator.ts
  - src/consolidation/doc-writer.ts
  - src/consolidation/run-sleep-pass.ts
  - src/adapter/promote-corpus-cli.ts
  - src/adapter/generate-corpus-cli.ts
  - src/adapter/generate-doc-cli.ts
  - src/adapter/recense.ts
  - src/viz/server.ts
  - src/viz/modules/corpus.js
  - src/viz/modules/reader.js
findings:
  critical: 1
  warning: 2
  info: 1
  total: 4
status: resolved
---

## Resolution (2026-06-19, commit 4d30eb0)

- **CR-01 (Critical) — FIXED.** Added `AND n.origin != 'inferred'` to the mass-gate query (`corpus-promoter.ts` `stmtGetSchemaMembersWithValues`) so it matches the centroid query's D-37 firewall. Regression test added (inferred members no longer launder a sub-threshold schema over the gate).
- **WR-01 (Warning) — FIXED.** Added `linkedDocRefs: genResult.linkedDocRefs` to the lazy `generate-doc-cli` `writeDoc` call (parity with the offline corpus-generator).
- **WR-02 (Warning) — REJECTED (intentional behavior).** The `cites` edges to tombstoned facts are load-bearing: `/doc/staleness` (`stmtCitedFacts`) detects dead citations via the cites-edge reverse lookup, so dropping them would render dead citations as unmarked live links (READER-03 regression). The `citationCount` inflation is cosmetic and `tombstonedCount` is reported separately.
- **IN-01 (Info) — no change** (reviewer confirmed correct-by-design).

Verification: tsc clean; corpus-promoter/corpus-generator/doc-writer suites green (40 tests). Engine invariants re-confirmed clean by the reviewer.

# Phase 28: Code Review Report

**Reviewed:** 2026-06-19
**Depth:** standard
**Files Reviewed:** 14 (+ reader.js, css/styles.css excluded as low-priority)
**Status:** issues_found

## Summary

Phase 28 ships the schema-anchored corpus: LLM-free CorpusPromoter, eager stubs, offline prose generation via `generateCorpusDocs`, two new edge kinds (`doc_containment`, `doc_reference`), link-kind-aware corpus renderer, and fill-in-place stable-edge invariant. The self-confirmation guard (D-43) and the single-writer invariant are correctly implemented. The schema migration (v12), type union extension, and prepared-statement discipline all check out.

One Critical finding: the D-37 firewall is breached in the mass-gate query — the promoter counts `origin='inferred'` members toward `mass` and `noiseFrac` even though it explicitly excludes them from the centroid computation. This allows inferred content to influence which schemas get a doc and how many.

Two Warnings: `generate-doc-cli.ts` drops `linkedDocRefs` on the lazy-on-click path (doc→doc cross-link edges never persist for user-triggered generations), and the `tombstoned` fact citations are counted as `verifiedFactIds` in `verifyCitations()` despite the caller treating them as unresolvable.

---

## Critical Issues

### CR-01: D-37 firewall violated in mass-gate — inferred members inflate `mass` and `noiseFrac`

**File:** `src/consolidation/corpus-promoter.ts:165-170`

**Issue:** `stmtGetSchemaMembersWithValues` (used to compute `mass`, `noiseFrac`, and the centroid member list) does NOT include `AND origin != 'inferred'`. The D-37 firewall that blocks inferred content from centroid computation is correctly applied to `stmtGetClusterableNodes` (line 153-157), but the *same gate is missing* from the mass-gate query. Result:

1. **Mass over-counting:** A schema whose abstracted members are mostly `origin='inferred'` facts (i.e., conclusions the engine itself drew) can cross the `highMass=10` or `lowMass=7` threshold and receive a doc stub, even though its evidence base is entirely self-generated. This is the definition of a self-confirmation pathway: inferred output inflates the promotion score of its source schema.
2. **Noise-fraction distortion:** `noiseFrac = noiseCount / mass` where `mass` includes inferred members. If inferred members are not noise tokens (they typically aren't — they're reasoned conclusions), they dilute `noiseFrac` and cause genuinely noisy schemas to pass the `noiseCap` filter.
3. **Inconsistency with centroid:** The centroid is computed only over the D-37-gated members (`clusterableById`), but `mass` includes un-gated members. A schema could have `mass=12` (passes gate) but `memberVecs.length=0` (centroid=null). This inconsistency can make a schema "promoted" with a null centroid, meaning it gets a doc stub but the semantic-breadth pass is always skipped — the doc is generated from spine + entity-hop only, which may be thin.

The project CLAUDE.md explicitly lists as a load-bearing guard: "never let inferred output strengthen a fact (self-confirmation)." While this is mass-gating rather than direct fact-strengthening, it is the same class of invariant violation at the corpus layer.

**Fix:** Add `AND n.origin != 'inferred'` to `stmtGetSchemaMembersWithValues`:

```typescript
this.stmtGetSchemaMembersWithValues = db.prepare(
  "SELECT e.dst as id, n.value as value FROM edge e " +
  "JOIN node n ON n.id = e.dst " +
  "WHERE e.src = ? AND e.kind = 'abstracts' " +
  "AND n.type IN ('fact','entity') AND n.tombstoned = 0" +
  " AND n.origin != 'inferred'"  // D-37: same gate as stmtGetClusterableNodes
);
```

This makes `mass` consistent with the centroid gate and closes the inferred-content laundering path.

---

## Warnings

### WR-01: `generate-doc-cli.ts` drops `linkedDocRefs` — lazy-gen path never writes `doc_link` edges

**File:** `src/adapter/generate-doc-cli.ts:175-181`

**Issue:** The `writeDoc` call in `generate-doc-cli.ts` omits `linkedDocRefs`:

```typescript
writeDoc(store, db, {
  docId: genResult.docId,
  slug,
  markdown: genResult.markdown,
  citedFactIds: genResult.citedFactIds,
  // linkedDocRefs: genResult.linkedDocRefs  ← MISSING
  now,
});
```

`WriteDocParams.linkedDocRefs` is optional (defaults to `[]`), so this compiles cleanly and silently. The offline path in `corpus-generator.ts:166-173` correctly passes `linkedDocRefs`. The lazy-on-click path (user opens a doc stub that the sleep pass hasn't generated yet) does not.

Consequences:
- When the user clicks a schema doc in the corpus and triggers lazy generation, any cross-references to other docs in the generated prose are never persisted as `doc_link` edges.
- The prose itself still contains the `recense://doc/<id>` links (they render correctly in the reader), but the graph-layer `doc_link` edges are absent until the NEXT offline pass regenerates the doc.
- This is asymmetric: offline-generated docs get cross-link edges; lazy-generated docs do not. The inconsistency grows with the number of user-triggered regenerations.

**Fix:** Add `linkedDocRefs` to the `writeDoc` call:

```typescript
writeDoc(store, db, {
  docId: genResult.docId,
  slug,
  markdown: genResult.markdown,
  citedFactIds: genResult.citedFactIds,
  linkedDocRefs: genResult.linkedDocRefs,  // add this
  now,
});
```

### WR-02: Tombstoned citations included in `uniqueVerified` — caller conflates "resolved" with "usable"

**File:** `src/reader/doc-generator.ts:118-124`

**Issue:** In `verifyCitations()`, the tombstoned-resolution path adds a tombstoned fact to `verifiedFactIds`:

```typescript
if (row.tombstoned === 1) {
  tombstonedCount++;
}
// Resolved (incl. tombstoned) → record canonical full id + verify.
canonical.set(raw, row.id);
verifiedFactIds.push(row.id);   // ← tombstoned ids included here
```

The function returns `uniqueVerified` which includes tombstoned fact IDs. `generateDoc` and `generateDocForSchema` return these as `citedFactIds`. `writeDoc` then creates `kind='cites'` edges from the doc node to tombstoned fact nodes (line 180-188 in doc-writer.ts). This means:

1. A `doc→fact` edge with `kind='cites'` is written to a tombstoned fact. The edge is FK-valid (the tombstoned row still exists in `node`), so it doesn't violate referential integrity. But the `/doc/meta` cited-fact list includes tombstoned IDs, which the client then tries to resolve in the graph — where they appear as `tombstoned=1`.
2. The staleness handler (`/doc/staleness`) separately detects tombstoned citations via `n.tombstoned = 1` JOIN, so the UI handles this correctly with `fact-tombstoned` styling. However, `citationCount` in the generation result (= `uniqueVerified.length`) over-counts by including tombstoned citations. The CLI output reports these as "real" citations.
3. More subtly: if a promoted schema has facts that get tombstoned after the doc is generated, subsequent `writeDoc` calls (e.g. `--force`) re-add `cites` edges to tombstoned nodes. The staleness UI handles the display, but the semantic meaning is inconsistent.

The `tombstonedCount` stat exists precisely so callers can distinguish these — but both `generateDoc` and `generateDocForSchema` include them in `citationCount` without a warning in the returned payload.

**Fix:** Exclude tombstoned IDs from `verifiedFactIds` (or at minimum from `uniqueVerified`):

```typescript
if (row.tombstoned === 1) {
  tombstonedCount++;
  canonical.set(raw, row.id);  // still canonicalize the prose
  // Do NOT push to verifiedFactIds — tombstoned refs don't write cites edges
  continue;
}
canonical.set(raw, row.id);
verifiedFactIds.push(row.id);
```

This keeps the prose canonicalized (so the reader can style it as tombstoned) but avoids writing `cites` edges to tombstoned nodes and keeps `citationCount` accurate. Note: this is a semantic change; verify that the staleness tests still pass.

---

## Info

### IN-01: `_docId` in `generateCorpusDocs` loop is fetched but never used

**File:** `src/consolidation/corpus-generator.ts:147`

**Issue:**

```typescript
for (const { docId: _docId, schemaId, schemaLabel } of toProcess) {
```

`_docId` is the actual stub node ID (from the DB query at line 113: `n.id AS docId`). It's renamed with `_` to signal it's unused. The fill-in-place logic in `writeDoc` re-discovers the stub by querying `stmtFindLiveDocForSlug.get(slug, docId)` where `docId` is the freshly-generated `gen.docId` (not the stub ID). This works correctly because `writeDoc` finds the existing empty stub by slug, not by ID.

However, the stub's actual ID is available at no cost (it's already in `_docId`). Passing it directly to `writeDoc` as the `docId` would allow `writeDoc` to skip its `stmtFindLiveDocForSlug` lookup entirely (it would find `existingDoc` immediately via the `AND n.id != ?` guard excluding the same ID... actually it wouldn't; the query excludes `n.id != docId`). Actually this is not straightforward to fix without modifying `writeDoc`'s API. The current approach is correct; `_docId` can remain unused.

This is genuinely an info-level note, not a fix recommendation. The `_` prefix correctly signals intentional discard.

---

_Reviewed: 2026-06-19_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
