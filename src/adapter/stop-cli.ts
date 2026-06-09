/**
 * stop-cli — Stop hook entry point (ADAPT-02, fires per turn).
 *
 * Receives the assistant's response via stdin, writes it to the episodic store,
 * then spawns the sleep-pass CLI as a detached child process (D-31).
 * Emits `{}` to stdout and exits 0 — non-blocking.
 *
 * Design invariants:
 *  - consumeStdin() MUST be called first — hook harness blocks on write otherwise.
 *  - Detached child uses stdio: 'ignore' — MANDATORY (RESEARCH §2 Pitfall 2).
 *    If 'inherit', child shares parent's closing handles and may EPIPE/crash.
 *  - child.unref() lets the parent exit without waiting for the child.
 *  - Does NOT inject context into the response — any context output from a Stop hook
 *    is silently dropped unless combined with { "decision": "block" } (RESEARCH §1.3 Pitfall 1).
 *    Job: write turn + spawn sleep pass; never output context.
 *  - Error discipline: any error logged to ERROR_LOG; hook still emits `{}`, exits 0.
 *
 * Threat mitigations:
 *  - T-03-2-T: type-guard last_assistant_message/session_id; recordEvent uses
 *    EpisodicStore.append with prepared statements (T-01-SQL).
 *  - T-03-2-I: stdio: 'ignore' prevents fd leak onto the detached child.
 *  - T-03-2-Dpath: dbPath passed as argv array element to spawn (no shell string).
 */
import { appendFileSync } from 'fs';
import { spawn } from 'child_process';
import { resolve } from 'path';
import Database from 'better-sqlite3';
import { resolveDbPath, loadConfiguredEnv } from './runtime-config';
import { initSchema } from '../db/schema';
import { DEFAULT_CONFIG } from '../lib/config';
import { realClock } from '../lib/clock';
import { AllocationGate, EpisodicStore, IngestionPipeline } from '../ingest/pipeline';

const ERROR_LOG = '/tmp/brain-memory-hook-errors.log';

/** Drain stdin — harness blocks on write if not drained (confirmed: lib.ts pattern). */
async function consumeStdin(): Promise<Record<string, unknown>> {
  return new Promise(resolve_ => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => { buf += chunk; });
    process.stdin.on('end', () => {
      try { resolve_(JSON.parse(buf) as Record<string, unknown>); } catch { resolve_({}); }
    });
    process.stdin.resume();
  });
}

/**
 * Spawn the sleep-pass CLI as a detached child process.
 * stdio: 'ignore' is MANDATORY (RESEARCH §2 Pitfall 2).
 * T-03-2-Dpath: dbPath is an argv array element, never shell-interpolated.
 */
function spawnSleepPass(dbPath: string): void {
  const sleepPassScript = resolve(__dirname, 'sleep-pass-cli.js');
  // WR-04: the per-turn sleep pass makes Haiku + embedding calls, so it needs the
  // API keys. On a `brain init` install those live in the configured env file, not
  // the hook's ambient env. Merge them in; explicitly-exported process.env wins.
  const child = spawn(
    process.execPath,                    // same node binary — avoids PATH issues in hook context
    [sleepPassScript, '--db', dbPath],
    {
      detached: true,                    // detach from parent process group
      stdio: 'ignore',                   // MUST be 'ignore' — never 'inherit' or 'pipe'
      env: { ...loadConfiguredEnv(), ...process.env },
    },
  );
  child.unref();                         // parent can exit without waiting for child
}

async function main(): Promise<void> {
  // MUST drain before any work
  const input = await consumeStdin();

  // Type-guard the fields we need (T-03-2-T)
  const assistantText = typeof input['last_assistant_message'] === 'string'
    ? input['last_assistant_message'] : '';
  const sessionId = typeof input['session_id'] === 'string'
    ? input['session_id'] : 'unknown';
  const cwd       = typeof input['cwd'] === 'string' ? input['cwd'] : '';

  // CR-01: --db (pinned by `brain init`) > BRAIN_MEMORY_DB env > shared default.
  const dbPath = resolveDbPath();

  if (assistantText) {
    const config = { ...DEFAULT_CONFIG, dbPath };
    const db = new Database(dbPath);
    initSchema(db);

    const gate     = new AllocationGate(config);
    const store    = new EpisodicStore(db, realClock, config);
    const pipeline = new IngestionPipeline(gate, store);

    pipeline.recordEvent({
      content: assistantText,
      role: 'assistant',
      origin: 'observed',
      sessionId,
      cwd,
    });

    db.close();
  }

  // Spawn the detached sleep pass (D-31 — non-blocking; lock guards overlap)
  spawnSleepPass(dbPath);

  // Stop hook emits `{}` — no context injection (Pitfall 1: context output silently dropped without decision:block)
  process.stdout.write('{}');
  process.exit(0);
}

main().catch(err => {
  appendFileSync(ERROR_LOG, `[${new Date().toISOString()}] stop-cli: ${err}\n`);
  process.stdout.write('{}');
  process.exit(0);
});
