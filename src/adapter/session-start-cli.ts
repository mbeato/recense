/**
 * session-start-cli — SessionStart hook entry point (ADAPT-01).
 *
 * Runs cue-less retrieval via RetrievalEngine and emits `hookSpecificOutput.additionalContext`
 * to Claude Code, replacing the flat MEMORY.md injection source (D-33).
 *
 * Design invariants:
 *  - consumeStdin() MUST be called first — the hook harness blocks on write if not drained.
 *  - LLM-free and embedding-free: only RetrievalEngine + synchronous SQLite reads.
 *  - Output is token-budgeted: engine already bounds the set; final string is also
 *    defensively truncated to injectionTokenBudget × 4 chars (T-03-3-I) and hard-capped
 *    at HARD_CAP (10,000 chars) per the Claude Code hook contract (RESEARCH §1.1).
 *  - Error discipline: all errors are logged to ERROR_LOG and the hook emits
 *    additionalContext:'' and exits 0 — never surfaces internal errors to the user.
 *  - Always exits 0: exit 2 is reserved for intentional blocking/rejection; this hook
 *    never blocks.
 *
 * Threat mitigations:
 *  - T-03-3-I: dual char cap (budget × 4 and hard 10,000) prevents context bloat.
 *  - T-03-3-D: pure synchronous SQLite reads (~100-150ms); no LLM/embedding calls.
 *  - T-03-3-T: emitContext uses one JSON.stringify payload; catch-all emits '' and exits 0.
 *  - T-03-3-E: RetrievalEngine is 100% read-only (Plan 01 guarantee); no write primitives
 *              invoked beyond initSchema DDL.
 */
import { appendFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema';
import { DEFAULT_CONFIG } from '../lib/config';
import { realClock } from '../lib/clock';
import { SemanticStore } from '../db/semantic-store';
import { CandidateRetriever } from '../retrieval/topk';
import { StrengthDecayManager } from '../strength/decay';
import { AllocationGate } from '../gate/allocation-gate';
import { RetrievalEngine } from '../retrieval/engine';

const EVENT = 'SessionStart';
const ERROR_LOG = '/tmp/brain-memory-hook-errors.log';

/**
 * 10,000-char hard cap from the Claude Code hook contract (RESEARCH §1.1).
 * injectionTokenBudget × 4 is the first gate; this is the absolute ceiling.
 */
const HARD_CAP = 10_000;

/**
 * Drain stdin — the harness blocks on write if stdin is not fully consumed
 * before the hook emits output. Confirmed pattern from ~/.claude/hooks/lib.ts.
 */
async function consumeStdin(): Promise<Record<string, unknown>> {
  return new Promise(resolve => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => { buf += chunk; });
    process.stdin.on('end', () => {
      try { resolve(JSON.parse(buf) as Record<string, unknown>); } catch { resolve({}); }
    });
    process.stdin.resume();
  });
}

/**
 * Emit additionalContext to stdout.
 * Confirmed shape from ~/.claude/hooks/lib.ts (emitContext, lines 44–52).
 * An empty string is the correct value for "nothing to inject" — not empty stdout.
 */
function emitContext(text: string): void {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: EVENT,
      additionalContext: text,
    },
  }));
}

async function main(): Promise<void> {
  // MUST drain stdin before any I/O — harness blocks on write otherwise (RESEARCH §1.1)
  await consumeStdin();

  const dbPath = process.env['BRAIN_MEMORY_DB'] ?? join(homedir(), 'brain-memory', 'brain.db');
  const config = { ...DEFAULT_CONFIG, dbPath };
  const db = new Database(dbPath);
  initSchema(db);

  // Instantiate all engine deps — LLM-free by construction (no Embedder/Judge instantiated)
  const clock = realClock;
  const store    = new SemanticStore(db, clock, config);
  const retriever = new CandidateRetriever(db);
  const strength  = new StrengthDecayManager(db, clock, config);
  const gate      = new AllocationGate(config);
  const engine    = new RetrievalEngine(db, clock, config, retriever, store, strength, gate);

  // Cue-less retrieval — 100% synchronous SQLite reads, no embedding calls (RET-01)
  const result = engine.retrieveCueless();

  // ── Format results into a compact text block (D-25) ──────────────────────────
  // hard_keep nodes are already pinned first by the engine (D-24).
  // Mark hard_keep entries with [keep] prefix for user-visible hint.
  const lines: string[] = [];
  for (const node of result.results) {
    const isHardKeep = gate.score(node.value, 'user').hardKeep;
    lines.push(isHardKeep ? `[keep] ${node.value}` : node.value);
  }

  let text = lines.join('\n');

  // ── Defensive char cap (T-03-3-I) ────────────────────────────────────────────
  // Engine already bounded the set by token budget, but newlines + [keep] prefixes
  // add a few chars. Truncate to budget × 4 chars; never exceed HARD_CAP.
  const budgetChars = config.injectionTokenBudget * 4;
  const maxChars = Math.min(budgetChars, HARD_CAP);
  if (text.length > maxChars) {
    const clipped = text.slice(0, maxChars);
    // Cut back to the last complete line so a node value is never injected
    // mid-string (e.g. "com.brain-mem"). Fall back to the raw slice only when a
    // single line already exceeds the cap, preserving the hard char bound.
    const lastNewline = clipped.lastIndexOf('\n');
    text = lastNewline > 0 ? clipped.slice(0, lastNewline) : clipped;
  }

  db.close();
  emitContext(text);
  process.exit(0);
}

main().catch(err => {
  // Log to file — never throw to stdout (would corrupt the JSON output and block the user)
  appendFileSync(ERROR_LOG, `[${new Date().toISOString()}] session-start-cli: ${err}\n`);
  emitContext(''); // emit empty — harness must not see partial JSON
  process.exit(0); // always exit 0 on error (never surface internal errors as a block)
});
