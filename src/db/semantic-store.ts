// STUB — implementation in feat(01-01) commit
import type Database from 'better-sqlite3';
import type { Clock } from '../lib/clock';
import type { EngineConfig } from '../lib/config';
import type { NodeRow, UpsertNodeParams, EdgeKind } from '../lib/types';

export class SemanticStore {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_db: Database.Database, _clock: Clock, _config: EngineConfig) {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  upsertNode(_params: UpsertNodeParams): void {
    throw new Error('upsertNode: not implemented');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  setEmbedding(_id: string, _vec: Float32Array): void {
    throw new Error('setEmbedding: not implemented');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  tombstone(_id: string): void {
    throw new Error('tombstone: not implemented');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  recordContradiction(_nodeId: string, _episodeId: string): void {
    throw new Error('recordContradiction: not implemented');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getNode(_id: string): NodeRow | null {
    throw new Error('getNode: not implemented');
  }

  upsertEdge(_params: {
    src: string;
    dst: string;
    rel: string;
    w: number;
    kind: EdgeKind;
    last_access?: number;
  }): void {
    throw new Error('upsertEdge: not implemented');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getMeta(_key: string): string | null {
    throw new Error('getMeta: not implemented');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  setMeta(_key: string, _value: string): void {
    throw new Error('setMeta: not implemented');
  }
}
