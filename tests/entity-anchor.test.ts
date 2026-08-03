/**
 * tests/entity-anchor.test.ts — Phase 69, Plan 69-01 (RECALL-01, F2 regression).
 *
 * Harness mirrors tests/recall-scope.test.ts: temp FILE DB under os.tmpdir(), initSchema,
 * FakeClock, SemanticStore, EntityResolver constructed with { ...DEFAULT_CONFIG, dbPath }.
 * SCRATCH DB only, zero network, zero LLM.
 *
 * The load-bearing case ("F2 regression: the 'contract with vtx' class") proves the audit's
 * sharpest whiff resolves: a fact reachable only by name surfaces despite an embedding
 * ORTHOGONAL to any query vector — because collectAnchoredFacts never consults cosine at all,
 * this is the structural proof that entity anchoring is a name-indexed channel, not a
 * dressed-up cosine search.
 *
 * All prompts and fact values below are hand-written synthetic text — never copied from
 * scripts/eval/results/ (gitignored, verbatim personal prompts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { initSchema } from '../src/db/schema';
import { DEFAULT_CONFIG } from '../src/lib/config';
import { FakeClock } from '../src/lib/clock';
import { SemanticStore } from '../src/db/semantic-store';
import { EntityResolver } from '../src/consolidation/entity-resolution';
import { newId } from '../src/lib/hash';
import {
  extractAnchorTokens,
  collectAnchoredFacts,
  MAX_ANCHOR_TOKENS,
  MAX_ANCHORED_FACTS,
} from '../src/retrieval/entity-anchor';

const DIMS = DEFAULT_CONFIG.embeddingDimensions;

function makeTempDbPath(): string {
  return path.join(os.tmpdir(), `entity-anchor-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

/** One-hot vector at `dim` — orthogonal to every other one-hot dim, never confused with cosine 1.0. */
function unitVec(dim: number): Float32Array {
  const v = new Float32Array(DIMS);
  v[dim] = 1;
  return v;
}

let tmpDbPath: string;
let db: Database.Database;
let store: SemanticStore;
let resolver: EntityResolver;

beforeEach(() => {
  tmpDbPath = makeTempDbPath();
  const setupDb = new Database(tmpDbPath);
  initSchema(setupDb);
  setupDb.close();
  db = new Database(tmpDbPath);
  const clock = new FakeClock(Date.UTC(2026, 0, 1));
  const config = { ...DEFAULT_CONFIG, dbPath: tmpDbPath };
  store = new SemanticStore(db, clock, config);
  resolver = new EntityResolver(db, store, config);
});

afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  try { fs.unlinkSync(tmpDbPath); } catch { /* ignore */ }
});

describe('extractAnchorTokens', () => {
  it('extracts distinctive tokens and drops common function words', () => {
    const tokens = extractAnchorTokens('do you remember anything from the contract i have with vtx');
    expect(tokens).toContain('contract');
    expect(tokens).toContain('vtx');
    expect(tokens).not.toContain('do');
    expect(tokens).not.toContain('you');
    expect(tokens).not.toContain('the');
    expect(tokens).not.toContain('with');
    expect(tokens).not.toContain('i');
  });

  it('does not filter on capitalization — an all-lowercase proper noun survives', () => {
    const tokens = extractAnchorTokens('the contract with vtx sets the terms');
    expect(tokens).toContain('vtx');
  });

  it('emits adjacent bigrams of surviving tokens alongside unigrams', () => {
    const tokens = extractAnchorTokens('what were the world triathlon tiers');
    expect(tokens).toContain('world triathlon');
  });

  it('deduplicates, preserves prompt order, and caps at MAX_ANCHOR_TOKENS', () => {
    const words = Array.from({ length: 20 }, (_, i) => `distinctword${i}`);
    const prompt = `${words.join(' ')} ${words[0]}`;
    const tokens = extractAnchorTokens(prompt);
    expect(tokens.length).toBeLessThanOrEqual(MAX_ANCHOR_TOKENS);
    expect(new Set(tokens).size).toBe(tokens.length);
    expect(tokens[0]).toBe('distinctword0');
  });

  it('WR-01 regression: strips sentence punctuation abutting the entity name ("vtx?" / "vtx." / "vtx,")', () => {
    expect(extractAnchorTokens('do you remember the contract i have with vtx?')).toContain('vtx');
    expect(extractAnchorTokens('i signed the contract with vtx.')).toContain('vtx');
    expect(extractAnchorTokens('about vtx, what were the contract terms')).toContain('vtx');
    // Never emits the punctuated form — the exact/Dice channels score against clean tokens.
    expect(extractAnchorTokens('do you remember the contract i have with vtx?')).not.toContain('vtx?');
  });

  it('WR-01 regression: punctuated stopwords no longer burn MAX_ANCHOR_TOKENS slots', () => {
    // "the," strips to "the" → STOPWORDS drops it (pre-fix it survived as "the,").
    const tokens = extractAnchorTokens('the, contract with vtx');
    expect(tokens).not.toContain('the,');
    expect(tokens).not.toContain('the');
    expect(tokens).toContain('vtx');
  });

  it('drops tokens shorter than 3 chars and pure-numeric tokens', () => {
    const tokens = extractAnchorTokens('ok 42 hi vtx 12345');
    expect(tokens).not.toContain('ok');
    expect(tokens).not.toContain('42');
    expect(tokens).not.toContain('hi');
    expect(tokens).not.toContain('12345');
    expect(tokens).toContain('vtx');
  });
});

describe('collectAnchoredFacts', () => {
  it('F2 regression: the "contract with vtx" class', () => {
    const entityId = newId();
    store.upsertNode({ id: entityId, type: 'entity', value: 'vtx', origin: 'observed' });

    const factId = newId();
    const factValue = 'the ciiaa signed with vtx sets the contract terms';
    store.upsertNode({ id: factId, type: 'fact', value: factValue, origin: 'observed' });
    // Embedding orthogonal to any query vector — collectAnchoredFacts never reads this at all;
    // the fact must surface purely through the name-indexed channel, not cosine.
    store.setEmbedding(factId, unitVec(0));

    const results = collectAnchoredFacts(
      store,
      resolver,
      'do you remember anything from the contract i have with vtx',
    );
    expect(results.map(f => f.id)).toContain(factId);
  });

  it('WR-01 end-to-end: the F2 class resolves when the entity name abuts sentence punctuation', () => {
    const entityId = newId();
    store.upsertNode({ id: entityId, type: 'entity', value: 'vtx', origin: 'observed' });
    const factId = newId();
    store.upsertNode({ id: factId, type: 'fact', value: 'the ciiaa signed with vtx sets the contract terms', origin: 'observed' });
    store.setEmbedding(factId, unitVec(0));

    const results = collectAnchoredFacts(
      store,
      resolver,
      'do you remember anything from the contract i have with vtx?',
    );
    expect(results.map(f => f.id)).toContain(factId);
  });

  it('sibling: with the entity node removed, the same prompt returns []', () => {
    const factId = newId();
    const factValue = 'the ciiaa signed with vtx sets the contract terms';
    store.upsertNode({ id: factId, type: 'fact', value: factValue, origin: 'observed' });
    store.setEmbedding(factId, unitVec(0));

    const results = collectAnchoredFacts(
      store,
      resolver,
      'do you remember anything from the contract i have with vtx',
    );
    expect(results).toEqual([]);
  });

  it('an entity plus a PRED_SET edge yields the fact with via:"edge"', () => {
    const entityId = newId();
    store.upsertNode({ id: entityId, type: 'entity', value: 'rileys', origin: 'observed' });
    const factId = newId();
    store.upsertNode({ id: factId, type: 'fact', value: 'rileys is a coffee shop on main street', origin: 'observed' });
    store.upsertEdge({ src: entityId, dst: factId, rel: 'located_in', w: 0.9, kind: 'relation' });

    const results = collectAnchoredFacts(store, resolver, 'where is rileys located');
    const hit = results.find(f => f.id === factId);
    expect(hit).toBeDefined();
    expect(hit?.via).toBe('edge');
    expect(hit?.entityValue).toBe('rileys');
  });

  it('a fact mentioning the entity by name with NO edge is still returned via:"name-fts"', () => {
    const entityId = newId();
    store.upsertNode({ id: entityId, type: 'entity', value: 'contoso', origin: 'observed' });
    const factId = newId();
    store.upsertNode({ id: factId, type: 'fact', value: 'the invoice from contoso is overdue', origin: 'observed' });

    const results = collectAnchoredFacts(store, resolver, 'what do you know about contoso');
    const hit = results.find(f => f.id === factId);
    expect(hit).toBeDefined();
    expect(hit?.via).toBe('name-fts');
  });

  it('a tombstoned fact is never returned', () => {
    const entityId = newId();
    store.upsertNode({ id: entityId, type: 'entity', value: 'acme', origin: 'observed' });
    const factId = newId();
    store.upsertNode({ id: factId, type: 'fact', value: 'the acme contract terms are net-30', origin: 'observed' });
    store.upsertEdge({ src: entityId, dst: factId, rel: 'part_of', w: 0.9, kind: 'relation' });
    store.tombstone(factId);

    const results = collectAnchoredFacts(store, resolver, 'tell me about the acme contract');
    expect(results.find(f => f.id === factId)).toBeUndefined();
  });

  it('rejects an entity candidate whose Dice score is below ANCHOR_LEX_FLOOR', () => {
    const entityId = newId();
    store.upsertNode({
      id: entityId,
      type: 'entity',
      value: 'worldwide dynamics holdings corp',
      origin: 'observed',
    });
    const factId = newId();
    store.upsertNode({ id: factId, type: 'fact', value: 'worldwide dynamics holdings corp signed a lease', origin: 'observed' });
    store.upsertEdge({ src: entityId, dst: factId, rel: 'part_of', w: 0.9, kind: 'relation' });

    // Only the single token "worldwide" survives extraction; its Dice score against the
    // four-token entity value (2*1/(1+4) = 0.4) sits below ANCHOR_LEX_FLOOR (0.5).
    const results = collectAnchoredFacts(store, resolver, 'please tell me about worldwide');
    expect(results).toEqual([]);
  });

  it('is deterministic across repeat calls and caps at MAX_ANCHORED_FACTS', () => {
    const entityId = newId();
    store.upsertNode({ id: entityId, type: 'entity', value: 'globex', origin: 'observed' });
    for (let i = 0; i < 12; i++) {
      const factId = newId();
      store.upsertNode({ id: factId, type: 'fact', value: `globex fact number ${i}`, origin: 'observed' });
      store.upsertEdge({ src: entityId, dst: factId, rel: 'part_of', w: 1 - i * 0.01, kind: 'relation' });
    }

    const run1 = collectAnchoredFacts(store, resolver, 'tell me about globex');
    const run2 = collectAnchoredFacts(store, resolver, 'tell me about globex');
    expect(run1.length).toBeLessThanOrEqual(MAX_ANCHORED_FACTS);
    expect(run1.map(f => f.id)).toEqual(run2.map(f => f.id));
    expect(new Set(run1.map(f => f.id)).size).toBe(run1.length);
  });

  it('module source contains no ModelProvider import (source-grep precedent)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/retrieval/entity-anchor.ts'), 'utf8');
    expect(src).not.toMatch(/ModelProvider/);
  });
});
