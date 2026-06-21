/**
 * Closed predicate vocabulary for Phase 37 typed predicate edges (TYPED-01).
 *
 * Port of spike 004 lib/vocab.ts with two additions:
 *   1. PREDICATE_GLOSSES — natural-language question-form strings for each predicate
 *      (D-07: embedded once at sleep, cosine-matched at recall, LLM-free online).
 *   2. V5 self-referential-edge guard in parseTriples (subject === object drop,
 *      RESEARCH §Security Domain, T-37-02).
 *
 * See Wave 1 (37-02) for the extraction prompt — it does not live in this module.
 *
 * Zero new runtime dependencies (net-zero dep invariant).
 */

/** The 12 closed predicates — finalized against the real customer-zero corpus (D-09). */
export const PREDICATES = [
  'built_by',        // X created/authored by person Y          (recense built_by Max)
  'works_on',        // person X works on project Y              (Max works_on recense)
  'part_of',         // X is a component/subsystem of Y          (viz part_of recense)
  'uses',            // X uses tool/library/service Y            (recense uses claude-headless)
  'depends_on',      // X depends on Y to function               (recense depends_on better-sqlite3)
  'runs_on',         // X runs on runtime/host Y                 (brain-memory runs_on launchd)
  'located_in',      // X lives in repo/place/dir Y              (schema located_in src/db)
  'integrates_with', // X integrates with peer system Y          (tonos integrates_with VTX)
  'supersedes',      // X replaces/supersedes prior Y            (ember-palette supersedes cyan)
  'prefers',         // person X prefers option Y                (Max prefers OpenAI)
  'evaluated',       // X was considered/evaluated for Y         (recense evaluated Azure)
  'configured_with', // X is configured with setting/value Y     (headless configured_with --tools-none)
] as const;

/** Union type of all valid predicate strings. */
export type Predicate = (typeof PREDICATES)[number];

/** Set of all valid predicates — O(1) membership test (T-37-01: vocab filter). */
export const PRED_SET: ReadonlySet<string> = new Set<string>(PREDICATES);

/** A typed relation triple {subject, predicate, object}. */
export interface Triple {
  subject: string;
  predicate: Predicate;
  object: string;
}

/**
 * Natural-language gloss strings for each predicate (D-07, RESEARCH §1).
 *
 * These are embedded ONCE at sleep time via ModelProvider.embed and stored in the
 * meta table under key `predicate_gloss_embeddings`. At recall time, the already-
 * embedded query cue is cosine-matched against these 12 vectors — LLM-free, O(12).
 *
 * Phrased as the natural-language QUESTION form users actually ask (CONTEXT.md §specifics).
 * Short precise glosses outperform paragraph-length prompts for cosine matching.
 */
export const PREDICATE_GLOSSES: Record<Predicate, string> = {
  built_by:         'who created or built this / who is the author',
  works_on:         'what project does this person work on',
  part_of:          'what system or project is this a component of',
  uses:             'what tool library or service does this use',
  depends_on:       'what does this depend on to function',
  runs_on:          'what runtime host or platform does this run on',
  located_in:       'where is this located or stored / what repo or dir',
  integrates_with:  'what peer system does this integrate with',
  supersedes:       'what does this replace or supersede',
  prefers:          'what does this person prefer or favor',
  evaluated:        'what was evaluated or considered for this',
  configured_with:  'what settings or configuration does this use',
};

/**
 * Parse the model's JSON array output, keeping only valid typed triples.
 *
 * Safety properties (mirrors parseClaims):
 *   - Returns [] on malformed JSON, non-array, or empty string — never throws (T-37-03).
 *   - Drops any triple whose predicate is NOT in the closed 12-vocab (T-37-01, V5 input validation).
 *   - Drops any triple where subject === object — self-referential-edge guard (T-37-02, RESEARCH §Security).
 *   - Trims whitespace from all string fields.
 *
 * @param text - Raw model output (may be wrapped in preamble/fences; first [...] is used).
 */
export function parseTriples(text: string): Triple[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): Triple[] => {
    if (typeof item !== 'object' || item === null) return [];
    const o = item as Record<string, unknown>;
    const s   = typeof o['subject']   === 'string' ? (o['subject']   as string).trim() : '';
    const p   = typeof o['predicate'] === 'string' ? (o['predicate'] as string).trim() : '';
    const obj = typeof o['object']    === 'string' ? (o['object']    as string).trim() : '';
    // T-37-01: vocab filter — drops any out-of-vocab predicate
    if (!s || !obj || !PRED_SET.has(p)) return [];
    // T-37-02: self-referential-edge guard (V5 addition beyond spike)
    if (s === obj) return [];
    return [{ subject: s, predicate: p as Predicate, object: obj }];
  });
}
