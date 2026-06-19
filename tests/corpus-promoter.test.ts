/**
 * corpus-promoter tests — Wave-0 scaffold (28-01).
 *
 * These describe blocks are intentionally SKIPPED (describe.skip / it.todo) so the
 * test suite stays GREEN after plan 28-01. Plan 28-03 (CorpusPromoter implementation)
 * will unskip and make these assertions green.
 *
 * Requirements covered:
 *  - CORPUS-02 (Req 2): LLM-free mass-gated promotion: gate returns ~15–60 candidates;
 *      noise filter excludes schemas with noise_frac ≥ 0.5.
 *  - CORPUS-03 (Req 3): Schema→schema ladder enrichment via cosine+mass signal;
 *      reference edges created between doc nodes of sibling/cosine-connected schemas;
 *      ≥1 parent→child containment edge yielded on a seeded in-memory brain.
 *  - CORPUS-05 (Req 5): Self-confirmation guard — source schema s/c/edge-weights
 *      UNCHANGED after promote() (snapshot diff); no edge incident on source schema.
 *
 * Wave-0 contract: parseable, zero failing tests, three named describe blocks.
 * Plan 28-03 converts these to real assertions.
 */
import { describe, it } from 'vitest';

// ---------------------------------------------------------------------------
// CORPUS-02: mass gate + noise filter
// ---------------------------------------------------------------------------

describe.skip('CorpusPromoter — CORPUS-02: mass gate + noise filter', () => {
  it.todo('gate returns between 15 and 60 promoted schema candidates against a seeded in-memory brain');
  it.todo('gate is deterministic: two calls on the same DB snapshot return the same set');
  it.todo('gate makes zero model calls (LLM-free: SQL/COUNT only)');
  it.todo('noise filter excludes schemas where noise_frac >= 0.5 (path/tool/worktree members)');
  it.todo('noise filter PASSES schemas with noise_frac < 0.5 (e.g. VTX Slot Projects at 0.21)');
  it.todo('hysteresis: schema with existing doc stub kept above LOW_MASS even if below HIGH_MASS');
  it.todo('schema below LOW_MASS that has a doc stub gets its doc tombstoned');
  it.todo('promote() returns a summary object with promoted count and tombstoned count');
});

// ---------------------------------------------------------------------------
// CORPUS-03: cosine+mass ladder enrichment — containment + reference edges
// ---------------------------------------------------------------------------

describe.skip('CorpusPromoter — CORPUS-03: cosine+mass ladder yields corpus edges', () => {
  it.todo(
    'two promoted schema docs that are SREL-02 siblings (same super-schema parent) ' +
    'get a doc_reference edge between their doc nodes',
  );
  it.todo(
    'two promoted schema docs connected by schema_rel (cosine pair) ' +
    'get a doc_reference edge between their doc nodes',
  );
  it.todo(
    'doc_containment edge created: larger-mass schema doc is parent of cosine-connected ' +
    'smaller-mass schema doc (directed parent→child)',
  );
  it.todo('corpus edges are written between doc nodes only — never between source schema nodes');
  it.todo('wipe-and-rebuild: second promote() replaces old corpus edges (idempotent cache)');
  it.todo(
    'promote() on a brain with at least one sibling pair produces ≥1 doc_containment OR ' +
    'doc_reference edge in the edge table with kind IN (doc_containment, doc_reference)',
  );
});

// ---------------------------------------------------------------------------
// CORPUS-05: self-confirmation guard (D-43, load-bearing)
// ---------------------------------------------------------------------------

describe.skip('CorpusPromoter — CORPUS-05: self-confirmation guard (D-43)', () => {
  it.todo(
    'source schema s value is UNCHANGED after promote() ' +
    '(snapshot diff: before == after)',
  );
  it.todo(
    'source schema c value is UNCHANGED after promote() ' +
    '(snapshot diff: before == after)',
  );
  it.todo(
    'no new edge is incident on a source schema node after promote() ' +
    '(SELECT COUNT(*) FROM edge WHERE src=schemaId OR dst=schemaId returns same before/after)',
  );
  it.todo(
    'source schema incident edge weights are UNCHANGED after promote() ' +
    '(snapshot diff on edge.w for all edges touching the source schema)',
  );
  it.todo(
    'no new abstracts/relation/schema_rel edge from promote() touches a source schema ' +
    '(only doc→doc and doc→fact cites edges may be added)',
  );
});
