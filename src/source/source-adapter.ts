/**
 * SourceAdapter seam (Phase 6, D-55).
 *
 * Defines the pluggable ingestion contract: every source (Gmail, meeting transcripts,
 * Obsidian vault) implements SourceAdapter and emits NormalizedRecord values that the
 * orchestrator feeds directly into EpisodicStore.append() through AllocationGate.
 *
 * Design decisions locked here:
 *  D-55: One injected seam, unified on the episodic path — no second code path for
 *        curated vs. noisy sources. Origin tag + AllocationGate sourceWeights do
 *        the curation/noise distinction.
 *  D-58: Chunking, provenance-header assembly, and content sizing happen INSIDE the
 *        adapter (before emit). pull() returns already-chunked, already-tagged records.
 *  D-63: Redaction (redactSecrets) happens inside the adapter BEFORE the record is
 *        emitted — raw sensitive text NEVER touches EpisodicStore (redact-at-boundary).
 *        The only recoverable place: EpisodicStore is append-only; post-append redaction
 *        cannot fully undo a write the sleep pass may already have read.
 *  D-60: Salience is NOT carried on NormalizedRecord. AllocationGate owns salience via
 *        sourceWeights (single salience authority, D-03). Adapters may not carry salience
 *        hints — that would let sources bypass the honest per-source weight calibration.
 *
 * Threat mitigations:
 *  T-06-05: content on emitted records is post-redaction; adapters call redactSecrets
 *           before constructing records — raw secrets never reach EpisodicStore.
 *
 * Seam house style mirrors provider.ts (ModelProvider / MockModelProvider):
 *  - Narrow interface, JSDoc-per-member.
 *  - No credentials at construction time (constructor is side-effect-free for tests).
 *  - MockSourceAdapter is deterministic (scripted queue), no network.
 */
import type { Origin, EpisodeRole } from '../lib/types';

// ---------------------------------------------------------------------------
// Normalized record — the unit emitted by SourceAdapter.pull()
// ---------------------------------------------------------------------------

/**
 * One episode-sized unit emitted by SourceAdapter.pull().
 *
 * Invariants that every adapter MUST uphold before constructing a record (D-58/D-59/D-63):
 *  1. content is already redacted — redactSecrets applied, T-06-05.
 *  2. content is already chunked to ≤ config.maxContentBytes.
 *  3. content is already prefixed with an inline provenance header, e.g.
 *        "From: alice@acme.com · Re: pricing\n\n<body>"
 *        "[Granola 2026-06-01] Max: <speaker turn>"
 *     so the existing LLM extractor sees provenance with zero new extract plumbing.
 *  4. source matches the adapter's `source` identifier string.
 *  5. external_id is stable across re-runs; combined with source as the dedup key (D-59).
 *
 * Salience is NOT included (D-60): AllocationGate.score(content, role, source)
 * applies the per-source weight at append time. Adapters carry no salience hint.
 */
export interface NormalizedRecord {
  /**
   * Redacted, chunked, provenance-header-prefixed episode text (D-58/D-63).
   * Must satisfy: Buffer.byteLength(content, 'utf8') ≤ config.maxContentBytes.
   */
  content: string;

  /**
   * Adapter identifier — e.g. 'gmail' | 'granola' | 'obsidian' | 'claude-code'.
   * Must match one of the enabledSources config entries and the adapter's `source` field.
   */
  source: string;

  /**
   * Stable dedup key for this record within the source (D-59).
   * Format examples:
   *   Gmail:      '<rfc2822-message-id>'
   *   Granola:    '<filename>#<turn-idx>'
   *   Obsidian:   '<vault-relative-path>#<section-slug>'
   * Combined with source in UNIQUE(source, external_id) for idempotent dedup.
   */
  external_id: string;

  /**
   * Immutable provenance tag (D-61).
   * 'asserted_by_user' — the founder's own vault (Obsidian). The founder's second brain,
   *   like MEMORY.md / CLAUDE.md. Earns higher initial confidence (c≈0.8).
   * 'observed'         — ALL communication channels (gmail, granola) and tool output,
   *   including the founder's own sent mail / spoken turns. Must earn confidence through
   *   consolidation. NEVER tag third-party content as 'asserted_by_user' — mis-tagging
   *   lets external claims masquerade as the founder's assertions (LEARN-03 guard).
   */
  origin: Origin;

  /**
   * Conversation role (D-10). For communication sources use 'user'; for tool output 'tool'.
   * Role drives the role-weight component of AllocationGate composite salience.
   */
  role: EpisodeRole;
}

// ---------------------------------------------------------------------------
// SourceAdapter interface — the SEAM-01 contract (D-55)
// ---------------------------------------------------------------------------

/**
 * Pluggable source ingestion seam.
 *
 * Each concrete adapter (Gmail, transcript folder, Obsidian vault) implements this
 * interface. The orchestrator calls pull() once per ingest cycle, feeding each record
 * to EpisodicStore.append() through AllocationGate.score(content, role, source).
 *
 * Construction discipline (D-47 mirror):
 *   No credentials at new time — the constructor must be side-effect-free so tests
 *   that verify seam shape never require API keys or filesystem access. Credentials
 *   are read lazily from process.env inside pull(), never stored on the instance.
 */
export interface SourceAdapter {
  /**
   * Stable adapter identifier — lowercase, kebab-case (e.g. 'gmail', 'obsidian').
   * Must match NormalizedRecord.source and the enabledSources config list.
   * Immutable: set at construction, never changed.
   */
  readonly source: string;

  /**
   * Pull all new records since the last cursor position.
   *
   * Returns NormalizedRecord[] where each record is:
   *  - Already redacted (secrets stripped via redactSecrets, D-63).
   *  - Already chunked to ≤ maxContentBytes (D-58).
   *  - Already prefixed with an inline provenance header (D-59).
   *
   * Async: ALL network / filesystem I/O completes here (async-before-sync pattern).
   * The orchestrator batches results into a synchronous db.transaction — no await
   * may escape into the write path (mirrors async-before-sync established in Phase 2).
   *
   * Isolation: a thrown error from one adapter MUST NOT block other adapters or the
   * sleep-pass consolidation (D-66). Orchestrators catch per-adapter and continue.
   */
  pull(): Promise<NormalizedRecord[]>;
}

// ---------------------------------------------------------------------------
// MockSourceAdapter — deterministic, no network; used by all unit tests
// ---------------------------------------------------------------------------

/**
 * Deterministic mock for unit tests.
 *
 * Takes a scripted NormalizedRecord[] at construction and returns it verbatim from pull().
 * No network, no filesystem, no credentials at new time.
 * Mirrors MockModelProvider / MockClaimExtractor script-queue discipline.
 */
export class MockSourceAdapter implements SourceAdapter {
  readonly source: string;
  private readonly script: NormalizedRecord[];

  /**
   * @param source - The adapter identifier (e.g. 'gmail', 'obsidian').
   * @param script - Fixed records returned by every pull() call (deterministic).
   */
  constructor(source: string, script: NormalizedRecord[]) {
    this.source = source;
    this.script = [...script];
  }

  /** Returns the scripted records; always resolves, never throws. */
  async pull(): Promise<NormalizedRecord[]> {
    return this.script;
  }
}
