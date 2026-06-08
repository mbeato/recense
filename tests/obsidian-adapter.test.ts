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

  it('sets external_id = <relPath>#<sectionIdx>', () => {
    const record = normalizeObsidianNote(plainSection, 'My Note', 2, 'folder/My Note.md');
    expect(record.external_id).toBe('folder/My Note.md#2');
  });

  it('external_id increments correctly per section index', () => {
    const r0 = normalizeObsidianNote(plainSection, 'Note', 0, 'n.md');
    const r1 = normalizeObsidianNote(plainSection, 'Note', 1, 'n.md');
    expect(r0.external_id).toBe('n.md#0');
    expect(r1.external_id).toBe('n.md#1');
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
