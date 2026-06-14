/**
 * session-start-cli — SessionStart hook entry point (ADAPT-01).
 *
 * Runs cue-less retrieval via RetrievalEngine and emits `hookSpecificOutput.additionalContext`
 * to Claude Code, replacing the flat MEMORY.md injection source (D-33).
 *
 * Design invariants:
 *  - consumeStdin() MUST be called first — the hook harness blocks on write if not drained.
 *  - LLM-free and embedding-free: only RetrievalEngine + synchronous SQLite reads.
 *  - READ-ONLY (M-3): opens the DB with {readonly:true, fileMustExist:true}; never runs
 *    initSchema or any DDL. Writer CLIs (sleep-pass, recall, recense init) own migrations.
 *    On missing DB or schema_version mismatch, emits empty context and exits 0 cleanly.
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
 *  - T-03-3-E: RetrievalEngine is 100% read-only; no write primitives invoked (M-3 locked).
 */
import { appendFileSync } from 'fs';
import Database from 'better-sqlite3';
import { resolveDbPath } from './runtime-config';
import { SCHEMA_VERSION } from '../db/schema';
import { DEFAULT_CONFIG } from '../lib/config';
import { realClock } from '../lib/clock';
import { SemanticStore } from '../db/semantic-store';
import { CandidateRetriever } from '../retrieval/topk';
import { StrengthDecayManager } from '../strength/decay';
import { AllocationGate } from '../gate/allocation-gate';
import { RetrievalEngine } from '../retrieval/engine';

const EVENT = 'SessionStart';
const ERROR_LOG = '/tmp/recense-hook-errors.log';

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
  const input = await consumeStdin();

  // Type-guard cwd from the hook payload (T-03-3-T; hot path — no LLM/embedding calls added)
  const cwd = typeof input['cwd'] === 'string' ? input['cwd'] : '';

  // CR-01: --db (pinned by `recense init`) > RECENSE_DB env > shared default.
  const dbPath = resolveDbPath();
  const config = { ...DEFAULT_CONFIG, dbPath };

  // M-3 LOCKED: open read-only — never run DDL or initSchema on the hot hook path.
  // A missing DB (fresh install, writer not yet run) or a schema_version mismatch (binary
  // older/newer than the DB) emits empty context and exits 0 cleanly.
  // Writer CLIs (recense init / sleep-pass / recall) own migrations.
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    appendFileSync(
      ERROR_LOG,
      `[${new Date().toISOString()}] session-start-cli: DB unavailable (${dbPath}): ${err} — run a writer CLI (recense init / recense sleep-pass) to initialise; emitting empty context\n`
    );
    emitContext('');
    process.exit(0);
  }

  // Schema-version check: if the DB was created by a newer binary, the reader must bail out
  // rather than operate on an unknown schema. If the DB is stale (older binary stamped it),
  // bail out so a writer CLI can migrate first (M-3 + M-9 companion).
  const vRow = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as
    { value: string } | undefined;
  if (!vRow || Number(vRow.value) !== SCHEMA_VERSION) {
    appendFileSync(
      ERROR_LOG,
      `[${new Date().toISOString()}] session-start-cli: schema_version mismatch ` +
      `(stored=${vRow?.value ?? 'absent'}, binary=${SCHEMA_VERSION}) — ` +
      `run a writer CLI (recense init / recense sleep-pass) to migrate; emitting empty context\n`
    );
    db.close();
    emitContext('');
    process.exit(0);
  }

  // Instantiate all engine deps — LLM-free by construction (no Embedder/Judge instantiated)
  const clock = realClock;
  const store    = new SemanticStore(db, clock, config);
  const retriever = new CandidateRetriever(db);
  const strength  = new StrengthDecayManager(db, clock, config);
  const gate      = new AllocationGate(config);
  const engine    = new RetrievalEngine(db, clock, config, retriever, store, strength, gate);

  // Cue-less retrieval — 100% synchronous SQLite reads, no embedding calls (RET-01)
  // Pass cwd for soft project scoping (DEBT-06): project-specific + global facts surface;
  // facts from other projects are excluded. Hot-path invariant: no LLM/embedding calls added.
  const result = engine.retrieveCueless(cwd);

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
