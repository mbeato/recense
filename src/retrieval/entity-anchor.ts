/**
 * entity-anchor.ts — LLM-free indexed prompt-token → entity → facts anchoring (Phase 69, Plan 69-01).
 *
 * RECALL-01's mechanism: a second, indexed candidate channel for ambient recall that reaches
 * facts anchored by a proper noun in the prompt — the audit's "contract with vtx" class (asked
 * twice, whiffed twice, facts present because flat cosine top-k has no name-match signal).
 *
 * Design decisions implemented here (CONTEXT.md D-02/D-03):
 *  D-02  CONSUMES `EntityResolver.generateCandidates` (Phase 64's exported union generator) —
 *        never reimplements candidate generation. This is exactly the reuse contract that
 *        module's own header names for this phase.
 *  D-03  Every exported function takes no LLM-provider dependency anywhere in its signature —
 *        a TYPE-LEVEL guarantee (not discipline) that this module cannot call a model even by
 *        accident, mirroring the D-04 guarantee `entity-resolution.ts` already carries.
 *
 * Read-only contract: this module never calls a node/edge mutation method, never adjusts
 * strength, never marks anything dead, and never opens a transaction. Every DB touch goes
 * through the injected `store`/`resolver`; this file never talks to a database handle directly.
 */
import type { SemanticStore } from '../db/semantic-store';
import type { EntityResolver } from '../consolidation/entity-resolution';
import { normalizeValue } from '../consolidation/normalize';
import { PRED_SET } from '../model/typed-predicates';

// ---------------------------------------------------------------------------
// Module constants (private-magnitude convention per 55-01 — caps, not behavior toggles;
// exported only so tests can assert the literals).
// ---------------------------------------------------------------------------

/** Max distinct anchor tokens (unigrams + bigrams) extracted from one prompt. */
export const MAX_ANCHOR_TOKENS = 12;

/** Max distinct entities a single prompt can anchor to. */
export const MAX_ANCHORED_ENTITIES = 3;

/** Minimum candidate score (max(lex, dense) — dense is always 0 here, see below) to accept an entity anchor. */
export const ANCHOR_LEX_FLOOR = 0.5;

/** Max facts taken per channel (edge, name) per accepted entity. */
export const ANCHOR_FACTS_PER_ENTITY = 3;

/** Max total facts returned across all accepted entities and channels. */
export const MAX_ANCHORED_FACTS = 6;

/** Per-call candidate cap passed to `generateCandidates` (mirrors ENTITY_CANDIDATE_K default). */
export const ANCHOR_CANDIDATE_K = 5;

// ---------------------------------------------------------------------------
// Tokenization: a rarity proxy, not linguistics (eval-tuned in 69-06).
// ---------------------------------------------------------------------------

/**
 * Curated single-purpose stopword list: English function words plus the highest-frequency
 * conversational/coding filler observed in the SEED-005 audit. This is a rarity proxy, not a
 * linguistic model, and is expected to be eval-tuned in 69-06 — it exists only to keep common
 * words from drowning out the one or two distinctive tokens a prompt actually needs anchored.
 */
const STOPWORDS = new Set<string>([
  'about', 'after', 'all', 'also', 'an', 'and', 'any', 'anything', 'are', 'as', 'at',
  'be', 'been', 'being', 'but', 'by',
  'can', 'code', 'could',
  'did', 'do', 'does', 'doing', 'down', 'during',
  'each',
  'file', 'for', 'from',
  'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'herself', 'him', 'himself', 'his', 'how',
  'if', 'in', 'into', 'is', 'it', 'its', 'itself',
  'just',
  'know',
  'me', 'more', 'most', 'my', 'myself',
  'need', 'no', 'nor', 'not',
  'of', 'off', 'on', 'once', 'only', 'or', 'other', 'our', 'ours', 'ourselves', 'out', 'over', 'own',
  'please',
  'remember',
  'same', 'she', 'should', 'so', 'some', 'such',
  'tell', 'test', 'than', 'that', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there',
  'these', 'they', 'thing', 'this', 'those', 'through', 'to', 'too',
  'under', 'until', 'up',
  'very',
  'want', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'will', 'with', 'would',
  'you', 'your', 'yours', 'yourself', 'yourselves',
]);

/**
 * Extract distinctive candidate tokens from a prompt (pure, no DB): runs `normalizeValue` over
 * the prompt, splits on spaces, strips non-alphanumeric edges per token (WR-01: normalizeValue
 * only lowercases/collapses whitespace, so "vtx?" would otherwise miss the exact channel AND
 * score Dice 0 against the stored "vtx" — whiffing whenever the entity name abuts sentence
 * punctuation, i.e. most natural prompts; edge-stripping also lets punctuated stopwords like
 * "the," hit the STOPWORDS check instead of burning a MAX_ANCHOR_TOKENS slot), drops
 * short/numeric/stopword tokens, and emits surviving unigrams in prompt order followed by
 * adjacent-surviving-pair bigrams (so a two-word entity name like "world triathlon" is
 * recoverable even though neither word alone is the anchor).
 *
 * Deliberately NO capitalization heuristic: the audit's sharpest whiff ("...contract i have
 * with vtx") is entirely lowercase, so a capitalization filter would falsify the exact case
 * this module exists to fix.
 */
export function extractAnchorTokens(promptText: string): string[] {
  const normalized = normalizeValue(promptText);
  const rawTokens = normalized.split(' ')
    .map(t => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(t => t.length > 0);
  const survivors = rawTokens.filter(
    t => t.length >= 3 && !/^\d+$/.test(t) && !STOPWORDS.has(t),
  );

  const bigrams: string[] = [];
  for (let i = 0; i < survivors.length - 1; i++) {
    bigrams.push(`${survivors[i]} ${survivors[i + 1]}`);
  }

  const ordered = [...survivors, ...bigrams];
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const t of ordered) {
    if (seen.has(t)) continue;
    seen.add(t);
    deduped.push(t);
  }
  return deduped.slice(0, MAX_ANCHOR_TOKENS);
}

// ---------------------------------------------------------------------------
// Anchored facts: indexed reads only.
// ---------------------------------------------------------------------------

/** One fact reached through entity anchoring, with attribution for which channel found it. */
export interface AnchoredFact {
  id: string;
  value: string;
  entityId: string;
  entityValue: string;
  via: 'edge' | 'name-fts';
}

/**
 * Resolve a prompt's distinctive tokens to live entity nodes and union in their facts through
 * two FTS-indexed channels — read-only, no LLM call, no full-table scan of any kind.
 *
 * 1. Tokenize the prompt (`extractAnchorTokens`).
 * 2. For each token, call `resolver.generateCandidates({ text: token, nodeType: 'entity' })`
 *    with NO embedding argument (T-69-01-DOS) AND `skipExactChannel: true` (WR-03): the dense
 *    channel is an O(N) full-table scan and decode over the whole node table, and the exact
 *    channel's `resolveEntityByName` statements are ALSO unindexed node-table scans (no
 *    expression index on `LOWER(value)`) — either would blow the hook latency budget. Only the
 *    BM25 (FTS-indexed) channel runs here; the Dice re-score carries exact names over the
 *    floor without the scan. Accept the top-scoring candidate iff its score clears
 *    ANCHOR_LEX_FLOOR, dedupe entity ids across tokens, stop after MAX_ANCHORED_ENTITIES.
 * 3. Per accepted entity, EDGE channel: read the entity's edges, keep the real semantic
 *    association edges (`kind === 'relation' && PRED_SET.has(rel)`, the same filter
 *    `buildHonestOneHopTrace` uses), sort by weight desc / neighbour-id-asc tiebreak, and take
 *    live (non-tombstoned), NON-ENTITY neighbours up to ANCHOR_FACTS_PER_ENTITY (WR-02:
 *    entity→entity relation edges exist; a neighbouring entity's value is just a name — the
 *    wasted token this module's contract rules out). Liveness and the entity skip are checked
 *    BEFORE a slot is consumed, mirroring the honest-trace discipline.
 * 4. Per accepted entity, NAME channel: call `generateCandidates({ text: entityValue,
 *    nodeType: 'fact' })` — again no embedding argument, again `skipExactChannel` — to reach facts that MENTION the entity
 *    without carrying an edge to it (the audit's contract facts). Keep positive-score
 *    candidates, skip ids already taken, skip tombstoned, take up to ANCHOR_FACTS_PER_ENTITY by
 *    score desc / id-asc tiebreak.
 * 5. Concatenate in (entity order, edge-before-name), dedupe by fact id keeping the first
 *    occurrence, cap at MAX_ANCHORED_FACTS.
 *
 * Never returns the entity nodes themselves — an entity node's value is just a name, a wasted
 * injected token; only the facts it anchors are returned.
 */
export function collectAnchoredFacts(
  store: SemanticStore,
  resolver: EntityResolver,
  promptText: string,
): AnchoredFact[] {
  const tokens = extractAnchorTokens(promptText);

  const acceptedEntities: Array<{ id: string; value: string }> = [];
  const seenEntityIds = new Set<string>();

  for (const token of tokens) {
    if (acceptedEntities.length >= MAX_ANCHORED_ENTITIES) break;

    const { candidates } = resolver.generateCandidates({
      text: token,
      nodeType: 'entity',
      k: ANCHOR_CANDIDATE_K,
      skipExactChannel: true, // WR-03: no unindexed node-table scans on the hook hot path
    });
    if (candidates.length === 0) continue;

    let best = candidates[0]!;
    for (const c of candidates) {
      if (c.score > best.score) best = c;
    }
    if (best.score < ANCHOR_LEX_FLOOR) continue;
    if (seenEntityIds.has(best.id)) continue;

    seenEntityIds.add(best.id);
    acceptedEntities.push({ id: best.id, value: best.value });
  }

  const facts: AnchoredFact[] = [];
  const seenFactIds = new Set<string>();

  for (const entity of acceptedEntities) {
    // Edge channel: real semantic association edges only (LANDMINE-2 filter, honest-trace parity).
    const semanticEdges = store
      .getEdgesForNode(entity.id)
      .filter(e => e.kind === 'relation' && PRED_SET.has(e.rel));
    const neighbours = semanticEdges
      .map(e => ({ neighbourId: e.src === entity.id ? e.dst : e.src, w: e.w }))
      .sort((a, b) => b.w - a.w || (a.neighbourId < b.neighbourId ? -1 : a.neighbourId > b.neighbourId ? 1 : 0));

    let edgeTaken = 0;
    for (const { neighbourId } of neighbours) {
      if (edgeTaken >= ANCHOR_FACTS_PER_ENTITY) break;
      if (seenFactIds.has(neighbourId)) continue;
      const node = store.getNode(neighbourId);
      if (!node || node.tombstoned === 1) continue; // liveness before the slot
      // WR-02: entity→entity relation edges exist (built_by, works_at, ...) — a neighbouring
      // ENTITY node's value is just a name, exactly the wasted injected token this module's
      // own contract rules out ("never returns the entity nodes themselves", above). Skip it
      // BEFORE the slot is consumed so a real fact behind it can still take the slot.
      if (node.type === 'entity') continue;
      seenFactIds.add(neighbourId);
      facts.push({ id: neighbourId, value: node.value, entityId: entity.id, entityValue: entity.value, via: 'edge' });
      edgeTaken++;
    }

    // Name channel: facts that mention the entity by name without carrying an edge to it.
    const { candidates: nameCandidates } = resolver.generateCandidates({
      text: entity.value,
      nodeType: 'fact',
      k: ANCHOR_CANDIDATE_K,
      skipExactChannel: true, // WR-03: no unindexed node-table scans on the hook hot path
    });
    const rankedNameCandidates = nameCandidates
      .filter(c => c.score > 0)
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    let nameTaken = 0;
    for (const c of rankedNameCandidates) {
      if (nameTaken >= ANCHOR_FACTS_PER_ENTITY) break;
      if (seenFactIds.has(c.id)) continue;
      const node = store.getNode(c.id);
      if (!node || node.tombstoned === 1) continue; // liveness before the slot
      seenFactIds.add(c.id);
      facts.push({ id: c.id, value: node.value, entityId: entity.id, entityValue: entity.value, via: 'name-fts' });
      nameTaken++;
    }
  }

  return facts.slice(0, MAX_ANCHORED_FACTS);
}
