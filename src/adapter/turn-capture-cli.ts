/**
 * turn-capture-cli — UserPromptSubmit hook entry point (ADAPT-02).
 *
 * Receives the user's prompt via stdin and writes it to the episodic store.
 * Emits `{}` to stdout and exits 0 — non-blocking (does not inject context).
 *
 * Design invariants:
 *  - consumeStdin() MUST be called first — the hook harness blocks on write if not.
 *  - All writes use IngestionPipeline.recordEvent() (prepared statements, T-03-2-T).
 *  - sourceInferenceId is left undefined → null (D-34: no-op pass-through this phase).
 *  - Error discipline: any internal error is logged to ERROR_LOG and the hook
 *    still emits `{}` and exits 0 — never surfaces errors to the user.
 *
 * Threat mitigations:
 *  - T-03-2-T: type-guard prompt/session_id to strings before use; recordEvent
 *    uses EpisodicStore.append which uses prepared statements (T-01-SQL).
 */
import { appendFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema';
import { DEFAULT_CONFIG } from '../lib/config';
import { realClock } from '../lib/clock';
import { AllocationGate, EpisodicStore, IngestionPipeline } from '../ingest/pipeline';

const ERROR_LOG = '/tmp/brain-memory-hook-errors.log';

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

  if (promptText) {
    const dbPath = process.env['BRAIN_MEMORY_DB'] ?? join(homedir(), 'brain-memory', 'brain.db');
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
      // sourceInferenceId left undefined → null (D-34: no-op pass-through this phase)
    });

    db.close();
  }

  // Turn-capture emits empty JSON — no injection, no blocking
  process.stdout.write('{}');
  process.exit(0);
}

main().catch(err => {
  appendFileSync(ERROR_LOG, `[${new Date().toISOString()}] turn-capture-cli: ${err}\n`);
  process.stdout.write('{}');
  process.exit(0);
});
