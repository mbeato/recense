/**
 * INGEST-01: EpisodicStore unconditional append.
 * INGEST-02: AllocationGate honest salience + hard-keep flag.
 * Pipeline: end-to-end recordEvent vertical slice.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import { initSchema } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { EngineConfig } from '../src/lib/config';
import { EpisodicStore } from '../src/db/episode-store';
import type { AppendEventParams } from '../src/db/episode-store';

const testConfig: EngineConfig = { ...DEFAULT_CONFIG, dbPath: ':memory:' };

// ─── INGEST-01: EpisodicStore ─────────────────────────────────────────────────

describe('INGEST-01: EpisodicStore unconditional append', () => {
  let db: Database.Database;
  let clock: FakeClock;
  let store: EpisodicStore;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    clock = new FakeClock(1_000_000);
    store = new EpisodicStore(db, clock, testConfig);
  });

  it('appends 50 events unconditionally regardless of salience or role', () => {
    for (let i = 0; i < 50; i++) {
      const role = i % 3 === 0 ? 'user' as const : i % 3 === 1 ? 'assistant' as const : 'tool' as const;
      store.append({
        content: `message ${i}`,
        origin: 'observed',
        salience: Math.random() * 0.05, // very low salience
        hard_keep: 0,
        role,
        session_id: 'sess-1',
        source_inference_id: null,
      });
    }
    expect(store.listUnconsolidated()).toHaveLength(50);
  });

  it('stored row carries all passed fields and consolidated=0', () => {
    clock.setNow(9_999_000);
    const row = store.append({
      content: 'hello world',
      origin: 'asserted_by_user',
      salience: 0.75,
      hard_keep: 1,
      role: 'user',
      session_id: 'sess-abc',
      source_inference_id: null,
    });
    expect(row.content).toBe('hello world');
    expect(row.origin).toBe('asserted_by_user');
    expect(row.salience).toBe(0.75);
    expect(row.hard_keep).toBe(1);
    expect(row.role).toBe('user');
    expect(row.session_id).toBe('sess-abc');
    expect(row.consolidated).toBe(0);
    expect(row.ts).toBe(9_999_000);
  });

  it('caps content longer than maxContentBytes and adds truncation marker', () => {
    const longContent = 'a'.repeat(10_000); // > 8 KB default
    const row = store.append({
      content: longContent,
      origin: 'observed',
      salience: 0.1,
      hard_keep: 0,
      role: 'tool',
      session_id: 'sess-1',
      source_inference_id: null,
    });
    const markerBytes = Buffer.byteLength('…[truncated]', 'utf8');
    expect(Buffer.byteLength(row.content, 'utf8')).toBeLessThanOrEqual(
      testConfig.maxContentBytes + markerBytes,
    );
    expect(row.content).toContain('[truncated]');
    expect(row.content.length).toBeLessThan(longContent.length);
  });

  it('stores content shorter than maxContentBytes verbatim (no truncation)', () => {
    const content = 'a short message that fits easily';
    const row = store.append({
      content,
      origin: 'observed',
      salience: 0.5,
      hard_keep: 0,
      role: 'assistant',
      session_id: 'sess-1',
      source_inference_id: null,
    });
    expect(row.content).toBe(content);
    expect(row.content).not.toContain('[truncated]');
  });

  it('listUnconsolidated returns hard_keep=1 rows before hard_keep=0 rows', () => {
    store.append({ content: 'low-sal-free', origin: 'observed', salience: 0.9, hard_keep: 0, role: 'user', session_id: 's', source_inference_id: null });
    store.append({ content: 'kept-low-sal', origin: 'observed', salience: 0.1, hard_keep: 1, role: 'user', session_id: 's', source_inference_id: null });

    const rows = store.listUnconsolidated();
    expect(rows[0]!.hard_keep).toBe(1);
    expect(rows[1]!.hard_keep).toBe(0);
  });

  it('listUnconsolidated sorts salience DESC within each hard_keep group', () => {
    store.append({ content: 'a', origin: 'observed', salience: 0.3, hard_keep: 0, role: 'user', session_id: 's', source_inference_id: null });
    store.append({ content: 'b', origin: 'observed', salience: 0.7, hard_keep: 0, role: 'user', session_id: 's', source_inference_id: null });
    store.append({ content: 'c', origin: 'observed', salience: 0.5, hard_keep: 1, role: 'user', session_id: 's', source_inference_id: null });
    store.append({ content: 'd', origin: 'observed', salience: 0.9, hard_keep: 1, role: 'user', session_id: 's', source_inference_id: null });

    const rows = store.listUnconsolidated();
    // hard_keep=1 group, salience DESC
    expect(rows[0]!.content).toBe('d'); // hk=1, sal=0.9
    expect(rows[1]!.content).toBe('c'); // hk=1, sal=0.5
    // hard_keep=0 group, salience DESC
    expect(rows[2]!.content).toBe('b'); // hk=0, sal=0.7
    expect(rows[3]!.content).toBe('a'); // hk=0, sal=0.3
  });

  it('getEpisode round-trips all fields', () => {
    // source_inference_id has an FK REFERENCES episode(id) — insert the parent first
    const parent = store.append({
      content: 'parent inference episode',
      origin: 'inferred',
      salience: 0.1,
      hard_keep: 0,
      role: 'assistant',
      session_id: 'sess-rt',
      source_inference_id: null,
    });
    const appended = store.append({
      content: 'round-trip test',
      origin: 'inferred',
      salience: 0.42,
      hard_keep: 0,
      role: 'assistant',
      session_id: 'sess-rt',
      source_inference_id: parent.id,
    });
    const retrieved = store.getEpisode(appended.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(appended.id);
    expect(retrieved!.content).toBe('round-trip test');
    expect(retrieved!.origin).toBe('inferred');
    expect(retrieved!.salience).toBeCloseTo(0.42);
    expect(retrieved!.role).toBe('assistant');
    expect(retrieved!.session_id).toBe('sess-rt');
    expect(retrieved!.source_inference_id).toBe(parent.id);
    expect(retrieved!.consolidated).toBe(0);
  });

  it('getEpisode returns null for an unknown id', () => {
    expect(store.getEpisode('does-not-exist')).toBeNull();
  });
});

// ─── INGEST-02: AllocationGate ────────────────────────────────────────────────

import { AllocationGate } from '../src/gate/allocation-gate';

describe('INGEST-02: AllocationGate honest salience + hard-keep', () => {
  let gate: AllocationGate;

  beforeEach(() => {
    gate = new AllocationGate(testConfig);
  });

  it('score returns salience in [0,1] for every role and content combination', () => {
    const inputs: Array<[string, 'user' | 'assistant' | 'tool']> = [
      ['hello', 'user'],
      ['always remember this', 'user'],
      ['actually that is wrong', 'assistant'],
      ['{"result": "ok"}', 'tool'],
      ['a'.repeat(500), 'tool'],
      ['never do this again', 'user'],
    ];
    for (const [content, role] of inputs) {
      const { salience } = gate.score(content, role);
      expect(salience).toBeGreaterThanOrEqual(0);
      expect(salience).toBeLessThanOrEqual(1);
    }
  });

  it('directive pattern with user role produces hardKeep=true', () => {
    expect(gate.score('always commit on green', 'user').hardKeep).toBe(true);
    expect(gate.score('never use var', 'user').hardKeep).toBe(true);
    expect(gate.score('remember to run tests first', 'user').hardKeep).toBe(true);
    expect(gate.score('I prefer TypeScript over JavaScript', 'user').hardKeep).toBe(true);
  });

  it('correction marker with user role produces hardKeep=true', () => {
    expect(gate.score('actually that is not right', 'user').hardKeep).toBe(true);
    expect(gate.score("no, that's wrong — it should be different", 'user').hardKeep).toBe(true);
  });

  it('directive pattern with tool role produces hardKeep=false (D-02)', () => {
    expect(gate.score('always commit on green', 'tool').hardKeep).toBe(false);
    expect(gate.score('never use var', 'tool').hardKeep).toBe(false);
    expect(gate.score('actually that is not right', 'tool').hardKeep).toBe(false);
  });

  it('salience is NOT forced to 1.0 when hardKeep=true (D-03 independence)', () => {
    const { salience, hardKeep } = gate.score('always commit on green', 'user');
    expect(hardKeep).toBe(true);
    expect(salience).toBeLessThan(1.0);
    expect(salience).toBeGreaterThan(0);
  });

  it('tool messages produce lower salience than equivalent user messages', () => {
    const userSal = gate.score('a simple message', 'user').salience;
    const toolSal = gate.score('a simple message', 'tool').salience;
    expect(userSal).toBeGreaterThan(toolSal);
  });

  it('longer content produces higher length signal than single-word content', () => {
    const short = gate.score('hi', 'user').salience;
    const long = gate.score('word '.repeat(50), 'user').salience;
    expect(long).toBeGreaterThan(short);
  });

  it('non-matching content with assistant role returns hardKeep=false', () => {
    expect(gate.score('the weather looks good today', 'assistant').hardKeep).toBe(false);
  });

  it('content with no patterns produces modest non-zero salience', () => {
    const { salience } = gate.score('hello world', 'user');
    expect(salience).toBeGreaterThan(0);
    expect(salience).toBeLessThan(0.5); // modest — no directive/correction match
  });

  it('directive/correction with assistant role produces hardKeep=false (force-keep restricted to user)', () => {
    // NEW per INGEST-02: only the user's own imperatives/corrections are hard-kept;
    // assistant restating a directive does not set hard_keep — stops over-firing
    expect(gate.score('always commit on green', 'assistant').hardKeep).toBe(false);
    expect(gate.score('never use var', 'assistant').hardKeep).toBe(false);
    expect(gate.score('actually that is not right', 'assistant').hardKeep).toBe(false);
  });

  it('assistant directive still computes non-zero salience (D-03 independence preserved)', () => {
    // Force-keep restricted to user; salience is still scored honestly — D-03 independence
    const { salience, hardKeep } = gate.score('always commit on green', 'assistant');
    expect(hardKeep).toBe(false);
    expect(salience).toBeGreaterThan(0);
    expect(salience).toBeLessThan(1.0);
  });

  it('consolSkipThresholdAssistant=0.5 and consolSkipThreshold=0.2 in DEFAULT_CONFIG', () => {
    expect(DEFAULT_CONFIG.consolSkipThresholdAssistant).toBe(0.5);
    expect(DEFAULT_CONFIG.consolSkipThreshold).toBe(0.2); // user threshold unchanged
  });
});

// ─── IngestionPipeline: end-to-end vertical slice ────────────────────────────

import { IngestionPipeline } from '../src/ingest/pipeline';

describe('IngestionPipeline: recordEvent end-to-end slice', () => {
  let db: Database.Database;
  let clock: FakeClock;
  let store: EpisodicStore;
  let gate: AllocationGate;
  let pipeline: IngestionPipeline;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    clock = new FakeClock(2_000_000);
    store = new EpisodicStore(db, clock, testConfig);
    gate = new AllocationGate(testConfig);
    pipeline = new IngestionPipeline(gate, store);
  });

  it('recordEvent persists gate salience unchanged (honest, D-03)', () => {
    const content = 'always run tests before committing';
    const { salience: expectedSalience } = gate.score(content, 'user');
    const row = pipeline.recordEvent({
      content,
      role: 'user',
      origin: 'observed',
      sessionId: 'sess-1',
    });
    expect(row.salience).toBeCloseTo(expectedSalience, 10);
  });

  it('directive user event stores hard_keep=1 and salience > 0', () => {
    const row = pipeline.recordEvent({
      content: 'always commit on green',
      role: 'user',
      origin: 'observed',
      sessionId: 'sess-1',
    });
    expect(row.hard_keep).toBe(1);
    expect(row.salience).toBeGreaterThan(0);
  });

  it('tool event is stored (not dropped) with hard_keep=0', () => {
    const before = store.listUnconsolidated().length;
    const row = pipeline.recordEvent({
      content: 'always commit on green',
      role: 'tool',
      origin: 'observed',
      sessionId: 'sess-1',
    });
    const after = store.listUnconsolidated().length;
    expect(after).toBe(before + 1); // row was appended
    expect(row.hard_keep).toBe(0);  // tool output never hard-kept (D-02)
  });

  it('50 mixed events are all stored — gate never drops (INGEST-01)', () => {
    for (let i = 0; i < 50; i++) {
      const role = i % 3 === 0 ? 'user' as const : i % 3 === 1 ? 'assistant' as const : 'tool' as const;
      pipeline.recordEvent({
        content: `event number ${i}`,
        role,
        origin: 'observed',
        sessionId: 'sess-bulk',
      });
    }
    expect(store.listUnconsolidated()).toHaveLength(50);
  });

  it('retrieved row has correct role and origin from recordEvent params', () => {
    const row = pipeline.recordEvent({
      content: 'the sky is blue',
      role: 'assistant',
      origin: 'inferred',
      sessionId: 'sess-check',
    });
    const retrieved = store.getEpisode(row.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.role).toBe('assistant');
    expect(retrieved!.origin).toBe('inferred');
    expect(retrieved!.session_id).toBe('sess-check');
  });

  // M-12: pipeline redacts secrets at the boundary (conversation-capture path)
  it('M-12: recordEvent redacts Anthropic key from content before storing', () => {
    const rawKey = 'sk-ant-api03-AbC0123456789defGHIjkl';
    const row = pipeline.recordEvent({
      content: `my key is ${rawKey} — treat as sensitive`,
      role: 'user',
      origin: 'observed',
      sessionId: 'sess-m12',
    });
    expect(row.content).not.toContain(rawKey);
    expect(row.content).toContain('[REDACTED:API_KEY]');
  });

  it('M-12: recordEvent leaves already-redacted content unchanged (idempotent)', () => {
    const alreadyRedacted = 'my key is [REDACTED:API_KEY] — already clean';
    const row = pipeline.recordEvent({
      content: alreadyRedacted,
      role: 'user',
      origin: 'observed',
      sessionId: 'sess-m12-idempotent',
    });
    expect(row.content).toBe(alreadyRedacted);
  });
});
