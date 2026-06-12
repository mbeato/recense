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
 *
 * M2: contradicted_ids lists ALL candidate ids the claim contradicts (not just the primary).
 * For non-contradict relations this is always []. For 'contradict', best_candidate_id should
 * also appear in the list. Optional to keep existing test literals compiling; every producer
 * normalizes to a concrete array (parseVerdict fail-safe, MockJudge default spread).
 */
export interface JudgeVerdict {
  best_candidate_id: string | null;
  relation: JudgeRelation;
  /** PE severity [0,1]; only meaningful for 'contradict' (D-15). */
  magnitude: number;
  /**
   * M2: ALL candidate ids the claim contradicts (including best_candidate_id).
   * Empty array for any non-contradict relation. Deduped. T-UE6-02: membership
   * filtering to the actual candidate set happens at the consolidator call site.
   */
  contradicted_ids?: string[];
}

/**
 * ONE batched call per claim weighing it against all K candidates → ONE verdict (D-18).
 */
export interface Judge {
  /** One claim vs all K nominated candidates → ONE verdict (D-18). */
  judge(claim: string, candidates: Array<{ id: string; value: string }>): Promise<JudgeVerdict>;

  /**
   * Batch variant: N claims in ONE LLM call to amortize the think-block cost across N claims.
   * Index-aligned: result[i] corresponds to items[i]. ≤2 LLM calls per episode total.
   * Items with 0 candidates → SAFE_VERDICT slot, excluded from the prompt (no network call).
   * Batch size 1 MUST reuse the single-claim path byte-identically (preserves judge-eval v2).
   */
  judgeBatch(
    items: Array<{ claim: string; candidates: Array<{ id: string; value: string }> }>
  ): Promise<JudgeVerdict[]>;
}

// ---------------------------------------------------------------------------
// Shared safe fallback verdict
// ---------------------------------------------------------------------------

const SAFE_VERDICT: JudgeVerdict = { best_candidate_id: null, relation: 'unrelated', magnitude: 0, contradicted_ids: [] };

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

    // M2: parse contradicted_ids (T-02-PARSE — membership filtering at consolidator call site, not here).
    // 1. Read field; keep only string entries; dedupe via Set.
    // 2. Fail-safe: relation === 'contradict' && list empty && candidateId !== null → [candidateId].
    // 3. Non-contradict relation → force [].
    const rawIds = obj['contradicted_ids'];
    let contradictedIds: string[];
    if (Array.isArray(rawIds)) {
      contradictedIds = [...new Set(rawIds.filter((x): x is string => typeof x === 'string'))];
    } else {
      contradictedIds = [];
    }
    if (relation === 'contradict') {
      if (contradictedIds.length === 0 && candidateId !== null) {
        contradictedIds = [candidateId];
      }
    } else {
      contradictedIds = [];
    }

    return { best_candidate_id: candidateId, relation: relation as JudgeRelation, magnitude: mag, contradicted_ids: contradictedIds };
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

// ---------------------------------------------------------------------------
// Batch parse helpers
// ---------------------------------------------------------------------------

/**
 * Extract the outermost JSON array span from a model response.
 * Mirrors extractJsonObject but for arrays. Returns null if no array span found.
 */
function extractJsonArray(text: string): string | null {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start, end + 1);
}

/**
 * Parse a batch LLM response into n verdicts (one per prompt item). T-02-PARSE.
 *
 * Applies the same validations as parseVerdict per item:
 *   - relation ∈ VALID_RELATIONS
 *   - magnitude clamped to [0,1]
 *   - contradicted_ids: string-filter, dedupe, contradict-fail-safe, non-contradict-force-empty
 *   - T-UE6-02 defensive filter: contradicted_ids clipped to actual candidate set for that item
 *
 * claim_index in the model JSON maps output to prompt position; falls back to array position.
 * Missing/malformed item → SAFE_VERDICT for that slot.
 * Whole-array parse failure → all SAFE_VERDICT.
 *
 * @param text - raw LLM response text
 * @param n - number of items in the batch prompt (verdicts returned = n)
 * @param perItemCandidateIds - Set of valid candidate ids per prompt item (T-UE6-02 defensive filter)
 */
function parseVerdictBatch(
  text: string,
  n: number,
  perItemCandidateIds: Array<Set<string>>
): JudgeVerdict[] {
  // Initialize all slots to SAFE_VERDICT
  const result: JudgeVerdict[] = Array.from({ length: n }, () => ({ ...SAFE_VERDICT }));

  try {
    const json = extractJsonArray(text);
    if (json === null) return result; // whole-array parse failure → all SAFE

    const rawArr = JSON.parse(json) as unknown;
    if (!Array.isArray(rawArr)) return result; // not an array → all SAFE

    for (let i = 0; i < rawArr.length; i++) {
      const raw = rawArr[i] as unknown;
      if (typeof raw !== 'object' || raw === null) continue; // malformed item → leave SAFE

      const obj = raw as Record<string, unknown>;

      // Map by claim_index when present/valid; else fall back to array position i
      const claimIndexField = obj['claim_index'];
      let slotIdx: number;
      if (
        typeof claimIndexField === 'number' &&
        Number.isInteger(claimIndexField) &&
        claimIndexField >= 0 &&
        claimIndexField < n
      ) {
        slotIdx = claimIndexField;
      } else {
        slotIdx = i;
        if (slotIdx >= n) continue; // position out of range → skip
      }

      // Apply T-02-PARSE validations (mirrors parseVerdict exactly)
      const relation = obj['relation'];
      const magnitude = obj['magnitude'];
      const bestId = obj['best_candidate_id'];

      if (typeof relation !== 'string' || !VALID_RELATIONS.has(relation)) continue; // leave SAFE

      const mag = typeof magnitude === 'number' ? Math.min(1, Math.max(0, magnitude)) : 0;
      const candidateId = bestId === null || bestId === undefined
        ? null
        : typeof bestId === 'string' ? bestId : null;

      // contradicted_ids: same T-02-PARSE logic as parseVerdict
      const rawIds = obj['contradicted_ids'];
      let contradictedIds: string[];
      if (Array.isArray(rawIds)) {
        contradictedIds = [...new Set(rawIds.filter((x): x is string => typeof x === 'string'))];
      } else {
        contradictedIds = [];
      }
      if (relation === 'contradict') {
        if (contradictedIds.length === 0 && candidateId !== null) {
          contradictedIds = [candidateId]; // contradict-fail-safe
        }
        // T-UE6-02 defensive filter: drop ids outside the actual candidate set for this slot
        const validIds = perItemCandidateIds[slotIdx];
        if (validIds !== undefined) {
          contradictedIds = contradictedIds.filter(id => validIds.has(id));
          // Re-apply fail-safe after filtering
          if (contradictedIds.length === 0 && candidateId !== null && validIds.has(candidateId)) {
            contradictedIds = [candidateId];
          }
        }
      } else {
        contradictedIds = []; // non-contradict: force empty
      }

      result[slotIdx] = {
        best_candidate_id: candidateId,
        relation: relation as JudgeRelation,
        magnitude: mag,
        contradicted_ids: contradictedIds,
      };
    }

    return result;
  } catch {
    // Whole-array parse failure → all SAFE_VERDICT
    return Array.from({ length: n }, () => ({ ...SAFE_VERDICT }));
  }
}

/**
 * Exported test helper — exposes parseVerdictBatch for unit testing without network.
 * Not part of the Judge seam contract; used only in tests/judge.test.ts.
 */
export function parseVerdictBatchForTest(
  text: string,
  n: number,
  perItemCandidateIds: Array<Set<string>>
): JudgeVerdict[] {
  return parseVerdictBatch(text, n, perItemCandidateIds);
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
  if (v1.relation === v2.relation) {
    // M2: when both are 'contradict', return v1 spread with contradicted_ids = intersection (conservative).
    // Both orderings must agree a node is contradicted before it routes; prevents order-swap flip-flop
    // from tombstoning a node only one ordering flags. (T-UE6-04 / order-swap invariant)
    if (v1.relation === 'contradict') {
      const v2Set = new Set(v2.contradicted_ids ?? []);
      const intersection = (v1.contradicted_ids ?? []).filter(id => v2Set.has(id));
      return { ...v1, contradicted_ids: intersection };
    }
    return v1;
  }
  if (v1.relation === 'contradict') return v2;
  if (v2.relation === 'contradict') return v1;
  return v1;
}

// ---------------------------------------------------------------------------
// Prompt for the AnthropicJudge
// ---------------------------------------------------------------------------

/**
 * Batch prompt prefix for judgeBatch (items.length > 1). One LLM call per episode
 * amortizes the think-block cost across N claims. Relations block and contradicted_ids
 * instruction copied verbatim from JUDGE_PROMPT_PREFIX.
 */
const JUDGE_BATCH_PROMPT_PREFIX = `You are a knowledge graph judge. For EACH numbered claim below, determine which of ITS candidates (if any) it contradicts and which single candidate best matches.
Return ONLY a valid JSON array with EXACTLY one verdict object per claim, in claim order:
[{"claim_index": <int>, "best_candidate_id": ..., "relation": ..., "magnitude": ..., "contradicted_ids": [...]}, ...]

Relations:
- "confirm": claim reaffirms the candidate's existing value
- "extend": claim adds new information to the candidate
- "contradict": claim directly conflicts with the candidate (magnitude = severity of conflict)
- "unrelated": no meaningful match; use null for best_candidate_id

For relation "contradict": list the ids of ALL candidates the claim contradicts in "contradicted_ids" (best_candidate_id should also appear in the list). For every other relation use an empty array [].

`;

const JUDGE_PROMPT_PREFIX = `You are a knowledge graph judge. Given a new claim and a list of candidate nodes from a knowledge graph, determine which candidate(s) (if any) the claim contradicts and which single candidate best matches overall.

Return ONLY valid JSON with exactly these fields:
{
  "best_candidate_id": "<id of best match, or null if none match>",
  "relation": "<confirm | extend | contradict | unrelated>",
  "magnitude": <float in [0.0, 1.0] — PE severity; use 0.0 for non-contradict>,
  "contradicted_ids": ["<id>", ...]
}

Relations:
- "confirm": claim reaffirms the candidate's existing value
- "extend": claim adds new information to the candidate
- "contradict": claim directly conflicts with the candidate (magnitude = severity of conflict)
- "unrelated": no meaningful match; use null for best_candidate_id

For relation "contradict": list the ids of ALL candidates the claim contradicts in "contradicted_ids" (best_candidate_id should also appear in the list). For every other relation use an empty array [].

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

    // Skip second call when v1 is non-destructive: chooseConsistentVerdict returns v1
    // in EVERY non-contradict-v1 path (agreement → v1; v2=contradict → v1 as the
    // non-destructive pick; both-non-contradict-differ → v1). The reversed call only
    // changes the outcome when v1 says contradict — the swap exists to gate destructive
    // verdicts, so only destructive verdicts pay for it. Behavior-identical by case
    // analysis; halves judge latency on confirm/extend/unrelated escalations.
    if (v1.relation !== 'contradict') return v1;

    const v2 = await this.judgeOnce(claim, [...candidates].reverse());
    return chooseConsistentVerdict(v1, v2);
  }

  /**
   * One batch LLM call for an array of items (all must have at least 1 candidate).
   * Builds the enumerated batch prompt and returns n verdicts via parseVerdictBatch.
   * Called at most twice per judgeBatch invocation (forward + optional swap pass).
   */
  private async judgeBatchOnce(
    batchItems: Array<{ claim: string; candidates: Array<{ id: string; value: string }> }>
  ): Promise<JudgeVerdict[]> {
    const parts: string[] = [JUDGE_BATCH_PROMPT_PREFIX];
    for (let i = 0; i < batchItems.length; i++) {
      const { claim, candidates } = batchItems[i]!;
      const candidateList = candidates
        .map(c => `  - id: "${c.id}", value: "${c.value}"`)
        .join('\n');
      parts.push(`Claim ${i}: "${claim}"\nCandidates for claim ${i}:\n${candidateList}`);
    }
    parts.push('\nReturn ONLY the JSON array.');

    const prompt = parts.join('\n');
    const perItemCandidateIds = batchItems.map(item => new Set(item.candidates.map(c => c.id)));

    const msg = await this.client.messages.create({
      model: this.model,
      max_tokens: Math.min(8192, Math.max(512, 512 * batchItems.length)),
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = msg.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map(block => block.text)
      .join('');

    return parseVerdictBatch(text, batchItems.length, perItemCandidateIds);
  }

  async judgeBatch(
    items: Array<{ claim: string; candidates: Array<{ id: string; value: string }> }>
  ): Promise<JudgeVerdict[]> {
    if (items.length === 0) return [];

    // Batch size 1: reuse single-claim path byte-identically (preserves judge-eval v2 validation)
    if (items.length === 1) {
      const item = items[0]!;
      return [await this.judge(item.claim, item.candidates)];
    }

    // Batch > 1: ONE prompt per episode amortizes one think block across N claims.
    // Items with 0 candidates → SAFE_VERDICT slot, excluded from prompt.
    const results: JudgeVerdict[] = items.map(() => ({ ...SAFE_VERDICT }));

    // Build ordered list of non-empty items, tracking their original indices
    const nonEmptyIdxs: number[] = [];
    const promptItems: Array<{ claim: string; candidates: Array<{ id: string; value: string }> }> = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i]!.candidates.length > 0) {
        nonEmptyIdxs.push(i);
        promptItems.push(items[i]!);
      }
    }
    if (promptItems.length === 0) return results; // all zero-candidate → all SAFE_VERDICT

    // Phase 1: forward batch call
    const v1Verdicts = await this.judgeBatchOnce(promptItems);
    for (let pi = 0; pi < nonEmptyIdxs.length; pi++) {
      results[nonEmptyIdxs[pi]!] = v1Verdicts[pi] ?? { ...SAFE_VERDICT };
    }

    // Order-swap for batched: only contradict items with ≥2 candidates pay for the second call.
    // Non-contradict verdicts are final (chooseConsistentVerdict always returns v1 for them —
    // case analysis: agree→v1, v2=contradict→v1, both-non-contradict-differ→v1).
    if (!JUDGE_ORDER_SWAP) return results;

    const swapItems: Array<{ claim: string; candidates: Array<{ id: string; value: string }> }> = [];
    const swapToOriginalIdx: number[] = []; // maps swap-batch position → original items index
    for (let pi = 0; pi < nonEmptyIdxs.length; pi++) {
      if (
        v1Verdicts[pi]?.relation === 'contradict' &&
        promptItems[pi]!.candidates.length >= 2
      ) {
        swapItems.push({
          claim: promptItems[pi]!.claim,
          candidates: [...promptItems[pi]!.candidates].reverse(),
        });
        swapToOriginalIdx.push(nonEmptyIdxs[pi]!);
      }
    }

    if (swapItems.length === 0) return results;

    // Phase 2: ONE second batch call with ONLY the contradict items (reversed candidates).
    // ≤2 LLM calls per episode total.
    const v2Verdicts = await this.judgeBatchOnce(swapItems);
    for (let j = 0; j < swapToOriginalIdx.length; j++) {
      const origIdx = swapToOriginalIdx[j]!;
      const v1 = results[origIdx]!;
      const v2 = v2Verdicts[j] ?? { ...SAFE_VERDICT };
      results[origIdx] = chooseConsistentVerdict(v1, v2);
    }

    return results;
  }

  /**
   * @internal Test factory — creates AnthropicJudge with a mock client (no API key required).
   * Object.create bypasses the constructor so createAnthropicClient is never called.
   * TypeScript `private readonly` is compile-time; Object.defineProperty replicates the semantics.
   */
  static forTest(client: AnthropicLike, model: string): AnthropicJudge {
    const j = Object.create(AnthropicJudge.prototype) as AnthropicJudge;
    Object.defineProperty(j, 'client', { value: client, writable: false, configurable: false });
    Object.defineProperty(j, 'model', { value: model, writable: false, configurable: false });
    return j;
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
    const queued = this.queue[this.index++]!;
    // M2: backward-compatible default — scripted verdicts that omit contradicted_ids emit []
    return { contradicted_ids: [], ...queued };
  }

  /**
   * Batch variant: consumes one queued verdict per item (no batch LLM call).
   * Delegates to judge() so existing scripted tests compose without changes.
   */
  async judgeBatch(
    items: Array<{ claim: string; candidates: Array<{ id: string; value: string }> }>
  ): Promise<JudgeVerdict[]> {
    const results: JudgeVerdict[] = [];
    for (const item of items) {
      results.push(await this.judge(item.claim, item.candidates));
    }
    return results;
  }
}
