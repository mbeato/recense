/**
 * ambient-recall — per-prompt LLM-free recall core for the UserPromptSubmit hook
 * (quick-260612-rt1).
 *
 * Extracted as an importable module (mirrors the `provider?: ModelProvider` injection
 * seam in wireMemoryEngine) so tests inject MockModelProvider in-process instead of
 * stubbing the embedder inside a spawned CLI.
 *
 * LLM-free by construction on the recall side: ONE embedding call (the only network
 * I/O), then RetrievalEngine.retrieveRanked — no generation, no judge.
 *
 * Threat mitigations:
 *  - T-RT1-01: prompt bounded to MAX_QUERY_CHARS before embedding; never interpolated
 *    into SQL (prepared statements throughout the engine).
 *  - T-RT1-03: EMBED_TIMEOUT_MS Promise.race with an unref'd timer — the hook process
 *    must exit promptly (harness kills at 5s; never get close). A timeout rejects and
 *    the caller's catch handles it (fail-open: '{}', exit 0).
 *  - T-RT1-05: recall path is read-only (retrieveRanked); the only write is the capped
 *    activation_trace ring via the flag-gated sink (documented exception, same as
 *    memory-ops search).
 *  - T-RT1-06 (Phase 69, T-69-03-DOS/T-69-03-WRITE): entity anchoring is read-only
 *    (EntityResolver/collectAnchoredFacts touch no mutation method), FTS-indexed-lookup-only
 *    (no dense scan — no vec is ever passed — and no exact-channel scan: `skipExactChannel`
 *    disables resolveEntityByName's unindexed node-table statements on this path, WR-03;
 *    see entity-anchor.ts), provider-free (constructor
 *    never accepts a ModelProvider — zero net-new LLM/network calls), fail-open (any
 *    throw during resolution/collection is swallowed and the path continues cosine-only),
 *    and bounded by the anchor module's own caps (MAX_ANCHORED_ENTITIES, MAX_ANCHORED_FACTS).
 */
import Database from 'better-sqlite3';
import type { Clock } from '../lib/clock';
import { realClock } from '../lib/clock';
import type { EngineConfig } from '../lib/config';
import type { ModelProvider } from '../model/provider';
import { SemanticStore } from '../db/semantic-store';
import { CandidateRetriever, vectorIndexPath } from '../retrieval/topk';
import { StrengthDecayManager } from '../strength/decay';
import { AllocationGate } from '../gate/allocation-gate';
import { RetrievalEngine } from '../retrieval/engine';
import { SwitchableActivationTraceSink } from '../viz/activation-sink';
import { cwdToScope, GLOBAL_SCOPE } from '../lib/scope';
import { collectAnchoredFacts, type AnchoredFact } from '../retrieval/entity-anchor';
import { EntityResolver } from '../consolidation/entity-resolution';
import type { NodeType } from '../lib/types';

// ---------------------------------------------------------------------------
// Tuning knobs — adjust here, not inline.
// ---------------------------------------------------------------------------

/** Max facts surfaced per prompt (breadth of the ambient block). */
export const AMBIENT_K = 5;

/**
 * Minimum cosine for a fact to surface ambiently. Deliberately ABOVE the
 * memory_search floor (0.3): ambient injection is unsolicited, so precision
 * beats recall here.
 *
 * Tuned 0.5 → 0.45 against live-graph probes (2026-06-13): memory-shaped
 * questions top out ~0.45–0.65 while generic coding prompts sit ≤0.43, so 0.5
 * silently rejected everything. Re-probe after the episode backlog consolidates
 * — richer fact nodes should widen the gap and may support a higher floor.
 */
export const AMBIENT_FLOOR = 0.45;

/**
 * Phase-19 viz lighting floor — well BELOW the injection floor. The brain lights
 * the nodes a turn genuinely retrieved down to this cosine, even when none cleared
 * AMBIENT_FLOOR (a real read that surfaced nothing still accessed real nodes). This
 * affects ONLY the activation trace, never what is injected. Aligned roughly with the
 * memory_search floor (0.3) but a touch lower so ordinary turns still light something;
 * raise it if the brain lights essentially-unrelated nodes, lower it for more activity.
 */
export const AMBIENT_VIZ_FLOOR = 0.25;

/** Per-line value cap — keeps the injected block token-lean. */
export const MAX_VALUE_CHARS = 200;

/**
 * Bound the prompt before embedding (same rationale as memory-ops MAX_QUERY_CHARS:
 * UTF-16 code units, not bytes — the looser bound is accepted).
 */
export const MAX_QUERY_CHARS = 4_000;

/** Embed-call timeout — well under the harness's 5s hook kill. */
export const EMBED_TIMEOUT_MS = 2_500;

/**
 * Max injected slots a floor-exempt anchored fact may occupy, out of AMBIENT_K (Phase 69
 * RECALL-01, T-69-03-PRECISION, 55-01-style magnitude constant). Caps how many facts that
 * only cleared the anchor module's lexical bar — not the cosine floor — can be FORCED into
 * the block; it never caps anchored facts that also earn a spot on cosine merit. Without
 * this cap, a prompt anchoring several low-relevance entities could crowd out the whole
 * block with unsolicited lines (F5's precision argument — ambient injection is unsolicited,
 * so precision beats recall here, same rationale as AMBIENT_FLOOR above).
 */
const ANCHOR_RESERVED_SLOTS = 2;

/** Reuse the existing prompt-embedding bound for anchor tokenization (55-01 convention: no second magnitude for the same "how much of the prompt do we look at" question). */
const MAX_ANCHOR_PROBE_CHARS = MAX_QUERY_CHARS;

/**
 * The seed's stated ambient token budget (~5 lines x 200 chars, SEED-005 "Eval-first
 * requirement"), re-expressed as an enforced constant rather than an assumption (Phase 69
 * RECALL-03, D-06/D-09). Measured over the block EXCLUDING the `Recalled from recense
 * (ambient):` header. This is the exact quantity 69-06's eval gate asserts — re-budgeting
 * here is a deliberate decision, not drift.
 *
 * Budget accounting counts the DATA-DRIVEN portion of each line only — the scope marker
 * plus the fact value/doc title, or a hop's neighbour label — the parts whose length is
 * driven by graph content and could otherwise be unbounded. The small, constant per-line
 * decoration (the `- `/`  ↳ ` bullet, the `(origin, score X.XX)` parenthetical) is fixed
 * format overhead, not counted against the budget, mirroring MAX_VALUE_CHARS's own framing
 * (cap the data-controlled part, not the format).
 *
 * WR-04 hard guarantee: each fact line's counted content (scope marker + value/title) is
 * capped at MAX_VALUE_CHARS — the marker counts INSIDE the per-line cap, never on top of it
 * — so AMBIENT_K fact lines can total at most AMBIENT_K × MAX_VALUE_CHARS = this budget, and
 * hops only append while the running total stays under it. The renderer's counted content
 * therefore NEVER exceeds this constant, which is exactly the invariant the 69-06 eval
 * gate's G4 check asserts (guard-set and ship-set agree on the same named quantity).
 */
export const AMBIENT_BLOCK_CHAR_BUDGET = AMBIENT_K * MAX_VALUE_CHARS;

/**
 * Reject after `ms`. The timer is unref'd so a resolved race never holds the
 * process open — the hook must exit promptly (T-RT1-03).
 */
function rejectAfter(ms: number): Promise<never> {
  return new Promise((_resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`embed timed out after ${ms}ms`)), ms);
    t.unref();
  });
}

/** One row of pre-resolved data the renderer turns into a line (+ optional hop lines). */
export interface RenderRow {
  id: string;
  value: string;
  score: number;
  origin: string;
  type: NodeType;
  scope?: string;
  docSlug?: string;
  anchoredVia?: string;
  hops?: Array<{ rel: string; label: string }>;
}

/**
 * Pure, budget-enforcing renderer for the injected ambient block (Phase 69 RECALL-02/03,
 * D-06/D-09). Every DB-derived field arrives pre-resolved on `rows` — this function touches
 * no store/db/clock collaborator, so it is trivially testable and side-effect-free.
 *
 * Budget enforcement, in this exact order:
 *   1. The header is emitted but not counted against the budget.
 *   2. One fact line per row (up to AMBIENT_K) is ALWAYS emitted — D-06: facts win, hops are
 *      enrichment, never a replacement. WR-04: each fact line's counted content (scope marker
 *      + value/title) is capped at MAX_VALUE_CHARS, so this facts-always-render floor is
 *      budget-safe by construction — AMBIENT_K capped lines total at most
 *      AMBIENT_BLOCK_CHAR_BUDGET exactly, never past it.
 *      Facts are accounted for FIRST, as a group — so a budget that is already fully spent by
 *      facts alone leaves genuinely zero room for any hop (D-06's "when the budget binds,
 *      hops are dropped" is evaluated against the REAL post-facts total, not a hop's lucky
 *      position ahead of a later maximal-length fact).
 *   3. Hop lines are appended beneath their own fact, in supplied order, only while there is
 *      still room in the (post-facts) budget; the first hop that would breach stops ALL
 *      further hop appending (never "skip and keep trying" — that would reorder enrichment
 *      nondeterministically across facts).
 */
/**
 * Collapse newline runs (plus surrounding indentation) to a single space (2026-08-07
 * cross-review CR-01). The block's grammar is one `- `/`  ↳ ` line per row/hop — a
 * multi-line node value (159/159 live embedded doc bodies, plus 17 fact nodes) must
 * never shatter a line into several. This is a rendering INVARIANT, independent of the
 * doc-link knob: it applies to the raw-value fact branch and hop labels alike, and it
 * makes deriveDocTitle's own first-line extraction a strict refinement rather than the
 * only newline-safe path.
 */
const flatten = (s: string): string => s.replace(/\s*\n+\s*/g, ' ');

export function renderAmbientBlock(rows: RenderRow[], opts?: { docLinks?: boolean }): string {
  const docLinks = opts?.docLinks ?? false;
  const selected = rows.slice(0, AMBIENT_K);

  // Pass 1 (facts win, D-06): build every fact line and sum their budget-relevant content
  // length BEFORE any hop is considered, so the hop pass starts from the REAL post-facts
  // total rather than an artificially low running count from processing rows one at a time.
  const factEntries = selected.map(row => {
    const marker = row.scope && row.scope !== GLOBAL_SCOPE ? `[${row.scope}] ` : '';
    const anchoredSuffix = row.anchoredVia ? `, via ${row.anchoredVia}` : '';
    // WR-04: the marker counts INSIDE the MAX_VALUE_CHARS per-line cap (marker + value/title
    // <= MAX_VALUE_CHARS), so the always-rendered fact lines can never total past
    // AMBIENT_BLOCK_CHAR_BUDGET — the hard guarantee G4 asserts.
    const valueCap = Math.max(0, MAX_VALUE_CHARS - marker.length);
    let factLine: string;
    let contentLen: number;
    if (docLinks && row.type === 'doc') {
      const title = deriveDocTitle(row).slice(0, valueCap);
      factLine = `- ${marker}${title} — recense://doc/${row.id} (doc, score ${row.score.toFixed(2)}${anchoredSuffix})`;
      contentLen = marker.length + title.length;
    } else {
      const value = flatten(row.value).slice(0, valueCap);
      factLine = `- ${marker}${value} (${row.origin}, score ${row.score.toFixed(2)}${anchoredSuffix})`;
      contentLen = marker.length + value.length;
    }
    return { row, factLine, contentLen };
  });
  let runningChars = factEntries.reduce((sum, e) => sum + e.contentLen, 0);

  // Pass 2: attach hop lines beneath their own fact, gated on the post-facts running total.
  const outLines: string[] = [];
  let hopsExhausted = false;
  for (const { row, factLine } of factEntries) {
    outLines.push(factLine);
    if (hopsExhausted) continue;
    for (const hop of (row.hops ?? []).slice(0, MAX_HOP_LINES_PER_FACT)) {
      const label = flatten(hop.label).slice(0, HOP_LABEL_CHARS);
      if (runningChars + label.length > AMBIENT_BLOCK_CHAR_BUDGET) {
        hopsExhausted = true;
        break;
      }
      // No score is printed — hop scores are always null by construction (WR-02); printing
      // a number here would fabricate a magnitude.
      outLines.push(`  ↳ ${hop.rel} ${label}`);
      runningChars += label.length;
    }
  }

  return ['Recalled from recense (ambient):', ...outLines].join('\n');
}

/**
 * Max short title cap for a doc-type row's rendered title (Phase 69 RECALL-02, T-69-04-BUDGET,
 * 55-01-style magnitude — not a config knob).
 */
const DOC_TITLE_CHARS = 80;

/**
 * Max rendered hop lines per fact (Phase 69 RECALL-03, D-06, 55-01-style magnitude — not a
 * config knob; tuned only against the eval gate's budget arithmetic).
 */
const MAX_HOP_LINES_PER_FACT = 2;

/** Per-hop neighbour-label cap (Phase 69 RECALL-03, magnitude — not a config knob). */
const HOP_LABEL_CHARS = 60;

/**
 * Derive a doc row's title purely from its value: the first non-empty line, stripped of a
 * leading markdown heading run and collapsed whitespace, capped at DOC_TITLE_CHARS. Never
 * fabricates a title; an empty value falls back to the doc's slug, then its raw id (Phase 69
 * RECALL-02, F4: MAX_VALUE_CHARS truncation of a hub doc body yields no actionable text, so a
 * title + citation is strictly cheaper and strictly more useful).
 */
function deriveDocTitle(row: RenderRow): string {
  const firstLine = row.value.split('\n').find(l => l.trim().length > 0) ?? '';
  const stripped = firstLine.replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim();
  const title = stripped || row.docSlug || row.id;
  return title.slice(0, DOC_TITLE_CHARS);
}

/**
 * Embed the prompt, run ranked retrieval (k=AMBIENT_K, floor=AMBIENT_FLOOR) against
 * the SHARED db handle, and format a token-lean injection block.
 *
 * Returns '' when nothing clears the floor (caller emits '{}').
 * The caller MUST have run initSchema on `db` already (the sink prepares a statement
 * against `meta`).
 *
 * `cwd` (Phase 69 RECALL-02, D-01): the hook's working directory, threaded in from
 * turn-capture-cli so this path can know "same project" for the first time (mirrors the
 * `retrieveCueless(cwd)` soft-scoping precedent at session-start-cli.ts:134-136). Defaults
 * to '' so every pre-phase 5-arg call site/test compiles and behaves unchanged: an empty
 * cwd derives GLOBAL_SCOPE via `cwdToScope`, which disables the ordering nudge entirely
 * (D-01 — a conservative default for an unknown origin).
 */
export async function ambientRecall(
  db: Database.Database,
  promptText: string,
  provider: ModelProvider,
  config: EngineConfig,
  clock: Clock = realClock,
  cwd: string = '',
): Promise<string> {
  // Collaborators on the SHARED handle — single process, single DB open.
  const store = new SemanticStore(db, clock, config);
  // Phase 41 (PERF-01/D-06): cue-less ambient path reads the persisted exact index (built
  // end-of-sleep-pass) so the per-prompt recall skips re-marshaling ~10k embedding rows;
  // brute-force fallback when the artifact is absent. config.dbPath is the same DB this handle
  // was opened against (turn-capture-cli passes { ...DEFAULT_CONFIG, dbPath }).
  const retriever = new CandidateRetriever(db, { indexPath: vectorIndexPath(config.dbPath) });
  const strength = new StrengthDecayManager(db, clock, config);
  const gate = new AllocationGate(config);

  // Phase 69 RECALL-02 (D-01): derive the caller's project scope from cwd (same
  // `cwdToScope` primitive session-start-cli's `retrieveCueless(cwd)` already uses for
  // soft project scoping). currentScope === GLOBAL_SCOPE (unknown/personal/home-dir
  // origin) disables the ordering nudge below entirely.
  const currentScope = cwdToScope(cwd);

  // This is the UserPromptSubmit hook, NOT SessionStart — D-97 (SessionStart stays
  // Noop/cueless/LLM-free) is untouched; session-start-cli does not import this module.
  // Constructed after initSchema (the sink prepares a stmt against `meta`). The ctor
  // refreshes once; the explicit refresh() documents the read-the-flag-now intent.
  const traceSink = new SwitchableActivationTraceSink(db, clock);
  traceSink.refresh();

  // ONE embedding call with an internal timeout (T-RT1-03). A timeout rejects and
  // the caller's catch handles it (fail-open).
  const [vec] = await Promise.race([
    provider.embed([promptText.slice(0, MAX_QUERY_CHARS)]),
    rejectAfter(EMBED_TIMEOUT_MS),
  ]);
  if (!vec) return '';

  // ── Entity anchoring (Phase 69 RECALL-01, D-02/D-03) ─────────────────────────────
  // Gated on config.entityAnchoringEnabled (dark default false — D-09 byte-identity:
  // `anchored` stays [], `anchoredIds` becomes an empty array, and retrieveRanked's own
  // opts.anchoredIds no-op guard leaves its output untouched). The whole block is
  // wrapped in try/catch: on ANY throw during resolution or collection, `anchored`
  // resets to [] and the path continues cosine-only — a slow/broken anchor module must
  // never fail the hook (fail-open, mirrors this file's T-RT1-03 posture; see T-RT1-06
  // above). Retained keyed by id (not just ids) so 69-04's renderer can read
  // `entityValue`/`via` for the provenance marker without a second collection pass.
  let anchored: AnchoredFact[] = [];
  if (config.entityAnchoringEnabled) {
    try {
      const resolver = new EntityResolver(db, store, config);
      anchored = collectAnchoredFacts(store, resolver, promptText.slice(0, MAX_ANCHOR_PROBE_CHARS));
    } catch {
      anchored = [];
    }
  }
  const anchoredById = new Map<string, AnchoredFact>(anchored.map(a => [a.id, a]));

  // ── 1-hop hand-off (Phase 69 RECALL-03, D-06) ────────────────────────────────────
  // Gated on config.ambientHopInjectionEnabled (dark default false — D-09: no hopCollector
  // means retrieveRanked's own `opts?.hopCollector != null` guard is never touched, so the
  // trace-emission branch's behavior is unchanged and this array simply stays empty).
  let collectedHops: Array<{ node_id: string; src: string; rel: string; score: null; hop: 1 }> = [];

  // retrieveRanked emits the viz trace itself when the flag is on. With vizFloor it
  // lights the genuinely-retrieved nodes down to AMBIENT_VIZ_FLOOR even when nothing
  // clears the injection floor — so the brain lights on essentially every prompt (a
  // real read happened), while injection still uses AMBIENT_FLOOR. Do NOT add a second
  // emit here.
  const engine = new RetrievalEngine(db, clock, config, retriever, store, strength, gate, traceSink);
  const results = engine.retrieveRanked(vec, AMBIENT_K, AMBIENT_FLOOR, undefined, {
    spreadHops: config.spreadHops,
    vizFloor: AMBIENT_VIZ_FLOOR,
    anchoredIds: anchored.map(a => a.id),
    ...(config.ambientHopInjectionEnabled
      ? { hopCollector: (hops: typeof collectedHops) => { collectedHops = hops; } }
      : {}),
  });
  if (results.length === 0) return '';

  // D-S6 provenance surfacing: ONE batch scope read over ALL rows retrieveRanked returned,
  // BEFORE any slicing/selection — this single read serves both the pre-existing `[slug]`
  // display marker AND (Phase 69 D-01) the ordering-only same-project rank nudge below. For
  // every OTHER caller (`RecallEngine.recall --scope`, corpus, viz) the underlying store
  // method remains display-only and never influences selection/order (D-S1); on THIS path
  // only, Phase 69 D-01 partially reverses that for ordering (never existence) — see the
  // bounded carve-out recorded at the store method's own doc comment.
  // 2026-08-07 cross-review WR-03: the batch is widened to include collected hop target
  // ids (still ONE query) so the hop-attribution pass below can apply the same scope
  // discipline to hop neighbours that the rank nudge/demotion applies to fact lines.
  const scopes = store.getNodeScopes([
    ...results.map(r => r.id),
    ...collectedHops.map(h => h.node_id),
  ]);

  // One indexed getNode per distinct id, cached — shared by the foreign-doc check below
  // and the origin lookup in the render loop, so no id is read from the node table twice.
  const nodeCache = new Map<string, ReturnType<typeof store.getNode>>();
  const getCachedNode = (id: string): ReturnType<typeof store.getNode> => {
    if (!nodeCache.has(id)) nodeCache.set(id, store.getNode(id));
    return nodeCache.get(id) ?? null;
  };

  // ── Ordering-only scope nudge + reserved-slot selection (Phase 69 RECALL-02, D-01) ──
  // (a) ORDERING-ONLY: `rankScore` never touches `r.score` — `r.score` (the true cosine)
  //     is exactly what gets rendered below; rankScore exists purely as a sort key.
  // (b) NEVER A FILTER (D-01: nudge, never filter): every row in `results` remains a
  //     selection candidate regardless of rankScore — the nudge can move a row's
  //     position but can never remove it (T-69-03-FILTER).
  // (c) `currentScope === GLOBAL_SCOPE` (unknown/personal cwd) disables BOTH the
  //     same-project boost AND the foreign-doc demotion (2026-08-07 cross-review WR-02:
  //     "foreign" is a relation TO the caller, so with an unknown caller it is a guess,
  //     not a definition — an unknown origin must be neutral, symmetric with the nudge
  //     guard). This also aligns live behavior with the arm the 69-06 gate actually
  //     measured: the gate always synthesized a known project cwd, so the
  //     unknown-caller demotion branch had zero eval coverage while firing on ~45% of
  //     real live turns.
  // (d) Both magnitudes are eval-tuned in 69-06 and ship at 0 (D-09): with both weights
  //     0, `rankScore(r) === r.score` for every row, so the stable sort below reduces to
  //     "resort by the same score, tie-broken by original index" — byte-identical to
  //     `results`' own order.
  const isForeignDoc = (id: string): boolean => {
    const node = getCachedNode(id);
    if (!node || node.type !== 'doc') return false;
    const scope = scopes.get(id) ?? GLOBAL_SCOPE;
    return scope !== currentScope && scope !== GLOBAL_SCOPE;
  };
  const rankScore = (r: { id: string; score: number }): number => {
    const scope = scopes.get(r.id) ?? GLOBAL_SCOPE;
    const sameProjectBoost =
      currentScope !== GLOBAL_SCOPE && scope === currentScope ? config.sameProjectRankNudge : 0;
    const foreignDemotion =
      currentScope !== GLOBAL_SCOPE && isForeignDoc(r.id) ? config.foreignDocDemotion : 0;
    return r.score + sameProjectBoost - foreignDemotion;
  };
  const ranked = results
    .map((r, i) => ({ r, i, rank: rankScore(r) }))
    .sort((a, b) => b.rank - a.rank || a.i - b.i)
    .map(x => x.r);

  // Reserved-slot selection (T-69-03-PRECISION): at most ANCHOR_RESERVED_SLOTS of the
  // AMBIENT_K slots may be FORCED in purely because a fact is anchored — an anchored
  // fact that also earns a spot in the general rank order competes there like any other
  // row and never counts against this budget.
  const resultIds = new Set(results.map(r => r.id));
  const anchoredPresentCount = anchored.reduce((n, a) => n + (resultIds.has(a.id) ? 1 : 0), 0);
  const reserved = Math.min(ANCHOR_RESERVED_SLOTS, anchoredPresentCount);
  const nonReservedSlots = AMBIENT_K - reserved;

  // 2026-08-07 cross-review WR-04: the cap must hold even when cosine candidates are
  // scarce. A floor-exempt anchored row (in `ranked` only because it was anchored, cosine
  // below AMBIENT_FLOOR) may enter ONLY through the reserved pass, and the reserved pass
  // counts its own additions — otherwise fewer than `nonReservedSlots` genuine cosine hits
  // let anchored rows leak into general slots (pass 1) or the backfill (pass 3), shipping
  // more than ANCHOR_RESERVED_SLOTS unsolicited lines. Rendering fewer than AMBIENT_K
  // lines in that scarce case is the docstring's stated intent ("never crowd out the
  // block"), not a shortfall.
  const isFloorExempt = (r: { id: string; score: number }): boolean =>
    anchoredById.has(r.id) && r.score < AMBIENT_FLOOR;
  const selectedIds = new Set<string>();
  for (const r of ranked) {
    if (selectedIds.size >= nonReservedSlots) break;
    if (isFloorExempt(r)) continue; // floor-exempt rows use reserved slots only
    selectedIds.add(r.id);
  }
  let forcedAnchored = 0;
  for (const r of ranked) {
    if (selectedIds.size >= AMBIENT_K || forcedAnchored >= reserved) break;
    if (!anchoredById.has(r.id) || selectedIds.has(r.id)) continue;
    selectedIds.add(r.id);
    forcedAnchored++;
  }
  for (const r of ranked) {
    if (selectedIds.size >= AMBIENT_K) break;
    if (selectedIds.has(r.id) || isFloorExempt(r)) continue;
    selectedIds.add(r.id);
  }
  // Emit the selected rows in rank order (not selection-pass order).
  const surfaced = ranked.filter(r => selectedIds.has(r.id));

  // ── Hop attribution (Phase 69 RECALL-03, D-06) ───────────────────────────────────
  // Group the collector's hops by their real `src` seed, keep only hops whose src is a
  // SELECTED row (never an arbitrary or first seed), resolve each hop's neighbour label via
  // the SAME node-row cache the render loop uses (one getNode per distinct hop target),
  // drop hops whose neighbour is missing or tombstoned, and cap at MAX_HOP_LINES_PER_FACT
  // per fact preserving the collector's own order (already weight-desc from
  // buildHonestOneHopTrace). No score is attached — hop scores are always null (WR-02).
  // 2026-08-07 cross-review WR-03: hop neighbours obey the block's existing disciplines
  // before consuming a slot — (1) never duplicate an already-selected fact line (both can
  // be top-k cosine hits for the same query), and (2) never inject a neighbour whose scope
  // is foreign to a KNOWN caller scope (neutral when the caller scope is global, consistent
  // with WR-02's symmetry rule — the same knobs shipped to bias the block toward the
  // caller's project must not be bypassed by a hop line). Hop lines are enrichment by D-06,
  // so dropping one is always safe.
  const hopsBySrc = new Map<string, Array<{ rel: string; label: string }>>();
  if (config.ambientHopInjectionEnabled) {
    for (const hop of collectedHops) {
      if (!selectedIds.has(hop.src)) continue;
      if (selectedIds.has(hop.node_id)) continue; // WR-03: never duplicate a fact line
      const nScope = scopes.get(hop.node_id) ?? GLOBAL_SCOPE;
      if (currentScope !== GLOBAL_SCOPE && nScope !== GLOBAL_SCOPE && nScope !== currentScope) {
        continue; // WR-03: foreign-scope neighbour dropped for a known-scope caller
      }
      const list = hopsBySrc.get(hop.src) ?? [];
      if (list.length >= MAX_HOP_LINES_PER_FACT) continue;
      const neighbour = getCachedNode(hop.node_id);
      if (!neighbour || neighbour.tombstoned === 1) continue; // dropped, never a placeholder
      list.push({ rel: hop.rel, label: neighbour.value.slice(0, HOP_LABEL_CHARS) });
      hopsBySrc.set(hop.src, list);
    }
  }

  const rows: RenderRow[] = surfaced.map(r => {
    const node = getCachedNode(r.id);
    return {
      id: r.id,
      value: r.value,
      score: r.score,
      origin: node?.origin ?? 'observed',
      type: node?.type ?? 'fact',
      scope: scopes.get(r.id),
      // getNodeDoc read ONLY for doc rows under the doc-link knob (at most one sidecar read
      // per doc row; zero on the common all-facts prompt).
      docSlug:
        config.ambientDocLinkRenderEnabled && node?.type === 'doc'
          ? store.getNodeDoc(r.id)?.slug
          : undefined,
      // Phase 69 anchored-fact provenance (D-06/69-03): visibly attribute a floor-exempt
      // injected line to the entity that anchored it.
      anchoredVia: anchoredById.get(r.id)?.entityValue,
      hops: hopsBySrc.get(r.id),
    };
  });

  return renderAmbientBlock(rows, { docLinks: config.ambientDocLinkRenderEnabled });
}

/**
 * Pure payload builder for the UserPromptSubmit hook output. Shape verified against
 * the session-start-cli emitContext form (the SessionStart analog) and the Claude
 * Code hooks contract for UserPromptSubmit. Single JSON.stringify — no partial-JSON
 * path (T-RT1-04).
 */
export function buildHookOutput(text: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: text,
    },
  });
}
