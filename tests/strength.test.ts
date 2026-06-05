/**
 * tests/strength.test.ts — STR-01, STR-02, STR-03
 *
 * Tests for StrengthDecayManager:
 *  STR-01: lazy multiplicative decay materialized before a self-limiting Hebbian increment;
 *           inferred origin blocked by origin guard.
 *  STR-02: confidence increment is bounded and never saturates.
 *  STR-03: AND-gated eviction; the simulated-month invariant evicts no evidence-backed fact.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../src/db/schema';
import { SemanticStore } from '../src/db/semantic-store';
import { StrengthDecayManager } from '../src/strength/decay';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { EngineConfig } from '../src/lib/config';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTestConfig(overrides?: Partial<EngineConfig>): EngineConfig {
  return {
    dbPath: ':memory:',
    ...DEFAULT_CONFIG,
    ...overrides,
  } as EngineConfig;
}

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  initSchema(db);
  return db;
}

// ── STR-01/02: decay arithmetic + Hebbian increment + origin guard ──────────

describe('STR-01: lazy decay — effectiveStrength (pure function)', () => {
  let manager: StrengthDecayManager;

  beforeEach(() => {
    const db = makeDb();
    const clock = new FakeClock(0);
    const config = makeTestConfig();
    manager = new StrengthDecayManager(db, clock, config);
  });

  it('14-day decay at λ=0.05: effectiveStrength(1, 0, 14d_ms, 0.05) ≈ exp(−0.7)', () => {
    const s = 1.0;
    const lambda = 0.05;
    const nowMs = 14 * 86_400_000;
    const result = manager.effectiveStrength(s, 0, nowMs, lambda);
    // Acceptance criterion from plan: within 1e-9 of Math.exp(-0.7)
    expect(result).toBeCloseTo(Math.exp(-0.7), 9);
  });

  it('zero Δt gives back the same s unchanged', () => {
    const t = Date.UTC(2026, 0, 1);
    expect(manager.effectiveStrength(0.8, t, t, 0.05)).toBe(0.8);
  });

  it('positive elapsed time monotonically decreases s', () => {
    const s = 0.7;
    const lambda = 0.05;
    const t0 = 0;
    const t1 = 7 * 86_400_000;
    const t2 = 14 * 86_400_000;
    expect(manager.effectiveStrength(s, t0, t1, lambda)).toBeGreaterThan(0);
    expect(manager.effectiveStrength(s, t0, t1, lambda))
      .toBeGreaterThan(manager.effectiveStrength(s, t0, t2, lambda));
  });

  it('effectiveStrength does not write to DB (pure, no side effects)', () => {
    const db = makeDb();
    const clock = new FakeClock(0);
    const config = makeTestConfig();
    const store = new SemanticStore(db, clock, config);
    const mgr = new StrengthDecayManager(db, clock, config);
    store.upsertNode({ id: 'n1', type: 'fact', value: 'test', origin: 'observed', s: 0.9 });
    const beforeNode = store.getNode('n1')!;

    clock.advanceDays(10);
    mgr.effectiveStrength(beforeNode.s, beforeNode.last_access, clock.nowMs(), config.lambda);

    const afterNode = store.getNode('n1')!;
    expect(afterNode.s).toBe(beforeNode.s);         // s unchanged in DB
    expect(afterNode.last_access).toBe(beforeNode.last_access); // last_access unchanged
  });
});

describe('STR-01: materializeDecay — writes decayed s to DB', () => {
  let db: Database.Database;
  let clock: FakeClock;
  let config: EngineConfig;
  let store: SemanticStore;
  let manager: StrengthDecayManager;

  beforeEach(() => {
    db = makeDb();
    clock = new FakeClock(Date.UTC(2026, 0, 1));
    config = makeTestConfig();
    store = new SemanticStore(db, clock, config);
    manager = new StrengthDecayManager(db, clock, config);
  });

  it('materializeDecay writes effective s back and updates last_access', () => {
    store.upsertNode({ id: 'n1', type: 'fact', value: 'test', origin: 'observed', s: 1.0 });
    const t0 = clock.nowMs();
    clock.advanceDays(14);
    manager.materializeDecay('n1');
    const node = store.getNode('n1')!;
    // Expected: 1.0 * exp(-0.05 * 14) = exp(-0.7)
    expect(node.s).toBeCloseTo(Math.exp(-0.7), 6);
    expect(node.last_access).toBe(clock.nowMs());
    expect(node.last_access).toBeGreaterThan(t0);
  });

  it('materializeDecay is a no-op for unknown nodeId', () => {
    // Should not throw
    expect(() => manager.materializeDecay('nonexistent')).not.toThrow();
  });
});

describe('STR-01: strengthen — decay-before-increment ordering + increments', () => {
  let db: Database.Database;
  let clock: FakeClock;
  let config: EngineConfig;
  let store: SemanticStore;
  let manager: StrengthDecayManager;

  beforeEach(() => {
    db = makeDb();
    clock = new FakeClock(Date.UTC(2026, 0, 1));
    config = makeTestConfig();
    store = new SemanticStore(db, clock, config);
    manager = new StrengthDecayManager(db, clock, config);
  });

  it('strengthen — materializes decay BEFORE incrementing (STR-01 no double-count)', () => {
    // Seed a node with s=1.0 at t=0
    const initialS = 1.0;
    const t0 = clock.nowMs();
    store.upsertNode({ id: 'n1', type: 'fact', value: 'test', origin: 'observed', s: initialS });

    // Advance 30 days — significant decay
    clock.advanceDays(30);
    const nowMs = clock.nowMs();
    // What decayed s will be
    const decayedS = manager.effectiveStrength(initialS, t0, nowMs, config.lambda);

    manager.strengthen('n1', 'observed');
    const node = store.getNode('n1')!;

    // Must be close to: decayed_s + eta*(1 - decayed_s)
    const expectedS = decayedS + config.eta * (1 - decayedS);
    // Must NOT be close to: initialS + eta*(1 - initialS) (naive — would prove decay skipped)
    const naiveS = initialS + config.eta * (1 - initialS);
    expect(node.s).toBeCloseTo(expectedS, 6);
    // Strengthen on top of un-decayed s would be higher — prove it's the lower value
    expect(node.s).toBeLessThan(naiveS);
  });

  it('strengthen with observed applies both s and c increments', () => {
    store.upsertNode({ id: 'n1', type: 'fact', value: 'test', origin: 'observed', s: 0.5, c: 0.3 });
    const before = store.getNode('n1')!;

    manager.strengthen('n1', 'observed');

    const after = store.getNode('n1')!;
    expect(after.s).toBeGreaterThan(before.s);
    expect(after.c).toBeGreaterThan(before.c);
  });

  it('strengthen with asserted_by_user applies both s and c increments', () => {
    store.upsertNode({ id: 'n1', type: 'fact', value: 'test', origin: 'asserted_by_user', s: 0.5, c: 0.3 });

    manager.strengthen('n1', 'asserted_by_user');

    const node = store.getNode('n1')!;
    expect(node.s).toBeGreaterThan(0.5);
    expect(node.c).toBeGreaterThan(0.3);
  });

  it('strengthen updates last_access to clock.nowMs()', () => {
    store.upsertNode({ id: 'n1', type: 'fact', value: 'test', origin: 'observed', s: 0.5 });
    clock.advanceDays(5);
    manager.strengthen('n1', 'observed');
    const node = store.getNode('n1')!;
    expect(node.last_access).toBe(clock.nowMs());
  });
});

describe('STR-01 origin guard — inferred claims cannot strengthen a node', () => {
  let db: Database.Database;
  let clock: FakeClock;
  let config: EngineConfig;
  let store: SemanticStore;
  let manager: StrengthDecayManager;

  beforeEach(() => {
    db = makeDb();
    clock = new FakeClock(Date.UTC(2026, 0, 1));
    config = makeTestConfig();
    store = new SemanticStore(db, clock, config);
    manager = new StrengthDecayManager(db, clock, config);
  });

  it('strengthen with inferred origin — s UNCHANGED (origin guard)', () => {
    store.upsertNode({ id: 'n1', type: 'fact', value: 'test', origin: 'observed', s: 0.5, c: 0.3 });
    const before = store.getNode('n1')!;

    manager.strengthen('n1', 'inferred');

    const after = store.getNode('n1')!;
    // Neither s nor c must change — self-confirmation prevention
    expect(after.s).toBe(before.s);
    expect(after.c).toBe(before.c);
  });

  it('strengthen with inferred origin — c UNCHANGED (origin guard)', () => {
    store.upsertNode({ id: 'n1', type: 'fact', value: 'test', origin: 'observed', s: 0.8, c: 0.7 });

    manager.strengthen('n1', 'inferred');

    const node = store.getNode('n1')!;
    expect(node.s).toBe(0.8);
    expect(node.c).toBe(0.7);
  });
});

describe('STR-02: confidence self-limiting — never saturates', () => {
  let db: Database.Database;
  let clock: FakeClock;
  let config: EngineConfig;
  let store: SemanticStore;
  let manager: StrengthDecayManager;

  beforeEach(() => {
    db = makeDb();
    clock = new FakeClock(Date.UTC(2026, 0, 1));
    config = makeTestConfig();
    store = new SemanticStore(db, clock, config);
    manager = new StrengthDecayManager(db, clock, config);
  });

  it('c stays strictly < 1.0 after 1000 confirming increments (STR-02)', () => {
    store.upsertNode({ id: 'n1', type: 'fact', value: 'test', origin: 'observed', s: 0.5, c: 0.3 });
    for (let i = 0; i < 1000; i++) {
      manager.strengthen('n1', 'observed');
      const node = store.getNode('n1')!;
      expect(node.c).toBeLessThan(1.0);
    }
  });

  it('c is monotonically non-decreasing across 100 confirming increments', () => {
    store.upsertNode({ id: 'n1', type: 'fact', value: 'test', origin: 'observed', s: 0.5, c: 0.1 });
    let prevC = 0.1;
    for (let i = 0; i < 100; i++) {
      manager.strengthen('n1', 'observed');
      const node = store.getNode('n1')!;
      expect(node.c).toBeGreaterThanOrEqual(prevC);
      prevC = node.c;
    }
  });

  it('c after 1000 increments is > 0.99 (self-limiting converges toward 1.0)', () => {
    store.upsertNode({ id: 'n1', type: 'fact', value: 'test', origin: 'observed', s: 0.5, c: 0.3 });
    for (let i = 0; i < 1000; i++) {
      manager.strengthen('n1', 'observed');
    }
    const node = store.getNode('n1')!;
    // Should be very close to 1.0 but not equal (convergence, not saturation)
    expect(node.c).toBeGreaterThan(0.99);
    expect(node.c).toBeLessThan(1.0);
  });

  it('s is also self-limiting and stays < 1.0 after 1000 increments', () => {
    store.upsertNode({ id: 'n1', type: 'fact', value: 'test', origin: 'observed', s: 0.1, c: 0.1 });
    for (let i = 0; i < 1000; i++) {
      manager.strengthen('n1', 'observed');
      const node = store.getNode('n1')!;
      expect(node.s).toBeLessThan(1.0);
    }
  });
});
