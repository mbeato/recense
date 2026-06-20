/**
 * Doc-ingest + idempotent re-ingest tests (Phase 31 Plan 01).
 *
 * Task 1 covers: emitDocEpisodes helper — origin/source, redaction, deterministic relPath.
 * Task 2 covers: content-hash idempotency via a real in-memory EpisodicStore + IngestionPipeline.
 *
 * All tests are deterministic in-memory (better-sqlite3 + mocked pipeline for Task 1).
 * No sleep.env, OPENAI_API_KEY, or headless transport required.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { initSchema } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { EngineConfig } from '../src/lib/config';
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
