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
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from 'fs';
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
