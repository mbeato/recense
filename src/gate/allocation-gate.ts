/**
 * AllocationGate — honest lexical salience + hard-keep flag (INGEST-02).
 *
 * Invariants:
 *  - salience is a genuine heuristic value in [0,1] — never pinned to 1.0 (D-03).
 *  - hard_keep is computed independently of salience (D-03).
 *  - hard_keep is ONLY set for user-role messages matching directive or correction
 *    patterns (INGEST-02: imperative SELF-statements are the user's own directives,
 *    not Claude restating them). Tool output is never hard-kept (D-02).
 *  - All regex patterns are compiled once at construction, never per call
 *    (anti-pattern guard: see RESEARCH anti-patterns).
 *  - No LLM, no embedding, no network, no Date.now() (D-01, D-12).
 *
 * Salience formula (Pattern 6, RESEARCH.md):
 *   salience = min(
 *     wRole    * roleWeights[role]  +
 *     wLength  * min(wordCount / lengthNormWords, 1)  +
 *     wDirective  * (matchesDirective ? 1 : 0)  +
 *     wCorrection * (matchesCorrection ? 1 : 0),
 *     1.0
 *   )
 */
import type { EngineConfig } from '../lib/config';
import type { EpisodeRole } from '../lib/types';

export class AllocationGate {
  private readonly compiledDirectives: RegExp[];
  private readonly compiledCorrections: RegExp[];
  private readonly cfg: EngineConfig['salience'];

  constructor(config: EngineConfig) {
    this.cfg = config.salience;

    // Compile regex patterns once — not per call (anti-pattern guard)
    // The stored strings use JS regex syntax (\\b for word boundary).
    // 'i' flag: case-insensitive matching for natural language.
    this.compiledDirectives = config.salience.directivePatterns.map(
      p => new RegExp(p, 'i'),
    );
    this.compiledCorrections = config.salience.correctionPatterns.map(
      p => new RegExp(p, 'i'),
    );
  }

  /**
   * Score a message for salience [0,1] and hard-keep eligibility.
   *
   * @param content - The episode text content.
   * @param role    - Conversation role (user | assistant | tool).
   * @returns       { salience: number; hardKeep: boolean }
   */
  score(content: string, role: EpisodeRole): { salience: number; hardKeep: boolean } {
    const cfg = this.cfg;

    // ── Component scores ──────────────────────────────────────────────────────

    // Role weight: user > assistant > tool (D-02)
    const roleScore = cfg.roleWeights[role];

    // Length signal: fraction of lengthNormWords covered; saturates at 1.0
    const wordCount = content.trim().split(/\s+/).filter(w => w.length > 0).length;
    const lengthScore = Math.min(wordCount / cfg.lengthNormWords, 1.0);

    // Pattern matches (boolean → 0 or 1 weight)
    const matchesDirective = this.compiledDirectives.some(p => p.test(content));
    const matchesCorrection = this.compiledCorrections.some(p => p.test(content));

    // ── Honest composite salience (D-03: never pinned) ────────────────────────
    const salience = Math.min(
      cfg.wRole       * roleScore                          +
      cfg.wLength     * lengthScore                        +
      cfg.wDirective  * (matchesDirective  ? 1.0 : 0.0)   +
      cfg.wCorrection * (matchesCorrection ? 1.0 : 0.0),
      1.0,
    );

    // ── Hard-keep flag: user-role only (D-02, INGEST-02) ────────────────────────
    // Only the user's own imperatives/corrections are force-kept.
    // Assistant restating a directive does not set hard_keep (stops over-firing).
    const hardKeep = role === 'user' && (matchesDirective || matchesCorrection);

    return { salience, hardKeep };
  }
}
