/**
 * ObsidianAdapter unit tests (D-58/D-59/D-61/D-63/D-67/T-04-PATH).
 *
 * Task 1: pure-function tests (chunkNote, noteTitle, normalizeObsidianNote).
 * Task 2: ObsidianAdapter class tests (recursive walk, cursor, path-guard, .obsidian-skip).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { DEFAULT_CONFIG } from '../src/lib/config';
import type { EngineConfig } from '../src/lib/config';
import { ObsidianAdapter } from '../src/source/obsidian-adapter';
import type { MetaCursor } from '../src/source/obsidian-adapter';
import { initSchema } from '../src/db/schema';
import { EpisodicStore } from '../src/db/episode-store';

import {
  chunkNote,
  noteTitle,
  normalizeObsidianNote,
} from '../src/source/obsidian-adapter';
import type { NoteSection } from '../src/source/obsidian-adapter';

// ─── chunkNote — heading-split chunking (D-58) ──────────────────────────────

describe('chunkNote — heading-split chunking (D-58)', () => {
  it('small note → single section, heading null, text = full content', () => {
    const content = 'Hello [[World]]\n\nThis is a small note.';
    const sections = chunkNote(content, 8_000);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.heading).toBeNull();
    expect(sections[0]!.text).toBe(content);
  });

  it('oversized note with ## headings → splits at each heading', () => {
    const bodyA = 'a'.repeat(5_000);
    const bodyB = 'b'.repeat(5_000);
    const content = `## Section A\n${bodyA}\n## Section B\n${bodyB}`;
    const sections = chunkNote(content, 8_000);
    expect(sections.length).toBeGreaterThanOrEqual(2);
    const headings = sections.map(s => s.heading).filter(Boolean);
    expect(headings.some(h => (h as string).includes('Section A'))).toBe(true);
    expect(headings.some(h => (h as string).includes('Section B'))).toBe(true);
  });

  it('each heading section text includes the heading line', () => {
    const content = `## Alpha\n${'a'.repeat(5_000)}\n## Beta\n${'b'.repeat(5_000)}`;
    const sections = chunkNote(content, 8_000);
    const sectionA = sections.find(s => s.heading?.includes('Alpha'));
    const sectionB = sections.find(s => s.heading?.includes('Beta'));
    expect(sectionA?.text).toContain('## Alpha');
    expect(sectionB?.text).toContain('## Beta');
  });

  it('oversized note without headings → single section, full content preserved (no adapter truncation)', () => {
    const content = 'x'.repeat(10_000);
    const sections = chunkNote(content, 8_000);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.heading).toBeNull();
    expect(sections[0]!.text).toBe(content); // capContent handles the hard cap downstream
    expect(sections[0]!.text).toHaveLength(10_000);
  });

  it('oversized note with # H1 headings also splits', () => {
    const content = `# Title One\n${'a'.repeat(5_000)}\n# Title Two\n${'b'.repeat(5_000)}`;
    const sections = chunkNote(content, 8_000);
    expect(sections.length).toBeGreaterThanOrEqual(2);
    expect(sections.some(s => s.heading?.includes('Title One'))).toBe(true);
    expect(sections.some(s => s.heading?.includes('Title Two'))).toBe(true);
  });

  it('pre-heading intro text becomes a separate null-heading section', () => {
    const intro = 'Intro paragraph before headings.\n\n';
    const mainSection = `## Main\n${'c'.repeat(9_000)}`;
    const content = intro + mainSection;
    const sections = chunkNote(content, 8_000);
    const preSection = sections.find(s => s.heading === null);
    expect(preSection).toBeDefined();
    expect(preSection!.text).toContain('Intro paragraph');
  });

  it('inline wikilinks are preserved in sections', () => {
    const content = `## Notes\n${'See [[Project X]] and '.repeat(1_000)}`;
    const sections = chunkNote(content, 8_000);
    const notesSection = sections.find(s => s.heading?.includes('Notes'));
    expect(notesSection?.text).toContain('[[Project X]]');
  });
});

// ─── noteTitle — basename extraction ────────────────────────────────────────

describe('noteTitle — basename extraction', () => {
  it('returns basename without .md extension', () => {
    expect(noteTitle('my-note.md')).toBe('my-note');
  });

  it('strips .md from a nested path', () => {
    expect(noteTitle('folder/sub/Deep Note.md')).toBe('Deep Note');
  });

  it('handles a top-level filename', () => {
    expect(noteTitle('tasks.md')).toBe('tasks');
  });
});

// ─── normalizeObsidianNote — NormalizedRecord construction (D-59/D-61/D-63) ─

describe('normalizeObsidianNote — NormalizedRecord construction', () => {
  const plainSection: NoteSection = {
    heading: null,
    text: 'Some content with [[Project X]].',
  };

  it('builds [[title]] provenance header prefixed in content', () => {
    const record = normalizeObsidianNote(plainSection, 'My Note', 0, 'folder/My Note.md');
    expect(record.content).toContain('[[My Note]]');
  });

  it('content includes section text after the header', () => {
    const record = normalizeObsidianNote(plainSection, 'My Note', 0, 'folder/My Note.md');
    expect(record.content).toContain('Some content with [[Project X]].');
  });

  it('sets source = "obsidian"', () => {
    const record = normalizeObsidianNote(plainSection, 'My Note', 0, 'folder/My Note.md');
    expect(record.source).toBe('obsidian');
  });

  it('sets origin = "asserted_by_user" (D-61 — only adapter with this origin)', () => {
    const record = normalizeObsidianNote(plainSection, 'My Note', 0, 'folder/My Note.md');
    expect(record.origin).toBe('asserted_by_user');
  });

  it('sets role = "user"', () => {
    const record = normalizeObsidianNote(plainSection, 'My Note', 0, 'folder/My Note.md');
    expect(record.role).toBe('user');
  });

  it('external_id is content-addressed: <relPath>#<16-hex-hash> (CR-01)', () => {
    const record = normalizeObsidianNote(plainSection, 'My Note', 2, 'folder/My Note.md');
    expect(record.external_id).toMatch(/^folder\/My Note\.md#[0-9a-f]{16}$/);
  });

  it('different section content → different external_id; same content → same external_id (CR-01)', () => {
    const sectionA: NoteSection = { heading: null, text: 'Content of section A.' };
    const sectionB: NoteSection = { heading: null, text: 'Content of section B — different text.' };
    const r0 = normalizeObsidianNote(sectionA, 'Note', 0, 'n.md');
    const r1 = normalizeObsidianNote(sectionB, 'Note', 1, 'n.md');
    // Different content → different external_id
    expect(r0.external_id).not.toBe(r1.external_id);
    expect(r0.external_id).toMatch(/^n\.md#[0-9a-f]{16}$/);
    expect(r1.external_id).toMatch(/^n\.md#[0-9a-f]{16}$/);
    // Same content + same relPath → same external_id (idempotent dedup)
    const r0b = normalizeObsidianNote(sectionA, 'Note', 0, 'n.md');
    expect(r0b.external_id).toBe(r0.external_id);
  });

  it('keeps [[wikilinks]] inline — not extracted as edges (CONSOL-03)', () => {
    const wikiSection: NoteSection = {
      heading: null,
      text: 'See [[Project Alpha]] and [[Task B]].',
    };
    const record = normalizeObsidianNote(wikiSection, 'Notes', 0, 'notes.md');
    expect(record.content).toContain('[[Project Alpha]]');
    expect(record.content).toContain('[[Task B]]');
  });

  it('redacts AWS key while preserving [[wikilinks]] (D-63)', () => {
    const awsSection: NoteSection = {
      heading: null,
      // AKIAIOSFODNN7EXAMPLE = valid AKIA[0-9A-Z]{16} format
      text: 'Key: AKIAIOSFODNN7EXAMPLE and see [[Project X]].',
    };
    const record = normalizeObsidianNote(awsSection, 'Secrets Note', 0, 'secrets.md');
    expect(record.content).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(record.content).toContain('[REDACTED:AWS_KEY]');
    expect(record.content).toContain('[[Project X]]');
  });

  it('redacts key=value secrets in note body (D-63)', () => {
    const secretSection: NoteSection = {
      heading: null,
      text: 'token=supersecretvalue123',
    };
    const record = normalizeObsidianNote(secretSection, 'Config', 0, 'config.md');
    expect(record.content).not.toContain('supersecretvalue123');
    expect(record.content).toContain('[REDACTED:SECRET]');
  });

  it('header line [[title]] is also subject to redaction if needed', () => {
    // Content after header should be redacted — verifies redaction runs on full content
    const section: NoteSection = {
      heading: '## Keys',
      text: '## Keys\nsk-abcdefghijklmnopqrstuvwxyz is my key',
    };
    const record = normalizeObsidianNote(section, 'Setup', 0, 'setup.md');
    expect(record.content).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    expect(record.content).toContain('[REDACTED:API_KEY]');
  });

  it('no upsertNode or upsertEdge calls in the file (CONSOL-03 — enforced by grep, confirmed by test shape)', () => {
    // This is a design invariant verified by acceptance-criteria grep;
    // the test affirms the function returns a NormalizedRecord with no graph writes.
    const record = normalizeObsidianNote(plainSection, 'Note', 0, 'note.md');
    expect(record).toHaveProperty('content');
    expect(record).toHaveProperty('source');
    expect(record).toHaveProperty('origin');
    expect(record).toHaveProperty('role');
    expect(record).toHaveProperty('external_id');
    // No graph properties — a NormalizedRecord is just a plain data object
    expect(record).not.toHaveProperty('nodeId');
    expect(record).not.toHaveProperty('edgeId');
  });
});

// ─── ObsidianAdapter — recursive vault walk (D-67/T-04-PATH) ─────────────────

/** In-memory MetaCursor implementation for tests. */
function makeMockMeta(): MetaCursor & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    getMeta: (key) => store.get(key) ?? null,
    setMeta: (key, value) => { store.set(key, value); },
  };
}

/** Build a minimal EngineConfig with the given obsidian.dir override. */
function makeConfig(obsidianDir: string): EngineConfig {
  return {
    ...DEFAULT_CONFIG,
    dbPath: ':memory:',
    obsidian: { dir: obsidianDir },
  };
}

describe('ObsidianAdapter — recursive vault walk (D-67/T-04-PATH)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // ── Empty dir config → no records ─────────────────────────────────────────

  it('returns [] immediately when config.obsidian.dir is empty string (fail-safe disabled)', async () => {
    const adapter = new ObsidianAdapter(makeConfig(''), makeMockMeta());
    const records = await adapter.pull();
    expect(records).toHaveLength(0);
  });

  it('readonly source identifier is "obsidian"', () => {
    const adapter = new ObsidianAdapter(makeConfig(tempDir), makeMockMeta());
    expect(adapter.source).toBe('obsidian');
  });

  // ── Flat walk ─────────────────────────────────────────────────────────────

  it('returns one record per .md file in a flat vault', async () => {
    fs.writeFileSync(path.join(tempDir, 'alpha.md'), 'Content of alpha [[Beta]].');
    fs.writeFileSync(path.join(tempDir, 'beta.md'), 'Content of beta.');

    const adapter = new ObsidianAdapter(makeConfig(tempDir), makeMockMeta());
    const records = await adapter.pull();
    expect(records).toHaveLength(2);
    expect(records.some(r => r.external_id.startsWith('alpha.md'))).toBe(true);
    expect(records.some(r => r.external_id.startsWith('beta.md'))).toBe(true);
  });

  // ── Recursive walk ────────────────────────────────────────────────────────

  it('returns records from nested subdirectories (recursive walk)', async () => {
    const sub1 = path.join(tempDir, 'projects');
    const sub2 = path.join(tempDir, 'projects', 'brain-memory');
    fs.mkdirSync(sub2, { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'root-note.md'), 'Root level note.');
    fs.writeFileSync(path.join(sub1, 'project-note.md'), 'Project note.');
    fs.writeFileSync(path.join(sub2, 'deep-note.md'), 'Deep nested note.');

    const adapter = new ObsidianAdapter(makeConfig(tempDir), makeMockMeta());
    const records = await adapter.pull();
    expect(records).toHaveLength(3);
    const externalIds = records.map(r => r.external_id);
    expect(externalIds.some(id => id.includes('root-note.md'))).toBe(true);
    expect(externalIds.some(id => id.includes('project-note.md'))).toBe(true);
    expect(externalIds.some(id => id.includes('deep-note.md'))).toBe(true);
  });

  // ── .obsidian dir skipped ─────────────────────────────────────────────────

  it('skips .obsidian/ config directory entirely', async () => {
    const obsidianDir = path.join(tempDir, '.obsidian');
    fs.mkdirSync(obsidianDir);
    fs.writeFileSync(path.join(obsidianDir, 'workspace.json'), '{}');
    fs.writeFileSync(path.join(obsidianDir, 'plugins.md'), 'Plugin note — should be skipped.');
    fs.writeFileSync(path.join(tempDir, 'real-note.md'), 'This is a real vault note.');

    const adapter = new ObsidianAdapter(makeConfig(tempDir), makeMockMeta());
    const records = await adapter.pull();
    expect(records).toHaveLength(1);
    expect(records[0]!.external_id).toContain('real-note.md');
    expect(records.every(r => !r.external_id.includes('.obsidian'))).toBe(true);
  });

  // ── Oversized note splits into multiple records ───────────────────────────

  it('oversized note with headings → multiple section records', async () => {
    const oversized = `## Section One\n${'a'.repeat(5_000)}\n## Section Two\n${'b'.repeat(5_000)}`;
    fs.writeFileSync(path.join(tempDir, 'big-note.md'), oversized);

    const adapter = new ObsidianAdapter(makeConfig(tempDir), makeMockMeta());
    const records = await adapter.pull();
    // Should produce 2+ records (one per section)
    expect(records.length).toBeGreaterThanOrEqual(2);
    // All records belong to big-note.md but with different section indices
    const bigNoteRecords = records.filter(r => r.external_id.startsWith('big-note.md'));
    expect(bigNoteRecords.length).toBeGreaterThanOrEqual(2);
    // Section indices are distinct
    const indices = bigNoteRecords.map(r => r.external_id.split('#')[1]);
    const unique = new Set(indices);
    expect(unique.size).toBe(bigNoteRecords.length);
  });

  it('all records from an oversized split note are asserted_by_user', async () => {
    const oversized = `## A\n${'a'.repeat(5_000)}\n## B\n${'b'.repeat(5_000)}`;
    fs.writeFileSync(path.join(tempDir, 'note.md'), oversized);

    const adapter = new ObsidianAdapter(makeConfig(tempDir), makeMockMeta());
    const records = await adapter.pull();
    expect(records.every(r => r.origin === 'asserted_by_user')).toBe(true);
    expect(records.every(r => r.source === 'obsidian')).toBe(true);
  });

  // ── Symlink escape skipped (T-04-PATH / T-06-20) ──────────────────────────

  it('skips a symlink that resolves outside the vault root (T-04-PATH)', async () => {
    // Create a target file outside the vault
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
    const outsideFile = path.join(outsideDir, 'secret.md');
    fs.writeFileSync(outsideFile, 'Outside-vault secret content.');

    // Create a symlink inside the vault that points to the outside file
    const symlinkInVault = path.join(tempDir, 'escape-link.md');
    fs.symlinkSync(outsideFile, symlinkInVault);

    // Also create a legitimate note inside the vault
    fs.writeFileSync(path.join(tempDir, 'legit.md'), 'Legitimate vault note.');

    try {
      const adapter = new ObsidianAdapter(makeConfig(tempDir), makeMockMeta());
      const records = await adapter.pull();
      // Only the legitimate note should be returned — symlink escape is skipped
      expect(records).toHaveLength(1);
      expect(records[0]!.external_id).toContain('legit.md');
      expect(records.every(r => !r.external_id.includes('escape-link'))).toBe(true);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  // ── Cursor advancement + skip on second pull (D-67) ──────────────────────

  it('writes cursor:obsidian after pull and skips unchanged notes on second pull', async () => {
    const notePath = path.join(tempDir, 'note.md');
    fs.writeFileSync(notePath, 'Initial content.');

    const meta = makeMockMeta();
    const adapter = new ObsidianAdapter(makeConfig(tempDir), meta);

    // First pull — cursor is 0, should return the note
    const first = await adapter.pull();
    expect(first).toHaveLength(1);

    // cursor:obsidian should be set to the note's mtime
    const cursorAfterFirst = meta.store.get('cursor:obsidian');
    expect(cursorAfterFirst).toBeDefined();
    expect(parseInt(cursorAfterFirst!, 10)).toBeGreaterThan(0);

    // Second pull with same meta (cursor is now set) — note mtime unchanged
    const adapter2 = new ObsidianAdapter(makeConfig(tempDir), meta);
    const second = await adapter2.pull();
    expect(second).toHaveLength(0); // unchanged note is skipped
  });

  it('cursor advances to max mtime seen', async () => {
    // Write two notes; bump b.md mtime 2 seconds ahead to make it deterministically latest.
    fs.writeFileSync(path.join(tempDir, 'a.md'), 'Note A');
    fs.writeFileSync(path.join(tempDir, 'b.md'), 'Note B');

    // Advance b.md mtime by 2 s and re-stat to get the actual post-utimes mtime.
    const beforeStat = fs.statSync(path.join(tempDir, 'b.md'));
    const laterTime = new Date(Math.floor(beforeStat.mtimeMs) + 2_000);
    fs.utimesSync(path.join(tempDir, 'b.md'), laterTime, laterTime);
    const actualBStat = fs.statSync(path.join(tempDir, 'b.md')); // re-stat after utimes

    const meta = makeMockMeta();
    const adapter = new ObsidianAdapter(makeConfig(tempDir), meta);
    await adapter.pull();

    // cursor should be >= b.md's actual mtime after the mtime bump
    const cursor = parseFloat(meta.store.get('cursor:obsidian')!);
    expect(cursor).toBeGreaterThanOrEqual(actualBStat.mtimeMs);
  });

  // ── Non-.md files are ignored ─────────────────────────────────────────────

  it('ignores non-.md files (images, JSON, txt)', async () => {
    fs.writeFileSync(path.join(tempDir, 'image.png'), 'fake png');
    fs.writeFileSync(path.join(tempDir, 'data.json'), '{}');
    fs.writeFileSync(path.join(tempDir, 'transcript.txt'), 'Some text.');
    fs.writeFileSync(path.join(tempDir, 'real.md'), 'Real note.');

    const adapter = new ObsidianAdapter(makeConfig(tempDir), makeMockMeta());
    const records = await adapter.pull();
    expect(records).toHaveLength(1);
    expect(records[0]!.external_id).toContain('real.md');
  });
});

// ─── normalizeObsidianNote — content-addressed external_id (CR-01) ─────────────

describe('normalizeObsidianNote — content-addressed external_id (CR-01)', () => {
  it('edited section text → different external_id (edit must re-ingest)', () => {
    const original: NoteSection = { heading: null, text: 'Original note text.' };
    const edited: NoteSection = { heading: null, text: 'Edited note text — fact changed.' };
    const r1 = normalizeObsidianNote(original, 'Note', 0, 'note.md');
    const r2 = normalizeObsidianNote(edited, 'Note', 0, 'note.md');
    // Different content → different hash → different external_id
    expect(r1.external_id).not.toBe(r2.external_id);
  });

  it('identical section text → same external_id (idempotent dedup)', () => {
    const section: NoteSection = { heading: null, text: 'Stable content, never changes.' };
    const r1 = normalizeObsidianNote(section, 'Note', 0, 'note.md');
    const r2 = normalizeObsidianNote(section, 'Note', 0, 'note.md');
    // Same content → same hash → same external_id (dedup fires)
    expect(r1.external_id).toBe(r2.external_id);
  });
});

// ─── EpisodicStore + ObsidianAdapter E2E: edit re-ingests, unchanged dedupes ──

describe('EpisodicStore + ObsidianAdapter E2E: edit re-ingests, unchanged dedupes (CR-01)', () => {
  let e2eTmpDir: string;

  beforeEach(() => {
    e2eTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-cr01-'));
  });

  afterEach(() => {
    fs.rmSync(e2eTmpDir, { recursive: true, force: true });
  });

  it('edited file content creates a new episode; re-read of unchanged content is deduped', async () => {
    const db = new Database(':memory:');
    initSchema(db);
    const store = new EpisodicStore(db, { nowMs: () => Date.now() }, { ...DEFAULT_CONFIG, dbPath: ':memory:' });
    const meta = makeMockMeta();
    const config = makeConfig(e2eTmpDir);
    const adapter = new ObsidianAdapter(config, meta);

    const notePath = path.join(e2eTmpDir, 'fact.md');
    const countEpisodes = () =>
      (db.prepare('SELECT COUNT(*) as n FROM episode').get() as { n: number }).n;

    const appendRecord = (rec: { content: string; source: string; external_id: string; origin: string; role: string }) =>
      store.append({
        content: rec.content,
        origin: rec.origin as 'observed' | 'asserted_by_user' | 'inferred',
        role: rec.role as 'user' | 'assistant' | 'tool',
        source: rec.source,
        external_id: rec.external_id,
        salience: 0.5,
        hard_keep: 0,
        session_id: 'test-session',
      });

    // ── Step 1: initial ingest ───────────────────────────────────────────────
    fs.writeFileSync(notePath, 'Jane runs Acme coaching.');
    const records1 = await adapter.pull();
    expect(records1).toHaveLength(1);
    appendRecord(records1[0]!);
    expect(countEpisodes()).toBe(1);

    // ── Step 2: edit the note ───────────────────────────────────────────────
    fs.writeFileSync(notePath, 'Jane runs Acme coaching — updated 2026.');
    meta.store.set('cursor:obsidian', '0'); // reset cursor so the file is re-read
    const records2 = await adapter.pull();
    expect(records2).toHaveLength(1);

    // Content-addressed: edit → different hash → different external_id → NOT deduped
    expect(records2[0]!.external_id).not.toBe(records1[0]!.external_id);
    appendRecord(records2[0]!);
    expect(countEpisodes()).toBe(2); // new episode created

    // ── Step 3: re-read unchanged file → same external_id → deduped ────────
    meta.store.set('cursor:obsidian', '0');
    const records3 = await adapter.pull();
    expect(records3).toHaveLength(1);
    expect(records3[0]!.external_id).toBe(records2[0]!.external_id); // unchanged content
    appendRecord(records3[0]!);
    expect(countEpisodes()).toBe(2); // no new episode — deduped
  });
});
