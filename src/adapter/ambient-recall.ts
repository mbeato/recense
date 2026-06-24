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
 */
export async function ambientRecall(
  db: Database.Database,
  promptText: string,
  provider: ModelProvider,
  config: EngineConfig,
  clock: Clock = realClock,
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

  // retrieveRanked emits the viz trace itself when the flag is on. With vizFloor it
  // lights the genuinely-retrieved nodes down to AMBIENT_VIZ_FLOOR even when nothing
  // clears the injection floor — so the brain lights on essentially every prompt (a
  // real read happened), while injection still uses AMBIENT_FLOOR. Do NOT add a second
  // emit here.
  const engine = new RetrievalEngine(db, clock, config, retriever, store, strength, gate, traceSink);
  const results = engine.retrieveRanked(vec, AMBIENT_K, AMBIENT_FLOOR, undefined, { vizFloor: AMBIENT_VIZ_FLOOR });
  if (results.length === 0) return '';

  // Token-lean block: header + one capped line per fact, max AMBIENT_K lines.
  // retrieveRanked rows carry id/value/score only; one indexed getNode per surfaced
  // row is acceptable on this path.
  const surfaced = results.slice(0, AMBIENT_K);

  // D-S6 provenance surfacing: batch-read scopes AFTER ranking/selection — this read
  // NEVER influences score, filter, or order (D-S1). A non-global scope renders as a
  // `[slug]` prefix; 'global' and unscoped nodes render with no marker (keeps the block
  // lean — only project-specific provenance is flagged). Display-only by construction.
  const scopes = store.getNodeScopes(surfaced.map(r => r.id));

  const lines = ['Recalled from recense (ambient):'];
  for (const r of surfaced) {
    const origin = store.getNode(r.id)?.origin ?? 'observed';
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
