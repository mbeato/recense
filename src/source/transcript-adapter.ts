/**
 * TranscriptAdapter — meeting-transcript ingestion seam (Phase 6, D-69).
 *
 * Tool-agnostic watched-folder reader: walks config.transcripts.dir, parses
 * .md/.txt/.vtt exports (Granola/Otter/Zoom — NOT a live bot) into speaker-turns,
 * prepends an inline speaker provenance header (D-59), redacts secrets at the
 * boundary (D-63), and tags every turn source='granola', origin='observed' (D-61).
 *
 * Pure functions (parseTranscript, normalizeTranscriptTurn) are separately
 * exported so unit tests cover them without any filesystem access.
 *
 * Design decisions locked here:
 *  D-58: Chunking, provenance-header assembly, and content sizing happen inside
 *        the adapter — one NormalizedRecord per speaker turn. The 8KB cap is
 *        applied downstream by capContent; a single over-long turn is one record
 *        (truncated at append), preserving turn granularity.
 *  D-59: external_id = contentExternalId(relPath, content) = `<relPath>#<sha256[:16]>`
 *        (content-addressed — CR-01 fix: edit → new hash → new episode → consolidator
 *        reconciles; unchanged re-read → same hash → INSERT OR IGNORE dedups).
 *        Inline provenance header = "[<basename>] <speaker>:" prepended to every turn.
 *  D-61: origin HARD-CODED 'observed' — spoken communication, including the
 *        founder's own turns, is observed, not asserted. Must earn confidence
 *        through consolidation. NEVER the founder-curated origin (T-06-18 guard).
 *  D-63: redactSecrets runs per-turn before NormalizedRecord construction —
 *        raw sensitive text never reaches EpisodicStore (T-06-19).
 *  D-67: cursor:granola = max mtime (ms, stored as string). Files with
 *        mtimeMs <= cursor are skipped on subsequent pulls (speed).
 *  D-69: tool-agnostic format parsing avoids per-vendor API/auth maintenance.
 *        Parsing is file-content-based, not API-based.
 *
 * Threat mitigations:
 *  T-06-16: Symlink traversal blocked by realpathSync + startsWith(realDir+sep)
 *            re-applied at every recursion level of the directory walk.
 *  T-06-17: Only read-only fs calls inside the walk (readdirSync/readFileSync/
 *            statSync); the source folder is never written.
 *  T-06-18: origin HARD-CODED 'observed'; grep gate asserts zero occurrences of
 *            the founder-curated origin tag in this file.
 *  T-06-19: redactSecrets called per-turn at the boundary before emit.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { EngineConfig } from '../lib/config';
import type { Clock } from '../lib/clock';
import { realClock } from '../lib/clock';
import type { SourceAdapter, NormalizedRecord } from './source-adapter';
import { contentExternalId } from './source-adapter';
import { redactSecrets } from './redact';
import type { SemanticStore } from '../db/semantic-store';

// ---------------------------------------------------------------------------
// SpeakerTurn — minimal parse unit
// ---------------------------------------------------------------------------

/** One attributed speaker turn parsed from a transcript file. */
export interface SpeakerTurn {
  speaker: string;
  text: string;
}

// ---------------------------------------------------------------------------
// Supported transcript file extensions
// ---------------------------------------------------------------------------

const TRANSCRIPT_EXTS = new Set(['.md', '.txt', '.vtt']);

// ---------------------------------------------------------------------------
// Pure transcript parser
// ---------------------------------------------------------------------------

/**
 * Speaker line pattern for .txt/.md files.
 * Starts with uppercase letter, followed by 0–40 word/space/dot/apostrophe/
 * hyphen characters, then a colon and optional content on the same line.
 * Examples that match: "Max:", "Dr. Smith:", "Alice M.D.:", "O'Brien:"
 */
const SPEAKER_LINE_RE = /^([A-Z][\w .'-]{0,40}):\s*(.*)$/;

/**
 * WebVTT cue-timing line: starts with two digits then a colon (HH:MM or MM:SS).
 * These are timestamp lines like "00:00:01.000 --> 00:00:05.000".
 */
const VTT_TIMING_RE = /^\d{2}:\d{2}/;

/**
 * WebVTT voice span: `<v Speaker>text</v>` or `<v Speaker>text` (without closer).
 * The speaker name is everything between `<v ` and `>`.
 */
const VTT_VOICE_TAG_RE = /^<v\s+([^>]+)>(.*?)(?:<\/v>)?$/;

/**
 * Parse transcript content into speaker-attributed turns.
 *
 * Supported extensions:
 *  .txt / .md  — `Speaker: text` lines; continuation lines until the next
 *                speaker line are grouped into the current turn's text.
 *                Lines before any speaker line attach to an "Unknown" speaker.
 *  .vtt        — WebVTT; the WEBVTT header, blank lines, and cue-timing lines
 *                are dropped. Each remaining line is parsed as either a
 *                `<v Speaker>text</v>` voice tag, a `Speaker: text` fallback,
 *                or ignored if it matches neither.
 *  other       — Returns a single turn { speaker: 'Unknown', text: content }.
 *
 * @param content  Raw file text.
 * @param ext      File extension including leading dot, e.g. '.txt'.
 */
export function parseTranscript(content: string, ext: string): SpeakerTurn[] {
  const normalizedExt = ext.toLowerCase();
  if (normalizedExt === '.vtt') {
    return parseVtt(content);
  } else if (normalizedExt === '.txt' || normalizedExt === '.md') {
    return parseTxtMd(content);
  } else {
    return [{ speaker: 'Unknown', text: content }];
  }
}

/**
 * Parse .txt/.md transcript: `Speaker: text` lines with continuation grouping.
 * Lines before the first speaker line attach to an "Unknown" speaker turn.
 * Blank continuation lines are skipped to keep turn text clean.
 */
function parseTxtMd(content: string): SpeakerTurn[] {
  const lines = content.split('\n');
  const turns: SpeakerTurn[] = [];

  let currentSpeaker: string | null = null;
  let currentLines: string[] = [];

  const flush = () => {
    if (currentSpeaker !== null && currentLines.length > 0) {
      turns.push({ speaker: currentSpeaker, text: currentLines.join('\n').trim() });
    }
  };

  for (const line of lines) {
    const match = SPEAKER_LINE_RE.exec(line);
    if (match && match[1] !== undefined && match[2] !== undefined) {
      flush();
      currentSpeaker = match[1];
      currentLines = match[2].trim() ? [match[2].trim()] : [];
    } else {
      const trimmed = line.trim();
      if (!trimmed) continue; // skip blank continuation lines
      if (currentSpeaker === null) {
        // Pre-speaker text: assign to Unknown
        currentSpeaker = 'Unknown';
        currentLines = [trimmed];
      } else {
        currentLines.push(trimmed);
      }
    }
  }
  flush();

  return turns;
}

/**
 * Parse WebVTT transcript.
 * Skips: WEBVTT header, blank lines, cue-timing lines (dd:dd... pattern),
 *        numeric cue identifiers.
 * Parses: `<v Speaker>text</v>` voice tags, or falls back to `Speaker: text`.
 * Lines matching neither pattern are ignored.
 */
function parseVtt(content: string): SpeakerTurn[] {
  const turns: SpeakerTurn[] = [];
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === 'WEBVTT') continue;
    if (VTT_TIMING_RE.test(trimmed)) continue; // cue timing line
    if (/^\d+$/.test(trimmed)) continue; // numeric cue identifier

    // Try voice tag first
    const voiceMatch = VTT_VOICE_TAG_RE.exec(trimmed);
    if (voiceMatch && voiceMatch[1] !== undefined && voiceMatch[2] !== undefined) {
      turns.push({ speaker: voiceMatch[1].trim(), text: voiceMatch[2].trim() });
      continue;
    }

    // Fall back to Speaker: text format
    const speakerMatch = SPEAKER_LINE_RE.exec(trimmed);
    if (speakerMatch && speakerMatch[1] !== undefined && speakerMatch[2] !== undefined) {
      turns.push({ speaker: speakerMatch[1], text: speakerMatch[2].trim() });
    }
    // Lines matching neither are silently dropped (metadata, NOTE cues, etc.)
  }

  return turns;
}

// ---------------------------------------------------------------------------
// Turn normalizer — builds NormalizedRecord from a SpeakerTurn
// ---------------------------------------------------------------------------

/**
 * Normalize a single speaker turn into a NormalizedRecord.
 *
 * Builds the inline provenance header `[<fileBasename>] <speaker>:` (D-59),
 * concatenates it with the turn text, runs the combined string through
 * redactSecrets (D-63/T-06-19), then returns a record with:
 *  source:      'granola' (canonical transcript source tag, cursor:granola/D-67)
 *  origin:      'observed' (HARD-CODED, D-61/T-06-18)
 *  role:        'user'
 *  external_id: contentExternalId(fileRelPath, content) (D-59 / CR-01 content-addressed key)
 *
 * The 8KB cap is applied downstream by capContent — if a single turn exceeds
 * the cap it is one record (truncated at append), per D-58 turn-granularity.
 *
 * @param turn          Parsed speaker turn.
 * @param fileBasename  Filename without directory (for the provenance header).
 * @param fileRelPath   Path relative to transcripts.dir root (for external_id).
 */
export function normalizeTranscriptTurn(
  turn: SpeakerTurn,
  fileBasename: string,
  fileRelPath: string,
): NormalizedRecord {
  const header = `[${fileBasename}] ${turn.speaker}:`;
  const raw = `${header} ${turn.text}`;
  const content = redactSecrets(raw);
  return {
    content,
    source: 'granola',
    origin: 'observed',
    role: 'user',
    // D-59 content-addressed dedup key (CR-01): <relPath>#<sha256(content)[:16]>
    // Editing a turn changes content → new hash → new external_id → new episode.
    // Unchanged re-read → same hash → INSERT OR IGNORE dedups (idempotent).
    external_id: contentExternalId(fileRelPath, content),
  };
}

// ---------------------------------------------------------------------------
// TranscriptAdapter — full SourceAdapter implementation
// ---------------------------------------------------------------------------

/**
 * TranscriptAdapter ingests meeting transcript exports from a watched folder.
 *
 * Implements SourceAdapter (D-55). Walks config.transcripts.dir recursively,
 * applying the realpathSync + startsWith(realDir+sep) path-traversal guard at
 * every directory level (T-04-PATH/T-06-16). Uses read-only filesystem calls
 * only — never writes the source folder (T-06-17).
 *
 * Cursor: reads cursor:granola from meta (a ms-timestamp string, D-67). Files
 * with mtimeMs <= cursor are skipped; after the walk the cursor is advanced to
 * the max mtime seen.
 *
 * CONSOL-03 isolation: this adapter NEVER calls EpisodicStore or the semantic
 * graph. The orchestrator feeds returned records through AllocationGate.
 */
export class TranscriptAdapter implements SourceAdapter {
  readonly source = 'granola';

  private readonly config: EngineConfig;
  private readonly meta: Pick<SemanticStore, 'getMeta' | 'setMeta'>;
  private readonly clock: Clock;

  /**
   * @param config  Engine config — reads config.transcripts.dir.
   * @param meta    SemanticStore accessors for cursor persistence.
   * @param clock   Injectable clock (defaults to realClock, D-12).
   */
  constructor(
    config: EngineConfig,
    meta: Pick<SemanticStore, 'getMeta' | 'setMeta'>,
    clock: Clock = realClock,
  ) {
    this.config = config;
    this.meta = meta;
    this.clock = clock;
  }

  /**
   * Pull all new transcript turns since cursor:granola.
   *
   * Returns { records, commitCursor } where commitCursor() persists the new mtime.
   * M-6: the cursor write is deferred — the orchestrator calls commitCursor() ONLY after
   * appendBatch succeeds. A crash between walk and commit means re-walk on next run
   * (at-least-once delivery; UNIQUE(source,external_id) deduplicated on replay).
   * Returns records=[] when transcripts.dir is empty or the directory cannot be resolved.
   *
   * Async-before-sync: all filesystem I/O completes here; the caller may wrap
   * results in a synchronous db.transaction without await escaping into the
   * write path (async-before-sync pattern, mirrors Phase 2).
   */
  async pull(): Promise<{ records: NormalizedRecord[]; commitCursor: () => void }> {
    const dir = this.config.transcripts.dir;
    if (!dir) return { records: [], commitCursor: () => {} }; // disabled — fail-safe (D-69)

    let realRootDir: string;
    try {
      realRootDir = fs.realpathSync(path.resolve(dir));
    } catch {
      return { records: [], commitCursor: () => {} }; // directory doesn't exist or isn't accessible
    }

    const cursorStr = this.meta.getMeta('cursor:granola');
    const cursor = cursorStr !== null ? parseFloat(cursorStr) : 0;

    const records: NormalizedRecord[] = [];
    let maxMtime = cursor;

    // Recursive directory walk with path-traversal guard at every level
    const walkDir = (currentRealDir: string, relFromRoot: string): void => {
      let entries: string[];
      try {
        entries = fs.readdirSync(currentRealDir).sort(); // sorted for determinism
      } catch {
        return; // directory unreadable — skip gracefully
      }

      for (const entry of entries) {
        const candidatePath = path.join(currentRealDir, entry);

        // T-04-PATH / T-06-16: resolve real path and assert it is inside root dir.
        // This guard catches symlinks pointing outside the watched folder.
        let realPath: string;
        try {
          realPath = fs.realpathSync(candidatePath);
        } catch {
          continue; // broken symlink or inaccessible — skip
        }

        if (!realPath.startsWith(realRootDir + path.sep)) {
          continue; // symlink escapes the root — skip (T-04-PATH)
        }

        let stat: fs.Stats;
        try {
          stat = fs.statSync(realPath);
        } catch {
          continue;
        }

        const entryRel = relFromRoot ? `${relFromRoot}/${entry}` : entry;

        if (stat.isDirectory()) {
          // Recurse; the guard above already asserted realPath is inside root
          walkDir(realPath, entryRel);
        } else if (stat.isFile()) {
          const ext = path.extname(entry).toLowerCase();
          if (!TRANSCRIPT_EXTS.has(ext)) continue;

          // D-67 cursor: skip files the last pull already saw
          if (stat.mtimeMs <= cursor) continue;

          if (stat.mtimeMs > maxMtime) maxMtime = stat.mtimeMs;

          let content: string;
          try {
            content = fs.readFileSync(realPath, 'utf8');
          } catch {
            continue; // file became unreadable between stat and read — skip
          }

          const turns = parseTranscript(content, ext);
          const basename = path.basename(entry);
          for (const turn of turns) {
            records.push(normalizeTranscriptTurn(turn, basename, entryRel));
          }
        }
      }
    };

    walkDir(realRootDir, '');

    // M-6: capture maxMtime for the deferred cursor commit (NOT written here).
    // commitCursor is a thunk — called by the orchestrator after appendBatch succeeds.
    const commitCursor = (): void => {
      if (maxMtime > cursor) {
        this.meta.setMeta('cursor:granola', String(maxMtime));
      }
    };

    return { records, commitCursor };
  }
}
