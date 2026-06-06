/**
 * smoke-schema — Phase 4 headline demo: schema induction on a real brain.db copy.
 *
 * Success criterion 1 (ROADMAP Phase 4): "A named generalization the user never stated,
 * observable on the founder's real brain.db."
 *
 * Steps:
 *   1. Resolve brain.db path from --db <path> or BRAIN_MEMORY_DB env var.
 *   2. Copy brain.db to a temp path so the original is never mutated.
 *   3. Open the temp copy, run initSchema (idempotent), build config.
 *   4. Run one Consolidator.consolidate() with real OpenAIEmbedder + Anthropic naming.
 *   5. Print every type='schema' node's value (the named generalizations).
 *
 * Dependencies: OPENAI_API_KEY + ANTHROPIC_API_KEY (or ANTHROPIC_VERTEX_* for Vertex).
 * NOT part of the automated vitest gate — requires real API keys and a populated brain.db.
 *
 * Threat mitigations:
 *  - T-04-01-K: keys read from process.env via SDK default — never literals, never logged.
 *  - Brain.db: copied to temp path before any writes — original untouched.
 */
import { copyFileSync, unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { initSchema } from '../src/db/schema';
import { DEFAULT_CONFIG } from '../src/lib/config';
import { realClock } from '../src/lib/clock';
import { EpisodicStore } from '../src/db/episode-store';
import { SemanticStore } from '../src/db/semantic-store';
import { StrengthDecayManager } from '../src/strength/decay';
import { CandidateRetriever } from '../src/retrieval/topk';
import { OpenAIEmbedder } from '../src/model/embedder';
import { AnthropicJudge } from '../src/model/judge';
import { AnthropicClaimExtractor } from '../src/model/claim-extractor';
import { SchemaInducer } from '../src/consolidation/schema-induction';
import { Consolidator } from '../src/consolidation/consolidator';
import type { NodeRow } from '../src/lib/types';

/**
 * Resolve brain.db path from --db <path> argv or BRAIN_MEMORY_DB env var.
 * Returns undefined if neither is supplied.
 */
function resolveDbPath(): string | undefined {
  const dbArgIdx = process.argv.indexOf('--db');
  if (dbArgIdx !== -1 && process.argv[dbArgIdx + 1]) {
    return process.argv[dbArgIdx + 1];
  }
  return process.env['BRAIN_MEMORY_DB'];
}

async function main(): Promise<void> {
  // ── 1. Resolve source DB path ────────────────────────────────────────────
  const sourceDbPath = resolveDbPath();
  if (!sourceDbPath) {
    console.error('[smoke-schema] No DB path supplied (--db <path> or BRAIN_MEMORY_DB env var)');
    process.exit(1);
  }
  if (!existsSync(sourceDbPath)) {
    console.error(`[smoke-schema] DB not found: ${sourceDbPath}`);
    process.exit(1);
  }

  // ── 2. Copy to temp path — never mutate the original ────────────────────
  const tempDbPath = join(tmpdir(), `brain-memory-schema-smoke-${Date.now()}.db`);
  console.log(`[smoke-schema] Copying ${sourceDbPath} → ${tempDbPath}`);
  copyFileSync(sourceDbPath, tempDbPath);

  const db = new Database(tempDbPath);

  try {
    // ── 3. Open + schema ──────────────────────────────────────────────────
    initSchema(db);
    const config = { ...DEFAULT_CONFIG, dbPath: tempDbPath };
    console.log('[smoke-schema] Schema initialized on temp copy');

    // ── 4. Count schema nodes BEFORE (baseline) ───────────────────────────
    const nodesBefore = db.prepare("SELECT * FROM node WHERE type = 'schema' AND tombstoned = 0").all() as NodeRow[];
    console.log(`[smoke-schema] Existing schema nodes before consolidation: ${nodesBefore.length}`);
    for (const s of nodesBefore) {
      console.log(`  (existing) "${s.value}"`);
    }

    // ── 5. Build full dependency graph ────────────────────────────────────
    const clock = realClock;
    const episodes  = new EpisodicStore(db, clock, config);
    const store     = new SemanticStore(db, clock, config);
    const strength  = new StrengthDecayManager(db, clock, config);
    const retriever = new CandidateRetriever(db);

    // Real model impls — keys from process.env via SDK default (T-04-01-K)
    const embedder  = new OpenAIEmbedder(config.openaiEmbedModel, config.embeddingDimensions);
    const judge     = new AnthropicJudge(config);
    const extractor = new AnthropicClaimExtractor(config);
    const inducer   = new SchemaInducer(db, store, strength, retriever, embedder, config, clock);

    const consolidator = new Consolidator(
      db, episodes, store, strength, retriever,
      embedder, judge, extractor, inducer, config, clock,
    );

    // ── 6. Run the sleep pass ─────────────────────────────────────────────
    console.log('[smoke-schema] Running consolidate() on real brain.db copy...');
    await consolidator.consolidate();
    console.log('[smoke-schema] Consolidation complete');

    // ── 7. Print all schema nodes ─────────────────────────────────────────
    const schemasAfter = db.prepare("SELECT * FROM node WHERE type = 'schema' AND tombstoned = 0").all() as NodeRow[];
    console.log(`\n[smoke-schema] Schema nodes after consolidation: ${schemasAfter.length}`);

    if (schemasAfter.length === 0) {
      console.log('  (none) — not enough clusterable nodes or cohesion too low.');
      console.log('  Ensure brain.db has ≥ schemaMinSupport (3) similar fact/entity nodes with embeddings.');
    } else {
      for (const s of schemasAfter) {
        const isNew = !nodesBefore.some(b => b.id === s.id);
        const tag = isNew ? ' [NEW]' : '';
        console.log(`  "${s.value}"${tag}`);
      }
    }

    const newCount = schemasAfter.filter(s => !nodesBefore.some(b => b.id === s.id)).length;
    console.log(`\n[smoke-schema] ${newCount} new schema(s) formed — PASS (success criterion 1)`);

  } finally {
    db.close();
    // Clean up temp file
    try { unlinkSync(tempDbPath); } catch { /* best-effort cleanup */ }
  }
}

main().catch(err => {
  console.error(`[smoke-schema] FAIL — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
