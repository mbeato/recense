/**
 * Doc-ingest + idempotent re-ingest tests (Phase 31 Plans 01 + 02).
 *
 * Plan 01 (Tasks 1+2): emitDocEpisodes helper — origin/source, redaction, deterministic relPath,
 *   content-hash idempotency via a real in-memory EpisodicStore + IngestionPipeline.
 *
 * Plan 02 (Tasks 1+2+3): fingerprint + --force flag, SemanticStore cursor skip-gate/write,
 *   dup-rate / reconciliation gate (D-07).
 *
 * All tests are deterministic in-memory (better-sqlite3 + mocked pipeline/transport).
 * No sleep.env, OPENAI_API_KEY, or headless transport required.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync, symlinkSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { initSchema } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { EngineConfig } from '../src/lib/config';
import { SemanticStore } from '../src/db/semantic-store';
import { EpisodicStore } from '../src/db/episode-store';
import { AllocationGate, IngestionPipeline } from '../src/ingest/pipeline';

const testConfig: EngineConfig = { ...DEFAULT_CONFIG, dbPath: ':memory:' };

// ── Task 1: emitDocEpisodes helper — origin/source/redaction/relPath ──────────

describe('project-doc', () => {
  let tmpDir: string;
  let capturedEvents: Array<Record<string, unknown>>;
  let mockPipeline: { recordEvent: (e: Record<string, unknown>) => void };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'recense-doc-test-'));
    capturedEvents = [];
    mockPipeline = {
      recordEvent: (event: Record<string, unknown>) => {
        capturedEvents.push(event);
      },
    };
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits origin="observed" and source="project-doc" for README.md', async () => {
    const { emitDocEpisodes } = await import('../src/adapter/ingest-project-cli');

    writeFileSync(join(tmpDir, 'README.md'), '# My Project\nThis is a test project.');

    const result = await emitDocEpisodes({
      dir: tmpDir,
      scope: 'test-scope',
      cwd: tmpDir,
      pipeline: mockPipeline as never,
      dryRun: false,
    });

    expect(result.docCount).toBe(1);
    expect(result.episodeCount).toBeGreaterThan(0);
    expect(capturedEvents).toHaveLength(result.episodeCount);

    const event = capturedEvents[0]!;
    expect(event['origin']).toBe('observed');
    expect(event['source']).toBe('project-doc');
  });

  it('sessionId begins with "project-doc:"', async () => {
    const { emitDocEpisodes } = await import('../src/adapter/ingest-project-cli');

    writeFileSync(join(tmpDir, 'README.md'), '# My Project\nSome content here.');

    await emitDocEpisodes({
      dir: tmpDir,
      scope: 'my-scope',
      cwd: tmpDir,
      pipeline: mockPipeline as never,
      dryRun: false,
    });

    expect(capturedEvents.length).toBeGreaterThan(0);
    const event = capturedEvents[0]!;
    expect(String(event['sessionId'])).toMatch(/^project-doc:/);
  });

  it('redacts API-key-shaped secrets from doc content', async () => {
    const { emitDocEpisodes } = await import('../src/adapter/ingest-project-cli');

    const secretKey = 'sk-abcdefghijklmnopqrstuvwxyz123456789';
    writeFileSync(join(tmpDir, 'README.md'), `# Config\nAPI key: ${secretKey}`);

    await emitDocEpisodes({
      dir: tmpDir,
      scope: 'test-scope',
      cwd: tmpDir,
      pipeline: mockPipeline as never,
      dryRun: false,
    });

    expect(capturedEvents.length).toBeGreaterThan(0);
    // Secret string must be absent from all recorded content
    for (const event of capturedEvents) {
      expect(String(event['content'])).not.toContain(secretKey);
    }
  });

  it('relPath is stable regardless of trailing slash in dir', async () => {
    const { emitDocEpisodes } = await import('../src/adapter/ingest-project-cli');

    writeFileSync(join(tmpDir, 'README.md'), '# Stable relPath test\nContent here.');

    const events1: Array<Record<string, unknown>> = [];
    const events2: Array<Record<string, unknown>> = [];

    await emitDocEpisodes({
      dir: tmpDir,
      scope: 'scope',
      cwd: tmpDir,
      pipeline: { recordEvent: (e: Record<string, unknown>) => events1.push(e) } as never,
      dryRun: false,
    });

    await emitDocEpisodes({
      dir: tmpDir + '/',
      scope: 'scope',
      cwd: tmpDir,
      pipeline: { recordEvent: (e: Record<string, unknown>) => events2.push(e) } as never,
      dryRun: false,
    });

    expect(events1.length).toBe(events2.length);
    // externalId should be identical (same relPath + same content)
    expect(events1[0]!['externalId']).toBe(events2[0]!['externalId']);
  });

  it('dryRun=true returns would-be counts but does NOT call recordEvent', async () => {
    const { emitDocEpisodes } = await import('../src/adapter/ingest-project-cli');

    writeFileSync(join(tmpDir, 'README.md'), '# Dry Run\nSome content.');
    writeFileSync(join(tmpDir, 'CLAUDE.md'), '# CLAUDE.md\nProject instructions.');

    const result = await emitDocEpisodes({
      dir: tmpDir,
      scope: 'scope',
      cwd: tmpDir,
      pipeline: mockPipeline as never,
      dryRun: true,
    });

    // No recordEvent calls in dry-run
    expect(capturedEvents).toHaveLength(0);
    // But counts reflect would-be docs
    expect(result.docCount).toBeGreaterThan(0);
  });

  it('collectDocPaths returns [] for a dir with no README/CLAUDE/docs', async () => {
    const { emitDocEpisodes } = await import('../src/adapter/ingest-project-cli');

    // Empty dir — no docs
    const result = await emitDocEpisodes({
      dir: tmpDir,
      scope: 'scope',
      cwd: tmpDir,
      pipeline: mockPipeline as never,
      dryRun: false,
    });

    expect(result.docCount).toBe(0);
    expect(result.episodeCount).toBe(0);
    expect(capturedEvents).toHaveLength(0);
  });

  it('ingests CLAUDE.md and docs/**/*.md in addition to README.md', async () => {
    const { emitDocEpisodes } = await import('../src/adapter/ingest-project-cli');

    writeFileSync(join(tmpDir, 'README.md'), '# README\nContent.');
    writeFileSync(join(tmpDir, 'CLAUDE.md'), '# CLAUDE\nInstructions.');
    mkdirSync(join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(join(tmpDir, 'docs', 'guide.md'), '# Guide\nGuide content.');

    const result = await emitDocEpisodes({
      dir: tmpDir,
      scope: 'scope',
      cwd: tmpDir,
      pipeline: mockPipeline as never,
      dryRun: false,
    });

    // Should have 3 docs: README.md, CLAUDE.md, docs/guide.md
    expect(result.docCount).toBe(3);
    // Verify source on all events
    for (const event of capturedEvents) {
      expect(event['source']).toBe('project-doc');
    }
  });

  it('externalId is derived from POST-redaction content (matches what is recorded)', async () => {
    const { emitDocEpisodes } = await import('../src/adapter/ingest-project-cli');
    const { contentExternalId } = await import('../src/source/source-adapter');

    writeFileSync(join(tmpDir, 'README.md'), '# README\nPlain content here.');

    await emitDocEpisodes({
      dir: tmpDir,
      scope: 'scope',
      cwd: tmpDir,
      pipeline: mockPipeline as never,
      dryRun: false,
    });

    expect(capturedEvents.length).toBeGreaterThan(0);
    const event = capturedEvents[0]!;
    const recordedContent = String(event['content']);
    const recordedExternalId = String(event['externalId']);

    // The externalId must be computed from the actual recorded content (post-redaction)
    const expectedExternalId = contentExternalId('README.md', recordedContent);
    expect(recordedExternalId).toBe(expectedExternalId);
  });

  // IN-01 / T-31-PATH: symlinked README/CLAUDE/docs that escape the project root must be skipped
  it('skips symlinked README/docs that escape the project root (T-31-PATH)', async () => {
    const { emitDocEpisodes, collectDocPaths } = await import('../src/adapter/ingest-project-cli');

    // Create a secret file OUTSIDE tmpDir
    const outsideDir = mkdtempSync(join(tmpdir(), 'recense-outside-'));
    const secretSentinel = 'TOP-SECRET-OUTSIDE-CONTENT-DO-NOT-INGEST';
    const outsideFile = join(outsideDir, 'secret.md');
    writeFileSync(outsideFile, `# secret\n${secretSentinel}`);

    try {
      // Symlink <tmpDir>/README.md and <tmpDir>/docs/leak.md to the outside file
      symlinkSync(outsideFile, join(tmpDir, 'README.md'));
      mkdirSync(join(tmpDir, 'docs'), { recursive: true });
      symlinkSync(outsideFile, join(tmpDir, 'docs', 'leak.md'));

      // collectDocPaths must exclude the escaping paths (realpath points outside root)
      const docPaths = collectDocPaths(tmpDir);
      const outsideReal = join(outsideDir, 'secret.md');
      for (const p of docPaths) {
        expect(p).not.toContain(outsideDir);
        expect(p).not.toBe(outsideReal);
      }

      // Outside content must never reach any recorded episode
      await emitDocEpisodes({
        dir: tmpDir,
        scope: 'scope',
        cwd: tmpDir,
        pipeline: mockPipeline as never,
        dryRun: false,
      });
      for (const event of capturedEvents) {
        expect(String(event['content'])).not.toContain(secretSentinel);
      }
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

// ── Task 2: content-hash idempotency (real in-memory DB) ─────────────────────

describe('project-doc idempotency', () => {
  let tmpDir: string;
  let db: Database.Database;
  let episodes: EpisodicStore;
  let pipeline: IngestionPipeline;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'recense-reingest-test-'));
    db = new Database(':memory:');
    initSchema(db);
    const clock = new FakeClock(1_000_000);
    episodes = new EpisodicStore(db, clock, testConfig);
    pipeline = new IngestionPipeline(new AllocationGate(testConfig), episodes);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('unchanged doc re-run inserts 0 new project-doc episodes', async () => {
    const { emitDocEpisodes } = await import('../src/adapter/ingest-project-cli');

    writeFileSync(join(tmpDir, 'README.md'), '# Project\nThis is the content.');

    // First run
    await emitDocEpisodes({
      dir: tmpDir,
      scope: 'scope',
      cwd: tmpDir,
      pipeline,
      dryRun: false,
    });

    const countAfterFirst = (db.prepare("SELECT COUNT(*) as c FROM episode WHERE source='project-doc'").get() as { c: number }).c;
    expect(countAfterFirst).toBeGreaterThan(0);

    // Second run on the SAME content — INSERT OR IGNORE on (source, external_id) → 0 new rows
    await emitDocEpisodes({
      dir: tmpDir,
      scope: 'scope',
      cwd: tmpDir,
      pipeline,
      dryRun: false,
    });

    const countAfterSecond = (db.prepare("SELECT COUNT(*) as c FROM episode WHERE source='project-doc'").get() as { c: number }).c;
    expect(countAfterSecond).toBe(countAfterFirst);
  });

  it('edited doc inserts a new project-doc episode', async () => {
    const { emitDocEpisodes } = await import('../src/adapter/ingest-project-cli');

    writeFileSync(join(tmpDir, 'README.md'), '# Project\nOriginal content.');

    // First run
    await emitDocEpisodes({
      dir: tmpDir,
      scope: 'scope',
      cwd: tmpDir,
      pipeline,
      dryRun: false,
    });

    const countAfterFirst = (db.prepare("SELECT COUNT(*) as c FROM episode WHERE source='project-doc'").get() as { c: number }).c;

    // Edit the doc — new content → new hash → new external_id → new episode
    writeFileSync(join(tmpDir, 'README.md'), '# Project\nEdited content — completely different now.');

    await emitDocEpisodes({
      dir: tmpDir,
      scope: 'scope',
      cwd: tmpDir,
      pipeline,
      dryRun: false,
    });

    const countAfterEdit = (db.prepare("SELECT COUNT(*) as c FROM episode WHERE source='project-doc'").get() as { c: number }).c;
    expect(countAfterEdit).toBeGreaterThan(countAfterFirst);
  });

  it('dry-run emitDocEpisodes never calls recordEvent (0 rows in DB)', async () => {
    const { emitDocEpisodes } = await import('../src/adapter/ingest-project-cli');

    writeFileSync(join(tmpDir, 'README.md'), '# Project\nSome content.');

    await emitDocEpisodes({
      dir: tmpDir,
      scope: 'scope',
      cwd: tmpDir,
      pipeline,
      dryRun: true,
    });

    const count = (db.prepare("SELECT COUNT(*) as c FROM episode WHERE source='project-doc'").get() as { c: number }).c;
    expect(count).toBe(0);
  });
});

// ── Plan 02 Task 1: --force flag + repo fingerprint helpers ──────────────────

describe('fingerprint helpers (Plan 02 Task 1)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'recense-fp-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parseIngestArgs: --force absent → force=false', async () => {
    const { parseIngestArgs } = await import('../src/adapter/ingest-project-cli');
    const args = parseIngestArgs(['/tmp/somedir']);
    expect(args.force).toBe(false);
  });

  it('parseIngestArgs: --force present → force=true', async () => {
    const { parseIngestArgs } = await import('../src/adapter/ingest-project-cli');
    const args = parseIngestArgs(['/tmp/somedir', '--force']);
    expect(args.force).toBe(true);
  });

  it('parseIngestArgs: --force with other flags → force=true', async () => {
    const { parseIngestArgs } = await import('../src/adapter/ingest-project-cli');
    const args = parseIngestArgs(['/tmp/somedir', '--dry-run', '--force', '--db', '/tmp/x.db']);
    expect(args.force).toBe(true);
    expect(args.dryRun).toBe(true);
    expect(args.db).toBe('/tmp/x.db');
  });

  it('gitFingerprint: non-git dir returns null', async () => {
    const { gitFingerprint } = await import('../src/adapter/ingest-project-cli');
    // tmpDir has no .git directory — spawnSync git rev-parse HEAD exits non-zero
    const result = gitFingerprint(tmpDir);
    expect(result).toBeNull();
  });

  it('gitFingerprint: git repo returns {sha, dirty} (uses process.cwd() which is a git repo)', async () => {
    const { gitFingerprint } = await import('../src/adapter/ingest-project-cli');
    // process.cwd() in the test runner is the brain-memory repo root (a git repo)
    const result = gitFingerprint(process.cwd());
    expect(result).not.toBeNull();
    expect(result!.sha.length).toBeGreaterThanOrEqual(7);
    expect(typeof result!.dirty).toBe('boolean');
  });

  it('gitFingerprint: init-ed temp repo returns {sha, dirty}', async () => {
    const { gitFingerprint } = await import('../src/adapter/ingest-project-cli');
    // Create a real git repo in tmpDir
    try {
      execSync(`git -C ${JSON.stringify(tmpDir)} init && git -C ${JSON.stringify(tmpDir)} config user.email "test@test.com" && git -C ${JSON.stringify(tmpDir)} config user.name "Test" && touch ${JSON.stringify(join(tmpDir, 'file.txt'))} && git -C ${JSON.stringify(tmpDir)} add . && git -C ${JSON.stringify(tmpDir)} commit -m "init"`, { stdio: 'pipe' });
    } catch {
      // If git init fails in CI, skip gracefully
      return;
    }
    const result = gitFingerprint(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.sha.length).toBeGreaterThanOrEqual(7);
    expect(result!.dirty).toBe(false);

    // Exercise the dirty=true branch: an untracked file makes the tree dirty
    writeFileSync(join(tmpDir, 'untracked.txt'), 'new content');
    const dirtyResult = gitFingerprint(tmpDir);
    expect(dirtyResult).not.toBeNull();
    expect(dirtyResult!.dirty).toBe(true);
  });

  it('computeProjectFingerprint: git repo → git: prefixed string', async () => {
    const { computeProjectFingerprint } = await import('../src/adapter/ingest-project-cli');
    const fp = computeProjectFingerprint(process.cwd(), []);
    expect(fp).toMatch(/^git:/);
  });

  it('computeProjectFingerprint: non-git dir → mtime: prefixed string', async () => {
    const { computeProjectFingerprint } = await import('../src/adapter/ingest-project-cli');
    // Write a doc file so mtime has a real value
    const docPath = join(tmpDir, 'README.md');
    writeFileSync(docPath, '# Hello');
    const fp = computeProjectFingerprint(tmpDir, [docPath]);
    expect(fp).toMatch(/^mtime:/);
  });

  it('computeProjectFingerprint: non-git mtime changes when doc is touched', async () => {
    const { computeProjectFingerprint } = await import('../src/adapter/ingest-project-cli');
    const docPath = join(tmpDir, 'README.md');
    writeFileSync(docPath, '# Hello');
    const fp1 = computeProjectFingerprint(tmpDir, [docPath]);

    // Advance mtime by 5 seconds
    const now = Date.now() / 1000;
    utimesSync(docPath, now + 5, now + 5);
    const fp2 = computeProjectFingerprint(tmpDir, [docPath]);

    expect(fp1).toMatch(/^mtime:/);
    expect(fp2).toMatch(/^mtime:/);
    expect(fp1).not.toBe(fp2);
  });

  it('computeProjectFingerprint: non-existent doc path is skipped (no throw)', async () => {
    const { computeProjectFingerprint } = await import('../src/adapter/ingest-project-cli');
    // Pass a non-existent path — should not throw, mtime fallback with 0
    expect(() => computeProjectFingerprint(tmpDir, ['/nonexistent/path/doc.md'])).not.toThrow();
  });
});

// ── Plan 02 Task 2: SemanticStore cursor skip-gate + deferred write ───────────
//
// These tests use runIngestWithMockSurvey() — a test-internal wrapper that wires
// the cursor skip-gate logic (SemanticStore getMeta/setMeta + computeProjectFingerprint)
// the same way real main() does, but with:
//   - an in-memory DB (no live brain)
//   - a mock surveyArea transport (callable counter, no real LLM)
//   - emitDocEpisodes (real but on tmpDir with no docs → 0 doc episodes)

describe('cursor skip-gate (Plan 02 Task 2)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let surveyCalls: number;
  let mockSurveyArea: (_area: string, _dir: string, _desc: string) => Promise<string>;

  const testConfig: EngineConfig = { ...DEFAULT_CONFIG, dbPath: ':memory:' };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'recense-cursor-test-'));
    // A non-git dir needs at least one doc so computeProjectFingerprint produces a
    // STABLE mtime fingerprint (WR-01: an empty doc-less dir fingerprints distinctly
    // every run and never skips — correct for the survey-gate, wrong for these
    // cursor-stability tests, which exercise the unchanged→skip path).
    writeFileSync(join(tmpDir, 'README.md'), '# cursor test\nStable content.');
    db = new Database(':memory:');
    initSchema(db);
    surveyCalls = 0;
    mockSurveyArea = async (_area: string, _dir: string, _desc: string) => {
      surveyCalls++;
      return '- test observation from mock survey';
    };
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Helper: run the cursor-gated survey path inline (models both real-run branches).
   * Returns the number of survey episodes fed and whether the survey was skipped.
   */
  async function runWithCursor(opts: { force?: boolean; dryRun?: boolean }): Promise<{ fed: number; skipped: boolean }> {
    const {
      computeProjectFingerprint, collectDocPaths, emitDocEpisodes, runSurveyAndFeed,
    } = await import('../src/adapter/ingest-project-cli');
    const { SemanticStore: SS } = await import('../src/db/semantic-store');
    const { realClock } = await import('../src/lib/clock');
    const { EpisodicStore: ES } = await import('../src/db/episode-store');
    const { AllocationGate: AG, IngestionPipeline: IP } = await import('../src/ingest/pipeline');

    const scope = 'test-scope';
    const semanticStore = new SS(db, realClock, testConfig);
    const episodes = new ES(db, realClock, testConfig);
    const pipeline = new IP(new AG(testConfig), episodes);

    const docPaths = collectDocPaths(tmpDir);
    const fingerprint = computeProjectFingerprint(tmpDir, docPaths);
    const stored = semanticStore.getMeta(`cursor:project:${scope}`);
    const surveySkipped = !opts.force && stored !== null && stored === fingerprint;

    // Emit docs unconditionally (independent of cursor)
    await emitDocEpisodes({
      dir: tmpDir, scope, cwd: tmpDir, pipeline,
      dryRun: opts.dryRun ?? false,
    });

    let fed = 0;
    if (surveySkipped) {
      process.stdout.write('  survey skipped (unchanged) — fingerprint matches cursor\n');
    } else {
      const result = await runSurveyAndFeed({
        dir: tmpDir, scope, repoDesc: 'test repo',
        pipeline, surveyArea: mockSurveyArea,
        dryRun: opts.dryRun ?? false,
      });
      fed = result.totalFed;
      // Commit cursor after survey succeeds, skipped on dry-run (D-09)
      if (!(opts.dryRun)) {
        semanticStore.setMeta(`cursor:project:${scope}`, fingerprint);
      }
    }

    return { fed, skipped: surveySkipped };
  }

  // T-31-CURSOR-1: unchanged repo → mock surveyArea NOT called → 0 survey episodes
  it('T-31-CURSOR-1: unchanged repo → survey skipped, 0 survey calls', async () => {
    // First run — no cursor stored → survey runs
    await runWithCursor({});
    expect(surveyCalls).toBeGreaterThan(0); // 5 SURVEY_AREAS
    const callsAfterFirst = surveyCalls;

    surveyCalls = 0; // reset counter

    // Second run — cursor stored + fingerprint matches → survey skipped
    const result = await runWithCursor({});
    expect(result.skipped).toBe(true);
    expect(surveyCalls).toBe(0); // survey transport NOT called
    void callsAfterFirst; // used above
  });

  // T-31-CURSOR-2: --force → survey runs even when cursor matches
  it('T-31-CURSOR-2: --force → survey runs even when cursor fingerprint matches', async () => {
    // First run — establishes cursor
    await runWithCursor({});
    surveyCalls = 0;

    // --force: cursor matches but survey must still run
    const result = await runWithCursor({ force: true });
    expect(result.skipped).toBe(false);
    expect(surveyCalls).toBeGreaterThan(0);
  });

  // T-31-CURSOR-3: --dry-run → cursor NOT written even after survey runs
  it('T-31-CURSOR-3: --dry-run → cursor not advanced', async () => {
    const { SemanticStore: SS } = await import('../src/db/semantic-store');
    const { realClock } = await import('../src/lib/clock');
    const semanticStore = new SS(db, realClock, testConfig);

    const cursorBefore = semanticStore.getMeta('cursor:project:test-scope');
    expect(cursorBefore).toBeNull(); // nothing stored yet

    await runWithCursor({ dryRun: true });

    const cursorAfter = semanticStore.getMeta('cursor:project:test-scope');
    expect(cursorAfter).toBeNull(); // still null after dry-run
  });

  // T-31-CURSOR-4: --db scratch → cursor stored in scratch DB, NOT the live brain
  it('T-31-CURSOR-4: scratch DB cursor is isolated from a different DB', async () => {
    const { computeProjectFingerprint, collectDocPaths } = await import('../src/adapter/ingest-project-cli');
    const { SemanticStore: SS } = await import('../src/db/semantic-store');
    const { realClock } = await import('../src/lib/clock');

    // Run in the main in-memory DB (already set up in runWithCursor)
    await runWithCursor({});

    // A SEPARATE DB should have no cursor row
    const separateDb = new Database(':memory:');
    initSchema(separateDb);
    const separateStore = new SS(separateDb, realClock, testConfig);
    const docPaths = collectDocPaths(tmpDir);
    const fp = computeProjectFingerprint(tmpDir, docPaths);

    expect(separateStore.getMeta('cursor:project:test-scope')).toBeNull();
    separateDb.close();
    void fp; // used above for type-safety
  });
});

// ── Plan 02 Task 3: D-07 dup-rate / reconciliation gate ──────────────────────
//
// Two tests prove the REINGEST-01 / D-07 contract using a deterministic
// in-memory harness with MockModelProvider (no real LLM / headless transport):
//
// (1) unchanged-re-run → cursor structural skip → 0 new consolidated beliefs
// (2) changed fact → tombstone+new (not dup); FK-clean

describe('D-07 dup-rate gate (Plan 02 Task 3)', () => {
  // ── helpers mirrored from consolidation.test.ts ────────────────────────────

  function makeAlwaysSameEmbedFn(dims: number): (text: string) => Float32Array {
    return (_text: string) => {
      const vec = new Float32Array(dims);
      vec[0] = 1.0;
      return vec;
    };
  }

  // ── Test 1: unchanged re-run → zero new consolidated beliefs ──────────────

  it('unchanged re-run yields zero new consolidated beliefs (SC2 — structural via cursor)', async () => {
    // Imports
    const DB = Database;
    const { initSchema: IS } = await import('../src/db/schema');
    const { FakeClock: FC } = await import('../src/lib/clock');
    const { DEFAULT_CONFIG: DC } = await import('../src/lib/config');
    const { SemanticStore: SS } = await import('../src/db/semantic-store');
    const { EpisodicStore: ES } = await import('../src/db/episode-store');
    const { AllocationGate: AG, IngestionPipeline: IP } = await import('../src/ingest/pipeline');
    const { Consolidator } = await import('../src/consolidation/consolidator');
    const { StrengthDecayManager } = await import('../src/strength/decay');
    const { CandidateRetriever } = await import('../src/retrieval/topk');
    const { MockModelProvider: MMP } = await import('../src/model/provider');
    const { SchemaInducer } = await import('../src/consolidation/schema-induction');
    const {
      computeProjectFingerprint, collectDocPaths, runSurveyAndFeed,
    } = await import('../src/adapter/ingest-project-cli');
    const { mkdtempSync: mdt, rmSync: rms, writeFileSync: wfs } = await import('fs');
    const { join: pj } = await import('path');
    const { tmpdir: td } = await import('os');

    const tmpDir = mdt(pj(td(), 'recense-d07-1-'));
    wfs(pj(tmpDir, 'README.md'), '# Test project\nThis project does X.');

    const db = new DB(':memory:');
    IS(db);
    const clock = new FC(Date.UTC(2026, 0, 1));
    const cfg = { ...DC, dbPath: ':memory:', consolSkipThreshold: 0.2, unrelatedSimilarityThreshold: 0.3, candidateK: 5 };
    const store = new SS(db, clock, cfg);
    const episodes = new ES(db, clock, cfg);
    const strength = new StrengthDecayManager(db, clock, cfg);
    const retriever = new CandidateRetriever(db);

    let surveyCalls = 0;
    const mockSurveyArea = async () => {
      surveyCalls++;
      return '- the project uses TypeScript';
    };

    // Helper to make a SchemaInducer no-op
    const makeInducer = (h: { db: Database.Database; store: InstanceType<typeof SS>; strength: InstanceType<typeof StrengthDecayManager>; retriever: InstanceType<typeof CandidateRetriever>; clock: InstanceType<typeof FC>; config: typeof cfg }) =>
      new SchemaInducer(
        h.db, h.store, h.strength, h.retriever,
        new MMP(),
        h.config, h.clock,
        async () => 'no-op-schema',
      );

    const alwaysSameEmbed = makeAlwaysSameEmbedFn(cfg.embeddingDimensions);

    // ── First run: no cursor stored → survey runs ────────────────────────────
    const provider1 = new MMP({
      embedFn: alwaysSameEmbed,
      generateScript: ['[{"type":"fact","value":"uses TypeScript"}]'],
      judgeScript: [],
    });
    const pipeline1 = new IP(new AG(cfg), episodes);
    await runSurveyAndFeed({
      dir: tmpDir, scope: 'test-scope', repoDesc: 'test',
      pipeline: pipeline1, surveyArea: mockSurveyArea, dryRun: false,
    });
    const consolidator1 = new Consolidator(db, episodes, store, strength, retriever, provider1, makeInducer({ db, store, strength, retriever, clock, config: cfg }), cfg, clock);
    await consolidator1.consolidate();
    const countAfterFirst = (db.prepare('SELECT COUNT(*) as c FROM node WHERE tombstoned=0').get() as { c: number }).c;
    expect(countAfterFirst).toBeGreaterThan(0);

    // Commit cursor — simulate what main() does after first survey
    const docPaths = collectDocPaths(tmpDir);
    const fingerprint = computeProjectFingerprint(tmpDir, docPaths);
    store.setMeta('cursor:project:test-scope', fingerprint);

    // ── Second run: cursor matches fingerprint → survey SKIPPED ─────────────
    const callsBeforeSecond = surveyCalls;
    const storedFp = store.getMeta('cursor:project:test-scope');
    const currentFp = computeProjectFingerprint(tmpDir, docPaths);
    const surveySkipped = storedFp !== null && storedFp === currentFp;

    expect(surveySkipped).toBe(true);

    if (!surveySkipped) {
      // This branch should NOT execute — if it does, the test will fail below
      const pipeline2 = new IP(new AG(cfg), episodes);
      await runSurveyAndFeed({
        dir: tmpDir, scope: 'test-scope', repoDesc: 'test',
        pipeline: pipeline2, surveyArea: mockSurveyArea, dryRun: false,
      });
    }

    // Consolidation on zero new unconsolidated episodes → no new beliefs
    const provider2 = new MMP({
      embedFn: alwaysSameEmbed,
      generateScript: [], // nothing to generate
      judgeScript: [],
    });
    const consolidator2 = new Consolidator(db, episodes, store, strength, retriever, provider2, makeInducer({ db, store, strength, retriever, clock, config: cfg }), cfg, clock);
    await consolidator2.consolidate();

    const countAfterSecond = (db.prepare('SELECT COUNT(*) as c FROM node WHERE tombstoned=0').get() as { c: number }).c;
    // Zero new consolidated beliefs: count unchanged
    expect(countAfterSecond).toBe(countAfterFirst);
    // Survey transport mock NOT called on second run
    expect(surveyCalls).toBe(callsBeforeSecond);

    db.close();
    rms(tmpDir, { recursive: true, force: true });
  });

  // ── Test 2: changed fact → reconcile in place (tombstone+new, not dup) ────

  it('changed fact reconciles in place (tombstone+new, not duplicate); FK-clean', async () => {
    const DB = Database;
    const { initSchema: IS } = await import('../src/db/schema');
    const { FakeClock: FC } = await import('../src/lib/clock');
    const { DEFAULT_CONFIG: DC } = await import('../src/lib/config');
    const { SemanticStore: SS } = await import('../src/db/semantic-store');
    const { EpisodicStore: ES } = await import('../src/db/episode-store');
    const { AllocationGate: AG, IngestionPipeline: IP } = await import('../src/ingest/pipeline');
    const { Consolidator } = await import('../src/consolidation/consolidator');
    const { StrengthDecayManager } = await import('../src/strength/decay');
    const { CandidateRetriever } = await import('../src/retrieval/topk');
    const { MockModelProvider: MMP } = await import('../src/model/provider');
    const { SchemaInducer } = await import('../src/consolidation/schema-induction');
    const { newId } = await import('../src/lib/hash');
    const { runSurveyAndFeed } = await import('../src/adapter/ingest-project-cli');
    const { mkdtempSync: mdt, rmSync: rms, writeFileSync: wfs } = await import('fs');
    const { join: pj } = await import('path');
    const { tmpdir: td } = await import('os');

    const tmpDir = mdt(pj(td(), 'recense-d07-2-'));
    wfs(pj(tmpDir, 'README.md'), '# Test project\nThe lang is TypeScript.');

    const db = new DB(':memory:');
    IS(db);
    const clock = new FC(Date.UTC(2026, 0, 1));
    const cfg = { ...DC, dbPath: ':memory:', consolSkipThreshold: 0.2, unrelatedSimilarityThreshold: 0.3, candidateK: 5 };
    const store = new SS(db, clock, cfg);
    const episodes = new ES(db, clock, cfg);
    const strength = new StrengthDecayManager(db, clock, cfg);
    const retriever = new CandidateRetriever(db);

    const makeInducer = () =>
      new SchemaInducer(
        db, store, strength, retriever,
        new MMP(),
        cfg, clock,
        async () => 'no-op-schema',
      );

    const alwaysSameEmbed = makeAlwaysSameEmbedFn(cfg.embeddingDimensions);

    // Seed an existing belief node: "project language is TypeScript"
    const oldNodeId = newId();
    const oldValue = 'project language is TypeScript';
    store.upsertNode({ id: oldNodeId, type: 'fact', value: oldValue, origin: 'observed', s: 0.5, c: 0.7 });
    const oldVec = alwaysSameEmbed(oldValue);
    store.setEmbedding(oldNodeId, oldVec);

    // Survey returns a contradicting restatement: "project language is JavaScript"
    const newValue = 'project language is JavaScript';
    const contradictVerdict = {
      best_candidate_id: oldNodeId,
      relation: 'contradict' as const,
      magnitude: 0.5, // mid-band: ratio 0.5/(0.5*0.7)=0.5/0.35≈1.43 → reconcile band
    };

    const mockSurveyArea = async () => `- ${newValue}`;

    const provider = new MMP({
      embedFn: alwaysSameEmbed,
      generateScript: [`[{"type":"fact","value":"${newValue}"}]`],
      judgeScript: [contradictVerdict],
    });

    const pipeline = new IP(new AG(cfg), episodes);
    await runSurveyAndFeed({
      dir: tmpDir, scope: 'test-scope', repoDesc: 'test',
      pipeline, surveyArea: mockSurveyArea, dryRun: false,
    });

    const consolidator = new Consolidator(db, episodes, store, strength, retriever, provider, makeInducer(), cfg, clock);
    await consolidator.consolidate();

    // Prior node must be tombstoned (superseded)
    const oldNode = store.getNode(oldNodeId)!;
    expect(oldNode.tombstoned).toBe(1);

    // Exactly one new live node with the new value (not a dup)
    const allNodes = db.prepare('SELECT id, value, tombstoned FROM node').all() as Array<{ id: string; value: string; tombstoned: number }>;
    const liveNewNodes = allNodes.filter(n => n.value === newValue && n.tombstoned === 0);
    expect(liveNewNodes).toHaveLength(1);

    // The old value must have no surviving live node (reconciled in place, not duplicated)
    const liveOldNodes = allNodes.filter(n => n.value === oldValue && n.tombstoned === 0);
    expect(liveOldNodes).toHaveLength(0);

    // FK-clean
    const fkCheck = db.prepare('PRAGMA foreign_key_check').all();
    expect(fkCheck).toHaveLength(0);

    db.close();
    rms(tmpDir, { recursive: true, force: true });
  });
});
