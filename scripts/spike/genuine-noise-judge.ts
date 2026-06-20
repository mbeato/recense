/**
 * genuine-noise-judge — Phase 29 THROWAWAY SPIKE harness (NOT production wiring).
 *
 * Measurement instrument for the Phase-29 go/no-go (Plan 03 writes it up):
 *   - Success Criterion 2 (D-02): each fact stamped `[usage]` in the scratch DB is judged
 *     `genuine | noise` by the EXISTING headless judge tier (net-zero new deps), tallied
 *     per INGEST-03 area, with the ≥5-genuine bar evaluated per area + every verdict line
 *     printed so the founder can spot-check (the LLM tally is auditable, never authoritative).
 *   - Success Criterion 3: the schemas induced from the `usage` facts are inspected
 *     (count + labels + #facts each generalizes) to prove the abstraction layer fired.
 *
 * This is a disposable harness in scripts/. It is READ-ONLY (opens the scratch DB with
 * `{ readonly: true }` — T-29-05) and is NOT added to package.json bin.
 *
 * RUN (founder, subscription-billed — D-02 measurement is human-owned per CLAUDE.md):
 *   RECENSE_LOCK_PATH=/tmp/recense-spike.lock RECENSE_JUDGE_PROVIDER=claude-headless \
 *   /Users/vtx/.nvm/versions/node/v25.5.0/bin/node node_modules/.bin/tsx \
 *   scripts/spike/genuine-noise-judge.ts --db /tmp/recense-spike.db
 *
 *   (Use the pinned node bin — better-sqlite3 is compiled for Node 25 / ABI 141; a plain
 *    `npx tsx` under an nvm-default Node 22 shell hits a NODE_MODULE_VERSION mismatch.
 *    OPENAI_API_KEY is NOT needed — this harness embeds nothing and writes nothing; the
 *    judge is claude-headless (subscription-billed). RECENSE_JUDGE_PROVIDER=claude-headless
 *    IS required so the judge routes to the headless transport.)
 *
 * BILLING / SELF-INGESTION (T-29-06): the judge is built via createClaudeHeadlessClient,
 * whose buildHeadlessArgs (a) passes `--setting-sources project` — dropping the global
 * UserPromptSubmit turn-capture hook so each `claude -p` call is NOT re-captured as an
 * episode (no self-ingestion loop), and (b) strips ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN
 * from the child env so calls bill the Max subscription, not the direct API. NEVER build
 * claude argv manually here.
 *
 * NET-ZERO DEPS (Success Criterion 1): no new npm dependency — every import already exists.
 */
import { homedir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import type Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_CONFIG } from '../../src/lib/config';
import { createClaudeHeadlessClient } from '../../src/model/claude-headless-client';
import { resolveProviderOverlay } from '../../src/consolidation/run-sleep-pass';
import type { EngineConfig } from '../../src/lib/config';

// ── Spike constants ──────────────────────────────────────────────────────────

/** Scratch-DB default — NEVER the live brain (D-05). */
const SCRATCH_DB = '/tmp/recense-spike.db';

/** The five INGEST-03 survey areas (D-06) — Success Criterion 2 measures ≥5 genuine PER area. */
const SURVEY_AREAS = ['architecture', 'conventions', 'decisions', 'current-state', 'gotchas'] as const;

/** The ≥5-genuine-per-area bar (Success Criterion 2 / D-02). */
const GENUINE_BAR = 5;

type Verdict = 'genuine' | 'noise' | 'unknown';
interface FactRow { id: string; value: string; area: string }
interface AreaTally { genuine: number; noise: number; unknown: number }

// ── Judge prompt (D-07 quality gate — Plan 03 calibration deliverable) ─────────

/**
 * The D-07 quality-gate definition, as a one-word classifier prompt. `{{FACT}}` is the
 * fact's value text. Keep the genuine/noise definitions intact — Plan 03 records this
 * verbatim as the calibration phrasing.
 */
const JUDGE_PROMPT = [
  `You are auditing the quality of a fact extracted from an automated survey of a code`,
  `repository. Classify the fact as exactly one of two categories.`,
  ``,
  `GENUINE = summarized, why-level semantic knowledge a senior engineer would tell a new`,
  `teammate: architecture rationale, conventions and the reasons behind them, design`,
  `decisions and their tradeoffs, the current state of the project, or a gotcha. It`,
  `explains WHY or captures a non-obvious insight.`,
  ``,
  `NOISE = a raw code line or snippet, structural trivia ("file X imports Y", "module A`,
  `calls module B"), a dependency or import list, boilerplate, or a config dump. It states`,
  `WHAT the code literally is without why-level insight.`,
  ``,
  `Fact to classify:`,
  `"""`,
  `{{FACT}}`,
  `"""`,
  ``,
  `Answer with EXACTLY one word, lowercase, no punctuation: genuine OR noise.`,
].join('\n');

// ── DB access (read-only) ──────────────────────────────────────────────────────

/** Resolve the scratch DB path: --db <path> > RECENSE_DB > /tmp/recense-spike.db (D-05). */
function resolveScratchDbPath(argv: string[]): string {
  const i = argv.indexOf('--db');
  const fromArg = i !== -1 && typeof argv[i + 1] === 'string' && argv[i + 1] !== '' ? argv[i + 1]! : undefined;
  return fromArg ?? process.env['RECENSE_DB'] ?? SCRATCH_DB;
}

/** Refuse to even read the live brain by default isolation hygiene (T-29-01 spirit). */
function isLiveBrain(dbPath: string): boolean {
  return dbPath === join(homedir(), '.config', 'recense', 'recense.db');
}

/**
 * Query the scratch DB for facts stamped `[usage]`, mapping each fact back to its INGEST-03
 * area. Facts ARE scoped (node_scope.scope='usage', finding #3 — 166 rows), so the scope
 * join is correct for facts. Area is derived by joining through the contributing episodes'
 * session_id (`project-survey:usage:<area>`) via consolidation_event; falls back to the raw
 * source tag bucket if the join is empty (finding #4).
 */
function loadUsageFacts(db: Database.Database): FactRow[] {
  // node has no created_at column (finding #2) — order by rowid, not created_at.
  const rows = db.prepare(`
    SELECT n.id AS id, n.value AS value,
      (
        SELECT e.session_id
        FROM consolidation_event ce
        JOIN episode e ON e.id = ce.episode_id
        WHERE ce.node_id = n.id AND e.session_id LIKE 'project-survey:usage:%'
        LIMIT 1
      ) AS sid
    FROM node n
    JOIN node_scope ns ON ns.node_id = n.id
    WHERE n.type = 'fact' AND n.tombstoned = 0 AND ns.scope = 'usage'
    ORDER BY n.rowid
  `).all() as Array<{ id: string; value: string; sid: string | null }>;

  return rows.map(r => ({
    id: r.id,
    value: r.value,
    // 'project-survey:usage:<area>' → '<area>'; fall back to 'unmapped' if the join was empty.
    area: r.sid ? r.sid.replace(/^project-survey:usage:/, '') : 'unmapped',
  }));
}

// ── Task 1: per-fact genuine/noise judge + per-area tally ──────────────────────

/** Judge one fact via the headless transport. Returns 'unknown' on empty/timeout/failure. */
async function judgeFact(
  client: ReturnType<typeof createClaudeHeadlessClient>['client'],
  model: string,
  fact: FactRow,
): Promise<Verdict> {
  const response = await client.messages.create({
    model,
    max_tokens: 64,
    messages: [{ role: 'user', content: JUDGE_PROMPT.replace('{{FACT}}', fact.value) }],
  } as Anthropic.MessageCreateParamsNonStreaming);

  const block = response.content[0] as { text?: string } | undefined;
  const raw = (block?.text ?? '').trim().toLowerCase();
  // Fail-safe: empty (timeout / non-zero exit / unparseable envelope) → 'unknown', never throw.
  if (!raw) return 'unknown';
  // Be lenient about the one-word contract: match the word anywhere in a short reply.
  if (/\bgenuine\b/.test(raw)) return 'genuine';
  if (/\bnoise\b/.test(raw)) return 'noise';
  return 'unknown';
}

// ── Task 2: schema-induction inspection ────────────────────────────────────────

/**
 * Report the schemas induced from the usage facts (Success Criterion 3). Schemas carry NO
 * node_scope='usage' row (finding #1 — 16 schemas exist, 0 match a scope='usage' join), so
 * count/label them WITHOUT the scope join. Best-effort: report #facts each schema generalizes
 * via outgoing abstracts/schema_rel edges (a schema's src edges point at its member facts).
 */
function reportSchemas(db: Database.Database): void {
  const schemas = db.prepare(`
    SELECT id, value FROM node WHERE type = 'schema' AND tombstoned = 0 ORDER BY rowid
  `).all() as Array<{ id: string; value: string }>;

  const memberCount = db.prepare(`
    SELECT COUNT(*) AS c FROM edge WHERE src = ? AND kind IN ('abstracts', 'schema_rel')
  `);

  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  SCHEMA-INDUCTION INSPECTION (Success Criterion 3)');
  console.log('═══════════════════════════════════════════════════════════');
  for (const s of schemas) {
    const m = memberCount.get(s.id) as { c: number };
    const label = s.value.length > 70 ? `${s.value.slice(0, 70)}…` : s.value;
    console.log(`  • ${label}  (generalizes ${m.c} fact${m.c === 1 ? '' : 's'})`);
  }
  const pass = schemas.length >= 1;
  console.log('');
  console.log(`  SCHEMAS INDUCED: ${schemas.length} (need >= 1) — ${pass ? 'PASS' : 'FAIL'}`);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const dbPath = resolveScratchDbPath(process.argv);
  if (isLiveBrain(dbPath)) {
    process.stderr.write('Refusing to read the live brain DB — pass --db /tmp/recense-spike.db — exiting\n');
    process.exit(1);
  }

  // Read-only: this harness only queries the scratch DB, never writes (T-29-05).
  const db = new Database(dbPath, { readonly: true });

  try {
    const facts = loadUsageFacts(db);
    if (facts.length === 0) {
      process.stderr.write(`No [usage] facts in ${dbPath} — run survey-feeder first — exiting\n`);
      process.exit(1);
    }

    // Reuse the existing judge tier (D-02) — net-zero new deps. Raise the timeout for the
    // long batch (same precedent as doc-gen) if the caller hasn't pinned one.
    if (!process.env['RECENSE_CLAUDE_HEADLESS_TIMEOUT_MS']) {
      process.env['RECENSE_CLAUDE_HEADLESS_TIMEOUT_MS'] = '600000';
    }
    const judgeConfig: EngineConfig = {
      ...DEFAULT_CONFIG,
      dbPath,
      ...resolveProviderOverlay(process.env, 'RECENSE_JUDGE_PROVIDER'),
    };
    const { client, model } = createClaudeHeadlessClient(judgeConfig);

    console.log(`genuine-noise-judge: ${facts.length} [usage] facts | judge model=${model} | db=${dbPath}`);
    console.log('');
    console.log('PER-FACT VERDICTS (founder spot-check — D-02; the judge is disposable, your read is the gate):');

    const tally: Record<string, AreaTally> = {};
    for (const fact of facts) {
      const verdict = await judgeFact(client, model, fact);
      if (!tally[fact.area]) tally[fact.area] = { genuine: 0, noise: 0, unknown: 0 };
      tally[fact.area]![verdict]++;
      const prefix = fact.value.length > 80 ? `${fact.value.slice(0, 80)}…` : fact.value;
      console.log(`  [${verdict.padEnd(7)}] ${fact.area.padEnd(13)} ${fact.id.slice(0, 8)}  ${prefix}`);
    }

    // ── Per-area tally + ≥5-genuine bar (Success Criterion 2) ──────────────────
    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  PER-AREA GENUINE/NOISE TALLY (Success Criterion 2 — need >= 5 genuine/area)');
    console.log('═══════════════════════════════════════════════════════════');
    const overall: AreaTally = { genuine: 0, noise: 0, unknown: 0 };
    // Print known areas first (stable order), then any unexpected buckets (e.g. 'unmapped').
    const orderedAreas = [
      ...SURVEY_AREAS.filter(a => tally[a]),
      ...Object.keys(tally).filter(a => !(SURVEY_AREAS as readonly string[]).includes(a)),
    ];
    for (const area of orderedAreas) {
      const t = tally[area]!;
      overall.genuine += t.genuine;
      overall.noise += t.noise;
      overall.unknown += t.unknown;
      const bar = t.genuine >= GENUINE_BAR ? 'PASS' : 'FAIL';
      console.log(
        `  ${area.padEnd(14)} genuine=${String(t.genuine).padStart(3)}  noise=${String(t.noise).padStart(3)}  unknown=${String(t.unknown).padStart(3)}  → ≥${GENUINE_BAR} genuine: ${bar}`,
      );
    }
    console.log('  ' + '-'.repeat(57));
    console.log(
      `  ${'OVERALL'.padEnd(14)} genuine=${String(overall.genuine).padStart(3)}  noise=${String(overall.noise).padStart(3)}  unknown=${String(overall.unknown).padStart(3)}  (total=${facts.length})`,
    );

    // ── Schema-induction inspection (Success Criterion 3) ──────────────────────
    reportSchemas(db);
  } finally {
    db.close();
  }
}

// Only run when invoked as the entry point, NOT when imported by a test of the helpers.
if (require.main === module) {
  main().catch(err => {
    process.stderr.write(`genuine-noise-judge FAILED: ${err}\n`);
    process.exit(1);
  });
}
