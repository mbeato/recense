/** Batched edge/liveness reader for spreadActivation — one prepared statement per hop (spec §3.1 "app-side batched frontier"). */
import type Database from 'better-sqlite3';
import type { SpreadEdgeRow, SpreadReader } from './activation';

export class SqliteSpreadReader implements SpreadReader {
  private readonly stmtEdges;
  private readonly stmtLive;

  constructor(db: Database.Database) {
    this.stmtEdges = db.prepare(`
      SELECT src, dst, rel, kind, w FROM edge
      WHERE src IN (SELECT value FROM json_each(?)) OR dst IN (SELECT value FROM json_each(?))
    `);
    this.stmtLive = db.prepare(`
      SELECT id FROM node WHERE tombstoned = 0 AND id IN (SELECT value FROM json_each(?))
    `);
  }

  edgesTouching(ids: string[]): SpreadEdgeRow[] {
    if (ids.length === 0) return [];
    const j = JSON.stringify(ids);
    return this.stmtEdges.all(j, j) as SpreadEdgeRow[];
  }

  liveIds(ids: string[]): Set<string> {
    if (ids.length === 0) return new Set();
    return new Set((this.stmtLive.all(JSON.stringify(ids)) as Array<{ id: string }>).map(r => r.id));
  }
}
