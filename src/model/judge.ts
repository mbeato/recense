/**
 * Judge seam (Phase 2, D-18/D-15).
 *
 * Narrow seam: the consolidation pass calls judge(); the real Anthropic call lives in
 * AnthropicJudge; tests use MockJudge (no network).
 *
 * Phase 5 SEAM-01 will subsume this into ModelProvider.generate/judge split.
 * Keep this minimal — only what the sleep pass needs.
 *
 * Threat mitigations:
 *  - T-02-KEY: Anthropic SDK reads ANTHROPIC_API_KEY from process.env by default.
 *    The key is never passed as a literal, never printed, and never committed.
 *    AnthropicJudge never exposes the client or key to any output stream.
 *  - T-02-PARSE: parseVerdict validates relation ∈ union, clamps magnitude to [0,1],
 *    and falls back to a safe `unrelated` verdict on malformed or invalid JSON.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { EngineConfig } from '../lib/config';
import { createAnthropicClient, type AnthropicLike } from './anthropic-client';

/** The §4 step-2 relation set (spec §4). */
export type JudgeRelation = 'confirm' | 'extend' | 'contradict' | 'unrelated';

/**
 * One verdict per claim weighing it against all K nominated candidates (D-18).
 * magnitude is the judge-emitted PE severity [0,1]; meaningful only for 'contradict' (D-15).
 */
export interface JudgeVerdict {
  best_candidate_id: string | null;
  relation: JudgeRelation;
  /** PE severity [0,1]; only meaningful for 'contradict' (D-15). */
  magnitude: number;
}

/**
 * ONE batched call per claim weighing it against all K candidates → ONE verdict (D-18).
 */
export interface Judge {
  /** One claim vs all K nominated candidates → ONE verdict (D-18). */
  judge(claim: string, candidates: Array<{ id: string; value: string }>): Promise<JudgeVerdict>;
}

// ---------------------------------------------------------------------------
// Shared safe fallback verdict
// ---------------------------------------------------------------------------

const SAFE_VERDICT: JudgeVerdict = { best_candidate_id: null, relation: 'unrelated', magnitude: 0 };

const VALID_RELATIONS = new Set<string>(['confirm', 'extend', 'contradict', 'unrelated']);

/**
 * Order-swap consistency toggle. When true, AnthropicJudge.judge() issues a second
 * call with reversed candidate order and applies chooseConsistentVerdict() to prevent
 * a run-to-run flip from escalating to a destructive 'contradict'.
 * Module-level const — NOT a config.ts field (file ownership: see PLAN-A constraints).
 * 2x judge cost is acceptable: this runs only in the offline sleep pass.
 */
const JUDGE_ORDER_SWAP = true;

/**
 * Isolate the outermost JSON object span from a model response. Models routinely
 * wrap the object in ```json fences or add preamble despite being told not to
 * (observed with claude-haiku-4-5); JSON.parse on the raw text then throws and
 * the verdict silently falls back to SAFE_VERDICT. Slicing first '{' … last '}'
 * recovers the object regardless of surrounding fences/prose. Returns null if no
 * object span is found. Mirrors extractJsonArray in claim-extractor.ts.
 */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start, end + 1);
}

/** Parse and validate an LLM JSON response into a JudgeVerdict. T-02-PARSE. */
function parseVerdict(text: string): JudgeVerdict {
  try {
    const json = extractJsonObject(text);
    if (json === null) return SAFE_VERDICT;
    const raw = JSON.parse(json) as unknown;
    if (typeof raw !== 'object' || raw === null) return SAFE_VERDICT;

    const obj = raw as Record<string, unknown>;
    const relation = obj['relation'];
    const magnitude = obj['magnitude'];
    const bestId = obj['best_candidate_id'];

    // Validate relation
    if (typeof relation !== 'string' || !VALID_RELATIONS.has(relation)) return SAFE_VERDICT;

    // Coerce and clamp magnitude to [0,1]
    const mag = typeof magnitude === 'number' ? Math.min(1, Math.max(0, magnitude)) : 0;

    // best_candidate_id: null or string
    const candidateId = bestId === null || bestId === undefined
      ? null
      : typeof bestId === 'string' ? bestId : null;

    return { best_candidate_id: candidateId, relation: relation as JudgeRelation, magnitude: mag };
  } catch {
    return SAFE_VERDICT;
  }
}

/**
 * Exported test helper — exposes parseVerdict for unit testing without network.
 * Not part of the Judge seam contract; used only in tests/judge.test.ts.
 */
export function parseVerdictForTest(text: string): JudgeVerdict {
  return parseVerdict(text);
}

/**
 * Order-swap consistency resolver (Fix A1b).
 *
 * Compares the forward-order verdict v1 with the reversed-order verdict v2 and
 * returns the non-destructive choice.  Mirrors the parseVerdictForTest precedent so
 * the disagreement rule is unit-testable without a network call.
 *
 * Rules (applied in order):
 *  1. Equal relations → return v1 (covers both-contradict and both-same-non-contradict).
 *  2. Exactly one is 'contradict' → return the non-contradict verdict.
 *     Never escalate to 'contradict' when the two orderings disagree (PLAN-A must_haves).
 *  3. Both non-contradict but differ → return v1 (first-order verdict wins).
 */
export function chooseConsistentVerdict(v1: JudgeVerdict, v2: JudgeVerdict): JudgeVerdict {
  if (v1.relation === v2.relation) return v1;
  if (v1.relation === 'contradict') return v2;
  if (v2.relation === 'contradict') return v1;
  return v1;
}

// ---------------------------------------------------------------------------
// Prompt for the AnthropicJudge
// ---------------------------------------------------------------------------

const JUDGE_PROMPT_PREFIX = `You are a knowledge graph judge. Given a new claim and a list of candidate nodes from a knowledge graph, determine which single candidate (if any) best matches the claim and how they relate.

Return ONLY valid JSON with exactly these fields:
{
  "best_candidate_id": "<id of best match, or null if none match>",
  "relation": "<confirm | extend | contradict | unrelated>",
  "magnitude": <float in [0.0, 1.0] — PE severity; use 0.0 for non-contradict>
}

Relations:
- "confirm": claim reaffirms the candidate's existing value
- "extend": claim adds new information to the candidate
- "contradict": claim directly conflicts with the candidate (magnitude = severity of conflict)
- "unrelated": no meaningful match; use null for best_candidate_id

New claim: `;

// ---------------------------------------------------------------------------
// Real implementation — wraps the Anthropic SDK
// ---------------------------------------------------------------------------

export class AnthropicJudge implements Judge {
  private readonly client: AnthropicLike;
  private readonly model: string;

  constructor(config: EngineConfig) {
    // T-02-KEY / T-99b-KEY: createAnthropicClient routes to the direct Anthropic SDK
    // (reads ANTHROPIC_API_KEY from process.env) or AnthropicVertex (authenticates via
    // GCP Application Default Credentials) based on config.modelProvider.
    // Credentials are never passed as literals, never logged, and never committed.
    const { client, model } = createAnthropicClient(config);
    this.client = client;
    this.model = model;
  }

  /**
   * Single round-trip to the Anthropic API for a given candidate ordering.
   * Extracted so judge() can call it twice (forward + reversed) for order-swap
   * consistency without duplicating the prompt/parse logic.
   */
  private async judgeOnce(
    claim: string,
    candidates: Array<{ id: string; value: string }>
  ): Promise<JudgeVerdict> {
    const candidateList = candidates
      .map(c => `  - id: "${c.id}", value: "${c.value}"`)
      .join('\n');

    const prompt =
      JUDGE_PROMPT_PREFIX +
      `"${claim}"\n\nCandidates:\n${candidateList}\n\nReturn ONLY the JSON object.`;

    const msg = await this.client.messages.create({
      model: this.model,
      max_tokens: 256,
      temperature: 0, // matches the validated eval config (Fix A1a)
      messages: [{ role: 'user', content: prompt }],
    });

    const text = msg.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map(block => block.text)
      .join('');

    return parseVerdict(text);
  }

  async judge(
    claim: string,
    candidates: Array<{ id: string; value: string }>
  ): Promise<JudgeVerdict> {
    // Short-circuit: no candidates → unrelated with no network call
    if (candidates.length === 0) return SAFE_VERDICT;

    const v1 = await this.judgeOnce(claim, candidates);

    // Skip second call when swap is disabled or there's only one candidate
    // (a single-candidate reversal yields no new information)
    if (!JUDGE_ORDER_SWAP || candidates.length < 2) return v1;

    const v2 = await this.judgeOnce(claim, [...candidates].reverse());
    return chooseConsistentVerdict(v1, v2);
  }
}

// ---------------------------------------------------------------------------
// Mock — deterministic, no network; used by all unit tests
// ---------------------------------------------------------------------------

/** Deterministic mock for unit tests — returns one queued JudgeVerdict per judge() call. */
export class MockJudge implements Judge {
  private readonly queue: JudgeVerdict[];
  private index = 0;

  constructor(scriptedVerdicts: JudgeVerdict[]) {
    this.queue = [...scriptedVerdicts];
  }

  async judge(
    _claim: string,
    _candidates: Array<{ id: string; value: string }>
  ): Promise<JudgeVerdict> {
    if (this.index >= this.queue.length) {
      throw new Error(
        `MockJudge queue exhausted: all ${this.queue.length} scripted verdicts have been consumed`
      );
    }
    return this.queue[this.index++]!;
  }
}
