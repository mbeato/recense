/**
 * turn-capture-cli — UserPromptSubmit hook entry point (ADAPT-02 + quick-260612-rt1).
 *
 * Receives the user's prompt via stdin, writes it to the episodic store, then runs
 * LLM-free ambient recall (one embedding call + retrieveRanked). When recalled facts
 * clear the floor, they are injected as hookSpecificOutput.additionalContext;
 * otherwise the hook emits `{}`. Either way it exits 0 — never blocks the prompt.
 *
 * D-97 boundary: this is the UserPromptSubmit hook. SessionStart (session-start-cli)
 * stays Noop/cueless/LLM-free and does not import the ambient-recall module.
 *
 * Recall-skip guards (capture still runs; output is `{}`):
 *  - slash commands (prompt starts with '/')
 *  - short prompts (< MIN_RECALL_CHARS chars)
 *  - no OPENAI_API_KEY after hydrateRuntimeEnv() (WR-04: sleep.env provides keys
 *    set-only-if-missing; the embed head is OpenAI — T-05-KEY)
 *
 * Design invariants:
 *  - consumeStdin() MUST be called first — the hook harness blocks on write if not.
 *  - All writes use IngestionPipeline.recordEvent() (prepared statements, T-03-2-T).
 *  - sourceInferenceId is left undefined → null (D-34: no-op pass-through this phase).
 *  - Error discipline: any internal error (including embed timeout) is logged to
 *    ERROR_LOG and the hook still emits `{}` and exits 0 — fail-open, never blocks,
 *    never emits partial/invalid JSON.
 *
 * Threat mitigations:
 *  - T-03-2-T: type-guard prompt/session_id to strings before use; recordEvent
 *    uses EpisodicStore.append which uses prepared statements (T-01-SQL).
 *  - T-RT1-02: key material is never logged or printed — skip-log text only.
 *  - T-RT1-04: stdout is either buildHookOutput()'s single JSON.stringify or
 *    the literal '{}'.
 */
import { appendFileSync } from 'fs';
import Database from 'better-sqlite3';
import { hydrateRuntimeEnv, resolveDbPath } from './runtime-config';
import { initSchema } from '../db/schema';
import { DEFAULT_CONFIG } from '../lib/config';
import { realClock } from '../lib/clock';
import { AllocationGate, EpisodicStore, IngestionPipeline } from '../ingest/pipeline';
import { DefaultModelProvider } from '../model/provider';
import { ambientRecall, buildHookOutput } from './ambient-recall';

const ERROR_LOG = '/tmp/brain-memory-hook-errors.log';

/** Prompts shorter than this skip ambient recall (too little signal to embed). */
const MIN_RECALL_CHARS = 12;

/** Drain stdin — harness blocks on write if not drained (confirmed: lib.ts pattern). */
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

async function main(): Promise<void> {
  // MUST drain before any work — harness blocks on write otherwise
  const input = await consumeStdin();

  // Type-guard the fields we need (T-03-2-T)
  const promptText = typeof input['prompt'] === 'string' ? input['prompt'] : '';
  const sessionId  = typeof input['session_id'] === 'string' ? input['session_id'] : 'unknown';
  const cwd        = typeof input['cwd'] === 'string' ? input['cwd'] : '';

  if (promptText) {
    // CR-01: --db (pinned by `brain init`) > BRAIN_MEMORY_DB env > shared default.
    const dbPath = resolveDbPath();
    const config = { ...DEFAULT_CONFIG, dbPath };
    const db = new Database(dbPath);
    initSchema(db);

    const gate     = new AllocationGate(config);
    const store    = new EpisodicStore(db, realClock, config);
    const pipeline = new IngestionPipeline(gate, store);

    pipeline.recordEvent({
      content: promptText,
      role: 'user',
      origin: 'observed',
      sessionId,
      cwd,
      // sourceInferenceId left undefined → null (D-34: no-op pass-through this phase)
    });

    // ── Ambient recall (quick-260612-rt1) — capture above already ran ─────────
    // Guards: slash commands and short prompts carry no recall signal; without an
    // embed key (WR-04 hydration first — sleep.env fills missing keys only) the
    // OpenAI embed head cannot run (T-05-KEY). Skip → identical to pre-rt1 behavior.
    let skipRecall = promptText.startsWith('/') || promptText.length < MIN_RECALL_CHARS;
    if (!skipRecall) {
      hydrateRuntimeEnv();
      if (process.env['OPENAI_API_KEY'] === undefined) {
        // T-RT1-02: never log key material — skip-reason text only.
        appendFileSync(ERROR_LOG, `[${new Date().toISOString()}] turn-capture-cli: no embed key; skipping ambient recall\n`);
        skipRecall = true;
      }
    }

    if (skipRecall) {
      db.close();
      process.stdout.write('{}');
      process.exit(0);
    }

    try {
      // generate/judge are never called on this path; lazy init means no
      // Anthropic key is needed at construction time.
      const provider = new DefaultModelProvider({
        generateConfig: config,
        judgeConfig: config,
        embedConfig: config,
      });
      const text = await ambientRecall(db, promptText, provider, config, realClock);
      db.close();
      process.stdout.write(text ? buildHookOutput(text) : '{}');
      process.exit(0);
    } catch (err) {
      // Fail-open: NEVER block the prompt, NEVER emit partial/invalid JSON.
      appendFileSync(ERROR_LOG, `[${new Date().toISOString()}] turn-capture-cli ambient-recall: ${err}\n`);
      try { db.close(); } catch { /* already closed */ }
      process.stdout.write('{}');
      process.exit(0);
    }
  }

  // Empty prompt: no DB open, no recall — emit empty JSON and exit 0 (unchanged)
  process.stdout.write('{}');
  process.exit(0);
}

main().catch(err => {
  appendFileSync(ERROR_LOG, `[${new Date().toISOString()}] turn-capture-cli: ${err}\n`);
  process.stdout.write('{}');
  process.exit(0);
});
