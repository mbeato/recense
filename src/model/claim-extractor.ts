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
 *
 * Threat mitigations (carried forward):
 *  - T-04-KEY / T-08-KEY: API key is read from env by the SDK inside DefaultModelProvider;
 *    it is never passed to or stored in this file.
 */
import type { NodeType, Origin } from '../lib/types';
import type { ModelProvider } from './provider';
import { promptForSource } from '../source/extraction-prompts';

/**
 * A single extracted knowledge unit from a document.
 * links = wikilink target values found in the same claim's context (D-05).
 *
 * origin is OPTIONAL here: the real/mock extractors need not populate it.
 * The consolidator stamps each claim with its source episode's origin after
 * extraction (Plan 02-02: `claim.origin = episode.origin`) so the
 * confirm→strengthen path can enforce the inferred origin-guard (correctness
 * constraint: self-confirmation loop must be closed at the strengthen call site).
 */
export type ExtractedClaim = {
  type: NodeType;
  value: string;
  links?: string[];
  /** Stamped by the consolidator from the source episode's origin (optional here). */
  origin?: Origin;
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
  {"type":"entity","value":"Jane Doe is the founder","links":["brain-memory project"]},
  {"type":"fact","value":"Never inflate metrics","links":[]},
  {"type":"entity","value":"brain-memory project"}
]

Document type: `;

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

// ---------------------------------------------------------------------------
// ProviderClaimExtractor — production extractor routing through ModelProvider.generate()
// ---------------------------------------------------------------------------

/**
 * Production ClaimExtractor that mirrors the Consolidator's extraction call
 * (consolidator.ts:247-251) for use by ColdStartSeeder (Phase 8, D-77).
 *
 * extract(content, sourceType) calls provider.generate with promptForSource(sourceType)
 * prefix + '\n\nDocument content:\n' + content suffix, then parses the response
 * with parseClaims. No episode.role term — seeding has no role context.
 *
 * Threat mitigation T-08-KEY: the API key is read from env by the SDK inside
 * DefaultModelProvider; it is never logged or passed through this class.
 */
export class ProviderClaimExtractor implements ClaimExtractor {
  constructor(private readonly provider: ModelProvider) {}

  async extract(content: string, sourceType: string): Promise<ExtractedClaim[]> {
    const prompt = promptForSource(sourceType) + '\n\nDocument content:\n' + content;
    const text = await this.provider.generate(prompt, { maxTokens: 2048 });
    return parseClaims(text);
  }
}

export function parseClaims(text: string): ExtractedClaim[] {
  const json = extractJsonArray(text);
  if (json === null) return [];
  try {
    const raw = JSON.parse(json) as unknown;
    if (!Array.isArray(raw)) return [];

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

      return [{ type: type as NodeType, value: value.trim(), links }];
    });
  } catch {
    return [];
  }
}
