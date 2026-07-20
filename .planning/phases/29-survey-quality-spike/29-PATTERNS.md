# Phase 29: Survey Quality Spike - Pattern Map

**Mapped:** 2026-06-19
**Files analyzed:** 2 new throwaway scripts
**Analogs found:** 2 / 2

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `scripts/spike/survey-feeder.ts` | utility (spike script) | batch, file-I/O | `src/adapter/import-memory-cli.ts` | exact |
| `scripts/spike/genuine-noise-judge.ts` | utility (harness) | batch, request-response | `scripts/eval/cost-benefit-harness.cjs` + `src/model/claude-headless-client.ts` | role-match |

---

## Pattern Assignments

### `scripts/spike/survey-feeder.ts` (batch feeder → pipeline)

**Analog:** `src/adapter/import-memory-cli.ts`

**Imports pattern** (`import-memory-cli.ts` lines 31-42):
```typescript
import { appendFileSync } from 'fs';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema';
import { DEFAULT_CONFIG } from '../lib/config';
import { realClock } from '../lib/clock';
import { EpisodicStore } from '../db/episode-store';
import { AllocationGate, IngestionPipeline } from '../ingest/pipeline';
import { cwdToScope } from '../lib/scope';
import { acquireLock, releaseLock } from './lockfile';
import { resolveDbPath as resolveSharedDbPath } from './runtime-config';
```
For the spike, also import `contentExternalId` from `src/source/source-adapter.ts` and `buildHeadlessArgs`/`createClaudeHeadlessClient` from `src/model/claude-headless-client.ts`.

**Log pattern** (`import-memory-cli.ts` lines 44, 252-253):
```typescript
const LOG_PATH = '/tmp/recense-survey-spike.log';
const fileLog = (msg: string): void =>
  appendFileSync(LOG_PATH, `[${new Date().toISOString()}] survey-spike: ${msg}\n`);
```

**DB path + lock validation BEFORE acquireLock (WR-02)** (`import-memory-cli.ts` lines 282-291):
```typescript
const dbPath = resolveSharedDbPath(argv, { fallbackToDefault: false });
if (!dbPath) {
  process.stderr.write('No DB path (--db <path> or RECENSE_DB env var) — exiting\n');
  process.exit(0);
}

if (!acquireLock()) {
  process.stderr.write('Lock held by another process — exiting\n');
  process.exit(0);
}
```
Critical: arg validation always BEFORE `acquireLock()`. For the spike set `RECENSE_LOCK_PATH=/tmp/recense-spike.lock` (env, not code) to avoid colliding with the live hourly pass.

**DB + pipeline construction** (`import-memory-cli.ts` lines 293-301):
```typescript
let db: Database.Database | undefined;
try {
  db = new Database(dbPath);
  initSchema(db);
  const config = { ...DEFAULT_CONFIG, dbPath };
  const episodes = new EpisodicStore(db, realClock, config);
  const pipeline = new IngestionPipeline(new AllocationGate(config), episodes);
  // ... use pipeline
} catch (err) {
  fileLog(`error: ${err}`);
  process.exitCode = 1;
} finally {
  db?.close();
  releaseLock();
}
```

**Core episode emission pattern** (`import-memory-cli.ts` lines 217-228, adapted for survey):
```typescript
pipeline.recordEvent({
  content,                        // summarized survey observation (natural-language belief)
  role: 'user',
  origin: 'observed',             // D-04: never 'asserted_by_user' for survey output
  sessionId: `project-survey:usage:${area}`,  // one session per surveyed area
  source: 'project-survey',       // D-04 source tag
  externalId: contentExternalId(`usage/${area}`, content),  // D-04 content-addressed dedup
  cwd: '/Users/vtx/usage',        // D-04: MUST be this exact path → resolves scope='usage'
});
```

**Scope verification** (`src/lib/scope.ts` lines 43-59):
```typescript
// cwdToScope('/Users/vtx/usage') → 'usage'
// Proof: HOME_PROJECT_RE = /^\/(?:Users|home)\/[^/]+(?:\/([^/]+))?/
// matches /Users/vtx/usage, segment='usage', not in PERSONAL_SLUGS → returns 'usage'
import { cwdToScope } from '../lib/scope';
```
The spike should assert `cwdToScope('/Users/vtx/usage') === 'usage'` before emitting any episodes.

**require.main guard** (`import-memory-cli.ts` lines 320-326):
```typescript
if (require.main === module) {
  main().catch(err => {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] survey-spike FATAL: ${err}\n`);
    releaseLock();
    process.exit(1);
  });
}
```

**Headless survey agent invocation** (`src/model/claude-headless-client.ts` lines 105-116):
```typescript
// Build args: -p --output-format json --model <model> --system-prompt <sys>
// --setting-sources project --tools none --strict-mcp-config --exclude-dynamic-system-prompt-sections
const args = buildHeadlessArgs(model, NEUTRAL_SYSTEM);
// Then spawn via createClaudeHeadlessClient — the transport handles stdin/stdout/timeout.
// The survey prompt goes as the user message (child.stdin.write(prompt)).
```
Use `resolveProviderOverlay(process.env, 'RECENSE_JUDGE_PROVIDER')` from `src/consolidation/run-sleep-pass.ts` lines 191-247 to select the model tier — same as `generate-doc-cli.ts` line 133.

**Judge-tier provider construction** (`src/adapter/generate-doc-cli.ts` lines 128-139):
```typescript
// Raise timeout for long agent runs (same as doc-gen):
if (!process.env['RECENSE_CLAUDE_HEADLESS_TIMEOUT_MS']) {
  process.env['RECENSE_CLAUDE_HEADLESS_TIMEOUT_MS'] = '600000';
}
const judgeConfig = { ...config, ...resolveProviderOverlay(process.env, 'RECENSE_JUDGE_PROVIDER') };
const provider = new DefaultModelProvider({
  generateConfig: judgeConfig,
  judgeConfig,
  embedConfig: config,
});
```
The spike can use `createClaudeHeadlessClient(judgeConfig)` directly (lower-level) rather than `DefaultModelProvider` if it only needs the raw text response from the survey agent.

**consolidation invocation after episode feed** (`src/adapter/ingest-cli.ts` lines 271-274):
```typescript
// After all episodes are emitted via pipeline.recordEvent, trigger the sleep pass
// under the SAME held lock (CONSOL-03):
await runConsolidation(db, dbPath, process.env, log);
```
Import: `import { runConsolidation } from '../consolidation/run-sleep-pass';`

---

### `scripts/spike/genuine-noise-judge.ts` (throwaway fact quality harness)

**Analog:** `scripts/eval/cost-benefit-harness.cjs` + `src/model/claude-headless-client.ts`

**DB query pattern for facts in scope** (cost-benefit-harness.cjs lines 47-50, adapted):
```typescript
// In the harness, query the scratch DB for facts stamped [usage] after consolidation:
const facts = db.prepare(`
  SELECT n.id, n.value, ns.scope
  FROM node n
  JOIN node_scope ns ON ns.node_id = n.id
  WHERE n.type = 'fact' AND n.tombstoned = 0 AND ns.scope = 'usage'
  ORDER BY n.created_at DESC
`).all() as Array<{ id: string; value: string; scope: string }>;
```

**Headless judge call pattern** (`src/model/claude-headless-client.ts` lines 130-218, distilled):
```typescript
import { createClaudeHeadlessClient } from '../../src/model/claude-headless-client';
import { resolveProviderOverlay } from '../../src/consolidation/run-sleep-pass';
import { DEFAULT_CONFIG } from '../../src/lib/config';

const config = { ...DEFAULT_CONFIG, dbPath };
const judgeConfig = { ...config, ...resolveProviderOverlay(process.env, 'RECENSE_JUDGE_PROVIDER') };
const { client, model } = createClaudeHeadlessClient(judgeConfig);

// Per-fact judgment:
const response = await client.messages.create({
  model,
  max_tokens: 64,
  messages: [{ role: 'user', content: JUDGE_PROMPT.replace('{{FACT}}', fact.value) }],
});
const verdict = (response.content[0] as { text: string }).text.trim().toLowerCase();
// verdict is 'genuine' | 'noise'
```
Note: the headless client returns empty string on timeout/failure; the harness must guard `if (!verdict) { /* count as unknown */ }`.

**Output tally pattern** (cost-benefit-harness.cjs lines 85-90):
```typescript
// Print a tally per area and an overall report:
const tally: Record<string, { genuine: number; noise: number; unknown: number }> = {};
for (const { area, verdict } of results) {
  if (!tally[area]) tally[area] = { genuine: 0, noise: 0, unknown: 0 };
  tally[area][verdict === 'genuine' ? 'genuine' : verdict === 'noise' ? 'noise' : 'unknown']++;
}
// Success criterion: ≥5 genuine per area (D-02, SC-2)
```

**DB open pattern** (cost-benefit-harness.cjs line 50):
```typescript
// Read-only: harness only queries, never writes to the scratch DB
const Database = require('better-sqlite3');
const db = new Database(scratchDbPath, { readonly: true });
```

---

## Shared Patterns

### Lock override for spike isolation (D-05)
**Source:** `src/adapter/lockfile.ts` lines 30, 43-45
**Apply to:** Both spike files
```typescript
// Set via env before running; getLockPath() reads it at call time (DEBT-02 pattern):
// RECENSE_LOCK_PATH=/tmp/recense-spike.lock
// In code — no code change needed; getLockPath() reads process.env['RECENSE_LOCK_PATH'] automatically.
export const LOCK_PATH = join(tmpdir(), 'recense-sleep.lock'); // default
function getLockPath(): string {
  return process.env['RECENSE_LOCK_PATH'] ?? LOCK_PATH;
}
```
Run the spike with `RECENSE_LOCK_PATH=/tmp/recense-spike.lock` to avoid colliding with the live hourly pass.

### Scratch DB isolation (D-05)
**Source:** `src/adapter/runtime-config.ts` lines 52-66
**Apply to:** Both spike files
```typescript
// resolveDbPath reads --db <path> first, then RECENSE_DB, then default.
// For the spike, always pass --db /tmp/recense-spike.db (never the live DB).
// If the spike is a .cjs script (like cost-benefit-harness), it can just:
const DB_PATH = process.argv.includes('--db')
  ? process.argv[process.argv.indexOf('--db') + 1]
  : process.env['RECENSE_DB'] || '/tmp/recense-spike.db';
```

### Billing guard for headless calls (load-bearing)
**Source:** `src/model/claude-headless-client.ts` lines 146-148
**Apply to:** Both spike files whenever spawning `claude -p`
```typescript
// ALWAYS strip API key from the child env so calls go against Max's subscription, not direct API:
const childEnv = { ...process.env };
delete childEnv['ANTHROPIC_API_KEY'];
delete childEnv['ANTHROPIC_AUTH_TOKEN'];
// This is handled automatically inside createClaudeHeadlessClient — use that, not raw spawn.
```

### Self-ingestion loop prevention
**Source:** `src/model/claude-headless-client.ts` lines 105-116 (`buildHeadlessArgs`)
**Apply to:** survey-feeder.ts headless calls
```typescript
// --setting-sources project drops global hooks (incl. the UserPromptSubmit turn-capture hook).
// Without this, each claude -p call is itself captured as a new episode → runaway loop.
// buildHeadlessArgs() already includes this flag — use it, don't build argv manually.
```

### require.main guard
**Source:** `src/adapter/import-memory-cli.ts` lines 320-326
**Apply to:** Both spike files
```typescript
if (require.main === module) {
  main().catch(err => {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] FATAL: ${err}\n`);
    releaseLock();
    process.exit(1);
  });
}
```

### contentExternalId for dedup
**Source:** `src/source/source-adapter.ts` lines 57-59
**Apply to:** survey-feeder.ts
```typescript
import { contentExternalId } from '../source/source-adapter';
// Usage: contentExternalId(`usage/${area}`, content)
// Returns: `usage/${area}#${sha256(content).slice(0, 16)}`
// This ensures re-running the spike with the same survey output produces zero new rows (idempotent).
```

---

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| (none) | — | — | All spike patterns map cleanly to existing codebase analogs |

---

## Key Integration Points (concrete)

**Scope derivation verification** — before emitting any episode, assert:
```typescript
import { cwdToScope } from '../lib/scope';
console.assert(cwdToScope('/Users/vtx/usage') === 'usage', 'scope mismatch');
```

**Episode shape for survey records** — the exact `recordEvent` call that correctly stamps `[usage]`:
```typescript
pipeline.recordEvent({
  content: summaryText,       // natural-language belief from survey agent
  role: 'user',
  origin: 'observed',
  sessionId: `project-survey:usage:${area}`,
  source: 'project-survey',
  externalId: contentExternalId(`usage/${area}`, summaryText),
  cwd: '/Users/vtx/usage',   // load-bearing: this is what drives scope='usage'
});
```

**consolidation to produce facts + schemas** — identical call to `ingest-cli.ts` line 272:
```typescript
await runConsolidation(db, dbPath, process.env, log);
// With: RECENSE_JUDGE_PROVIDER=claude-headless RECENSE_EXTRACTOR_PROVIDER=claude-headless
```

**Post-consolidation scope verification** — query to confirm [usage] stamping worked:
```sql
SELECT n.id, n.value, ns.scope
FROM node n
JOIN node_scope ns ON ns.node_id = n.id
WHERE n.type IN ('fact','schema') AND n.tombstoned = 0 AND ns.scope = 'usage'
ORDER BY n.created_at DESC LIMIT 20;
```

---

## Metadata

**Analog search scope:** `src/adapter/`, `src/model/`, `src/ingest/`, `src/db/`, `src/lib/`, `src/consolidation/`, `src/source/`, `scripts/eval/`
**Files scanned:** 11 source files read in full
**Pattern extraction date:** 2026-06-19
