/**
 * Walking Skeleton smoke script — STORE-03 end-to-end round-trip.
 *
 * Proves the substrate works end-to-end with ZERO LLM and ZERO network calls:
 *   1. Open an in-memory SQLite DB.
 *   2. Run initSchema.
 *   3. Write one fact node via the owned write primitive.
 *   4. Attach a synthetic embedding via setEmbedding.
 *   5. Run topk with the same vector.
 *   6. Assert the node comes back as the top hit.
 *
 * Exit code 0 on success, non-zero on any failure.
 */
import Database from 'better-sqlite3';
import { initSchema } from '../src/db/schema';
import { SemanticStore } from '../src/db/semantic-store';
import { CandidateRetriever } from '../src/retrieval/topk';
import { realClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import { newId } from '../src/lib/hash';

const db = new Database(':memory:');

try {
  // ── 1. Schema ─────────────────────────────────────────────────────────────
  initSchema(db);
  console.log('[smoke] schema initialized');

  // ── 2. Components ─────────────────────────────────────────────────────────
  const config = { ...DEFAULT_CONFIG, dbPath: ':memory:' };
  const store = new SemanticStore(db, realClock, config);
  const retriever = new CandidateRetriever(db);

  // ── 3. Write one fact node ─────────────────────────────────────────────────
  const nodeId = newId();
  store.upsertNode({
    id: nodeId,
    type: 'fact',
    value: 'Max is the founder of brain-memory',
    origin: 'asserted_by_user',
    c: 0.8,
  });
  const writtenNode = store.getNode(nodeId)!;
  console.log(`[smoke] upsertNode: id=${nodeId}, embedded_hash=${String(writtenNode.embedded_hash)}`);
  if (writtenNode.embedded_hash !== null) {
    throw new Error('Expected embedded_hash to be null (dirty) immediately after upsertNode');
  }

  // ── 4. Attach a synthetic embedding (16-dim unit vector in direction 0) ───
  const vec = new Float32Array(16);
  vec[0] = 1.0;
  store.setEmbedding(nodeId, vec);
  const embeddedNode = store.getNode(nodeId)!;
  console.log(`[smoke] setEmbedding: embedded_hash=${embeddedNode.embedded_hash}`);
  if (embeddedNode.embedded_hash !== embeddedNode.value_hash) {
    throw new Error('Expected embedded_hash == value_hash after setEmbedding (dirty flag cleared)');
  }

  // ── 5. Retrieve top-1 ─────────────────────────────────────────────────────
  const results = retriever.topk(vec, 1);
  console.log(`[smoke] topk(k=1): id=${results[0]?.id ?? 'none'}, score=${results[0]?.score ?? 0}`);

  // ── 6. Assert round-trip ──────────────────────────────────────────────────
  if (results.length !== 1) {
    throw new Error(`Expected 1 result, got ${results.length}`);
  }
  if (results[0]!.id !== nodeId) {
    throw new Error(`Expected top hit to be ${nodeId}, got ${results[0]!.id}`);
  }
  if (Math.abs(results[0]!.score - 1.0) > 1e-5) {
    throw new Error(`Expected score ≈ 1.0, got ${results[0]!.score}`);
  }

  console.log('\n[smoke] PASS — write→embed→retrieve round-trip successful');
  console.log(`        node id:  ${nodeId}`);
  console.log(`        score:    ${results[0]!.score.toFixed(6)}`);
} finally {
  db.close();
}
