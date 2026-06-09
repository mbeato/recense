/**
 * brain-scheduler — cross-platform Scheduler seam (SCHED-01, SCHED-02, D-92).
 *
 * Exports runSchedulerCommand(sub, args) — dispatched by brain.ts 'scheduler' case.
 *
 * Commands:
 *  install → macOS: idempotent launchd registration (bootout + enable + bootstrap).
 *            Linux: honest D-92 guidance (foreground process; no daemon/pidfile).
 *  status  → macOS: launchctl print registration check.
 *            Linux: pgrep-based liveness (informational; not-running is NOT an error).
 *  run     → macOS: error — use launchd instead.
 *            Linux: croner hourly sleep-pass in-process (blocks until Ctrl+C).
 *
 * Design invariants (D-92):
 *  - macOS: launchd unchanged; no new pidfile/daemon machinery.
 *  - Linux: foreground process only; reboot-survival is v2.1 (systemd).
 *  - Croner tick: acquireLock → db = new Database → initSchema → runConsolidation
 *    → finally { db?.close(); releaseLock() }.
 *  - protect:true skips a tick if the prior run is still active (overrun guard,
 *    T-09-13 / Pitfall 4).
 *
 * Threat mitigations:
 *  - T-09-13: croner { protect: true } + O_EXCL lock — belt-and-suspenders overrun guard.
 *  - T-09-14: idempotent bootout-then-bootstrap modern launchd API (not deprecated load/unload).
 */
import { appendFileSync, readFileSync, writeFileSync } from 'fs';
import { resolve, join } from 'path';
import { execSync } from 'child_process';
import { Cron } from 'croner';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema';
import { runConsolidation } from '../consolidation/run-sleep-pass';
import { acquireLock, releaseLock } from './lockfile';

const LOG_PATH = '/tmp/brain-memory-sleep.log';

/** Append a timestamped line to the log file (never stdout/stderr for background ops). */
const log = (msg: string): void =>
  appendFileSync(LOG_PATH, `[${new Date().toISOString()}] brain-scheduler: ${msg}\n`);

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve scripts/ paths relative to this compiled module's location.
 * Compiled output: dist/src/adapter/brain-scheduler.js
 * Project root:    dist/src/adapter/ → ../../.. = project root.
 */
function resolveScriptPaths(): { plistTemplate: string; wrapperPath: string } {
  const projectRoot = resolve(__dirname, '../../..');
  return {
    plistTemplate: join(projectRoot, 'scripts', 'com.brain-memory.sleep-pass.plist.template'),
    wrapperPath: join(projectRoot, 'scripts', 'sleep-pass-launchd.sh'),
  };
}

// ---------------------------------------------------------------------------
// macOS launchd functions
// ---------------------------------------------------------------------------

function installMacOSScheduler(): void {
  const { plistTemplate, wrapperPath } = resolveScriptPaths();
  const uid = execSync('id -u', { encoding: 'utf8' }).trim();
  const domain = `gui/${uid}`;
  const label = 'com.brain-memory.sleep-pass';
  const home = process.env['HOME'] ?? '/tmp';

  const envFilePath =
    process.env['BRAIN_MEMORY_SLEEP_ENV'] ??
    join(home, '.config', 'brain-memory', 'sleep.env');
  const launchAgentsDir = join(home, 'Library', 'LaunchAgents');
  const plistDst = join(launchAgentsDir, `${label}.plist`);

  // Substitute plist template — mirrors setup-dogfood.sh lines 168-171
  const plistContent = readFileSync(plistTemplate, 'utf8')
    .replace(/__WRAPPER__/g, wrapperPath)
    .replace(/__ENV_FILE__/g, envFilePath);
  writeFileSync(plistDst, plistContent);
  console.log(`  Plist written: ${plistDst}`);

  // Idempotent bootout → enable → bootstrap (modern API; not deprecated load/unload)
  // bootout removes any stale registration; enable clears any disabled override;
  // bootstrap registers the plist in the user's GUI session.
  try { execSync(`launchctl bootout ${domain}/${label}`, { stdio: 'ignore' }); } catch { /* not registered yet — OK */ }
  try { execSync(`launchctl enable ${domain}/${label}`, { stdio: 'ignore' }); } catch { /* best-effort */ }
  try {
    execSync(`launchctl bootstrap ${domain} "${plistDst}"`, { stdio: 'pipe' });
    console.log(`  Loaded: ${label}`);
    console.log(`  Verify: launchctl print ${domain}/${label} | grep state`);
  } catch {
    console.error(`  Could not load from this context (need a GUI login session — not SSH/sandbox).`);
    console.error(`  Run manually: launchctl bootstrap ${domain} "${plistDst}"`);
  }
}

function checkMacOSStatus(): void {
  const label = 'com.brain-memory.sleep-pass';
  try {
    const uid = execSync('id -u', { encoding: 'utf8' }).trim();
    const domain = `gui/${uid}`;
    execSync(`launchctl print ${domain}/${label}`, { stdio: 'ignore' });
    console.log(`  ${label}: registered (macOS launchd)`);
    console.log(`  Check: launchctl print gui/${uid}/${label} | grep state`);
  } catch {
    console.log(`  ${label}: not registered`);
    console.log('  Run: brain scheduler install');
  }
}

// ---------------------------------------------------------------------------
// Linux / non-macOS functions
// ---------------------------------------------------------------------------

function printLinuxGuidance(): void {
  console.log('  brain scheduler install (Linux):');
  console.log('    Start the hourly sleep-pass with: brain scheduler run');
  console.log('    The process stops when your terminal session ends.');
  console.log('    Reboot-survival (systemd unit) is planned for v2.1.');
}

function checkLinuxStatus(): void {
  try {
    execSync('pgrep -f "brain scheduler run"', { stdio: 'ignore' });
    console.log('  brain scheduler run: running');
  } catch {
    // Not running is informational on Linux — not an error (D-92)
    console.log('  brain scheduler run: not running');
    console.log('  Start with: brain scheduler run');
  }
}

async function startLinuxScheduler(): Promise<void> {
  const dbPath = process.env['BRAIN_MEMORY_DB'];
  if (!dbPath) {
    process.stderr.write(
      'BRAIN_MEMORY_DB not set — cannot start scheduler (set it in your env file).\n',
    );
    process.exit(1);
  }

  console.log('brain scheduler run — hourly sleep-pass active (Ctrl+C to stop)');
  console.log('Note: stops when this process exits; reboot-survival is v2.1 (systemd)');
  log('Linux scheduler started');

  const job = new Cron('0 * * * *', { protect: true }, async () => {
    log('hourly tick starting');
    // Validate before lock (WR-02: lock leak prevention)
    if (!dbPath) {
      log('no DB path — skipping tick');
      return;
    }
    if (!acquireLock()) {
      log('lock held by another process — skipping tick');
      return;
    }
    let db: Database.Database | undefined;
    try {
      db = new Database(dbPath);
      initSchema(db);
      await runConsolidation(db, dbPath, process.env, log);
      log('hourly tick complete');
    } catch (err) {
      log(`hourly tick error: ${err}`);
    } finally {
      // close DB first, then release lock (seed-cli.ts lines 141-143 correct order)
      db?.close();
      releaseLock();
    }
  });

  // Block until Ctrl+C / SIGTERM — croner's job keeps the event loop alive
  process.on('SIGINT', () => { log('received SIGINT, stopping'); job.stop(); process.exit(0); });
  process.on('SIGTERM', () => { log('received SIGTERM, stopping'); job.stop(); process.exit(0); });
}

// ---------------------------------------------------------------------------
// Main dispatcher — exported for brain.ts
// ---------------------------------------------------------------------------

/**
 * Route `brain scheduler <sub>` to the correct platform implementation.
 * Called by brain.ts 'scheduler' case with the sub-argument and remaining argv.
 */
export function runSchedulerCommand(sub: string | undefined, _args: string[]): void {
  const platform = process.platform;

  switch (sub) {
    case 'install':
      if (platform === 'darwin') {
        installMacOSScheduler();
      } else {
        printLinuxGuidance();
      }
      break;

    case 'status':
      if (platform === 'darwin') {
        checkMacOSStatus();
      } else {
        checkLinuxStatus();
      }
      break;

    case 'run':
      if (platform === 'darwin') {
        process.stderr.write(
          '`brain scheduler run` is for Linux. macOS uses launchd — run `brain scheduler install`.\n',
        );
        process.exit(1);
      }
      // startLinuxScheduler returns a Promise that only resolves on signal;
      // .catch() ensures unhandled rejection triggers a clean exit.
      startLinuxScheduler().catch(err => {
        log(`scheduler run fatal: ${err}`);
        process.exit(1);
      });
      break;

    default:
      process.stderr.write('Usage: brain scheduler install|status|run\n');
      process.exit(1);
  }
}
