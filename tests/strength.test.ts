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

// ── STR-03: AND-gated eviction sweep + 30-day invariant ─────────────────────

describe('STR-03: AND-gated eviction sweep', () => {
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

  it('truth table — only tombstoned+low_s+low_c is evicted', () => {
    // Should evict: tombstoned=1, effective_s=0.001 < 0.05, c=0.001 < 0.15
    store.upsertNode({ id: 'should-evict', type: 'fact', value: 'old', origin: 'observed', s: 0.001, c: 0.001, tombstoned: true });

    // Should NOT evict: tombstoned=0 (gate closed)
    store.upsertNode({ id: 'no-tombstone', type: 'fact', value: 'live', origin: 'observed', s: 0.001, c: 0.001, tombstoned: false });

    // Should NOT evict: tombstoned=1 but c=0.9 (above evictionCThreshold=0.15)
    store.upsertNode({ id: 'high-c', type: 'fact', value: 'high-c', origin: 'observed', s: 0.001, c: 0.9, tombstoned: true });

    // Should NOT evict: tombstoned=1 but effective_s=0.9 (above evictionSThreshold=0.05)
    store.upsertNode({ id: 'high-s', type: 'fact', value: 'high-s', origin: 'observed', s: 0.9, c: 0.001, tombstoned: true });

    const evicted = manager.runEvictionSweep();

    expect(evicted).toContain('should-evict');
    expect(evicted).not.toContain('no-tombstone');
    expect(evicted).not.toContain('high-c');
    expect(evicted).not.toContain('high-s');

    // Verify DB state
    expect(store.getNode('should-evict')).toBeNull();
    expect(store.getNode('no-tombstone')).not.toBeNull();
    expect(store.getNode('high-c')).not.toBeNull();
    expect(store.getNode('high-s')).not.toBeNull();
  });

  it('tombstoned=0, low s, low c, 30 days — NOT evicted (gate closure)', () => {
    // Acceptance criterion from plan: {tombstoned:0, s:0.001, c:0.001} after 30 FakeClock days
    store.upsertNode({ id: 'live', type: 'fact', value: 'alive', origin: 'observed', s: 0.001, c: 0.001, tombstoned: false });
    clock.advanceDays(30);
    const evicted = manager.runEvictionSweep();
    expect(evicted).not.toContain('live');
    expect(store.getNode('live')).not.toBeNull();
  });

  it('tombstoned=1, low s, low c, 30 days — IS evicted', () => {
    // Acceptance criterion from plan: {tombstoned:1, s:0.001, c:0.001} after 30 FakeClock days IS evicted
    store.upsertNode({ id: 'dead', type: 'fact', value: 'stale', origin: 'observed', s: 0.001, c: 0.001, tombstoned: true });
    clock.advanceDays(30);
    const evicted = manager.runEvictionSweep();
    expect(evicted).toContain('dead');
    expect(store.getNode('dead')).toBeNull();
  });

  it('runEvictionSweep uses effective_s (not stored s) for threshold comparison', () => {
    // Node starts with s=0.9 but after massive decay effective_s will be << threshold
    // However since tombstoned=1 is required, use tombstoned=true
    // After enough decay effective_s will fall below evictionSThreshold=0.05
    // λ=0.05, s=0.3, after 365 days: 0.3*exp(-0.05*365) = 0.3*exp(-18.25) ≈ 0
    store.upsertNode({ id: 'decayed', type: 'fact', value: 'old', origin: 'observed', s: 0.3, c: 0.001, tombstoned: true });
    clock.advanceDays(365); // 1 year of no access
    const evicted = manager.runEvictionSweep();
    // effective_s is now ~0 which is well below 0.05, c=0.001 < 0.15, tombstoned=1
    expect(evicted).toContain('decayed');
  });

  it('runEvictionSweep returns empty array when no nodes qualify', () => {
    store.upsertNode({ id: 'n1', type: 'fact', value: 'alive', origin: 'observed', s: 0.5, c: 0.5, tombstoned: false });
    const evicted = manager.runEvictionSweep();
    expect(evicted).toHaveLength(0);
  });

  it('eviction predicate contains all three AND terms (tombstoned, sThreshold, cThreshold)', () => {
    // Verify each condition is independently required by testing all partial combinations

    // tombstoned=1, low s, HIGH c — should NOT evict
    store.upsertNode({ id: 'test-c', type: 'fact', value: 'v', origin: 'observed', s: 0.001, c: 0.9, tombstoned: true });
    // tombstoned=1, HIGH s, low c — should NOT evict
    store.upsertNode({ id: 'test-s', type: 'fact', value: 'v2', origin: 'observed', s: 0.9, c: 0.001, tombstoned: true });
    // tombstoned=0, low s, low c — should NOT evict
    store.upsertNode({ id: 'test-t', type: 'fact', value: 'v3', origin: 'observed', s: 0.001, c: 0.001, tombstoned: false });
    // All three — should evict
    store.upsertNode({ id: 'test-all', type: 'fact', value: 'v4', origin: 'observed', s: 0.001, c: 0.001, tombstoned: true });

    const evicted = manager.runEvictionSweep();
    expect(evicted).toEqual(['test-all']);
  });
});

describe('STR-03 INVARIANT: 30-day simulated month — no evidence-backed node evicted', () => {
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

  it('no origin=observed/asserted_by_user node evicted after 30 sparse-read days', () => {
    // Seed evidence-backed nodes (D-06: tombstoned=false)
    store.upsertNode({ id: 'obs1', type: 'fact', value: 'observed fact 1', origin: 'observed', s: 0.5, c: 0.5, tombstoned: false });
    store.upsertNode({ id: 'obs2', type: 'entity', value: 'observed entity', origin: 'observed', s: 0.3, c: 0.4, tombstoned: false });
    store.upsertNode({ id: 'asc1', type: 'fact', value: 'user asserted fact', origin: 'asserted_by_user', s: 0.1, c: 0.8, tombstoned: false });
    store.upsertNode({ id: 'asc2', type: 'schema', value: 'user schema', origin: 'asserted_by_user', s: 0.2, c: 0.6, tombstoned: false });

    // Simulate 30 days of sparse reads (worst case — no access, maximum decay)
    for (let day = 0; day < 30; day++) {
      clock.advanceDays(1);
    }

    // Run eviction sweep
    const evicted = manager.runEvictionSweep();

    // INVARIANT: no evidence-backed node is ever evicted (tombstoned=0 gate closure)
    expect(evicted).not.toContain('obs1');
    expect(evicted).not.toContain('obs2');
    expect(evicted).not.toContain('asc1');
    expect(evicted).not.toContain('asc2');

    // All nodes still exist in DB
    expect(store.getNode('obs1')).not.toBeNull();
    expect(store.getNode('obs2')).not.toBeNull();
    expect(store.getNode('asc1')).not.toBeNull();
    expect(store.getNode('asc2')).not.toBeNull();
  });

  it('invariant holds even for nodes with near-zero s and c (tombstoned=0 is the only gate)', () => {
    // Seeds with very low s and c — still protected by tombstoned=0
    store.upsertNode({ id: 'weak-obs', type: 'fact', value: 'weakly remembered', origin: 'observed', s: 0.001, c: 0.001, tombstoned: false });
    store.upsertNode({ id: 'weak-asc', type: 'fact', value: 'weakly asserted', origin: 'asserted_by_user', s: 0.001, c: 0.001, tombstoned: false });

    // Maximum time advance — 365 days, no access
    for (let day = 0; day < 365; day++) {
      clock.advanceDays(1);
    }

    const evicted = manager.runEvictionSweep();
    expect(evicted).not.toContain('weak-obs');
    expect(evicted).not.toContain('weak-asc');
    expect(store.getNode('weak-obs')).not.toBeNull();
    expect(store.getNode('weak-asc')).not.toBeNull();
  });

  it('tombstoned nodes with low s and c ARE evicted (sweep is not completely inert)', () => {
    // Verifies the sweep does something — tombstoned nodes still get cleaned up
    store.upsertNode({ id: 'stale1', type: 'fact', value: 'old claim', origin: 'observed', s: 0.001, c: 0.001, tombstoned: true });
    store.upsertNode({ id: 'stale2', type: 'fact', value: 'another old', origin: 'asserted_by_user', s: 0.001, c: 0.001, tombstoned: true });

    clock.advanceDays(30);
    const evicted = manager.runEvictionSweep();

    expect(evicted).toContain('stale1');
    expect(evicted).toContain('stale2');
  });
});
