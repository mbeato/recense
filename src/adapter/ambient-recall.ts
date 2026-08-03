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
 *    (EntityResolver/collectAnchoredFacts touch no mutation method), indexed-lookup-only
 *    (no dense/full-table scan — see entity-anchor.ts D-03), provider-free (constructor
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
 * Reject after `ms`. The timer is unref'd so a resolved race never holds the
 * process open — the hook must exit promptly (T-RT1-03).
 */
function rejectAfter(ms: number): Promise<never> {
  return new Promise((_resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`embed timed out after ${ms}ms`)), ms);
    t.unref();
  });
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

  // retrieveRanked emits the viz trace itself when the flag is on. With vizFloor it
  // lights the genuinely-retrieved nodes down to AMBIENT_VIZ_FLOOR even when nothing
  // clears the injection floor — so the brain lights on essentially every prompt (a
  // real read happened), while injection still uses AMBIENT_FLOOR. Do NOT add a second
  // emit here.
  const engine = new RetrievalEngine(db, clock, config, retriever, store, strength, gate, traceSink);
  const results = engine.retrieveRanked(vec, AMBIENT_K, AMBIENT_FLOOR, undefined, {
    vizFloor: AMBIENT_VIZ_FLOOR,
    anchoredIds: anchored.map(a => a.id),
  });
  if (results.length === 0) return '';

  // D-S6 provenance surfacing: ONE batch scope read over ALL rows retrieveRanked returned,
  // BEFORE any slicing/selection — this single read serves both the pre-existing `[slug]`
  // display marker AND (Phase 69 D-01) the ordering-only same-project rank nudge below. For
  // every OTHER caller (`RecallEngine.recall --scope`, corpus, viz) the underlying store
  // method remains display-only and never influences selection/order (D-S1); on THIS path
  // only, Phase 69 D-01 partially reverses that for ordering (never existence) — see the
  // bounded carve-out recorded at the store method's own doc comment.
  const scopes = store.getNodeScopes(results.map(r => r.id));

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
  // (c) `currentScope === GLOBAL_SCOPE` (unknown/personal cwd) disables the same-project
  //     boost entirely; foreign-doc demotion still applies to scoped docs since "foreign"
  //     is well-defined independent of whether the CALLER's own scope is known.
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
    const foreignDemotion = isForeignDoc(r.id) ? config.foreignDocDemotion : 0;
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

  const selectedIds = new Set<string>();
  for (const r of ranked) {
    if (selectedIds.size >= nonReservedSlots) break;
    selectedIds.add(r.id);
  }
  for (const r of ranked) {
    if (selectedIds.size >= AMBIENT_K) break;
    if (!anchoredById.has(r.id) || selectedIds.has(r.id)) continue;
    selectedIds.add(r.id);
  }
  for (const r of ranked) {
    if (selectedIds.size >= AMBIENT_K) break;
    if (selectedIds.has(r.id)) continue;
    selectedIds.add(r.id);
  }
  // Emit the selected rows in rank order (not selection-pass order).
  const surfaced = ranked.filter(r => selectedIds.has(r.id));

  const lines = ['Recalled from recense (ambient):'];
  for (const r of surfaced) {
    const origin = getCachedNode(r.id)?.origin ?? 'observed';
    const scope = scopes.get(r.id);
    const marker = scope && scope !== 'global' ? `[${scope}] ` : '';
    lines.push(`- ${marker}${r.value.slice(0, MAX_VALUE_CHARS)} (${origin}, score ${r.score.toFixed(2)})`);
  }
  return lines.join('\n');
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
