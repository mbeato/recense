#!/usr/bin/env node
/**
 * brain — single dispatcher entry point (D-86).
 *
 * Routes `brain <command>` to the correct handler module using lazy require()
 * inside each case so only the matched handler pays its load cost (D-87).
 *
 * Design invariants:
 *  - No top-level import/require of handler modules (D-87 lazy-require compliance).
 *  - Hook subcommands (session-start, turn-capture, stop) load only when invoked.
 *  - Unknown commands fail closed: stderr + exit 1 (T-09-08).
 *  - Handler CLIs that use `require.main === module` guards (seed, ingest, sleep-pass)
 *    are dispatched via spawnSync so the guard fires correctly in the child.
 *
 * Threat mitigations:
 *  - T-09-07: D-87 conditional require() — only the matched handler loads; no top-level
 *    handler imports that would pay the full load cost on every invocation.
 *  - T-09-08: default case prints usage and exits 1 (fail-closed on unknown argv).
 */

// Pin the Node runtime BEFORE any handler (and thus better-sqlite3) loads. Re-execs under
// RECENSE_NODE_BIN when the ambient Node's ABI would mismatch the native addon, so
// `brain` works in any terminal regardless of the user's nvm default (DX). One-hop guarded;
// no-op when already on the right Node or when no pin is configured. pin-node imports only
// Node built-ins, so this stays off the better-sqlite3 load path.
(require('./pin-node') as typeof import('./pin-node')).pinNodeRuntime(__filename);

// Hydrate the recense config (DB path, API keys, model) from the env file the launchd
// jobs already source, for any key absent from the shell — so interactive `brain <cmd>`
// resolves the SAME DB/config as the background jobs instead of an empty default DB.
// Set-only-if-missing: an explicit shell env or `--db <flag>` still wins.
(require('./runtime-config') as typeof import('./runtime-config')).hydrateRuntimeEnv();

const cmd  = process.argv[2];
const sub  = process.argv[3];
const rest = process.argv.slice(4);

/**
 * Spawn a compiled CLI script as a subprocess and forward its exit code.
 * Used for CLIs that guard execution with `require.main === module` (test isolation).
 * stdio: 'inherit' keeps the user's terminal connected to the child process.
 */
function spawnScript(name: string, argv: string[]): never {
  const { spawnSync } = require('child_process') as typeof import('child_process');
  const { resolve }   = require('path') as typeof import('path');
  const r = spawnSync(process.execPath, [resolve(__dirname, name), ...argv], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

switch (cmd) {

  // ── Hook subcommands (D-87: only the matched handler loads) ──────────────────
  case 'hook':
    switch (sub) {
      case 'session-start': require('./session-start-cli'); break;
      case 'turn-capture':  require('./turn-capture-cli');  break;
      case 'stop':          require('./stop-cli');           break;
      default:
        process.stderr.write(`recense hook: unknown subcommand '${sub ?? '(none)'}'\n`);
        process.exit(1);
    }
    break;

  // ── Operator commands that auto-invoke main() on require() ───────────────────
  case 'recall':   require('./recall-cli');   break;
  case 'snapshot': require('./snapshot-cli'); break;

  // ── Forward-declared commands (implemented in later plans) ───────────────────
  case 'viz':    require('./recense-viz-cli'); break;

  // ── Scheduler (exports runSchedulerCommand; not auto-invoking) ───────────────
  case 'scheduler': {
    const sched = require('./recense-scheduler') as { runSchedulerCommand: (s: string | undefined, r: string[]) => void };
    sched.runSchedulerCommand(sub, rest);
    break;
  }

  // ── CLIs with require.main guard — dispatch via subprocess ───────────────────
  // H-1: forward argv[3..] (process.argv.slice(3)) so the child receives all
  // positional args and flags (e.g. `recense ingest gmail` or `recense seed --db /x`).
  // The local `rest = slice(4)` is intentionally NOT used here — it drops argv[3].
  // recense-init.ts guards execution with `require.main === module` (interactive wizard)
  // so a bare require() would never invoke main(). Spawn as a subprocess so the guard
  // fires correctly in the child (consistent with mcp/serve dispatch pattern).
  case 'init':       spawnScript('recense-init.js',    process.argv.slice(3)); break;
  case 'sleep-pass': spawnScript('sleep-pass-cli.js', process.argv.slice(3)); break;
  case 'seed':       spawnScript('seed-cli.js',       process.argv.slice(3)); break;
  case 'ingest':     spawnScript('ingest-cli.js',     process.argv.slice(3)); break;
  // import-memory-cli.ts guards execution with `require.main === module` (it exports
  // planImport/runImport for unit tests), so spawn as a subprocess so the guard fires.
  case 'import-memory': spawnScript('import-memory-cli.js', process.argv.slice(3)); break;
  // ingest-project-cli.ts guards execution with `require.main === module` (it exports
  // parseIngestArgs/resolveSurveyScope/resolveSurveyCwd/runSurveyAndFeed for unit tests),
  // so spawn as a subprocess so the guard fires correctly in the child.
  case 'ingest-project': spawnScript('ingest-project-cli.js', process.argv.slice(3)); break;
  // dedup-entities-cli.ts guards execution with `require.main === module` (it exports
  // printDryRun for unit tests), so spawn as a subprocess so the guard fires.
  case 'dedup-entities': spawnScript('dedup-entities-cli.js', process.argv.slice(3)); break;
  // dedup-facts-cli.ts guards execution with `require.main === module` (it exports
  // printDryRun for unit tests), so spawn as a subprocess so the guard fires.
  case 'dedup-facts': spawnScript('dedup-facts-cli.js', process.argv.slice(3)); break;
  // cleanup-corpus-cli.ts guards execution with `require.main === module` (it exports
  // enumerateJunkDocs/printDryRunReport/hardDeleteJunkDocs for unit tests), so spawn
  // as a subprocess so the guard fires correctly in the child.
  // Default: dry-run ON; real mutating run requires --no-dry-run (T-25-06 discipline).
  case 'cleanup-corpus': spawnScript('cleanup-corpus-cli.js', process.argv.slice(3)); break;
  // remember-cli.ts guards execution with `require.main === module` (it exports helpers for
  // unit tests + holds the write lock + runs the judge synchronously), so spawn as a subprocess
  // so the guard fires correctly in the child. Use slice(3) NOT rest/slice(4) — slice(4) drops
  // argv[3] which is the "<fact>" positional (H-1 note: same invariant as other write-CLIs).
  case 'remember': spawnScript('remember-cli.js', process.argv.slice(3)); break;
  // generate-doc-cli.ts guards execution with `require.main === module` (write-capable,
  // lock-guarded; READER-01 — generates a lifecycle-exempt type='doc' node for a project slug).
  case 'generate-doc': spawnScript('generate-doc-cli.js', process.argv.slice(3)); break;
  // promote-corpus-cli.ts guards execution with `require.main === module` (write-capable,
  // lock-guarded; CORPUS-02/03/05 — LLM-free idempotent corpus-promotion pass that derives
  // doc_containment + doc_reference edges between schema-anchored doc stubs).
  case 'promote-corpus': spawnScript('promote-corpus-cli.js', process.argv.slice(3)); break;
  // generate-corpus-cli.ts guards execution with `require.main === module` (write-capable,
  // lock-guarded; CORPUS-06 — fills empty schema-anchored corpus doc stubs with prose via
  // the offline judge-tier generation path; lazy-on-click stays as fallback).
  case 'generate-corpus': spawnScript('generate-corpus-cli.js', process.argv.slice(3)); break;
  // mcp-cli exports createBrainMcpServer for tests, so its CLI entry is guarded by
  // `require.main === module` — a bare require() here would never fire the guard
  // (require.main stays recense.js) and the server would never start.
  case 'mcp':        spawnScript('mcp-cli.js',        process.argv.slice(3)); break;
  case 'serve':      spawnScript('serve-cli.js',      process.argv.slice(3)); break;
  // recense-doctor exports check helpers for unit tests, so its entry is guarded by
  // `require.main === module` (WR-01) — spawn so the guard fires in the child.
  case 'doctor':     spawnScript('recense-doctor.js',   process.argv.slice(3)); break;

  // ── Default: fail closed (T-09-08) ───────────────────────────────────────────
  default:
    process.stderr.write(
      'Usage: brain <command> [args]\n' +
      'Commands: hook, init, doctor, recall, remember, viz, sleep-pass, seed, ingest, import-memory, ingest-project, dedup-entities, dedup-facts, cleanup-corpus, generate-doc, promote-corpus, generate-corpus, snapshot, scheduler, mcp, serve\n',
    );
    process.exit(1);
}
