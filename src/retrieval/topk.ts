// STUB — implementation in feat(01-01) GREEN commit (Task 4)
import type Database from 'better-sqlite3';

export function cosineSimF32(_a: Float32Array, _b: Float32Array): number {
  throw new Error('cosineSimF32: not implemented');
}

export class CandidateRetriever {
  // Constructor is a no-op stub so tests can create instances
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_db: Database.Database) {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  topk(_queryVec: Float32Array, _k: number): Array<{ id: string; score: number }> {
    throw new Error('topk: not implemented');
  }
}
