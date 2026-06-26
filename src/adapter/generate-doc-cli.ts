/**
 * generate-doc-cli — recense generate-doc <slug> (Phase 27, Plan 27-02).
 *
 * Write-capable, lock-guarded CLI that runs the doc-generation pipeline for a project slug:
 *   1. Gather facts (scope ∪ semantic ∪ entity-hop, D-01)
 *   2. Generate a cited markdown deep-dive via the judge-tier model (D-04)
 *   3. Write the result as a lifecycle-exempt type='doc' node via writeDoc (single-writer)
 *   4. Emit a JSON line {nodeId, slug, generated_at, citationCount, invented, tombstoned}
 *
 * Design invariants:
 *  D-02  Idempotent by default: if a doc node already exists for the slug, exit with the
 *        existing node data (no LLM call). Use --force to regenerate.
 *  D-04  Generation uses the judge-tier EngineConfig as the generate head (no new docModel var).
 *  D-06  One generate call per invocation (maxTokens 4000); low-volume lazy posture.
 *  T-27-06  DoS guard: idempotent by default, single generate call, no auto-batch.
 *  T-27-07  All writes through SemanticStore + writeDoc (single-writer invariant).
 *  WR-02  Validate DB path BEFORE acquireLock — process.exit() with the lock held leaks it.
 *  T-25-07  Lock released in finally on every path (the shared write-lock pattern).
 *  T-39.3-04  Lock-wait is bounded by RECENSE_CLAUDE_HEADLESS_TIMEOUT_MS (default 600000);
 *             on budget expiry → writeStatus('failed', 'engine stayed busy') + exit.
 *  require.main guard: importing this module never auto-runs main() (test isolation).
 *
 * Entry point: dispatched by recense.ts via spawnScript('generate-doc-cli.js', ...).
 *
 * CLI usage:
 *   recense generate-doc <slug> [--db <path>] [--force]
 */
import { appendFileSync } from 'fs';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema';
import { DEFAULT_CONFIG } from '../lib/config';
import { realClock } from '../lib/clock';
import { SemanticStore } from '../db/semantic-store';
import { DefaultModelProvider } from '../model/provider';
import { generateDoc, generateDocForSchema } from '../reader/doc-generator';
import { computeSchemaCentroid } from '../reader/doc-gather';
import { writeDoc } from '../consolidation/doc-writer';
import { DocGraphDeriver } from '../consolidation/doc-graph-deriver';
import { acquireLock, releaseLock } from './lockfile';
import { writeStatus, clearStatus } from './gen-status';
import { resolveDbPath as resolveSharedDbPath } from './runtime-config';
import { resolveProviderOverlay } from '../consolidation/run-sleep-pass';

const LOG_PATH = '/tmp/recense-generate-doc.log';

/** Append a timestamped line to the log file. */
const fileLog = (msg: string): void =>
  appendFileSync(LOG_PATH, `[${new Date().toISOString()}] generate-doc: ${msg}\n`);

// Poll interval for the lock-wait loop (~2s per D-2 guidance; exported for tests).
export const POLL_MS = 2000;

// ── waitForLock — bounded lock-wait helper (D-2, T-39.3-04) ─────────────────
//
// Factored out of main() so the budget/poll logic is unit-testable without
// spawning a child process. The loop:
//   1. Call writeQueued() to stamp 'queued' (first iteration and every retry).
//   2. Try acquire() — if true, return true (caller proceeds to generate).
//   3. If elapsed >= budget, call writeFailedBusy() then return false.
//   4. Sleep pollMs, then repeat from step 1.
//
// Design: writeQueued is re-stamped each iteration to keep updatedAt fresh so
// readStatus treats an in-progress wait as non-stale (STALE_MS = 15min >> pollMs).

export interface WaitForLockOpts {
  /** Try to acquire the lock — non-blocking, returns true on success. */
  acquire: () => boolean;
  /** Write phase='queued' status (may be called multiple times). */
  writeQueued: () => void;
  /** Write phase='failed' with error='engine stayed busy' and exit signal. */
  writeFailedBusy: () => void;
  /** Async sleep for pollMs between attempts. */
  sleep: (ms: number) => Promise<void>;
  /** Return monotonic time in ms (injectable for tests). */
  now: () => number;
  /** Give-up deadline in ms from start. */
  budgetMs: number;
  /** Poll interval in ms. */
  pollMs: number;
}

/**
 * Wait for the write lock within the given budget.
 *
 * Returns true when the lock is acquired; returns false when budget expires
 * (after calling writeFailedBusy). Calls writeQueued before each acquire attempt
 * to keep the status file's updatedAt fresh.
 */
export async function waitForLock(opts: WaitForLockOpts): Promise<boolean> {
  const { acquire, writeQueued, writeFailedBusy, sleep, now, budgetMs, pollMs } = opts;
  const start = now();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Re-stamp 'queued' before each attempt to keep updatedAt fresh.
    writeQueued();

    if (acquire()) {
      return true;
    }

    // Check budget AFTER a failed acquire (not before the first attempt).
    if (now() - start >= budgetMs) {
      writeFailedBusy();
      return false;
    }

    await sleep(pollMs);
  }
}

async function main(): Promise<void> {
  const argv = process.argv;

  // ── 1. Parse args ─────────────────────────────────────────────────────────
  // slug is the first positional arg after the command (argv[3] from recense.ts perspective,
  // but when spawned as a child process argv[2] is the first user arg).
  // argv[0]=node, argv[1]=generate-doc-cli.js, argv[2]=<slug>, argv[3..]=flags
  const slug = argv[2] ?? '';
  const isForce = argv.includes('--force');

  if (!slug || slug.startsWith('--')) {
    process.stderr.write('recense generate-doc: usage: recense generate-doc <slug> [--db <path>] [--force]\n');
    process.exit(1);
  }

  // ── 2. Validate DB path BEFORE acquiring lock (WR-02) ─────────────────────
  const dbPath = resolveSharedDbPath(argv, { fallbackToDefault: false });
  if (!dbPath) {
    process.stderr.write(
      'recense generate-doc: No DB path (--db <path> or RECENSE_DB env var) — exiting\n',
    );
    process.exit(0);
  }

  // ── 3. Raise timeouts BEFORE reading the budget for the lock-wait loop ─────
  // Set these before reading the budget value so the lock-wait uses the same
  // 600s headroom as the generation call itself.
  if (!process.env['RECENSE_CLAUDE_HEADLESS_TIMEOUT_MS']) {
    process.env['RECENSE_CLAUDE_HEADLESS_TIMEOUT_MS'] = '600000';
  }
  if (!process.env['RECENSE_SDK_TIMEOUT_MS']) {
    process.env['RECENSE_SDK_TIMEOUT_MS'] = '600000';
  }

  // ── 4. Bounded lock-wait loop (D-2, T-39.3-04) ───────────────────────────
  // Replaces the old instant bail: `if (!acquireLock()) { stderr; process.exit(0) }`.
  // Budget = doc-gen timeout (defaults to 600000ms = 10min) so the wait never outlasts
  // the generation itself.
  const budgetMs = Number(process.env['RECENSE_CLAUDE_HEADLESS_TIMEOUT_MS'] ?? '600000');

  const lockAcquired = await waitForLock({
    acquire: acquireLock,
    writeQueued: () => writeStatus(slug, 'queued'),
    writeFailedBusy: () => {
      writeStatus(slug, 'failed', { error: 'engine stayed busy' });
      fileLog(`give up: lock held for entire budget (${budgetMs}ms) — slug=${slug}`);
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    budgetMs,
    pollMs: POLL_MS,
  });

  if (!lockAcquired) {
    // writeStatus('failed', ...) already called by writeFailedBusy above.
    process.exit(0);
  }

  let db: Database.Database | undefined;
  try {
    fileLog(`starting: slug=${slug} force=${isForce}`);

    db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    initSchema(db);

    const config = { ...DEFAULT_CONFIG, dbPath };
    const store = new SemanticStore(db, realClock, config);

    // ── 5. Idempotency: check for existing doc node (D-02 lazy-gen) ──────────
    // BUG-2b fix (28-04): only skip as "already done" when an existing live doc has
    // a NON-EMPTY value. An empty-value stub (CorpusPromoter's eager placeholder) must
    // proceed to generation — the stub's node id will be filled in place by writeDoc
    // (stable-edge invariant). --force bypasses this check as before.
    //
    // Plan 39.3-02 (sub-step 4): the wait loop writes 'queued' BEFORE the lock is
    // acquired, and the idempotency cached-hit early-return runs AFTER the lock and
    // after the DB handle is open (it needs db). BEFORE returning, write 'done' then
    // clearStatus so the slug never leaves a dangling 'queued' status visible to the
    // viz server for up to STALE_MS. DO NOT move the check before the wait loop.
    if (!isForce) {
      const existingDoc = db.prepare(
        `SELECT n.id, n.value, nd.generated_at
         FROM node n
         JOIN node_doc nd ON nd.node_id = n.id
         JOIN node_scope ns ON ns.node_id = n.id
         WHERE n.type = 'doc' AND n.tombstoned = 0 AND ns.scope = ?
         LIMIT 1`,
      ).get(slug) as { id: string; value: string; generated_at: number } | undefined;

      if (existingDoc && existingDoc.value.trim().length > 0) {
        fileLog(`doc already exists for slug=${slug} nodeId=${existingDoc.id} — skipping (use --force to regen)`);
        process.stdout.write(
          JSON.stringify({
            nodeId: existingDoc.id,
            slug,
            generated_at: existingDoc.generated_at,
            citationCount: null,
            invented: null,
            tombstoned: null,
            cached: true,
          }) + '\n',
        );
        // Clear the 'queued' status left by the wait loop (cached-hit fast-path dangling fix).
        writeStatus(slug, 'done');
        clearStatus(slug);
        return;
      }
      // existingDoc with empty value → fall through to generation (stub fill-in-place path)
    }

    // ── 6. Build the judge-tier provider (D-04 — generateConfig = judgeConfig) ─
    // Doc-gen produces ~4000 tokens of cited prose — far slower than the small judge
    // calls the shared headless client's 120s default was tuned for. A run that crosses
    // 120s gets SIGKILL'd and the headless client returns EMPTY content (its production
    // fail-safe), which would silently persist as an empty "successful" doc. Raise the
    // doc-gen timeout to 600s (~10min headroom) when unset; env-overridable. Scoped to
    // this CLI only — the shared client's empty-on-failure fail-safe is unchanged (the
    // always-on sleep pass relies on it). Matches the sleep-pass slowness precedent.
    // (Timeouts were already raised in step 3 above, before the lock-wait loop.)

    // The judge-tier config is the strong-model slot in any env — no new docModel var.
    const judgeConfig = { ...config, ...resolveProviderOverlay(process.env, 'RECENSE_JUDGE_PROVIDER') };
    const embedConfig = config; // embedding uses base config (same pattern as sleep-pass)
    const provider = new DefaultModelProvider({
      generateConfig: judgeConfig,   // D-04: judge-tier is the generate head
      judgeConfig,
      embedConfig,
    });

    fileLog(`generating: slug=${slug} provider=${judgeConfig.modelProvider}`);

    // ── 7. Generate ───────────────────────────────────────────────────────────
    // BUG-2b fix (28-04): a slug that resolves to a live schema node is a SCHEMA-anchored
    // doc (the CorpusPromoter's slug = schemaId). Route it through generateDocForSchema
    // (D-09 thesis framing); a non-schema slug is a project-scope doc → generateDoc. The
    // schema's evidence is linked by `abstracts` edges, not node_scope, so the scope gather
    // would find nothing — the branch is load-bearing, not cosmetic.
    const schemaRow = db.prepare(
      "SELECT value FROM node WHERE id = ? AND type = 'schema' AND tombstoned = 0",
    ).get(slug) as { value: string } | undefined;

    // Wire onPhase → writeStatus so gathering/generating/verifying land in the status file.
    const onPhase = (phase: string) => writeStatus(slug, phase as Parameters<typeof writeStatus>[1]);

    let genResult;
    if (schemaRow) {
      // Centroid = mean of the schema's abstracted live observed fact/entity member embeddings
      // (D-37 gate, Pitfall 5 byteOffset decode). Delegated to computeSchemaCentroid (CORPUS-06)
      // so the logic is defined once; null → semantic-breadth pass is skipped.
      const centroid = computeSchemaCentroid(db, slug);
      fileLog(`schema-anchored: label="${schemaRow.value}" centroid=${centroid ? 'yes' : 'null'}`);
      genResult = await generateDocForSchema(
        { db, store, provider },
        { schemaId: slug, centroid, schemaLabel: schemaRow.value },
        { onPhase },
      );
    } else {
      genResult = await generateDoc({ db, store, provider }, slug, { onPhase });
    }

    fileLog(
      `generated: citations=${genResult.citationCount} invented=${genResult.invented} tombstoned=${genResult.tombstoned}`,
    );

    // ── 8. Write (finalizing phase) ───────────────────────────────────────────
    // Write 'finalizing' immediately before writeDoc + DocGraphDeriver so the reader
    // sees a meaningful phase during the DB write (covers both steps 8 and 8b).
    writeStatus(slug, 'finalizing');

    // All writes through the single-writer path (T-27-07).
    const now = realClock.nowMs();
    writeDoc(store, db, {
      docId: genResult.docId,
      slug,
      markdown: genResult.markdown,
      citedFactIds: genResult.citedFactIds,
      linkedDocRefs: genResult.linkedDocRefs, // WR-01: write doc_link edges on the lazy path too (parity with corpus-generator)
      now,
    });

    fileLog(`written: nodeId=${genResult.docId}`);

    // ── 8b. Re-derive the doc-graph (Phase 39.2 — keep regen from orphaning a doc) ──
    // Regeneration mints a NEW doc node id and tombstones the old one, stranding the
    // node-id-keyed doc_containment/doc_reference edges on the dead node — the regenerated doc
    // would render disjoint until the next sleep pass. DocGraphDeriver is the sole owner of those
    // edges (D-11); its LLM-free wipe-and-rebuild re-keys them onto the live node via slug/scope,
    // restoring the doc's hub→subject / subject→chapter / cross-project links immediately.
    // Non-fatal: the doc write already succeeded; an edge-rebuild hiccup just defers reconnection
    // to the next sleep pass.
    try {
      const docGraph = await new DocGraphDeriver(db, store, config, realClock).deriveDocGraph();
      fileLog(`doc-graph re-derived: containment=${docGraph.containment} reference=${docGraph.reference}`);
    } catch (e) {
      fileLog(`doc-graph re-derive skipped (non-fatal): ${e}`);
    }

    // ── 9. Emit result JSON ───────────────────────────────────────────────────
    process.stdout.write(
      JSON.stringify({
        nodeId: genResult.docId,
        slug,
        generated_at: now,
        citationCount: genResult.citationCount,
        invented: genResult.invented,
        tombstoned: genResult.tombstoned,
        cached: false,
      }) + '\n',
    );

    // Mark done and clean up the status file after a successful commit.
    writeStatus(slug, 'done');
    clearStatus(slug);
  } catch (err) {
    // Report the real failure reason in the status file BEFORE stderr/exitCode handling.
    writeStatus(slug, 'failed', { error: String(err) });
    fileLog(`error: ${err}`);
    process.stderr.write(`recense generate-doc: ${err}\n`);
    process.exitCode = 1;
  } finally {
    db?.close();
    releaseLock();
  }
}

// Only run when invoked as the entry point (dispatched via recense.ts subprocess),
// NOT when imported by a unit test or when require()-d without being main.
if (require.main === module) {
  main().catch(err => {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] generate-doc FATAL: ${err}\n`);
    releaseLock();
    process.exit(1);
  });
}
