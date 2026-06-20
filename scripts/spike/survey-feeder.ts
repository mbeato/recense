/**
 * survey-feeder — Phase 29 THROWAWAY SPIKE (NOT production wiring).
 *
 * Proves Success Criterion 1: an agentic survey of one real repo (/Users/vtx/usage,
 * the `@mbeato/contextscope` package — D-01) emits SUMMARIZED observations (why-level,
 * no raw code — D-07/D-08) as episodes through the EXISTING offline pipeline, then runs
 * consolidation on a SCRATCH DB to mint facts stamped `[usage]` — with ZERO new runtime
 * deps (reuses the `claude -p` headless transport).
 *
 * This is a disposable harness in scripts/. It is deliberately NOT a SourceAdapter
 * implementation and NOT a `recense survey` CLI — both are deferred to Phase 30.
 * Do NOT add it to package.json bin.
 *
 * RUN (founder, subscription-billed — experiment design is human-owned per CLAUDE.md / D-02):
 *   RECENSE_LOCK_PATH=/tmp/recense-spike.lock \
 *   RECENSE_EXTRACTOR_PROVIDER=claude-headless RECENSE_JUDGE_PROVIDER=claude-headless \
 *   $RECENSE_NODE_BIN node_modules/.bin/tsx scripts/spike/survey-feeder.ts --db /tmp/recense-spike.db
 *   (RECENSE_NODE_BIN = the node better-sqlite3 was compiled against, e.g.
 *    /Users/vtx/.nvm/versions/node/v25.5.0/bin/node — a plain `npx tsx` under an
 *    nvm-default Node 22 shell hits a NODE_MODULE_VERSION ABI mismatch.)
 *
 * ISOLATION (D-05, load-bearing):
 *  - Scratch DB only: defaults to /tmp/recense-spike.db; ABORTS if the resolved path is
 *    the live brain (~/.config/recense/recense.db) — survey episodes must never pollute
 *    customer-zero (T-29-01).
 *  - RECENSE_LOCK_PATH=/tmp/recense-spike.lock (env, no code change) so getLockPath()
 *    returns the spike lock and the live hourly sleep pass is NOT blocked (the global
 *    write lock is one lock and fast-fails with no queue).
 *
 * BILLING / SELF-INGESTION (T-29-03/T-29-04): the survey agent is built via
 * createClaudeHeadlessClient, whose buildHeadlessArgs already (a) passes
 * `--setting-sources project` — dropping the global UserPromptSubmit turn-capture hook so
 * each `claude -p` call is NOT re-captured as an episode (no self-ingestion loop), and
 * (b) strips ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN from the child env so calls bill the
 * Max subscription, not the direct API. NEVER build claude argv manually here.
 *
 * NET-ZERO DEPS (Success Criterion 1): no new npm dependency is added — every import below
 * already exists in the engine.
 */
import { appendFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import type Anthropic from '@anthropic-ai/sdk';
import { initSchema } from '../../src/db/schema';
import { DEFAULT_CONFIG } from '../../src/lib/config';
import { realClock } from '../../src/lib/clock';
import { EpisodicStore } from '../../src/db/episode-store';
import { AllocationGate, IngestionPipeline } from '../../src/ingest/pipeline';
import { cwdToScope } from '../../src/lib/scope';
import { contentExternalId } from '../../src/source/source-adapter';
import { acquireLock, releaseLock } from '../../src/adapter/lockfile';
import { createClaudeHeadlessClient } from '../../src/model/claude-headless-client';
import { runConsolidation, resolveProviderOverlay } from '../../src/consolidation/run-sleep-pass';
import type { EngineConfig } from '../../src/lib/config';

// ── Spike constants ──────────────────────────────────────────────────────────

/** The survey target repo (D-01). Its cwd → scope 'usage' via cwdToScope. */
const SURVEY_CWD = '/Users/vtx/usage';

/** Scratch-DB default — NEVER the live brain (D-05). */
const SCRATCH_DB = '/tmp/recense-spike.db';

/** Disposable log (import-memory-cli pattern). */
const LOG_PATH = '/tmp/recense-survey-spike.log';

/**
 * The five INGEST-03 survey areas (D-06). Success Criterion 2 measures ≥5 genuine
 * facts PER AREA, so each area is surveyed independently with its own session id.
 */
export const SURVEY_AREAS = [
  'architecture',
  'conventions',
  'decisions',
  'current-state',
  'gotchas',
] as const;
export type SurveyArea = (typeof SURVEY_AREAS)[number];

/** Append a timestamped line to the spike log. */
const fileLog = (msg: string): void =>
  appendFileSync(LOG_PATH, `[${new Date().toISOString()}] survey-spike: ${msg}\n`);

// ── Survey prompt (D-08 — summarization prompt shape; calibration deliverable) ──

/**
 * Build the per-area survey prompt (D-08). This exact shape is a Phase-30 calibration
 * output — keep the "summarized / why-not-what / no-raw-code / no-import-graph" clauses
 * intact. The agent runs with Read/Grep/Glob over SURVEY_CWD and returns natural-language
 * belief statements, ~one belief per line, suited to the existing claim extractor.
 */
export function buildSurveyPrompt(area: SurveyArea): string {
  return [
    `You are surveying the local code repository at ${SURVEY_CWD} (the @mbeato/contextscope`,
    `package — a CLI + local Next.js dashboard that audits per-turn Claude Code token context).`,
    `Use your Read, Grep, and Glob tools to read the real repo: README.md, AGENTS.md, DESIGN.md,`,
    `PLAN.md, and the app/, bin/, lib/, plugin/, and scripts/ directories.`,
    ``,
    `Report SUMMARIZED OBSERVATIONS about this ONE area: "${area}".`,
    ``,
    `Write WHY, NOT WHAT. Emit why-level semantic knowledge a senior engineer would tell a`,
    `new teammate: architecture rationale, conventions and the reasons behind them, design`,
    `decisions and their tradeoffs, the current state of the project, and gotchas.`,
    ``,
    `STRICT QUALITY GATE — your output MUST NOT contain:`,
    `  - any raw code lines or code snippets,`,
    `  - import/dependency graphs or dependency lists ("file X imports Y"),`,
    `  - structural trivia (file listings, "module A calls module B"),`,
    `  - config dumps or boilerplate.`,
    `Only summarized, why-level semantic knowledge belongs in the output.`,
    ``,
    `Format: natural-language belief statements, roughly ONE belief per line, each a complete`,
    `standalone sentence. No headers, no bullets, no numbering, no preamble — just the belief`,
    `lines. If you have nothing genuine to say for this area, return an empty response.`,
  ].join('\n');
}

// ── Task 1: survey agent — summarized observations per INGEST-03 area ──────────

/**
 * Invoke the survey agent once for `area` over SURVEY_CWD via the existing headless
 * transport. Returns the agent's raw text response, or '' on empty/timeout/failure
 * (the headless client's fail-safe-empty contract) so the caller can guard.
 *
 * The agent is built from the judge-tier config (D-03) — the strong-model slot — reusing
 * resolveProviderOverlay exactly as generate-doc-cli does.
 */
export async function surveyArea(area: SurveyArea, judgeConfig: EngineConfig): Promise<string> {
  const { client, model } = createClaudeHeadlessClient(judgeConfig);
  const prompt = buildSurveyPrompt(area);

  fileLog(`survey: area=${area} model=${model} cwd=${SURVEY_CWD}`);
  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  } as Anthropic.MessageCreateParamsNonStreaming);

  const block = response.content[0] as { text?: string } | undefined;
  const text = (block?.text ?? '').trim();
  if (!text) {
    // Fail-safe empty: timeout / non-zero exit / unparseable envelope. Guarded, not thrown.
    fileLog(`survey: area=${area} EMPTY response (timeout/failure) — skipping`);
    return '';
  }
  return text;
}

/**
 * Split a survey agent response into episode-sized records: one belief-line per record.
 * Blank lines are dropped. Chunking granularity is the spike's discretion (CONTEXT.md);
 * one-belief-per-line matches the prompt's requested shape and the claim extractor.
 */
export function splitObservations(text: string): string[] {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
}

// ── Task 2: episode feeder + scratch-DB consolidation under the spike lock ─────

/**
 * Resolve the scratch DB path: --db <path> > RECENSE_DB > /tmp/recense-spike.db (D-05).
 * Returns null (caller aborts) if the resolved path is the live brain.
 */
export function resolveScratchDbPath(argv: string[]): string | null {
  const i = argv.indexOf('--db');
  const fromArg = i !== -1 && typeof argv[i + 1] === 'string' && argv[i + 1] !== '' ? argv[i + 1]! : undefined;
  const dbPath = fromArg ?? process.env['RECENSE_DB'] ?? SCRATCH_DB;
  const liveBrain = join(homedir(), '.config', 'recense', 'recense.db');
  if (dbPath === liveBrain) return null; // T-29-01: never the live brain
  return dbPath;
}

async function main(): Promise<void> {
  const argv = process.argv;

  // ── Scope-tagging assertion BEFORE any DB open (spike deliverable, D-04) ──────
  const scope = cwdToScope(SURVEY_CWD);
  if (scope !== 'usage') {
    process.stderr.write(`scope assertion failed: cwdToScope('${SURVEY_CWD}') === '${scope}', expected 'usage' — exiting\n`);
    process.exit(1);
  }

  // ── Validate DB path BEFORE acquireLock (WR-02 lock-leak prevention) ──────────
  const dbPath = resolveScratchDbPath(argv);
  if (dbPath === null) {
    process.stderr.write('Refusing to run against the live brain DB (~/.config/recense/recense.db) — use --db /tmp/recense-spike.db — exiting\n');
    process.exit(1);
  }

  // --consolidate-only: skip the (expensive, subscription-billed) survey/feed and
  // re-run consolidation on episodes already in the scratch DB. Use after a survey
  // succeeded but consolidation failed (e.g. missing OPENAI_API_KEY) — re-surveying
  // would re-bill the agent runs for data we already have.
  const consolidateOnly = argv.includes('--consolidate-only');

  // Pre-flight: consolidation embeds via OpenAI. Fail loud BEFORE the long survey
  // rather than swallowing 350+ per-episode "skipped" errors and reporting a false
  // "Sleep pass complete" with 0 facts. (Manual runs must export OPENAI_API_KEY —
  // it lives in ~/.config/recense/sleep.env, which the launchd pass sources.)
  if (!process.env['OPENAI_API_KEY']) {
    process.stderr.write('OPENAI_API_KEY is missing — consolidation embeds via OpenAI and would skip every episode.\n  Export it (e.g. from ~/.config/recense/sleep.env) before running — exiting\n');
    process.exit(1);
  }

  // RECENSE_LOCK_PATH=/tmp/recense-spike.lock is set via env at run time so getLockPath()
  // returns the spike lock and the live hourly pass is never blocked (no code change).
  if (!acquireLock()) {
    process.stderr.write('Lock held by another process — exiting\n');
    process.exit(0);
  }

  // Long agent runs (same precedent as doc-gen): raise the headless timeout if unset.
  if (!process.env['RECENSE_CLAUDE_HEADLESS_TIMEOUT_MS']) {
    process.env['RECENSE_CLAUDE_HEADLESS_TIMEOUT_MS'] = '600000';
  }

  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath);
    initSchema(db);
    const config: EngineConfig = { ...DEFAULT_CONFIG, dbPath };
    const judgeConfig: EngineConfig = { ...config, ...resolveProviderOverlay(process.env, 'RECENSE_JUDGE_PROVIDER') };
    const episodes = new EpisodicStore(db, realClock, config);
    const pipeline = new IngestionPipeline(new AllocationGate(config), episodes);

    fileLog(`start: dbPath=${dbPath} scope=${scope} judge=${judgeConfig.modelProvider}`);

    // ── Feed: survey each area, emit one episode per belief-line ───────────────
    const perArea: Record<string, number> = {};
    let total = 0;
    if (consolidateOnly) {
      fileLog('consolidate-only: skipping survey/feed, re-consolidating existing episodes');
    } else {
      for (const area of SURVEY_AREAS) {
        const text = await surveyArea(area, judgeConfig);
        const observations = splitObservations(text);
        let fed = 0;
        for (const content of observations) {
          pipeline.recordEvent({
            content,
            role: 'user',
            origin: 'observed', // D-04: survey output is observed, NEVER asserted_by_user
            sessionId: `project-survey:usage:${area}`,
            source: 'project-survey',
            externalId: contentExternalId(`usage/${area}`, content),
            cwd: '/Users/vtx/usage', // === SURVEY_CWD; load-bearing literal drives scope='usage'
          });
          fed++;
        }
        perArea[area] = fed;
        total += fed;
        fileLog(`fed: area=${area} episodes=${fed}`);
      }
    }

    // ── Consolidate on the scratch DB under the SAME held lock (CONSOL-03) ──────
    // Run with RECENSE_EXTRACTOR_PROVIDER=claude-headless RECENSE_JUDGE_PROVIDER=claude-headless
    // (set via env at run time) so consolidation mints facts via the headless transport.
    fileLog('consolidation: starting sleep pass on scratch DB');
    await runConsolidation(db, dbPath, process.env, fileLog);
    fileLog('Sleep pass complete');

    // ── Final summary ──────────────────────────────────────────────────────────
    const areaSummary = SURVEY_AREAS.map(a => `${a}=${perArea[a] ?? 0}`).join(' ');
    process.stdout.write(consolidateOnly
      ? `survey-feeder done — consolidate-only: re-consolidated existing episodes (no survey)\n`
      : `survey-feeder done — episodes fed per area: ${areaSummary} | total=${total}\n`);
    process.stdout.write(`scratch DB: ${dbPath} (live brain untouched) — see ${LOG_PATH}\n`);
    fileLog(`done: total=${total} perArea=${JSON.stringify(perArea)}`);
  } catch (err) {
    fileLog(`error: ${err}`);
    // Surface to stderr too — a file-only log here masks the failure as a silent
    // exit (e.g. better-sqlite3 ABI mismatch under the wrong node), which reads
    // as "nothing happened" in the terminal. Fail loud.
    process.stderr.write(`survey-feeder FAILED: ${err}\nSee ${LOG_PATH}\n`);
    process.exitCode = 1;
  } finally {
    db?.close();
    releaseLock();
  }
}

// Only run when invoked as the entry point, NOT when imported by a test of the helpers.
if (require.main === module) {
  main().catch(err => {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] survey-spike FATAL: ${err}\n`);
    releaseLock();
    process.exit(1);
  });
}
