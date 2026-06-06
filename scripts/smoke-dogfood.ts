/**
 * smoke-dogfood — automated end-to-end store → consolidate → retrieve loop (plan 03-03).
 *
 * Proves success criterion 4: a fact stored this session surfaces in cue-less retrieval
 * after the sleep pass — the regression-testable spine of the dogfood loop, LLM-free.
 *
 * Steps:
 *   1. Open :memory: DB, initSchema, build full config.
 *   2. Record a fact-bearing episode via IngestionPipeline.recordEvent (role='user').
 *   3. Run the sleep pass: Consolidator with Mock model impls (no network calls).
 *      - MockEmbedder: deterministic unit vector per text (claim embedding + re-embed dirty).
 *      - MockClaimExtractor: scripted to extract the FACT_VALUE from any episode.
 *      - MockJudge: scripted 'unrelated' (no existing nodes → auto-unrelated path anyway).
 *   4. Run engine.retrieveCueless() and assert the consolidated fact's node value appears.
 *
 * LLM-free guarantee: only Mock* model impls are instantiated.
 * Exit 0 on PASS, non-zero on any miss or error.
 */
import Database from 'better-sqlite3';
import { initSchema } from '../src/db/schema';
import { DEFAULT_CONFIG } from '../src/lib/config';
import { realClock } from '../src/lib/clock';
import { SemanticStore } from '../src/db/semantic-store';
import { CandidateRetriever } from '../src/retrieval/topk';
import { StrengthDecayManager } from '../src/strength/decay';
import { AllocationGate } from '../src/gate/allocation-gate';
import { RetrievalEngine } from '../src/retrieval/engine';
import { EpisodicStore, IngestionPipeline } from '../src/ingest/pipeline';
import { Consolidator } from '../src/consolidation/consolidator';
import { SchemaInducer } from '../src/consolidation/schema-induction';
import { MockEmbedder } from '../src/model/embedder';
import { MockJudge } from '../src/model/judge';
import { MockClaimExtractor } from '../src/model/claim-extractor';

/**
 * The fact value that the MockClaimExtractor will extract from the episode.
 * This value must appear in retrieveCueless() results after consolidation.
 */
const FACT_VALUE = 'brain-memory stores memories using SQLite and TypeScript';

/**
 * Deterministic mock embedder: returns a unit vector in dimension 0 for any text.
 * Valid Float32Array of embeddingDimensions — topk and setEmbedding work correctly.
 * All texts get the same vector (cosine = 1.0 between any two) which is fine here:
 * the smoke only tests the store→consolidate→retrieve loop, not retrieval ranking.
 */
function makeMockEmbedder(): MockEmbedder {
  const dims = DEFAULT_CONFIG.embeddingDimensions;
  return new MockEmbedder((_text: string) => {
    const vec = new Float32Array(dims);
    vec[0] = 1.0; // unit vector in dimension 0 — cosine similarity is well-defined
    return vec;
  });
}

const db = new Database(':memory:');

async function main(): Promise<void> {
  // ── 1. Schema + config ─────────────────────────────────────────────────────
  initSchema(db);
  const config = { ...DEFAULT_CONFIG, dbPath: ':memory:' };

  console.log('[smoke-dogfood] schema initialized');

  // ── 2. Shared components ───────────────────────────────────────────────────
  const clock     = realClock;
  const store     = new SemanticStore(db, clock, config);
  const retriever = new CandidateRetriever(db);
  const strength  = new StrengthDecayManager(db, clock, config);
  const gate      = new AllocationGate(config);
  const episodes  = new EpisodicStore(db, clock, config);

  // ── 3. Store: record a fact-bearing episode via IngestionPipeline ──────────
  const pipeline = new IngestionPipeline(gate, episodes);
  pipeline.recordEvent({
    content: FACT_VALUE,
    role: 'user',
    origin: 'observed',
    sessionId: 'smoke-dogfood-session',
    // sourceInferenceId left undefined → null (D-34: no-op pass-through this phase)
  });
  console.log(`[smoke-dogfood] episode recorded: "${FACT_VALUE}"`);

  // ── 4. Consolidate: sleep pass with Mock model impls (LLM-free) ────────────
  // MockClaimExtractor → extracts FACT_VALUE regardless of episode content.
  // MockJudge         → scripted 'unrelated' (not called: no candidates in empty DB).
  // MockEmbedder      → deterministic unit vector for claim embedding + re-embed dirty.
  const embedder  = makeMockEmbedder();
  const extractor = new MockClaimExtractor([{ type: 'fact', value: FACT_VALUE }]);
  const judge     = new MockJudge([{ best_candidate_id: null, relation: 'unrelated', magnitude: 0 }]);

  // No-op inducer (stub naming fn): smoke-dogfood has only 1 node → below schemaMinSupport
  const inducer = new SchemaInducer(
    db, store, strength, retriever, embedder, config, clock,
    async () => 'no-op-schema',
  );

  const consolidator = new Consolidator(
    db, episodes, store, strength, retriever, embedder, judge, extractor, inducer, config, clock,
  );
  await consolidator.consolidate();
  console.log('[smoke-dogfood] consolidation complete');

  // ── 5. Retrieve: assert the fact surfaces in cue-less retrieval ───────────
  const engine = new RetrievalEngine(db, clock, config, retriever, store, strength, gate);
  const result  = engine.retrieveCueless();

  const found = result.results.some(r => r.value === FACT_VALUE);
  if (!found) {
    const actual = result.results.map(r => r.value).join(', ');
    throw new Error(
      `FAIL: consolidated fact not found in retrieveCueless() results.\n` +
      `  Expected: "${FACT_VALUE}"\n` +
      `  Actual results: [${actual || '(empty)'}]`,
    );
  }

  console.log(`[smoke-dogfood] retrieved: "${FACT_VALUE}" (score=${result.results.find(r => r.value === FACT_VALUE)?.score.toFixed(4)})`);
  console.log('\n[smoke-dogfood] PASS — store → consolidate → retrieve loop successful');
}

main()
  .catch(err => {
    console.error(`[smoke-dogfood] FAIL — ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  })
  .finally(() => {
    try { db.close(); } catch { /* already closed */ }
  });
