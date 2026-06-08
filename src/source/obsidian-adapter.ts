/**
 * ObsidianAdapter — Obsidian vault ingestion source (Phase 6, D-55/D-56/D-58/D-59/D-61/D-63/D-67).
 *
 * Ships the founder's curated second brain through the unified episodic seam.
 * Vault notes are the ONLY adapter content tagged origin='asserted_by_user' (D-61) —
 * the founder's own notes are trustworthy like MEMORY.md/CLAUDE.md, so they earn
 * asserted origin, but still flow through the episodic path (gate, PE-gating,
 * contradiction machinery) unlike the one-shot seeder.
 *
 * Design decisions locked here:
 *  D-56: The seeder (src/seeder/) is NOT shared or imported here. The seeder is a one-shot
 *        graph-writer (direct node/edge writes, `seeded` flag); the Obsidian adapter is a
 *        recurring episodic-producer (returns NormalizedRecords, no graph write).
 *        The adapter mirrors the seeder's path-guard pattern but is an independent file.
 *  D-58: Chunking happens inside the adapter — one episode per note, splitting on
 *        top-level headings (^#{1,2} ) when a note exceeds config.maxContentBytes.
 *        No data is invented; oversized headingless notes pass through as one section
 *        and capContent handles the hard byte cap downstream.
 *  D-59: external_id = `<vault-relpath>#<section-idx>` for dedup.
 *  D-61: origin='asserted_by_user' — the ONLY adapter that earns this origin.
 *        [[wikilinks]] are kept inline in content (NOT written as edges — CONSOL-03)
 *        so the extraction prompt parses them into claim.links downstream.
 *  D-63: redactSecrets runs per-section at the boundary before record emit — raw
 *        text never reaches EpisodicStore, even for the trusted vault.
 *  D-67: cursor:obsidian = max mtimeMs seen, persisted via meta.setMeta. On each
 *        pull(), files with mtimeMs <= cursor are skipped (incremental walk).
 *  T-04-PATH: realpathSync + startsWith(realRoot + sep) re-applied at EVERY recursion
 *        level — not just the top-level — preventing symlink traversal out of vault.
 *
 * Threat mitigations (from plan 06-06 threat model):
 *  T-06-20: symlink traversal → realpathSync guard at every level; symlink-escape test.
 *  T-06-21: non-vault content as asserted_by_user → only this adapter sets asserted origin,
 *           and only over content read from config.obsidian.dir under the path guard.
 *  T-06-22: secrets in vault notes → redactSecrets per-section before emit (D-63).
 *  T-06-23: adapter writing vault or graph → read-only fs calls only; no graph writes (CONSOL-03).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { EngineConfig } from '../lib/config';
import type { Clock } from '../lib/clock';
import type { SourceAdapter, NormalizedRecord } from './source-adapter';
import { redactSecrets } from './redact';

// ─── NoteSection ─────────────────────────────────────────────────────────────

/**
 * One chunk of a vault note produced by chunkNote().
 *
 * heading: the full heading line (e.g. "## Section Name") if this section starts
 *          at a heading; null for the intro section before the first heading, or
 *          when the note has no headings.
 * text:    the full text of this section (includes the heading line if applicable).
 *          Passed as-is to normalizeObsidianNote; the heading line remains in text
 *          so the LLM extractor sees structural context.
 */
export interface NoteSection {
  heading: string | null;
  text: string;
}

// ─── Pure helpers (exported for unit tests) ──────────────────────────────────

/**
 * Compiled once at module load — matches the beginning of a # or ## heading line.
 * Used by chunkNote to find split points. Pattern: one or two # followed by a space
 * and at least one non-newline character (^#{1,2} .+ in multiline mode).
 */
const HEADING_SPLIT_RE = /^(#{1,2}) (.+)$/gm;

/**
 * Chunk a vault note into heading-delimited sections (D-58).
 *
 * - If content fits within maxBytes → single section (heading=null, text=full content).
 * - If content exceeds maxBytes AND has ^#{1,2} headings → split at each heading;
 *   each section carries the heading line in both heading (the full line) and text.
 *   Content before the first heading becomes an implicit section with heading=null.
 * - If content exceeds maxBytes but has NO headings → single section (heading=null,
 *   text=full content). capContent downstream handles the hard byte cap; the adapter
 *   NEVER truncates — no data is invented.
 *
 * Pure function — no side effects, no filesystem access.
 *
 * @param content  Raw vault note text (UTF-8).
 * @param maxBytes Byte cap from config.maxContentBytes.
 * @returns        Array of sections; always at least one element.
 */
export function chunkNote(content: string, maxBytes: number): NoteSection[] {
  // Fits within cap — return whole note as one section, no split needed.
  if (Buffer.byteLength(content, 'utf8') <= maxBytes) {
    return [{ heading: null, text: content }];
  }

  // Oversized — collect heading split points.
  const splitPoints: Array<{ index: number; headingLine: string }> = [];

  // Reset lastIndex before use (global regex, compile-once discipline).
  HEADING_SPLIT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HEADING_SPLIT_RE.exec(content)) !== null) {
    splitPoints.push({ index: m.index, headingLine: m[0] });
  }

  // No headings → fall back to whole note (downstream capContent is the safety net).
  if (splitPoints.length === 0) {
    return [{ heading: null, text: content }];
  }

  const sections: NoteSection[] = [];

  // Intro text before first heading (may be empty string, but include for completeness).
  if (splitPoints[0]!.index > 0) {
    const preText = content.slice(0, splitPoints[0]!.index);
    sections.push({ heading: null, text: preText });
  }

  // One section per heading: heading line + body until next heading (or end).
  for (let i = 0; i < splitPoints.length; i++) {
    const start = splitPoints[i]!.index;
    const end = i + 1 < splitPoints.length ? splitPoints[i + 1]!.index : content.length;
    const sectionText = content.slice(start, end);
    sections.push({ heading: splitPoints[i]!.headingLine, text: sectionText });
  }

  return sections;
}

/**
 * Extract a note title from its vault-relative path (D-59).
 * Returns the basename without the `.md` extension.
 * Pure function — no filesystem access.
 */
export function noteTitle(relPath: string): string {
  return path.basename(relPath, '.md');
}

/**
 * Build a NormalizedRecord from one note section (D-58/D-59/D-61/D-63).
 *
 * Content layout:
 *   [[<title>]]           ← provenance header (D-59)
 *   <section.text>        ← section body (includes heading line when applicable)
 *
 * [[wikilinks]] in section.text are kept verbatim so the extraction prompt
 * downstream parses them into claim.links. The adapter NEVER writes edges (CONSOL-03).
 *
 * redactSecrets is applied to the full assembled content before the record is
 * returned — secrets are stripped at the boundary, never reaching EpisodicStore (D-63).
 *
 * Pure function — no side effects, no filesystem access, no graph writes.
 */
export function normalizeObsidianNote(
  section: NoteSection,
  title: string,
  sectionIdx: number,
  relPath: string,
): NormalizedRecord {
  // Provenance header — [[title]] so the LLM extractor sees note identity.
  const header = `[[${title}]]`;
  const rawContent = `${header}\n${section.text}`;

  // Redact secrets at the boundary (D-63 / T-06-22) before the record is emitted.
  const content = redactSecrets(rawContent);

  return {
    content,
    source: 'obsidian',
    // D-61: vault is the ONLY adapter that earns asserted_by_user origin.
    // WARNING: never add asserted_by_user to any other adapter — it would let external
    // content masquerade as the founder's own assertions (LEARN-03 guard).
    origin: 'asserted_by_user',
    role: 'user',
    // D-59 stable dedup key: <vault-relpath>#<section-idx>
    external_id: `${relPath}#${sectionIdx}`,
  };
}

// ─── MetaCursor — minimal interface for cursor persistence ───────────────────

/**
 * Minimal interface for cursor persistence (D-67).
 * Satisfied by SemanticStore (getMeta/setMeta), but declared here to avoid
 * a hard import of the full database module in the adapter.
 */
export interface MetaCursor {
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
}

// ─── ObsidianAdapter ─────────────────────────────────────────────────────────

/**
 * ObsidianAdapter — recurring episodic producer for the founder's vault (D-55).
 *
 * On each pull():
 *  1. Reads cursor:obsidian from meta (ms timestamp, D-67).
 *  2. Recursively walks config.obsidian.dir (with path-guard at every level, T-04-PATH).
 *  3. Skips files with mtimeMs <= cursor (only ingest new/modified notes).
 *  4. Chunks each eligible note, normalizes sections to NormalizedRecords.
 *  5. Advances cursor:obsidian to max mtimeMs seen.
 *
 * Read-only on the vault — ONLY readdirSync/readFileSync/statSync (T-06-23).
 * NEVER writes the graph (CONSOL-03). NEVER imports the seeder module (D-56).
 */
export class ObsidianAdapter implements SourceAdapter {
  readonly source = 'obsidian';

  constructor(
    private readonly config: EngineConfig,
    private readonly meta: MetaCursor,
    private readonly clock?: Clock,
  ) {}

  /**
   * Pull all new/modified vault notes since cursor:obsidian.
   *
   * Returns NormalizedRecord[] — one record per note section.
   * Returns [] immediately if config.obsidian.dir is empty (fail-safe disabled state).
   * Returns [] if the vault root does not exist or is not readable.
   */
  async pull(): Promise<NormalizedRecord[]> {
    const dir = this.config.obsidian.dir;
    // Fail-safe: empty dir means the adapter is disabled (D-56).
    if (!dir) return [];

    // Resolve + path-guard the vault root (T-04-PATH first level).
    const resolvedDir = path.resolve(dir);
    let realRoot: string;
    try {
      realRoot = fs.realpathSync(resolvedDir);
    } catch {
      return []; // vault dir doesn't exist or is not accessible
    }

    // Read cursor — ms timestamp (may have sub-ms fractional component); default 0.
    // parseFloat preserves fractional ms so that `mtime <= cursor` correctly skips
    // files whose mtime exactly equals the last-seen max (parseInt would truncate,
    // leaving a fractional mtime just above the truncated cursor and re-ingesting
    // the file on every pull — Rule 1 correctness requirement).
    const cursorRaw = this.meta.getMeta('cursor:obsidian');
    const cursor = cursorRaw !== null ? parseFloat(cursorRaw) : 0;

    const records: NormalizedRecord[] = [];
    let maxMtime = cursor;

    // Recursive walk — re-applies path-guard at every level (T-04-PATH).
    this.walkDir(realRoot, realRoot, cursor, records, (mtime) => {
      if (mtime > maxMtime) maxMtime = mtime;
    });

    // Advance cursor to max mtime seen (D-67).
    if (maxMtime > cursor) {
      this.meta.setMeta('cursor:obsidian', String(maxMtime));
    }

    return records;
  }

  // ── Private walk helper ──────────────────────────────────────────────────

  /**
   * Recursively walk `dirPath`, collecting NormalizedRecords for .md files.
   *
   * @param dirPath   Current directory being enumerated (already verified inside realRoot).
   * @param realRoot  Canonical vault root path; all entries are verified against this.
   * @param cursor    mtimeMs threshold; files at or below are skipped (D-67).
   * @param records   Accumulator for output records.
   * @param onMtime   Callback to report mtime of each processed file (for cursor advance).
   */
  private walkDir(
    dirPath: string,
    realRoot: string,
    cursor: number,
    records: NormalizedRecord[],
    onMtime: (mtime: number) => void,
  ): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(dirPath).sort(); // sort for deterministic ordering
    } catch {
      return; // directory not readable — skip gracefully
    }

    for (const entry of entries) {
      // Skip the .obsidian configuration directory (Obsidian workspace config — not notes).
      if (entry === '.obsidian') continue;

      const candidatePath = path.join(dirPath, entry);

      // T-04-PATH: Re-apply realpathSync + containment guard at EVERY recursion level.
      // This prevents a symlink inside a subdirectory from escaping the vault boundary.
      let realPath: string;
      try {
        realPath = fs.realpathSync(candidatePath);
      } catch {
        continue; // broken symlink or inaccessible — skip
      }

      // Containment check: the resolved path must be strictly inside the vault root.
      if (!realPath.startsWith(realRoot + path.sep)) {
        continue; // symlink or hardlink escapes vault boundary — skip (T-04-PATH / T-06-20)
      }

      // Read stat (uses the already-resolved real path for consistency).
      let stat: fs.Stats;
      try {
        stat = fs.statSync(realPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        // Recurse — guard was already applied above for this directory path.
        this.walkDir(realPath, realRoot, cursor, records, onMtime);
      } else if (entry.endsWith('.md')) {
        const mtime = stat.mtimeMs;

        // Cursor filter: skip unchanged files (D-67).
        if (mtime <= cursor) continue;

        onMtime(mtime);

        // Read note — read-only on vault (T-06-23: readdirSync/readFileSync/statSync only).
        let content: string;
        try {
          content = fs.readFileSync(realPath, 'utf8');
        } catch {
          continue;
        }

        // Vault-relative path for external_id and title extraction.
        const relPath = path.relative(realRoot, realPath);
        const title = noteTitle(relPath);

        // Chunk + normalize — one record per section.
        const sections = chunkNote(content, this.config.maxContentBytes);
        for (let i = 0; i < sections.length; i++) {
          records.push(normalizeObsidianNote(sections[i]!, title, i, relPath));
        }
      }
      // Non-.md files (images, PDFs, etc.) are silently skipped.
    }
  }
}
