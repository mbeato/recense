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
import type { EngineConfig } from '../lib/config';
import { createAnthropicClient, type AnthropicLike } from './anthropic-client';

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
  private readonly client: AnthropicLike;
  private readonly model: string;

  constructor(config: EngineConfig) {
    // T-04-KEY / T-99b-KEY: createAnthropicClient routes to the direct Anthropic SDK
    // (reads ANTHROPIC_API_KEY from process.env) or AnthropicVertex (authenticates via
    // GCP Application Default Credentials) based on config.modelProvider.
    // Credentials are never passed as literals, never logged, and never committed.
    const { client, model } = createAnthropicClient(config);
    this.client = client;
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
