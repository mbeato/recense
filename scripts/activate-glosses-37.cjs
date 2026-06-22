#!/usr/bin/env node
/**
 * Phase 37 go-live: one-off activation of the predicate-gloss embeddings on a live DB.
 *
 * embedAndStoreGlosses() was built in 37-01 but never wired to a caller, so the recall
 * typed-path stayed dormant (matchPredicate returns null until the meta row exists).
 * This script embeds the 12 static glosses ONCE and stores them in the meta table, using
 * the SAME provider/config the sleep pass uses (so the gloss vectors share the query-vec
 * embedding space). Idempotent — skips if already present. The sleep pass now also does
 * this automatically (run-sleep-pass.ts); this is the immediate-activation path.
 *
 * Usage:  set -a; . ~/.config/recense/sleep.env; set +a; node scripts/activate-glosses-37.cjs --db <path>
 */
const path = require('path');
const Database = require('better-sqlite3');
const { DEFAULT_CONFIG } = require(path.resolve(__dirname, '../dist/src/lib/config.js'));
const { realClock } = require(path.resolve(__dirname, '../dist/src/lib/clock.js'));
const { SemanticStore } = require(path.resolve(__dirname, '../dist/src/db/semantic-store.js'));
const { DefaultModelProvider } = require(path.resolve(__dirname, '../dist/src/model/provider.js'));
const { embedAndStoreGlosses, loadGlossEmbeddings } = require(path.resolve(__dirname, '../dist/src/consolidation/gloss-embeddings.js'));

const arg = (k, d) => { const i = process.argv.indexOf(k); return i !== -1 ? process.argv[i + 1] : d; };
const DB_PATH = arg('--db', `${process.env.HOME}/.config/recense/recense.db`);

(async () => {
  const config = { ...DEFAULT_CONFIG, dbPath: DB_PATH };
  const db = new Database(DB_PATH); // read-write: setMeta writes one meta row
  const store = new SemanticStore(db, realClock, config);

  if (loadGlossEmbeddings(store)) {
    console.log('gloss embeddings already present — nothing to do (idempotent).');
    db.close();
    return;
  }

  console.log(`embedding 12 predicate glosses (model=${config.openaiEmbedModel}) into ${DB_PATH} ...`);
  const provider = new DefaultModelProvider({ embedConfig: config });
  await embedAndStoreGlosses(provider, store);

  const check = loadGlossEmbeddings(store);
  if (!check) { console.error('FAILED: glosses still absent after embed'); process.exit(1); }
  const dims = Object.values(check)[0].length;
  console.log(`stored 12 glosses (${dims}-dim each). Recall typed-path is now ACTIVE on this DB.`);
  db.close();
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
