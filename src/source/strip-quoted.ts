/**
 * stripQuotedForwarded / isNearEmptyResidual — the D-06 quoted/forwarded-content detector
 * for DRIFT-03 (Phase 65, Plan 65-02).
 *
 * **Scope fence — provenance/distinctness path ONLY.** This module must never be called
 * from `normalizeGmailMessage`'s content path (`src/source/gmail-adapter.ts`), never from
 * `src/ingest/pipeline.ts`, and never in any way that changes `record.content`, the
 * extractor's input, or Phase 62's EMAIL-03 `stripHiddenContent` behavior. Its one intended
 * caller is the provenance-distinctness key derivation (Plan 65-04): the residual this
 * module produces decides whether an email contributes independent provenance toward
 * `countDistinctProvenance` (`src/consolidation/update-decision.ts`), NOT what the extractor
 * or any downstream consumer sees as episode content. Adding a second call site that feeds
 * episode content is a correctness regression, not a refactor.
 *
 * Why this exists (research Pitfall 3): keying provenance-distinctness on raw message
 * identity turns three forwards of one underlying thread into three "independent"
 * corroborations, which can force-destabilize a belief off a single manipulated email. This
 * module reduces a body to the author's own newly-written text FIRST, so 3 forwards of one
 * thread collapse to 1 independent residual (D-07) while 3 genuinely independent emails
 * still count as 3.
 *
 * Contract (adapted from `strip-hidden.ts`'s four-guarantee block):
 *  - **Pure**: no side effects, no I/O, no randomness, no clock read.
 *  - **Idempotent**: `stripQuotedForwarded(stripQuotedForwarded(x)) === stripQuotedForwarded(x)`.
 *  - **Total**: never throws, for any string including empty/malformed/unterminated/
 *    adversarially-nested input.
 *  - **Monotone toward less content**: `stripQuotedForwarded(x).length <= x.length` always;
 *    the output is never the raw input re-expanded.
 *
 * Under-count/over-count asymmetry: every ambiguous case in this module resolves toward
 * LESS residual. Under-counting provenance only delays a belief update (a held claim stays
 * held one cycle longer); over-counting manufactures false independence and can force a
 * belief update off duplicated content (the exact farming vector Pitfall 3 describes). When
 * in doubt, this module strips more, not less.
 *
 * Zero imports by design — this module has no dependency surface to audit.
 */

// ---------------------------------------------------------------------------
// Module-scope compiled regexes (compile ONCE at module load, never per call —
// mirrors strip-hidden.ts's compile-once discipline).
// ---------------------------------------------------------------------------

/**
 * A line whose first non-space character is `>` (up to 3 leading spaces tolerated, matching
 * common mailer soft-wrap of quoted lines). Multiline so `^`/`$` anchor per line.
 */
const QUOTE_LINE_RE = /^ {0,3}>.*$/gm;

/**
 * The `On <anything> wrote:` attribution boundary. The middle span is bounded by an explicit
 * length-limited character class (up to ~200 non-newline characters, optionally spanning ONE
 * newline) rather than a greedy `.*` — an unbounded greedy match across a large body is the
 * classic catastrophic-backtracking foot-gun, and this function must stay total and bounded.
 * Anchored at line start (multiline) to avoid matching "on" mid-sentence.
 */
const ATTRIBUTION_RE = /^On [^\n]{0,200}(?:\n[^\n]{0,200})? wrote:\s*$/gim;

/**
 * Forwarded-message banners recognized at line start. Covers: a run of 2+ dashes, the word
 * "Forwarded message" (case-insensitive), a run of 2+ dashes; "-----Original Message-----"
 * (any dash count >=2); and "Begin forwarded message:".
 */
const FORWARD_MARKER_RE = /^(?:-{2,}\s*Forwarded message\s*-{2,}|-{2,}\s*Original Message\s*-{2,}|Begin forwarded message:)\s*$/gim;

/** RFC 3676 signature delimiter: a line consisting of exactly `-- ` (dash dash space). */
const SIGNATURE_DELIM_RE = /^-- $/gm;

/** Non-whitespace character, used by `isNearEmptyResidual` for the residual-size count. */
const NON_WHITESPACE_RE = /\S/g;

/** Three or more consecutive blank lines collapse to one, keeping the residual tidy. */
const EXCESS_BLANK_LINES_RE = /\n{3,}/g;

/**
 * Fail-closed input-size guard, mirroring the shipped `MAX_STRIP_INPUT_CODE_UNITS` precedent
 * in `gmail-adapter.ts`. Returning EMPTY (not the input) above this bound is the fail-closed
 * direction for THIS module: an oversized body yields "no independent residual", which
 * under-counts provenance. Under-counting only delays a belief update; over-counting
 * (e.g. falling back to returning the raw input) would manufacture false independence — the
 * exact farming vector this module exists to prevent. See the file header's asymmetry note.
 */
const MAX_QUOTE_STRIP_CODE_UNITS = 200_000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reduce an email body to the author's own newly-written text by dropping quoted and
 * forwarded material.
 *
 * Algorithm (single pass, deterministic, no clock, no I/O, no randomness):
 *  1. Over-cap guard: inputs longer than `MAX_QUOTE_STRIP_CODE_UNITS` return `''` immediately.
 *  2. Split on `\n` and walk from the top; stop at the FIRST line matching `ATTRIBUTION_RE`,
 *     `FORWARD_MARKER_RE`, or `SIGNATURE_DELIM_RE` — everything from that line onward is
 *     dropped. This "stop at the first boundary" rule is deliberate: quoted material below an
 *     attribution line frequently contains the ORIGINAL sender's un-prefixed text (Gmail's
 *     HTML-to-text conversion often drops `>` prefixes on quoted content), so a quote-line-only
 *     filter would leak the quoted body through and defeat D-07's farming-prevention guarantee.
 *  3. From the surviving prefix, drop every line matching `QUOTE_LINE_RE`.
 *  4. Rejoin with `\n`, collapse runs of 3+ blank lines to one, and `.trim()` the result.
 *
 * @param text - Raw email body text (post EMAIL-03 `stripHiddenContent`, never the reverse).
 * @returns    The author's own newly-written text, with all quoted/forwarded/signature
 *             content removed. Never longer than `text`; never throws.
 */
export function stripQuotedForwarded(text: string): string {
  if (text.length > MAX_QUOTE_STRIP_CODE_UNITS) return '';
  if (text.length === 0) return '';

  const lines = text.split('\n');

  // Reset lastIndex before each manual .test() loop on a global regex (mirrors
  // strip-hidden.ts's compile-once + lastIndex-reset discipline).
  ATTRIBUTION_RE.lastIndex = 0;
  FORWARD_MARKER_RE.lastIndex = 0;
  SIGNATURE_DELIM_RE.lastIndex = 0;

  // Step 2: find the first boundary line. The attribution pattern can span two physical
  // lines (mailer soft-wrap), so test each line and, failing that, each adjacent two-line
  // window joined by '\n'.
  let boundaryIndex = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    FORWARD_MARKER_RE.lastIndex = 0;
    SIGNATURE_DELIM_RE.lastIndex = 0;
    ATTRIBUTION_RE.lastIndex = 0;
    if (FORWARD_MARKER_RE.test(line) || SIGNATURE_DELIM_RE.test(line) || ATTRIBUTION_RE.test(line)) {
      boundaryIndex = i;
      break;
    }
    // Two-line attribution window (e.g. "On Mon, Jan 5...\n...9:00 AM Alice wrote:").
    if (i + 1 < lines.length) {
      const window = `${line}\n${lines[i + 1]}`;
      ATTRIBUTION_RE.lastIndex = 0;
      if (ATTRIBUTION_RE.test(window)) {
        boundaryIndex = i;
        break;
      }
    }
  }

  const prefixLines = lines.slice(0, boundaryIndex);

  // Step 3: drop every quote-prefixed line from the surviving prefix.
  QUOTE_LINE_RE.lastIndex = 0;
  const kept = prefixLines.filter(line => {
    QUOTE_LINE_RE.lastIndex = 0;
    return !QUOTE_LINE_RE.test(line);
  });

  // Step 4: rejoin, collapse excess blank lines, trim.
  let result = kept.join('\n');
  result = result.replace(EXCESS_BLANK_LINES_RE, '\n\n');
  result = result.trim();

  // Monotonicity safety net: the transformation above is structurally length-reducing
  // (line removal + trim), but guard explicitly — truncating RESULT (never re-expanding
  // toward the raw input) — so the contract can never be violated by a future edit to this
  // function.
  return result.length <= text.length ? result : result.slice(0, text.length);
}

/**
 * Judge whether `text` is too small to count as independent evidence, counting only
 * non-whitespace characters (a residual of pure whitespace, or short filler like "FYI",
 * should not earn independent provenance).
 *
 * `minNonWhitespaceChars = 0` disables the gate — every input (including `''`) returns
 * `false` in that case, the documented "gate disabled" value.
 *
 * Kept as a separate exported function from `stripQuotedForwarded` (mirroring
 * `stripInvisibleCodepoints` staying separate from `stripHiddenContent`): Plan 65-10's
 * dry-run harness needs to report the residual-length distribution independently of the
 * pass/fail judgement so the threshold can be tuned against real inbox data. The threshold
 * itself is supplied by the caller (`config.provenanceMinResidualChars`, added in Plan
 * 65-03) — this module holds no default and reads no config.
 *
 * @param text                   - Residual text to judge (typically the output of
 *                                 `stripQuotedForwarded`).
 * @param minNonWhitespaceChars  - Minimum non-whitespace character count required to count
 *                                 as independent evidence. `0` disables the gate.
 * @returns                      `true` if `text` has fewer than `minNonWhitespaceChars`
 *                                non-whitespace characters (near-empty); `false` otherwise.
 */
export function isNearEmptyResidual(text: string, minNonWhitespaceChars: number): boolean {
  if (minNonWhitespaceChars <= 0) return false;
  NON_WHITESPACE_RE.lastIndex = 0;
  const matches = text.match(NON_WHITESPACE_RE);
  const count = matches === null ? 0 : matches.length;
  return count < minNonWhitespaceChars;
}
