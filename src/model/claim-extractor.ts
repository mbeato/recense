/**
 * ClaimExtractor seam (INGEST-03, D-05).
 *
 * Narrow seam: the seeder calls extract(); the real Anthropic call lives in
 * AnthropicClaimExtractor; tests use MockClaimExtractor (no network).
 *
 * Phase 5 SEAM-01 will subsume this into the full ModelProvider.generate/judge
 * split. Keep this minimal — only what the cold-start seeder needs.
 *
 * Threat mitigations:
 *  - T-04-KEY: Anthropic SDK reads ANTHROPIC_API_KEY from process.env by default.
 *    The key is never passed as a literal, never logged, and never committed.
 *    AnthropicClaimExtractor never calls console.log with the client or key.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { NodeType, Origin } from '../lib/types';

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
// Extraction prompt (used by AnthropicClaimExtractor)
// ---------------------------------------------------------------------------

const EXTRACTION_PROMPT = `You are a knowledge extraction assistant. Extract all structured knowledge from the given memory document.

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
// Real implementation — wraps the Anthropic SDK
// ---------------------------------------------------------------------------

export class AnthropicClaimExtractor implements ClaimExtractor {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(model: string) {
    // T-04-KEY: Anthropic() reads ANTHROPIC_API_KEY from process.env automatically.
    // Do not pass the key as a literal argument.
    // Do not log this.client or any key-bearing value.
    this.client = new Anthropic();
    this.model = model;
  }

  async extract(content: string, sourceType: string): Promise<ExtractedClaim[]> {
    const msg = await this.client.messages.create({
      model: this.model, // 'claude-haiku-4-5-20251001' from config — never the deprecated name
      max_tokens: 2048,
      messages: [
        {
          role: 'user',
          content: EXTRACTION_PROMPT + sourceType + '\n\nDocument content:\n' + content,
        },
      ],
    });

    // Extract text blocks from the response
    const text = msg.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    return parseClaims(text);
  }
}

// ---------------------------------------------------------------------------
// Mock — deterministic, no network; used by all unit tests
// ---------------------------------------------------------------------------

/** Deterministic mock for unit tests — returns scripted claims on every call. */
export class MockClaimExtractor implements ClaimExtractor {
  constructor(private readonly scripted: ExtractedClaim[]) {}

  async extract(_content: string, _sourceType: string): Promise<ExtractedClaim[]> {
    return this.scripted;
  }
}

// ---------------------------------------------------------------------------
// Internal JSON parser
// ---------------------------------------------------------------------------

function parseClaims(text: string): ExtractedClaim[] {
  try {
    const raw = JSON.parse(text) as unknown;
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
