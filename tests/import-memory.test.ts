/**
 * import-memory CLI tests (Plan 999.3-02, D-S4 / D-S5).
 *
 * Behavioural invariants:
 *  (a) planImport scans `<base>/*\/memory/*.md`, SKIPS the policy-bundle skiplist
 *      and MEMORY.md index files (D-S5), and emits one 'import' item per remaining
 *      fact file with the correct project/cwd/scope (D-S4 cwd→scope mapping).
 *  (b) folderToCwd maps `-Users-vtx-<slug>` → `/Users/vtx/<slug>` (slugs may contain
 *      dashes, e.g. brain-memory).
 *  (c) runImport ingests exactly the 'import' items via IngestionPipeline.recordEvent
 *      with source='memory-import' and a stable external_id.
 *  (d) A second runImport on unchanged files adds ZERO new episodes (idempotent via
 *      (source, external_id) dedup — D-59 backstop).
 *  (e) --dry-run / planImport writes nothing and never mutates source files.
 *
 * Uses: a real temp fixture dir, in-memory SQLite, real Gate/Store/Pipeline.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initSchema } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { EngineConfig } from '../src/lib/config';
import { EpisodicStore } from '../src/db/episode-store';
import { AllocationGate, IngestionPipeline } from '../src/ingest/pipeline';
import { folderToCwd, planImport, runImport } from '../src/adapter/import-memory-cli';

const TEST_CONFIG: EngineConfig = { ...DEFAULT_CONFIG, dbPath: ':memory:' };

/**
 * Build a fixture project dir under base:
 *   <base>/-Users-vtx-<slug>/memory/{MEMORY.md, voice_profile.md, fact-one.md, fact-two.md}
 * Returns the per-file paths so tests can assert content/mtime stability.
 */
function makeFixture(base: string, slug: string): {
  memoryIndex: string;
  policyBundle: string;
  factOne: string;
  factTwo: string;
} {
  const memDir = join(base, `-Users-vtx-${slug}`, 'memory');
  mkdirSync(memDir, { recursive: true });
  const memoryIndex = join(memDir, 'MEMORY.md');
  const policyBundle = join(memDir, 'voice_profile.md');
  const factOne = join(memDir, 'fact-one.md');
  const factTwo = join(memDir, 'fact-two.md');
  writeFileSync(memoryIndex, '# Memory Index\n- [a](a.md)\n');
  writeFileSync(policyBundle, '# voice profile\nlowercase by default\n');
  writeFileSync(factOne, '# fact one\nthe db path is ~/.config/recense/recense.db\n');
  writeFileSync(factTwo, '# fact two\nthe judge model is qwen 35b-a3b\n');
  return { memoryIndex, policyBundle, factOne, factTwo };
}

describe('folderToCwd — folder → cwd mapping (D-S4)', () => {
  it('maps -Users-vtx-brain-memory → /Users/vtx/brain-memory (slug keeps its dash)', () => {
    expect(folderToCwd('-Users-vtx-brain-memory')).toBe('/Users/vtx/brain-memory');
  });

  it('maps -Users-vtx-resume → /Users/vtx/resume', () => {
    expect(folderToCwd('-Users-vtx-resume')).toBe('/Users/vtx/resume');
  });

  it('returns empty string for a non-project folder name', () => {
    expect(folderToCwd('not-a-project')).toBe('');
    expect(folderToCwd('-Users-vtx')).toBe('');
  });
});

describe('planImport — scan + skiplist (D-S5)', () => {
  let base: string;
  afterEach(() => {
    if (base) rmSync(base, { recursive: true, force: true });
  });

  it('imports exactly the 2 fact files, skips MEMORY.md + policy bundle, with correct scope', () => {
    base = mkdtempSync(join(tmpdir(), 'import-mem-'));
    makeFixture(base, 'someproj');

    const plan = planImport(base, {});
    const imports = plan.filter(p => p.action === 'import');
    const skips = plan.filter(p => p.action === 'skip');

    expect(imports).toHaveLength(2);
    expect(skips).toHaveLength(2);
    // Every import is correctly attributed to the project scope.
    for (const item of imports) {
      expect(item.project).toBe('someproj');
      expect(item.cwd).toBe('/Users/vtx/someproj');
      expect(item.scope).toBe('someproj');
      expect(item.externalId).toContain('memory-import:someproj:');
    }
    // The skiplist hits are the index and the policy bundle.
    const skipReasons = skips.map(s => s.skipReason).sort();
    expect(skipReasons).toEqual(['memory-index', 'policy-bundle']);
  });

  it('the resume project maps to global scope', () => {
    base = mkdtempSync(join(tmpdir(), 'import-mem-'));
    makeFixture(base, 'resume');
    const imports = planImport(base, {}).filter(p => p.action === 'import');
    expect(imports).toHaveLength(2);
    for (const item of imports) expect(item.scope).toBe('global');
  });

  it('--project filters to a single project', () => {
    base = mkdtempSync(join(tmpdir(), 'import-mem-'));
    makeFixture(base, 'proja');
    makeFixture(base, 'projb');
    const imports = planImport(base, { project: 'projb' }).filter(p => p.action === 'import');
    expect(imports).toHaveLength(2);
    for (const item of imports) expect(item.project).toBe('projb');
  });

  it('writes nothing and leaves source files byte-for-byte unchanged', () => {
    base = mkdtempSync(join(tmpdir(), 'import-mem-'));
    const f = makeFixture(base, 'someproj');
    const before = {
      one: readFileSync(f.factOne, 'utf8'),
      two: readFileSync(f.factTwo, 'utf8'),
      policy: readFileSync(f.policyBundle, 'utf8'),
      mtime: statSync(f.factOne).mtimeMs,
    };
    planImport(base, {});
    expect(readFileSync(f.factOne, 'utf8')).toBe(before.one);
    expect(readFileSync(f.factTwo, 'utf8')).toBe(before.two);
    expect(readFileSync(f.policyBundle, 'utf8')).toBe(before.policy);
    expect(statSync(f.factOne).mtimeMs).toBe(before.mtime);
  });
});

describe('runImport — ingest via pipeline, idempotent (D-S4)', () => {
  let db: Database.Database;
  let store: EpisodicStore;
  let pipeline: IngestionPipeline;
  let base: string;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    store = new EpisodicStore(db, new FakeClock(1_000_000), TEST_CONFIG);
    pipeline = new IngestionPipeline(new AllocationGate(TEST_CONFIG), store);
    base = mkdtempSync(join(tmpdir(), 'import-mem-'));
  });

  afterEach(() => {
    db.close();
    if (base) rmSync(base, { recursive: true, force: true });
  });

  it('ingests exactly the 2 fact files with source=memory-import and mapped cwd', () => {
    makeFixture(base, 'someproj');
    const plan = planImport(base, {});
    const counts = runImport(plan, pipeline, () => {});

    expect(counts.imported).toBe(2);
    expect(counts.skippedPolicy).toBe(1);
    expect(counts.skippedIndex).toBe(1);

    const episodes = store.listUnconsolidated();
    expect(episodes).toHaveLength(2);
    for (const ep of episodes) {
      expect(ep.source).toBe('memory-import');
      expect(ep.cwd).toBe('/Users/vtx/someproj');
      expect(ep.external_id).toContain('memory-import:someproj:');
    }
  });

  it('a second run on unchanged files adds zero new episodes (idempotent)', () => {
    makeFixture(base, 'someproj');
    const plan1 = planImport(base, {});
    runImport(plan1, pipeline, () => {});
    expect(store.listUnconsolidated()).toHaveLength(2);

    const plan2 = planImport(base, {});
    const counts2 = runImport(plan2, pipeline, () => {});
    // recordEvent still "imports" each item, but the (source, external_id) dedup
    // backstop means no NEW rows land.
    expect(counts2.imported).toBe(2);
    expect(store.listUnconsolidated()).toHaveLength(2);
  });

  it('never modifies source files during a real import', () => {
    const f = makeFixture(base, 'someproj');
    const before = readFileSync(f.factOne, 'utf8');
    const beforeMtime = statSync(f.factOne).mtimeMs;
    runImport(planImport(base, {}), pipeline, () => {});
    expect(readFileSync(f.factOne, 'utf8')).toBe(before);
    expect(statSync(f.factOne).mtimeMs).toBe(beforeMtime);
  });
});
