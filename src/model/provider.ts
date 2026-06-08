/**
 * ModelProvider seam (Phase 5, SEAM-01, D-46).
 *
 * Defines the three independently-swappable capability heads:
 *   generate — text completion via the Anthropic transport (or Vertex/local)
 *   embed    — batch text embeddings via OpenAI
 *   judge    — relation classification via the Anthropic transport
 *
 * Transport selection stays STRICTLY BELOW this layer (D-47): DefaultModelProvider
 * delegates to createAnthropicClient for generate/judge and OpenAIEmbedder for embed.
 * Neither keys nor transports are selected inside this class.
 *
 * Threat mitigations:
 *  - T-05-KEY: DefaultModelProvider never holds or logs API keys.
 *    generate/judge route through createAnthropicClient (reads ANTHROPIC_API_KEY /
 *    ADC from env automatically). embed routes through OpenAIEmbedder which reads
 *    OPENAI_API_KEY from env automatically.
 *    Verified by grep gate: no direct Anthropic() construction, no apiKey literals in this file.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { EngineConfig } from '../lib/config';
import { createAnthropicClient } from './anthropic-client';
import { OpenAIEmbedder } from './embedder';
import { AnthropicJudge } from './judge';
import type { JudgeVerdict } from './judge';

// ---------------------------------------------------------------------------
// Public interface — the SEAM-01 contract (spec §7 / D-46)
// ---------------------------------------------------------------------------

/**
 * One value with three independently-swappable capability heads (D-46).
 * Swapping the `embed` implementation must NEVER require changes to `generate` or `judge`.
 */
export interface ModelProvider {
  /** Text completion: one user-turn prompt → one string response. */
  generate(prompt: string, opts?: { maxTokens?: number }): Promise<string>;

  /** Batch embed N texts → N Float32Arrays, index-aligned. */
  embed(texts: string[]): Promise<Float32Array[]>;

  /**
   * Classify one claim against K candidates → ONE verdict (D-18).
   * Signature identical to Judge.judge — delegates cleanly.
   */
  judge(
    claim: string,
    candidates: Array<{ id: string; value: string }>
  ): Promise<JudgeVerdict>;
}

// ---------------------------------------------------------------------------
// Real implementation — per-head config, transport below (D-47)
// ---------------------------------------------------------------------------

/**
 * Production ModelProvider. Each head receives its own EngineConfig so that
 * transport routing (anthropic / vertex / local) stays per-role as established
 * by the existing seams (extractor vs judge vs base), NOT selected here.
 *
 * Construction is lazy: OpenAIEmbedder and AnthropicJudge are created once on
 * first delegation, not in the constructor, so construction stays side-effect-free
 * in tests that only verify the class shape (T-05-KEY: no API key needed at new time).
 */
export class DefaultModelProvider implements ModelProvider {
  private readonly generateConfig: EngineConfig;
  private readonly judgeConfig: EngineConfig;
  private readonly embedConfig: EngineConfig;

  private _embedder: OpenAIEmbedder | null = null;
  private _judge: AnthropicJudge | null = null;

  constructor({
    generateConfig,
    judgeConfig,
    embedConfig,
  }: {
    generateConfig: EngineConfig;
    judgeConfig: EngineConfig;
    embedConfig: EngineConfig;
  }) {
    this.generateConfig = generateConfig;
    this.judgeConfig = judgeConfig;
    this.embedConfig = embedConfig;
  }

  async generate(prompt: string, opts?: { maxTokens?: number }): Promise<string> {
    // Transport is resolved below: createAnthropicClient reads env creds automatically.
    // Never log `client` or expose it — T-05-KEY.
    const { client, model } = createAnthropicClient(this.generateConfig);
    const msg = await client.messages.create({
      model,
      max_tokens: opts?.maxTokens ?? 1024,
      messages: [{ role: 'user', content: prompt }],
    });
    return msg.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map(block => block.text)
      .join('');
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!this._embedder) {
      // OpenAIEmbedder reads OPENAI_API_KEY from env automatically — T-05-KEY.
      this._embedder = new OpenAIEmbedder(
        this.embedConfig.openaiEmbedModel,
        this.embedConfig.embeddingDimensions
      );
    }
    return this._embedder.embed(texts);
  }

  async judge(
    claim: string,
    candidates: Array<{ id: string; value: string }>
  ): Promise<JudgeVerdict> {
    if (!this._judge) {
      // AnthropicJudge uses createAnthropicClient internally — T-05-KEY.
      this._judge = new AnthropicJudge(this.judgeConfig);
    }
    return this._judge.judge(claim, candidates);
  }
}

// ---------------------------------------------------------------------------
// Mock — deterministic, no network; used by all unit tests
// ---------------------------------------------------------------------------

/**
 * Deterministic mock for unit tests. Each head has its own script/fn and
 * they share NO state, proving independent swappability (SEAM-01 SC1).
 */
export class MockModelProvider implements ModelProvider {
  private readonly generateQueue: string[];
  private readonly embedFn: (t: string) => Float32Array;
  private readonly judgeQueue: JudgeVerdict[];
  private generateIdx = 0;
  private judgeIdx = 0;

  constructor({
    generateScript = [],
    embedFn = () => new Float32Array(1),
    judgeScript = [],
  }: {
    generateScript?: string[];
    embedFn?: (t: string) => Float32Array;
    judgeScript?: JudgeVerdict[];
  } = {}) {
    this.generateQueue = [...generateScript];
    this.embedFn = embedFn;
    this.judgeQueue = [...judgeScript];
  }

  async generate(_prompt: string, _opts?: { maxTokens?: number }): Promise<string> {
    if (this.generateIdx >= this.generateQueue.length) {
      throw new Error(
        `MockModelProvider generate queue exhausted: all ${this.generateQueue.length} scripted responses have been consumed`
      );
    }
    return this.generateQueue[this.generateIdx++]!;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(this.embedFn);
  }

  async judge(
    _claim: string,
    _candidates: Array<{ id: string; value: string }>
  ): Promise<JudgeVerdict> {
    if (this.judgeIdx >= this.judgeQueue.length) {
      throw new Error(
        `MockModelProvider judge queue exhausted: all ${this.judgeQueue.length} scripted verdicts have been consumed`
      );
    }
    return this.judgeQueue[this.judgeIdx++]!;
  }
}
