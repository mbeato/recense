/**
 * ClaimExtractor seam (INGEST-03, D-05).
 *
 * Phase 5 Plan 02 (SEAM-01 wiring): AnthropicClaimExtractor removed; claim extraction now
 * routes through ModelProvider.generate() in the Consolidator. This file retains:
 *   - EXTRACTION_PROMPT (exported — used by Consolidator to build the generate call)
 *   - parseClaims (exported — shared parser for both Consolidator and tests)
 *   - ExtractedClaim / ClaimExtractor interface (kept for ColdStartSeeder compatibility)
 *   - MockClaimExtractor (kept for ColdStartSeeder tests that have not yet migrated)
 *   - ProviderClaimExtractor (Phase 8, D-77): production extractor wrapping ModelProvider
 *   - extractClaimsWithChunking (Phase 14): chunked extraction for long content
 *
 * Threat mitigations (carried forward):
 *  - T-04-KEY / T-08-KEY: API key is read from env by the SDK inside DefaultModelProvider;
 *    it is never passed to or stored in this file.
 */
import type { NodeType, Origin } from '../lib/types';
import type { ModelProvider } from './provider';
import { promptForSource } from '../source/extraction-prompts';
import { parseTriples, type Triple } from './typed-predicates';

// ---------------------------------------------------------------------------
// ActionType — closed enum with 'other' fallback (D-02, TEMP-02)
// ---------------------------------------------------------------------------

/**
 * Closed vocabulary of temporal annotation types (D-02).
 * Phase 21 LLM-free surfacing uses this as a deterministic filter key.
 * Model output outside this enum is coerced to 'other' by toActionType() — never crashes,
 * never stores an invalid value (D-02 robustness guard).
 */
export type ActionType =
  | 'deadline'
  | 'flight'
  | 'appointment'
  | 'receipt'
  | 'payment'
  | 'meeting'
  | 'other';

/** Canonical set of valid ActionType values (used for O(1) membership test in toActionType). */
export const ACTION_TYPES: ReadonlySet<ActionType> = new Set([
  'deadline', 'flight', 'appointment', 'receipt', 'payment', 'meeting', 'other',
]);

/**
 * Coerce an unknown value to ActionType.
 * Returns the value unchanged if it is a string member of ACTION_TYPES;
 * otherwise returns 'other'. Never throws (D-02 robustness — model output is untrusted).
 */
export function toActionType(raw: unknown): ActionType {
  if (typeof raw === 'string' && ACTION_TYPES.has(raw as ActionType)) {
    return raw as ActionType;
  }
  return 'other';
}

/**
 * A single extracted knowledge unit from a document.
 * links = wikilink target values found in the same claim's context (D-05).
 *
 * origin is OPTIONAL here: the real/mock extractors need not populate it.
 * The consolidator stamps each claim with its source episode's origin after
 * extraction (Plan 02-02: `claim.origin = episode.origin`) so the
 * confirm→strengthen path can enforce the inferred origin-guard (correctness
 * constraint: self-confirmation loop must be closed at the strengthen call site).
 *
 * D-03: due_at/action_type are optional temporal annotations. Claims that omit
 * them behave exactly as before — no node_temporal row is written (backward-compat).
 */
export type ExtractedClaim = {
  type: NodeType;
  value: string;
  links?: string[];
  /** Stamped by the consolidator from the source episode's origin (optional here). */
  origin?: Origin;
  /** ISO-8601 UTC datetime; present only for time-sensitive commitments (D-03). */
  due_at?: string;
  /** Closed enum for surfacing; present only when due_at is set (D-02/D-03). */
  action_type?: ActionType;
};

/** Narrow extraction seam — the only contract the seeder depends on. */
export interface ClaimExtractor {
  extract(content: string, sourceType: string): Promise<ExtractedClaim[]>;
}

// ---------------------------------------------------------------------------
// Extraction prompt (exported — used by Consolidator.consolidate() via ModelProvider.generate)
// ---------------------------------------------------------------------------

export const EXTRACTION_PROMPT = `You are a knowledge extraction assistant. Extract all structured knowledge from the given memory document.

For each item extract:
- "type": "entity" for named people, projects, tools, technologies, and organizations; "fact" for rules, preferences, capabilities, and factual statements
- "value": a concise, self-contained string
- "links": an array of OTHER item values referenced via [[WikiLink]] syntax in the document, provided WITHOUT the double brackets (omit if none)

Return ONLY a valid JSON array — no preamble, no explanation, no markdown fences.

Example:
[
  {"type":"entity","value":"Jane Doe is the founder","links":["recense project"]},
  {"type":"fact","value":"Never inflate metrics","links":[]},
  {"type":"entity","value":"recense project"}
]

Document type: `;

/**
 * Merged extraction prompt (D-02, Phase 37): one Haiku call emits facts AND typed triples.
 *
 * Output contract: a single JSON object { "facts": [...], "triples": [...] } — NOT a bare array.
 * Pitfall 3: never feed the raw merged output to parseClaims (its [ ] heuristic mis-parses objects).
 * Use parseMergedExtraction to route .facts → parseClaims logic, .triples → parseTriples.
 *
 * Routing (D-02 scope): default/claude-code/obsidian path ONLY.
 * Source-specific prompts (gmail/gcal/granola/transcript/web/document/code-diff) are unchanged.
 *
 * Mode switch (D-03): active when RECENSE_TYPED_EXTRACTION_MODE=merged (dark-default).
 * promptForSource routes to this prompt when merged mode is active.
 */
export const MERGED_EXTRACTION_PROMPT = `You are a knowledge extraction assistant. From the given memory document, extract TWO things:

## Part 1 — Facts and Entities
For each item extract:
- "type": "entity" for named people, projects, tools, technologies, and organizations; "fact" for rules, preferences, capabilities, and factual statements
- "value": a concise, self-contained string
- "links": an array of OTHER item values referenced via [[WikiLink]] syntax in the document, provided WITHOUT the double brackets (omit if none)

## Part 2 — Typed Relationship Triples
Extract every clear (subject, predicate, object) relationship where predicate is EXACTLY one of:
built_by, works_on, part_of, uses, depends_on, runs_on, located_in, integrates_with, supersedes, prefers, evaluated, configured_with

Rules:
- subject and object are short canonical entity names (e.g. "recense", "Max", "launchd"). No sentences.
- If no predicate fits a relationship, SKIP it. Do not invent.
- Only relationships between two named things.

Return ONLY a single valid JSON object with two keys — no preamble, no markdown fences:
{
  "facts": [
    {"type":"entity","value":"Jane Doe is the founder","links":["recense project"]},
    {"type":"fact","value":"Never inflate metrics","links":[]}
  ],
  "triples": [
    {"subject":"recense","predicate":"uses","object":"claude-headless"},
    {"subject":"Max","predicate":"works_on","object":"recense"}
  ]
}

Document type: `;

// ---------------------------------------------------------------------------
// Extraction tunables (named constants — never magic numbers at call sites)
// ---------------------------------------------------------------------------

/**
 * Maximum tokens for a single extraction generate() call.
 * Raised from 2048 → 8192 to prevent JSON array truncation on long content
 * (Phase 14 hardening: silent claim loss when response was cut mid-array).
 */
export const EXTRACTION_MAX_TOKENS = 8_192;

/**
 * JSON Schema for the flat claims array returned by the local constrained-decoding
 * extraction path (QUICK-260612-clb). Passed as `jsonSchema` to
 * `provider.generate()` → forwarded to OllamaClient's native /api/chat endpoint
 * as the `format` parameter.
 *
 * Uses array-root schema (empirically verified: Ollama 0.21.2 accepts this shape).
 * Anthropic/Vertex transports receive this in the ignored `extra` arg and never
 * include it in their request body (T-CLB-seam).
 */
export const CLAIM_ARRAY_SCHEMA: object = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['entity', 'fact'] },
      value: { type: 'string' },
      links: { type: 'array', items: { type: 'string' } },
      // D-03 additions: present only when episodic-email/calendar prompt is active.
      // Optional in required[] — omitted by baseline prompts (backward-compat).
      due_at: { type: 'string' },
      action_type: {
        type: 'string',
        enum: ['deadline', 'flight', 'appointment', 'receipt', 'payment', 'meeting', 'other'],
      },
    },
    required: ['type', 'value'],
  },
};

/**
 * Character threshold above which content is split into chunks for extraction.
 * ~24 000 chars ≈ well under the 8K-token API limit per chunk while leaving
 * headroom for the prompt prefix. Episodes from EpisodicStore are already
 * capped at maxContentBytes (8 000), so chunking is a forward-compatibility
 * guard for the seeder path and future content-limit increases.
 */
export const EXTRACTION_CHUNK_CHARS = 24_000;

// ---------------------------------------------------------------------------
// Mock — deterministic, no network; retained for ColdStartSeeder compatibility
// ---------------------------------------------------------------------------

/** Deterministic mock for unit tests — returns scripted claims on every call. */
export class MockClaimExtractor implements ClaimExtractor {
  constructor(private readonly scripted: ExtractedClaim[]) {}

  async extract(_content: string, _sourceType: string): Promise<ExtractedClaim[]> {
    return this.scripted;
  }
}

// ---------------------------------------------------------------------------
// JSON parser (exported for regression tests — must handle real model output)
// ---------------------------------------------------------------------------

/**
 * Isolate the outermost JSON array span from a model response. Models routinely
 * wrap the array in ```json fences or add preamble despite being told not to
 * (observed with claude-haiku-4-5); JSON.parse on the raw text then throws and
 * every claim is silently dropped. Slicing first '[' … last ']' recovers the
 * array regardless of surrounding fences/prose. Returns null if no array span.
 */
function extractJsonArray(text: string): string | null {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start, end + 1);
}

/**
 * Validate and coerce one parsed JSON array into ExtractedClaim[].
 * Filters out items with missing/invalid type or value fields.
 *
 * Exported for reuse by parseMergedExtraction (Phase 37, D-02): routes obj.facts through
 * the same validation logic without passing the raw merged string to parseClaims.
 */
export function parseClaimsFromArray(raw: unknown[]): ExtractedClaim[] {
  return raw.flatMap((item): ExtractedClaim[] => {
    if (typeof item !== 'object' || item === null) return [];
    const obj = item as Record<string, unknown>;

    const type = obj['type'];
    const value = obj['value'];

    if (
      (type !== 'entity' && type !== 'fact' && type !== 'schema') ||
      typeof value !== 'string' ||
      value.trim() === ''
    ) {
      return [];
    }

    const links = Array.isArray(obj['links'])
      ? (obj['links'] as unknown[]).filter((l): l is string => typeof l === 'string')
      : undefined;

    // D-03: extract temporal fields only when due_at is a non-empty string.
    // action_type is coerced to 'other' for any out-of-enum model output (D-02).
    // Both fields are left undefined when due_at is absent — backward-compat preserved.
    const rawDueAt = obj['due_at'];
    const due_at =
      typeof rawDueAt === 'string' && rawDueAt.trim() ? rawDueAt.trim() : undefined;
    const action_type = due_at !== undefined ? toActionType(obj['action_type']) : undefined;

    return [{ type: type as NodeType, value: value.trim(), links, due_at, action_type }];
  });
}

// ---------------------------------------------------------------------------
// ProviderClaimExtractor — production extractor routing through ModelProvider.generate()
// ---------------------------------------------------------------------------

/**
 * Production ClaimExtractor that mirrors the Consolidator's extraction call
 * (consolidator.ts:247-251) for use by ColdStartSeeder (Phase 8, D-77).
 *
 * extract(content, sourceType) delegates to extractClaimsWithChunking so very
 * long seeder content is handled correctly without truncation. No episode.role
 * term — seeding has no role context.
 *
 * Threat mitigation T-08-KEY: the API key is read from env by the SDK inside
 * DefaultModelProvider; it is never logged or passed through this class.
 */
export class ProviderClaimExtractor implements ClaimExtractor {
  constructor(private readonly provider: ModelProvider) {}

  async extract(content: string, sourceType: string): Promise<ExtractedClaim[]> {
    const promptPrefix = promptForSource(sourceType) + '\n\nDocument content:\n';
    return extractClaimsWithChunking(this.provider, promptPrefix, content);
  }
}

export function parseClaims(text: string): ExtractedClaim[] {
  // Constrained-decoding object-wrap guard (QUICK-260612-clb):
  // When OllamaClient returns an object-wrapped response `{"items":[...]}` (e.g. from
  // an object-root schema fallback), extract and parse the inner array directly.
  // This runs before the array-slicing path so it handles pure object responses where
  // no stray `[` from other contexts exists. Falls through silently on any parse error.
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed) as unknown;
      if (
        typeof obj === 'object' &&
        obj !== null &&
        !Array.isArray(obj) &&
        'items' in obj &&
        Array.isArray((obj as Record<string, unknown>)['items'])
      ) {
        return parseClaimsFromArray((obj as Record<string, unknown>)['items'] as unknown[]);
      }
    } catch {
      // Not a valid JSON object — fall through to the existing array-slicing path
    }
  }

  const json = extractJsonArray(text);

  if (json === null) {
    // No ']' found — likely a truncated response. Attempt salvage: find the first
    // '[' and last '}' in the raw text, close the array, and parse the prefix.
    const startIdx = text.indexOf('[');
    const lastBrace = text.lastIndexOf('}');
    if (startIdx !== -1 && lastBrace !== -1 && lastBrace > startIdx) {
      try {
        const partial = text.slice(startIdx, lastBrace + 1) + ']';
        const partialRaw = JSON.parse(partial) as unknown;
        if (Array.isArray(partialRaw) && partialRaw.length > 0) {
          const salvaged = parseClaimsFromArray(partialRaw);
          if (salvaged.length > 0) {
            console.warn(
              `[recense] parseClaims: no closing ']' — salvaged ${salvaged.length} claim(s) from truncated array`,
            );
            return salvaged;
          }
        }
      } catch {
        // Salvage parse also failed — nothing recoverable
      }
    }
    return [];
  }

  try {
    const raw = JSON.parse(json) as unknown;
    if (!Array.isArray(raw)) return [];
    return parseClaimsFromArray(raw);
  } catch {
    // Full array parse failed. Two sub-cases:
    // (a) A ']' appeared inside a string value — extractJsonArray cut the span at
    //     the wrong ']', leaving the trailing objects outside `json`. Salvage by
    //     searching for the last '}' in the raw text and constructing the prefix.
    // (b) Other malformed JSON — find the last '}' in the extracted json span.

    // Case (b): try the extracted json span first (fast path for the common case)
    const lastBraceInJson = json.lastIndexOf('}');
    if (lastBraceInJson !== -1) {
      try {
        const partial = json.slice(0, lastBraceInJson + 1) + ']';
        const partialRaw = JSON.parse(partial) as unknown;
        if (Array.isArray(partialRaw) && partialRaw.length > 0) {
          const salvaged = parseClaimsFromArray(partialRaw);
          if (salvaged.length > 0) {
            console.warn(
              `[recense] parseClaims: malformed JSON array — salvaged ${salvaged.length} claim(s)`,
            );
            return salvaged;
          }
        }
      } catch {
        // json-span salvage failed — fall through to raw-text salvage
      }
    }

    // Case (a): raw-text salvage — handles ] inside string values causing wrong span cut
    const rawStart = text.indexOf('[');
    const rawLastBrace = text.lastIndexOf('}');
    if (rawStart !== -1 && rawLastBrace !== -1 && rawLastBrace > rawStart) {
      try {
        const partial = text.slice(rawStart, rawLastBrace + 1) + ']';
        const partialRaw = JSON.parse(partial) as unknown;
        if (Array.isArray(partialRaw) && partialRaw.length > 0) {
          const salvaged = parseClaimsFromArray(partialRaw);
          if (salvaged.length > 0) {
            console.warn(
              `[recense] parseClaims: malformed span (] in value?) — salvaged ${salvaged.length} claim(s)`,
            );
            return salvaged;
          }
        }
      } catch {
        // Raw-text salvage also failed — nothing recoverable
      }
    }

    return [];
  }
}

// ---------------------------------------------------------------------------
// Merged extraction parser (Phase 37 D-02 — parseMergedExtraction)
// ---------------------------------------------------------------------------

/**
 * Parse the merged { facts, triples } JSON object emitted by MERGED_EXTRACTION_PROMPT.
 *
 * Safety:
 *  - Returns { claims: [], triples: [] } on any parse failure (T-37-07 safe fallback).
 *  - Pitfall 3: parses the response as a JSON OBJECT explicitly — never feeds raw merged
 *    string to parseClaims (whose [ ] heuristic would mis-parse the outer object shape).
 *  - obj.facts is routed through parseClaimsFromArray (same validation as parseClaims).
 *  - obj.triples is routed through parseTriples (imported from typed-predicates: vocab-
 *    filtered + self-ref-guarded). T-37-06 / T-37-07 both satisfied here.
 *  - Bare-array input (a plain [...]) returns the safe fallback — the object shape is
 *    required; silent misrouting is refused (acceptance criterion 3).
 *
 * @param text - Raw model response from a MERGED_EXTRACTION_PROMPT generate() call.
 */
export function parseMergedExtraction(text: string): { claims: ExtractedClaim[]; triples: Triple[] } {
  const safe = { claims: [] as ExtractedClaim[], triples: [] as Triple[] };
  const trimmed = text.trim();
  // Must start with '{' — a bare array or any other shape is rejected (Pitfall 3 guard).
  if (!trimmed.startsWith('{')) return safe;
  let obj: unknown;
  try {
    // Locate the outermost object span (models may add prose/fences despite instructions).
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) return safe;
    obj = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return safe;
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return safe;
  const record = obj as Record<string, unknown>;

  const factsRaw = record['facts'];
  const triplesRaw = record['triples'];

  const claims = Array.isArray(factsRaw) ? parseClaimsFromArray(factsRaw) : [];
  const triples = Array.isArray(triplesRaw) ? parseTriples(JSON.stringify(triplesRaw)) : [];
  return { claims, triples };
}

// ---------------------------------------------------------------------------
// Chunked extraction helper (exported — used by Consolidator + ProviderClaimExtractor)
// ---------------------------------------------------------------------------

/**
 * Split content on newline boundaries, keeping each chunk <= maxChars.
 * Falls back to a hard split at maxChars when no newline is found in range.
 */
function splitIntoChunks(content: string, maxChars: number): string[] {
  if (content.length <= maxChars) return [content];
  const chunks: string[] = [];
  let pos = 0;
  while (pos < content.length) {
    if (content.length - pos <= maxChars) {
      chunks.push(content.slice(pos));
      break;
    }
    let end = pos + maxChars;
    // Prefer splitting at the last newline within the window to avoid mid-sentence cuts
    const nlIdx = content.lastIndexOf('\n', end - 1);
    if (nlIdx > pos) end = nlIdx + 1; // include the newline in the current chunk
    chunks.push(content.slice(pos, end));
    pos = end;
  }
  return chunks.filter(c => c.trim().length > 0);
}

/**
 * Extract claims from content of arbitrary length, chunking when necessary.
 *
 * When content.length <= EXTRACTION_CHUNK_CHARS: single generate() call (existing behavior).
 * When content.length >  EXTRACTION_CHUNK_CHARS: split on paragraph/newline boundaries,
 *   extract each chunk sequentially with the same prompt prefix, and concatenate claims.
 *
 * Per-episode quarantine semantics (H-2) are preserved: any chunk failure propagates as
 * a thrown Error, quarantining the entire episode without marking it consolidated.
 *
 * @param provider      ModelProvider — generate() is called once per chunk.
 * @param promptPrefix  Prompt text prepended to each chunk (includes role header and
 *                      "Document content:" label — identical across all chunks).
 * @param content       Raw episode/document content to extract from (chunked if long).
 */
export async function extractClaimsWithChunking(
  provider: ModelProvider,
  promptPrefix: string,
  content: string,
): Promise<ExtractedClaim[]> {
  if (content.length <= EXTRACTION_CHUNK_CHARS) {
    const text = await provider.generate(promptPrefix + content, {
      maxTokens: EXTRACTION_MAX_TOKENS,
      jsonSchema: CLAIM_ARRAY_SCHEMA,
    });
    return parseClaims(text);
  }

  console.warn(
    `[recense] extractClaimsWithChunking: content ${content.length} chars exceeds ` +
      `EXTRACTION_CHUNK_CHARS (${EXTRACTION_CHUNK_CHARS}) — splitting into chunks`,
  );
  const chunks = splitIntoChunks(content, EXTRACTION_CHUNK_CHARS);
  const allClaims: ExtractedClaim[] = [];
  for (const chunk of chunks) {
    // Any chunk failure propagates (H-2: episode quarantine semantics)
    const text = await provider.generate(promptPrefix + chunk, {
      maxTokens: EXTRACTION_MAX_TOKENS,
      jsonSchema: CLAIM_ARRAY_SCHEMA,
    });
    allClaims.push(...parseClaims(text));
  }
  return allClaims;
}
