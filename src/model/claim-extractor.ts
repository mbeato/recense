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
import type { NodeType } from '../lib/types';

/**
 * A single extracted knowledge unit from a document.
 * links = wikilink target values found in the same claim's context (D-05).
 */
export type ExtractedClaim = {
  type: NodeType;
  value: string;
  links?: string[];
};

/** Narrow extraction seam — the only contract the seeder depends on. */
export interface ClaimExtractor {
  extract(content: string, sourceType: string): Promise<ExtractedClaim[]>;
}

// Stub: full implementation in GREEN phase
export class AnthropicClaimExtractor implements ClaimExtractor {
  constructor(_model: string) {}
  async extract(_content: string, _sourceType: string): Promise<ExtractedClaim[]> {
    return [];
  }
}

/** Deterministic mock for unit tests — returns scripted claims on every call. */
export class MockClaimExtractor implements ClaimExtractor {
  constructor(private readonly scripted: ExtractedClaim[]) {}
  async extract(_content: string, _sourceType: string): Promise<ExtractedClaim[]> {
    return [];
  }
}
