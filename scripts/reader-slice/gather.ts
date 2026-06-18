/**
 * Reader-slice GATHER step (THROWAWAY / de-risk).
 *
 * Read-only. Opens the live recense.db and assembles the candidate fact-set for a
 * project query two ways, then unions them:
 *   1. Lexical: fact nodes whose value mentions the term (LIKE — robust, no FTS rowid assumptions).
 *   2. Entity-linked: entities matching the term → 1-hop edges → fact neighbors.
 *
 * Outputs JSON {id, value, c, origin, last_access, via} so we can judge whether the
 * substrate yields a coherent enough set to generate a deep-dive. Touches NO production code.
 *
 * Usage: tsx scripts/reader-slice/gather.ts <term> [limit]
 */
import Database from 'better-sqlite3';

const DB = process.env.RECENSE_DB || '/Users/vtx/.config/recense/recense.db';
const term = (process.argv[2] || 'tonos').toLowerCase();
const limit = Number(process.argv[3] || 60);

const db = new Database(DB, { readonly: true, fileMustExist: true });

type Row = { id: string; value: string; c: number; origin: string; last_access: number };

// 1. Lexical: facts mentioning the term
const lexical = db
  .prepare(
    `SELECT id, value, c, origin, last_access FROM node
     WHERE type='fact' AND tombstoned=0 AND lower(value) LIKE ?
     ORDER BY s DESC LIMIT ?`,
  )
  .all(`%${term}%`, limit) as Row[];

// 2. Entity-linked: entities matching term → 1-hop fact neighbors
const entityIds = (
  db
    .prepare(
      `SELECT id FROM node WHERE type='entity' AND tombstoned=0 AND lower(value) LIKE ?`,
    )
    .all(`%${term}%`) as Array<{ id: string }>
).map(r => r.id);

const linked: Row[] = [];
if (entityIds.length) {
  const placeholders = entityIds.map(() => '?').join(',');
  const neighborSql = `
    SELECT DISTINCT n.id, n.value, n.c, n.origin, n.last_access
    FROM edge e
    JOIN node n ON n.id = (CASE WHEN e.src IN (${placeholders}) THEN e.dst ELSE e.src END)
    WHERE (e.src IN (${placeholders}) OR e.dst IN (${placeholders}))
      AND n.type='fact' AND n.tombstoned=0`;
  linked.push(...(db.prepare(neighborSql).all(...entityIds, ...entityIds, ...entityIds) as Row[]));
}

// Union, dedupe by id
const byId = new Map<string, Row & { via: string }>();
for (const r of lexical) byId.set(r.id, { ...r, via: 'lexical' });
for (const r of linked) {
  const existing = byId.get(r.id);
  if (existing) existing.via = 'lexical+linked';
  else byId.set(r.id, { ...r, via: 'linked' });
}

const facts = [...byId.values()];
const out = {
  term,
  entityMatches: entityIds.length,
  counts: {
    lexical: lexical.length,
    linked: linked.length,
    union: facts.length,
  },
  facts,
};

console.error(
  `[gather] term="${term}" entities=${entityIds.length} lexical=${lexical.length} linked=${linked.length} union=${facts.length}`,
);
console.log(JSON.stringify(out, null, 2));
db.close();
