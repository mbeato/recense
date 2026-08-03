/**
 * DRIFT-03 structural guard: no file under src/ inspects a session_id/sessionId value's
 * string CONTENT.
 *
 * WHY this matters: `.planning/phases/65-belief-gated-status-drift-provenance-distinctness-fix/
 * 65-SESSION-ID-AUDIT.md` section 2 locks the claim that every live `session_id`/`sessionId`
 * consumer under `src/` is exactly one of `mint` (constructs a value), `passthrough` (carries a
 * value without inspecting it), `value-semantic` (`countDistinctProvenance`, the one consumer
 * whose behavior depends on the value's identity/cardinality), or `unrelated` (a different
 * `sessionId` concept entirely). That claim is what makes the D-02 PRIMARY shape safe: widening
 * `ingest-cli.ts:188`'s gmail session id from the literal `ingest:gmail` to
 * `ingest:gmail:<sender-domain>:<thread-id>` cannot silently break anything, because nothing
 * downstream parses, prefix-matches, splits, or equality-compares the string's content. This
 * test is the shipped, non-vacuous enforcement of that claim — closing the D-02 gate with code,
 * not just review discipline. Weakening or deleting this guard silently reopens the gate the
 * audit closed.
 *
 * Comment-stripping (see `stripComments` below) is LOAD-BEARING, not cosmetic: this file's own
 * header, the audit doc, and the Phase 65 module doc comments all name the forbidden patterns
 * (`.startsWith(`, `===`, etc.) in prose. An unstripped scan of this very file would flag its
 * own comments as offenses and self-invalidate the guard.
 *
 * Shape mirrors tests/no-ats-domain-table.test.ts and tests/src-import-boundary.test.ts: an
 * exported pure predicate, a real src/ walk asserting `[]`, and a non-vacuousness check that
 * plants synthetic offenders through the SAME predicate (so the guard cannot pass by having a
 * real bug in an unused copy of the pattern list).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SRC_DIR = resolve(__dirname, '..', 'src');

/** Recursively collect all .ts files under dir. */
function collectTsFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...collectTsFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      result.push(full);
    }
  }
  return result;
}

/**
 * Strip `//` line comments and `/* *\/` block comments, replacing removed characters with
 * spaces (never removing newlines) so line numbers of the remaining code are unaffected.
 * MANDATORY before matching — see file header.
 */
function stripComments(source: string): string {
  let out = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  out = out.replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
  return out;
}

// A "session id receiver" is a bare `session_id` / `sessionId` identifier, or a member
// expression whose FINAL segment is one of those two names (e.g. `episode.session_id`,
// `decision.episodeSessionId` does NOT match — the final segment must be exactly
// `session_id` or `sessionId`, not a compound like `episodeSessionId`).
const RECEIVER = '(?:[A-Za-z_$][\\w$]*\\.)*(?:session_id|sessionId)';

/** `<receiver>.startsWith(` / `.endsWith(` / `.includes(` / `.split(` / `.slice(` /
 *  `.substring(` / `.match(` / `.indexOf(` — inspecting a session id's string content. */
const INSPECT_METHOD_RE = new RegExp(
  `(${RECEIVER})\\.(startsWith|endsWith|includes|split|slice|substring|match|indexOf)\\s*\\(`,
);

/** `<receiver> === 'literal'` / `!==` / `==` / `!=` — receiver on the left. */
const COMPARE_LEFT_RE = new RegExp(`(${RECEIVER})\\s*(===|!==|==|!=)\\s*(['"\`])`);

/** `'literal' === <receiver>` / `!==` / `==` / `!=` — receiver on the right. */
const COMPARE_RIGHT_RE = new RegExp(
  `(['"\`])(?:[^'"\`\\\\]|\\\\.)*\\3\\s*(===|!==|==|!=)\\s*(${RECEIVER})\\b`,
);

/** `<regex>.test(<receiver>)` — a regex test against a session id's content. */
const REGEX_TEST_RE = new RegExp(`\\.test\\s*\\(\\s*(${RECEIVER})\\s*\\)`);

/**
 * Returns one human-readable offense string per line that inspects a session_id/sessionId
 * value's string CONTENT, or [] if the file is clean.
 *
 * NOT flagged (legitimate, happens at five sites today): assignment (`session_id = x`),
 * object-property construction / interface declaration (`sessionId: <anything>`,
 * `session_id: <anything>`) — including `src/lib/types.ts` interface fields and
 * `src/db/schema.ts` DDL column declarations, both of which use `:` rather than `.` and so
 * never match any pattern above.
 */
export function findSessionIdContentBranches(source: string, relPath: string): string[] {
  const offenses: string[] = [];
  const stripped = stripComments(source);
  const originalLines = source.split('\n');
  const strippedLines = stripped.split('\n');

  strippedLines.forEach((line, idx) => {
    if (
      INSPECT_METHOD_RE.test(line) ||
      COMPARE_LEFT_RE.test(line) ||
      COMPARE_RIGHT_RE.test(line) ||
      REGEX_TEST_RE.test(line)
    ) {
      offenses.push(`${relPath}:${idx + 1} — ${(originalLines[idx] ?? '').trim()}`);
    }
  });

  return offenses;
}

describe('DRIFT-03 no-session-id-content-inspection guard — real walk', () => {
  it('no file under src/ inspects a session_id/sessionId value\'s string content', () => {
    const files = collectTsFiles(SRC_DIR);
    const offenses: string[] = [];
    for (const path of files) {
      offenses.push(...findSessionIdContentBranches(readFileSync(path, 'utf8'), path));
    }
    expect(offenses).toEqual([]);
    // Sanity: the walk actually covered a meaningful slice of the codebase — a suite that
    // silently scanned zero files would pass vacuously.
    expect(files.length).toBeGreaterThan(100);
  });
});

describe('DRIFT-03 guard — non-vacuousness (planted offenders, same predicate)', () => {
  it('flags `session_id.startsWith(...)`', () => {
    const offenses = findSessionIdContentBranches(
      "if (session_id.startsWith('ingest:')) { doThing(); }",
      'src/synthetic/__offender-startswith.ts',
    );
    expect(offenses.length).toBeGreaterThan(0);
  });

  it('flags `sessionId.split(...)`', () => {
    const offenses = findSessionIdContentBranches(
      "const suffix = sessionId.split(':')[1];",
      'src/synthetic/__offender-split.ts',
    );
    expect(offenses.length).toBeGreaterThan(0);
  });

  it('flags `episode.session_id === \'ingest:gmail\'`', () => {
    const offenses = findSessionIdContentBranches(
      "if (episode.session_id === 'ingest:gmail') { legacyPath(); }",
      'src/synthetic/__offender-equality.ts',
    );
    expect(offenses.length).toBeGreaterThan(0);
  });

  it('flags `sessionId.includes(...)`', () => {
    const offenses = findSessionIdContentBranches(
      "const isIngest = sessionId.includes('ingest:');",
      'src/synthetic/__offender-includes.ts',
    );
    expect(offenses.length).toBeGreaterThan(0);
  });

  it('flags a regex `.test(...)` against a session id', () => {
    const offenses = findSessionIdContentBranches(
      "const isIngest = /^ingest:/.test(sessionId);",
      'src/synthetic/__offender-regex-test.ts',
    );
    expect(offenses.length).toBeGreaterThan(0);
  });

  it('ignores all five offender patterns when they appear only inside comments', () => {
    const commented = `
      // if (session_id.startsWith('ingest:')) { doThing(); }
      // const suffix = sessionId.split(':')[1];
      /* if (episode.session_id === 'ingest:gmail') { legacyPath(); } */
      // const isIngest = sessionId.includes('ingest:');
      /* const isIngest = /^ingest:/.test(sessionId); */
      const x = 1; // harmless trailing comment
    `;
    const offenses = findSessionIdContentBranches(commented, 'src/synthetic/__all-commented.ts');
    expect(offenses).toEqual([]);
  });
});

describe('DRIFT-03 guard — allowed-mint regression (real mint lines must never be flagged)', () => {
  it('allows the ingest-cli.ts gmail/source mint', () => {
    const offenses = findSessionIdContentBranches(
      'sessionId: `ingest:${r.source}`,',
      'src/adapter/ingest-cli.ts',
    );
    expect(offenses).toEqual([]);
  });

  it('allows the import-memory-cli.ts mint', () => {
    const offenses = findSessionIdContentBranches(
      'sessionId: `${IMPORT_SOURCE}:${item.project}`,',
      'src/adapter/import-memory-cli.ts',
    );
    expect(offenses).toEqual([]);
  });

  it('allows the ingest-project-cli.ts survey mint', () => {
    const offenses = findSessionIdContentBranches(
      'sessionId: `project-survey:${scope}:${area}`,',
      'src/adapter/ingest-project-cli.ts',
    );
    expect(offenses).toEqual([]);
  });

  it('allows the ingest-project-cli.ts doc mint', () => {
    const offenses = findSessionIdContentBranches(
      'sessionId: `project-doc:${scope}:${relPath}`,',
      'src/adapter/ingest-project-cli.ts',
    );
    expect(offenses).toEqual([]);
  });
});
