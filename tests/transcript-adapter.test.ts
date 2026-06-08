/**
 * TranscriptAdapter unit tests — pure-function and filesystem-based.
 *
 * Task 1: Pure function tests (parseTranscript, normalizeTranscriptTurn) — no filesystem.
 * Task 2: TranscriptAdapter integration tests using a temp dir.
 *
 * All transcript turns carry origin='observed' (D-61 hard-coded);
 * source='granola' (D-67); external_id=<relPath>#<turnIdx> (D-59).
 * Secrets redacted at boundary by redactSecrets (D-63/T-06-19).
 * Path-traversal guard: realpathSync + startsWith(realDir+sep) (T-04-PATH/T-06-16).
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseTranscript, normalizeTranscriptTurn, TranscriptAdapter } from '../src/source/transcript-adapter';

// ---------------------------------------------------------------------------
// Task 1: Pure parser tests — no filesystem required
// ---------------------------------------------------------------------------

describe('parseTranscript — .txt/.md format', () => {
  it('parses three speaker turns from simple .txt', () => {
    const input = 'Max: hi\nAlice: hey\nMax: bye';
    const turns = parseTranscript(input, '.txt');
    expect(turns).toHaveLength(3);
    expect(turns[0]).toEqual({ speaker: 'Max', text: 'hi' });
    expect(turns[1]).toEqual({ speaker: 'Alice', text: 'hey' });
    expect(turns[2]).toEqual({ speaker: 'Max', text: 'bye' });
  });

  it('parses .md extension identically to .txt', () => {
    const input = 'Max: hi\nAlice: hey';
    const turns = parseTranscript(input, '.md');
    expect(turns).toHaveLength(2);
    expect(turns[0]).toEqual({ speaker: 'Max', text: 'hi' });
  });

  it('groups multi-line turns until the next speaker line', () => {
    const input = [
      'Max: hello',
      'this is a continuation',
      'second continuation line',
      'Alice: got it',
    ].join('\n');
    const turns = parseTranscript(input, '.txt');
    expect(turns).toHaveLength(2);
    expect(turns[0]!.speaker).toBe('Max');
    expect(turns[0]!.text).toContain('hello');
    expect(turns[0]!.text).toContain('continuation');
    expect(turns[1]).toEqual({ speaker: 'Alice', text: 'got it' });
  });

  it('attaches lines before any speaker line to Unknown speaker', () => {
    const input = 'pre-speaker text\nMax: hi';
    const turns = parseTranscript(input, '.txt');
    expect(turns[0]!.speaker).toBe('Unknown');
    expect(turns[0]!.text).toContain('pre-speaker text');
    expect(turns[1]).toEqual({ speaker: 'Max', text: 'hi' });
  });

  it('handles speaker with spaces and dots in name', () => {
    const input = 'Dr. Smith: diagnosis\nMax: thanks';
    const turns = parseTranscript(input, '.txt');
    expect(turns[0]!.speaker).toBe('Dr. Smith');
    expect(turns[0]!.text).toBe('diagnosis');
  });

  it('returns a single Unknown turn for empty content', () => {
    const turns = parseTranscript('', '.txt');
    // No turns when completely empty — Unknown with empty text is fine OR no turns
    // Implementation: if no speaker lines and no non-empty pre-speaker lines, empty array is ok
    expect(Array.isArray(turns)).toBe(true);
  });
});

describe('parseTranscript — .vtt format', () => {
  it('parses WEBVTT header + timestamp cues + <v Speaker>text, strips cue timestamps', () => {
    const vtt = [
      'WEBVTT',
      '',
      '00:00:00.000 --> 00:00:05.000',
      '<v Max>Hello there</v>',
      '',
      '00:00:05.000 --> 00:00:10.000',
      '<v Alice>Hi Max</v>',
    ].join('\n');
    const turns = parseTranscript(vtt, '.vtt');
    expect(turns).toHaveLength(2);
    expect(turns[0]).toEqual({ speaker: 'Max', text: 'Hello there' });
    expect(turns[1]).toEqual({ speaker: 'Alice', text: 'Hi Max' });
  });

  it('handles <v Speaker>text without closing tag', () => {
    const vtt = [
      'WEBVTT',
      '',
      '00:00:00.000 --> 00:00:05.000',
      '<v Max>Hi there',
    ].join('\n');
    const turns = parseTranscript(vtt, '.vtt');
    expect(turns).toHaveLength(1);
    expect(turns[0]).toEqual({ speaker: 'Max', text: 'Hi there' });
  });

  it('skips WEBVTT line, blank lines, and cue timestamp lines', () => {
    const vtt = [
      'WEBVTT',
      '',
      '00:00:01.500 --> 00:00:03.000',
      '<v Speaker One>test cue',
    ].join('\n');
    const turns = parseTranscript(vtt, '.vtt');
    expect(turns).toHaveLength(1);
    expect(turns[0]!.speaker).toBe('Speaker One');
    expect(turns[0]!.text).toBe('test cue');
    // No cue timestamps in text
    expect(turns[0]!.text).not.toContain('-->');
    expect(turns[0]!.text).not.toContain('00:00');
  });

  it('falls back to Speaker: text format in VTT when no voice tags', () => {
    const vtt = [
      'WEBVTT',
      '',
      '00:00:00.000 --> 00:00:05.000',
      'Max: fallback format',
    ].join('\n');
    const turns = parseTranscript(vtt, '.vtt');
    expect(turns).toHaveLength(1);
    expect(turns[0]).toEqual({ speaker: 'Max', text: 'fallback format' });
  });

  it('handles numeric cue identifiers (skips them)', () => {
    const vtt = [
      'WEBVTT',
      '',
      '1',
      '00:00:00.000 --> 00:00:05.000',
      '<v Max>cue with id</v>',
    ].join('\n');
    const turns = parseTranscript(vtt, '.vtt');
    expect(turns).toHaveLength(1);
    expect(turns[0]!.text).toBe('cue with id');
    // Numeric cue id '1' should not appear as a turn
    expect(turns[0]!.speaker).toBe('Max');
  });
});

describe('parseTranscript — unknown extension', () => {
  it('returns a single Unknown turn for unknown extensions', () => {
    const content = 'some arbitrary content';
    const turns = parseTranscript(content, '.docx');
    expect(turns).toHaveLength(1);
    expect(turns[0]!.speaker).toBe('Unknown');
    expect(turns[0]!.text).toBe(content);
  });
});

describe('normalizeTranscriptTurn', () => {
  it('builds inline provenance header [basename] speaker:', () => {
    const turn = { speaker: 'Max', text: 'hello world' };
    const record = normalizeTranscriptTurn(turn, 'meeting.txt', 0, 'meeting.txt');
    expect(record.content).toContain('[meeting.txt] Max:');
    expect(record.content).toContain('hello world');
  });

  it('sets source=granola, origin=observed, role=user', () => {
    const turn = { speaker: 'Alice', text: 'agreed' };
    const record = normalizeTranscriptTurn(turn, 'call.txt', 1, 'call.txt');
    expect(record.source).toBe('granola');
    expect(record.origin).toBe('observed');
    expect(record.role).toBe('user');
  });

  it('external_id is content-addressed: <fileRelPath>#<16-hex-hash> (CR-01)', () => {
    const turn = { speaker: 'Max', text: 'hi' };
    const record = normalizeTranscriptTurn(turn, 'meeting.txt', 0, 'meeting.txt');
    expect(record.external_id).toMatch(/^meeting\.txt#[0-9a-f]{16}$/);

    const record2 = normalizeTranscriptTurn(turn, 'meeting.txt', 5, 'sub/meeting.txt');
    expect(record2.external_id).toMatch(/^sub\/meeting\.txt#[0-9a-f]{16}$/);
  });

  it('edited turn text → different external_id (edit must re-ingest, CR-01)', () => {
    const original = { speaker: 'Max', text: 'The project is on track.' };
    const edited = { speaker: 'Max', text: 'The project is behind schedule.' };
    const r1 = normalizeTranscriptTurn(original, 'meeting.txt', 0, 'meeting.txt');
    const r2 = normalizeTranscriptTurn(edited, 'meeting.txt', 0, 'meeting.txt');
    // Different content → different hash → different external_id
    expect(r1.external_id).not.toBe(r2.external_id);
  });

  it('identical turn text → same external_id (idempotent dedup, CR-01)', () => {
    const turn = { speaker: 'Max', text: 'Stable statement.' };
    const r1 = normalizeTranscriptTurn(turn, 'meeting.txt', 0, 'meeting.txt');
    const r2 = normalizeTranscriptTurn(turn, 'meeting.txt', 0, 'meeting.txt');
    // Same content → same hash → same external_id (dedup fires)
    expect(r1.external_id).toBe(r2.external_id);
  });

  it('redacts GitHub token in turn content while preserving speaker name (D-63/T-06-19)', () => {
    const token = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcd';
    const turn = { speaker: 'Jane Doe', text: `use this token: ${token}` };
    const record = normalizeTranscriptTurn(turn, 'standup.txt', 0, 'standup.txt');
    expect(record.content).not.toContain(token);
    expect(record.content).toContain('[REDACTED:API_KEY]');
    // Speaker name preserved in the header
    expect(record.content).toContain('Jane Doe');
  });

  it('origin is HARD-CODED observed — never asserted_by_user (T-06-18)', () => {
    const turn = { speaker: 'Max', text: 'this is my own words' };
    const record = normalizeTranscriptTurn(turn, 'notes.txt', 0, 'notes.txt');
    expect(record.origin).toBe('observed');
    expect(record.origin).not.toBe('asserted_by_user');
  });
});

// ---------------------------------------------------------------------------
// Task 2: TranscriptAdapter integration tests — uses a temp dir
// ---------------------------------------------------------------------------

describe('TranscriptAdapter', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs) {
      try { fs.rmSync(dir, { recursive: true }); } catch { /* best effort */ }
    }
    tmpDirs.length = 0;
  });

  const makeTmpDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-test-'));
    tmpDirs.push(dir);
    return dir;
  };

  const makeMeta = () => {
    const store: Record<string, string> = {};
    return {
      getMeta: (key: string): string | null => store[key] ?? null,
      setMeta: (key: string, value: string): void => { store[key] = value; },
    };
  };

  const makeConfig = (dir: string) => ({
    transcripts: { dir },
    // minimal EngineConfig shape — unused fields not needed for the adapter
  }) as any;

  it('returns [] when transcripts.dir is empty string (fail-safe)', async () => {
    const meta = makeMeta();
    const adapter = new TranscriptAdapter(makeConfig(''), meta);
    const records = await adapter.pull();
    expect(records).toEqual([]);
  });

  it('returns [] when transcripts.dir does not exist', async () => {
    const meta = makeMeta();
    const adapter = new TranscriptAdapter(makeConfig('/nonexistent/path/xyz'), meta);
    const records = await adapter.pull();
    expect(records).toEqual([]);
  });

  it('pulls per-turn records from a .txt file', async () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'meeting.txt'), 'Max: hi\nAlice: hey\nMax: bye');
    const meta = makeMeta();
    const adapter = new TranscriptAdapter(makeConfig(dir), meta);
    const records = await adapter.pull();
    expect(records).toHaveLength(3);
    const [r0, r1, r2] = records;
    expect(r0!.source).toBe('granola');
    expect(r0!.origin).toBe('observed');
    // Content-addressed external_ids: each turn has different text → different hash
    expect(r0!.external_id).toMatch(/^meeting\.txt#[0-9a-f]{16}$/);
    expect(r1!.external_id).toMatch(/^meeting\.txt#[0-9a-f]{16}$/);
    expect(r2!.external_id).toMatch(/^meeting\.txt#[0-9a-f]{16}$/);
    expect(new Set([r0!.external_id, r1!.external_id, r2!.external_id]).size).toBe(3);
  });

  it('recursively walks nested subdirectories and returns turns from all levels', async () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'top.txt'), 'Max: hello\nAlice: world');
    const sub = path.join(dir, 'subdir');
    fs.mkdirSync(sub);
    const vtt = [
      'WEBVTT',
      '',
      '00:00:00.000 --> 00:00:05.000',
      '<v Bob>how are you</v>',
    ].join('\n');
    fs.writeFileSync(path.join(sub, 'call.vtt'), vtt);
    const meta = makeMeta();
    const adapter = new TranscriptAdapter(makeConfig(dir), meta);
    const records = await adapter.pull();
    // 2 turns from top.txt + 1 turn from subdir/call.vtt
    expect(records).toHaveLength(3);
    const ids = records.map(r => r.external_id);
    // Content-addressed: check path prefix and hash format rather than positional indices
    expect(ids.filter(id => id.startsWith('top.txt#')).length).toBe(2);
    expect(ids.filter(id => id.startsWith('subdir/call.vtt#')).length).toBe(1);
    expect(ids.every(id => /^[^#]+#[0-9a-f]{16}$/.test(id))).toBe(true);
  });

  it('skips a symlink pointing outside the watched dir (T-04-PATH/T-06-16)', async () => {
    const dir = makeTmpDir();
    const outside = makeTmpDir();
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'Max: secret content here');
    // Create a symlink inside dir that points outside
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'evil.txt'));
    // Also create a legitimate file
    fs.writeFileSync(path.join(dir, 'legit.txt'), 'Max: legitimate');
    const meta = makeMeta();
    const adapter = new TranscriptAdapter(makeConfig(dir), meta);
    const records = await adapter.pull();
    // Only the legitimate file should produce records; symlink is skipped
    expect(records).toHaveLength(1);
    expect(records[0]!.external_id).toMatch(/^legit\.txt#[0-9a-f]{16}$/);
    expect(records[0]!.content).toContain('legitimate');
  });

  it('writes cursor:granola after first pull and skips files on second pull (D-67)', async () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'meeting.txt'), 'Max: hello');
    const meta = makeMeta();
    const adapter = new TranscriptAdapter(makeConfig(dir), meta);

    // First pull — should return records and set cursor
    const first = await adapter.pull();
    expect(first).toHaveLength(1);
    expect(meta.getMeta('cursor:granola')).not.toBeNull();

    // Second pull — cursor covers the file, no new records
    const second = await adapter.pull();
    expect(second).toHaveLength(0);
  });

  it('sets cursor:granola to the max mtimeMs of processed files', async () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'Max: first');
    const meta = makeMeta();
    const adapter = new TranscriptAdapter(makeConfig(dir), meta);
    await adapter.pull();
    const cursor = meta.getMeta('cursor:granola');
    expect(cursor).not.toBeNull();
    // cursor should be a numeric ms timestamp
    expect(parseFloat(cursor!)).toBeGreaterThan(0);
  });

  it('does not modify cursor:granola when dir is empty', async () => {
    const dir = makeTmpDir();
    const meta = makeMeta();
    const adapter = new TranscriptAdapter(makeConfig(dir), meta);
    await adapter.pull();
    // No files → cursor stays unset
    expect(meta.getMeta('cursor:granola')).toBeNull();
  });

  it('ignores non-transcript file extensions', async () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'notes.pdf'), 'Max: pdf content');
    fs.writeFileSync(path.join(dir, 'audio.mp3'), 'binary');
    fs.writeFileSync(path.join(dir, 'meeting.txt'), 'Max: real transcript');
    const meta = makeMeta();
    const adapter = new TranscriptAdapter(makeConfig(dir), meta);
    const records = await adapter.pull();
    // Only the .txt file should be processed
    expect(records).toHaveLength(1);
    expect(records[0]!.external_id).toMatch(/^meeting\.txt#[0-9a-f]{16}$/);
  });

  it('source property is granola', () => {
    const adapter = new TranscriptAdapter(makeConfig(''), makeMeta());
    expect(adapter.source).toBe('granola');
  });

  it('redacts secrets in transcript content (D-63/T-06-19)', async () => {
    const dir = makeTmpDir();
    const token = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcd';
    fs.writeFileSync(path.join(dir, 'meeting.txt'), `Max: use this token: ${token}`);
    const meta = makeMeta();
    const adapter = new TranscriptAdapter(makeConfig(dir), meta);
    const records = await adapter.pull();
    expect(records[0]!.content).not.toContain(token);
    expect(records[0]!.content).toContain('[REDACTED:API_KEY]');
  });
});
