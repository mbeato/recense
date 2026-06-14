/**
 * smoke-recall — Phase 4 explicit recall demo on a real recense.db copy (LEARN-02, D-40).
 *
 * Success criterion 2 (ROADMAP Phase 4): "recall-cli emits an inferred-tagged inference
 * on the founder's real recense.db with node count unchanged."
 *
 * Steps:
 *   1. Resolve recense.db path from --db <path> or RECENSE_DB env var.
 *   2. Copy recense.db to a temp path so the original is never mutated.
 *   3. Open the temp copy, run initSchema (idempotent), build config.
 *   4. Record initial node count (ephemeral-as-fact guard).
 *   5. Build RecallEngine and run recall("<question the schema should answer>").
 *   6. Print the returned JSON and assert node count is unchanged.
 *
 * Dependencies: OPENAI_API_KEY (embed) + ANTHROPIC_API_KEY (compose).
 * NOT part of the automated vitest gate — requires real API keys and a populated recense.db
 * that has previously been through the sleep pass (to have schema nodes + embeddings).
 *
 * Threat mitigations:
 *  - T-04-03-K: keys read from process.env via SDK default — never literals, never logged.
 *  - T-04-03-I: query is a hardcoded literal here (smoke test); in recall-cli it comes
 *    from --query argv and is treated as data content, never shell-interpolated.
 *  - Brain.db: copied to temp path — original untouched.
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
import { DefaultModelProvider } from '../src/model/provider';
import { RecallEngine } from '../src/recall';

/**
 * Resolve recense.db path from --db <path> argv or RECENSE_DB env var.
 */
function resolveDbPath(): string | undefined {
  const idx = process.argv.indexOf('--db');
  if (idx !== -1 && process.argv[idx + 1]) {
    return process.argv[idx + 1];
  }
  return process.env['RECENSE_DB'];
}

/**
 * Resolve query from --query <text> argv, or use a default.
 */
function resolveQuery(): string {
  const idx = process.argv.indexOf('--query');
  if (idx !== -1 && process.argv[idx + 1]) {
    return process.argv[idx + 1] ?? 'What patterns do you know about my work?';
  }
  return 'What patterns do you know about my work?';
}

async function main(): Promise<void> {
  // ── 1. Resolve source DB path ────────────────────────────────────────────
  const sourceDbPath = resolveDbPath();
  if (!sourceDbPath) {
    console.error('[smoke-recall] No DB path supplied (--db <path> or RECENSE_DB env var)');
    process.exit(1);
  }
  if (!existsSync(sourceDbPath)) {
    console.error(`[smoke-recall] DB not found: ${sourceDbPath}`);
    process.exit(1);
  }

  // ── 2. Copy to a temp path (never mutate the original) ───────────────────
  const tempDbPath = join(tmpdir(), `smoke-recall-${Date.now()}.db`);
  copyFileSync(sourceDbPath, tempDbPath);
  console.log(`[smoke-recall] Copied recense.db → ${tempDbPath}`);

  try {
    // ── 3. Open temp copy ────────────────────────────────────────────────────
    const db = new Database(tempDbPath);
    initSchema(db);
    const config = { ...DEFAULT_CONFIG, dbPath: tempDbPath };

    // ── 4. Record initial node count (ephemeral-as-fact guard) ───────────────
    const nodeCountBefore = (db.prepare('SELECT count(*) as c FROM node').get() as { c: number }).c;
    console.log(`[smoke-recall] Node count before recall: ${nodeCountBefore}`);

    // ── 5. Build RecallEngine dependency graph ────────────────────────────────
    const episodes = new EpisodicStore(db, realClock, config);
    const store    = new SemanticStore(db, realClock, config);
    const strength = new StrengthDecayManager(db, realClock, config);
    const retriever = new CandidateRetriever(db);

    // T-04-03-K / T-05-02-KEY: keys read from process.env by SDK inside DefaultModelProvider
    const provider = new DefaultModelProvider({ generateConfig: config, judgeConfig: config, embedConfig: config });

    const engine = new RecallEngine(
      db, realClock, config, provider, retriever, store, strength, episodes,
    );

    // ── 6. Run recall ─────────────────────────────────────────────────────────
    const query = resolveQuery();
    console.log(`[smoke-recall] Query: "${query}"`);
    const result = await engine.recall(query, 'smoke-session');

    // ── 7. Print result ───────────────────────────────────────────────────────
    console.log('[smoke-recall] Result:');
    console.log(JSON.stringify(result, null, 2));

    // ── 8. Assert node count unchanged (ephemeral-as-fact guarantee, LEARN-02) ─
    const nodeCountAfter = (db.prepare('SELECT count(*) as c FROM node').get() as { c: number }).c;
    console.log(`[smoke-recall] Node count after recall: ${nodeCountAfter}`);

    if (nodeCountAfter !== nodeCountBefore) {
      console.error(
        `[smoke-recall] FAIL: node count changed from ${nodeCountBefore} to ${nodeCountAfter} — ephemeral-as-fact violated`
      );
      db.close();
      process.exit(1);
    }

    console.log('[smoke-recall] PASS: node count unchanged (ephemeral-as-fact guarantee holds)');

    if (result.origin !== 'inferred') {
      console.error(`[smoke-recall] FAIL: result.origin is "${result.origin}" (expected "inferred")`);
      db.close();
      process.exit(1);
    }

    if (result.inference !== null) {
      console.log(`[smoke-recall] PASS: non-null inference returned with origin:inferred`);
    } else {
      console.log(`[smoke-recall] NOTE: inference is null — schema may not exist yet. Run smoke-schema.ts first.`);
    }

    db.close();
  } finally {
    // Always clean up the temp copy
    try {
      unlinkSync(tempDbPath);
      console.log('[smoke-recall] Cleaned up temp DB');
    } catch {
      // best-effort cleanup
    }
  }
}

main().catch(err => {
  console.error('[smoke-recall] FATAL:', err);
  process.exit(1);
});
