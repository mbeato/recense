// Phase 37 extraction-only typed-edge minter (judge-skipped, edge-faithful).
// Replicates the consolidator's genuine typed-edge path EXACTLY:
//   merged headless-Haiku extraction (pool of 4) -> parseMergedExtraction
//   -> resolve subject/object names to node ids via the same LIKE query
//   -> skip dangling/self-loop -> upsertEdge({rel, w:0.1, kind:'relation'}).
// The judge (claim/belief reconciliation) is skipped: D-08 guarantees it never
// touches typed edges, so the edges are byte-identical to a full pipeline run.
import Database from 'better-sqlite3';
import { DEFAULT_CONFIG } from '/Users/vtx/brain-memory/src/lib/config';
import type { EngineConfig } from '/Users/vtx/brain-memory/src/lib/config';
import { DefaultModelProvider } from '/Users/vtx/brain-memory/src/model/provider';
import { SemanticStore } from '/Users/vtx/brain-memory/src/db/semantic-store';
import { promptForSource } from '/Users/vtx/brain-memory/src/source/extraction-prompts';
import { parseMergedExtraction } from '/Users/vtx/brain-memory/src/model/claim-extractor';
import { realClock } from '/Users/vtx/brain-memory/src/lib/clock';

process.env['RECENSE_TYPED_EXTRACTION_MODE'] = 'merged';

const DB_PATH = process.env['EXTRACT37_DB'] ?? '/tmp/scratch-live-37.db';
const MIN_SAL = parseFloat(process.env['EXTRACT37_MIN_SAL'] ?? '0.5');
const POOL = 4; // mirrors PREFETCH_CONCURRENCY=4
const EXTRACTION_MAX_TOKENS = 2048;

const db = new Database(DB_PATH);
const cfg: EngineConfig = {
  ...DEFAULT_CONFIG,
  dbPath: DB_PATH,
  modelProvider: 'claude-headless',
  claudeHeadlessModel: DEFAULT_CONFIG.claudeHeadlessExtractModel, // Haiku — the genuine extractor
} as EngineConfig;
const provider = new DefaultModelProvider({ generateConfig: cfg, judgeConfig: cfg, embedConfig: cfg });
const store = new SemanticStore(db, realClock, cfg);

// Same resolver the consolidator uses (Phase 37 Fix-2: ranked exact→entity→shortest).

// Resumability: mark each episode consolidated=2 (copy-only flag) after its edges are
// minted, so a restart skips completed episodes. The SELECT below loads only consolidated=1
// (unprocessed) — so kill-anytime / restart-anytime continues where it left off.
const markDone = db.prepare(`UPDATE episode SET consolidated = 2 WHERE id = ?`);

// D-08: skip inferred episodes (origin gate). Typed-extraction-eligible sources only
// are handled by promptForSource returning the merged prompt; non-eligible sources just
// won't yield triples. We process the high/mid-salience band.
const episodes = db.prepare(
  `SELECT id, source, role, content FROM episode
   WHERE salience >= ? AND origin != 'inferred' AND consolidated = 1
   ORDER BY salience DESC`
).all(MIN_SAL) as Array<{ id: string; source: string; role: string; content: string }>;

console.log(`extraction-only edge mint: ${episodes.length} episodes (salience>=${MIN_SAL}), pool=${POOL}, db=${DB_PATH}`);

let done = 0, tripleCount = 0, resolved = 0, dropped = 0;

async function processOne(ep: { id: string; source: string; role: string; content: string }): Promise<void> {
  const prompt = promptForSource(ep.source) + ep.role + '\n\nDocument content:\n' + ep.content;
  let triples;
  try {
    const raw = await provider.generate(prompt, { maxTokens: EXTRACTION_MAX_TOKENS });
    triples = parseMergedExtraction(raw).triples;
  } catch (err) {
    console.error(`  ep ${ep.id} extraction error: ${String(err).slice(0, 120)}`);
    triples = [];
  }
  for (const t of triples) {
    tripleCount++;
    const srcId = store.resolveEntityByName(t.subject);
    const dstId = store.resolveEntityByName(t.object);
    if (!srcId || !dstId || srcId === dstId) { dropped++; continue; }
    store.upsertEdge({ src: srcId, dst: dstId, rel: t.predicate, w: 0.1, kind: 'relation' });
    resolved++;
  }
  markDone.run(ep.id); // resumability: this episode is done; a restart will skip it
  done++;
  if (done % 25 === 0) console.log(`  ${done}/${episodes.length} episodes, ${resolved} edges minted (${dropped} dangling/self dropped)`);
}

(async () => {
  // Bounded pool of POOL workers over the episode queue.
  let idx = 0;
  const worker = async (): Promise<void> => {
    while (idx < episodes.length) {
      const ep = episodes[idx++]!;
      await processOne(ep);
    }
  };
  await Promise.all(Array.from({ length: POOL }, () => worker()));

  console.log(`\n=== DONE: ${done} episodes, ${tripleCount} triples extracted, ${resolved} edges minted, ${dropped} dropped ===`);
  const rows = db.prepare(
    `SELECT rel, COUNT(*) c FROM edge WHERE kind='relation' AND rel IN
     ('uses','part_of','works_on','configured_with','depends_on','runs_on','evaluated','integrates_with','built_by','prefers','supersedes','located_in')
     GROUP BY rel ORDER BY c DESC`
  ).all() as Array<{ rel: string; c: number }>;
  console.log('=== typed edges by predicate ===');
  for (const r of rows) console.log(`  ${r.rel}: ${r.c}`);
  const present = new Set(rows.map(r => r.rel));
  const ALL = ['built_by','works_on','part_of','uses','depends_on','runs_on','located_in','integrates_with','supersedes','prefers','evaluated','configured_with'];
  const missing = ALL.filter(p => !present.has(p));
  console.log(`coverage: ${present.size}/12 predicates${missing.length ? ' — MISSING: ' + missing.join(', ') : ' — FULL 12/12'}`);
  db.close();
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
