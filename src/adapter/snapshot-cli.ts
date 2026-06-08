/**
 * snapshot-cli — lock-guarded eval-snapshot record/replay adapter (SEAM-03).
 *
 * Modes:
 *   --record --query <text> [--expected <text>] --db <path>
 *     Embeds the query, runs RetrievalEngine.retrieve (LLM-free, D-52), captures the top
 *     result as the blessed expected_answer (or uses --expected when supplied, D-51),
 *     inserts one eval_snapshot row, emits JSON `{ recorded: <id> }` to stdout.
 *
 *   --replay --db <path>
 *     Calls replaySnapshots over all stored rows, emits
 *     `{ total, matched, regressions: [...] }` to stdout.
 *     Exits 0 when all snapshots match; exits 1 when any regression is found (CI-usable).
 *
 * Design invariants:
 *  - acquireLock() (O_EXCL) before any DB open — single-writer preserved (CONSOL-03, T-05-SNAP-LOCK).
 *  - releaseLock() in finally — no lock leak even on unhandled errors.
 *  - stdout receives ONLY JSON; all diagnostics go to LOG_PATH (never stdout).
 *  - --query and --expected argv are treated as data: bound params only, never interpolated (T-05-SNAP-I).
 *  - DefaultModelProvider reads OPENAI_API_KEY / ANTHROPIC_API_KEY from env — never logged (T-05-SNAP-K).
 */
import { appendFileSync } from 'fs';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema';
import { DEFAULT_CONFIG } from '../lib/config';
import { realClock } from '../lib/clock';
import { SemanticStore } from '../db/semantic-store';
import { StrengthDecayManager } from '../strength/decay';
import { CandidateRetriever } from '../retrieval/topk';
import { AllocationGate } from '../gate/allocation-gate';
import { RetrievalEngine } from '../retrieval/engine';
import { DefaultModelProvider } from '../model/provider';
import { recordSnapshot, replaySnapshots } from '../eval/snapshot';
import { acquireLock, releaseLock } from './lockfile';

const LOG_PATH = '/tmp/brain-memory-snapshot.log';

/** Append a timestamped line to the log file (never stdout). */
const log = (msg: string): void =>
  appendFileSync(LOG_PATH, `[${new Date().toISOString()}] snapshot-cli: ${msg}\n`);

/** Resolve dbPath from --db <path> argv or BRAIN_MEMORY_DB env var. */
function resolveDbPath(): string | undefined {
  const idx = process.argv.indexOf('--db');
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return process.env['BRAIN_MEMORY_DB'];
}

/**
 * Resolve the query text from --query <text> argv.
 * T-05-SNAP-I: returned as-is — never shell-interpolated; treated as data only.
 */
function resolveQuery(): string | undefined {
  const idx = process.argv.indexOf('--query');
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return undefined;
}

/**
 * Resolve the explicit expected answer from --expected <text> argv.
 * T-05-SNAP-I: returned as-is — treated as data only.
 */
function resolveExpected(): string | undefined {
  const idx = process.argv.indexOf('--expected');
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return undefined;
}

/** True when --record flag is present in argv. */
const MODE_RECORD = process.argv.includes('--record');
/** True when --replay flag is present in argv. */
const MODE_REPLAY = process.argv.includes('--replay');

/** Safe null JSON for record mode errors — callers can JSON.parse(stdout) safely. */
const SAFE_RECORD_NULL = JSON.stringify({ recorded: null });
/** Safe null JSON for replay mode errors — callers can JSON.parse(stdout) safely. */
const SAFE_REPLAY_NULL = JSON.stringify({ total: 0, matched: 0, regressions: [] });

async function main(): Promise<void> {
  // ── 1. Validate mode BEFORE acquiring lock (WR-02: lock leak prevention) ──
  if (!MODE_RECORD && !MODE_REPLAY) {
    log('No mode flag supplied: use --record or --replay — exiting');
    process.stdout.write(SAFE_RECORD_NULL);
    process.exit(0);
  }

  const dbPath = resolveDbPath();
  if (!dbPath) {
    log('No DB path supplied (--db <path> or BRAIN_MEMORY_DB env var) — exiting');
    process.stdout.write(MODE_RECORD ? SAFE_RECORD_NULL : SAFE_REPLAY_NULL);
    process.exit(0);
  }

  if (MODE_RECORD) {
    const query = resolveQuery();
    if (!query) {
      log('--record requires --query <text> — exiting');
      process.stdout.write(SAFE_RECORD_NULL);
      process.exit(0);
    }
  }

  // ── 2. Lock guard — single-writer, O_EXCL (T-05-SNAP-LOCK) ─────────────
  if (!acquireLock()) {
    log('Lock held by another process — exiting');
    process.stdout.write(MODE_RECORD ? SAFE_RECORD_NULL : SAFE_REPLAY_NULL);
    process.exit(0);
  }

  try {
    // ── 3. Open DB and initialize schema (creates eval_snapshot if absent) ─
    const db = new Database(dbPath);
    initSchema(db);

    const config = { ...DEFAULT_CONFIG, dbPath };

    // T-05-SNAP-K: DefaultModelProvider reads API keys from env; never logged or stdout.
    const provider = new DefaultModelProvider({
      generateConfig: config,
      judgeConfig:    config,
      embedConfig:    config,
    });

    if (MODE_RECORD) {
      // ── 4a. RECORD mode ─────────────────────────────────────────────────
      const query    = resolveQuery()!; // validated above
      const expected = resolveExpected();

      // Build the LLM-free retrieval engine (D-52)
      const store    = new SemanticStore(db, realClock, config);
      const retriever = new CandidateRetriever(db);
      const strength = new StrengthDecayManager(db, realClock, config);
      const gate     = new AllocationGate(config);
      const engine   = new RetrievalEngine(db, realClock, config, retriever, store, strength, gate);

      // Embed the query to get the retrieval vector
      const [queryVec] = await provider.embed([query]);
      const result = engine.retrieve(queryVec);

      // Resolve blessed expected_answer: explicit --expected OR top retrieval result (D-51)
      const blessed = expected ?? result.results[0]?.value;
      if (!blessed) {
        log(`--record: retrieval returned no result and --expected not supplied for query="${query}" — exiting`);
        process.stdout.write(SAFE_RECORD_NULL);
        db.close();
        return;
      }

      const id = recordSnapshot(db, { query, expectedAnswer: blessed, ts: Date.now() });
      process.stdout.write(JSON.stringify({ recorded: id }));
      db.close();

    } else {
      // ── 4b. REPLAY mode ─────────────────────────────────────────────────
      const results = await replaySnapshots(db, provider.embed.bind(provider), config);
      const matched    = results.filter(r => r.match).length;
      const regressions = results.filter(r => !r.match);

      process.stdout.write(JSON.stringify({
        total: results.length,
        matched,
        regressions: regressions.map(r => ({
          id:     r.id,
          query:  r.query,
          cosine: r.cosine,
        })),
      }));

      db.close();

      // CI-usable: non-zero exit when any regression found (D-53)
      if (regressions.length > 0) {
        log(`replay: ${regressions.length} regression(s) detected`);
        // process.exit() skips the finally below — release the lock first so
        // the shared single-writer lock is not leaked for LOCK_STALE_MS (WR-01).
        releaseLock();
        process.exit(1);
      }
    }
  } catch (err) {
    log(`snapshot-cli error: ${err}`);
    process.stdout.write(MODE_RECORD ? SAFE_RECORD_NULL : SAFE_REPLAY_NULL);
  } finally {
    // ── 5. Always release the lock (T-05-SNAP-LOCK) ──────────────────────
    releaseLock();
  }
}

main().catch(err => {
  appendFileSync(LOG_PATH, `[${new Date().toISOString()}] snapshot-cli FATAL: ${err}\n`);
  releaseLock(); // best-effort cleanup
  process.exit(1);
});
