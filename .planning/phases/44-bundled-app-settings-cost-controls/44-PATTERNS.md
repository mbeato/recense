# Phase 44: Bundled-App Settings & Cost Controls - Pattern Map

**Mapped:** 2026-06-24
**Files analyzed:** 9 (5 new, 4 modified)
**Analogs found:** 9 / 9

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/adapter/settings-loader.ts` (NEW) | utility/config | file-I/O | `src/adapter/runtime-config.ts` | exact |
| `src/adapter/config-cli.ts` (NEW) | utility/CLI dispatcher | request-response | `src/adapter/recense-scheduler.ts` | exact |
| `src/viz/server.ts` (MODIFY — add routes) | route | request-response | `src/viz/server.ts` (existing routes) | self |
| `src/viz/modules/settings.js` (NEW) | component/module | request-response | `src/viz/modules/reader.js` | exact |
| `src/db/schema.ts` + `src/adapter/sleep-pass-cli.ts` (MODIFY — ledger + sink wiring) | model + service | batch | `src/model/claude-headless-client.ts`, `scripts/eval/cost-benefit-harness.cjs` | role-match |
| `src/lib/config.ts` (MODIFY — preset/settings types) | model/config | N/A | `src/lib/config.ts` (self) | self |
| `src/consolidation/run-sleep-pass.ts` (MODIFY — lines 563-629) | service | batch | `src/adapter/runtime-config.ts` (`resolveEnabledSources` pattern) | role-match |
| `src/adapter/ingest-project-cli.ts` (MODIFY — lines 769,795) | service/CLI | batch | `src/consolidation/run-sleep-pass.ts` lines 563-629 (sibling caller) | exact |
| `src/adapter/recense-scheduler.ts` (MODIFY — frequency apply) | service/scheduler | event-driven | `src/adapter/recense-scheduler.ts` `installMacOSScheduler()` (self) | self |

---

## Pattern Assignments

### `src/adapter/settings-loader.ts` (NEW — utility/config, file-I/O)

**Analog:** `src/adapter/runtime-config.ts`

This is the analog match for the entire settings surface. Every shape in `runtime-config.ts` has a direct counterpart in the settings loader.

**Imports pattern** (`runtime-config.ts` lines 13-15):
```typescript
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
```

**Config-dir path helpers** (`runtime-config.ts` lines 22-32):
```typescript
// Mirror of defaultDbPath() — settings.json lives in the SAME ~/.config/recense/ dir.
export function defaultDbPath(): string {
  return join(homedir(), '.config', 'recense', 'recense.db');
}
export function sleepEnvPath(): string {
  return (
    process.env['RECENSE_SLEEP_ENV'] ??
    join(homedir(), '.config', 'recense', 'sleep.env')
  );
}
// New counterpart to copy:
// export function defaultSettingsPath(): string {
//   return join(homedir(), '.config', 'recense', 'settings.json');
// }
```

**Precedence shape to mirror** (`runtime-config.ts` lines 52-66):
```typescript
// `--db <path>` > RECENSE_DB env > defaultDbPath()
// Map to: explicit env var > settings.json > DEFAULT_CONFIG
export function resolveDbPath(
  argv: string[] = process.argv,
  opts: { fallbackToDefault?: boolean } = {},
): string | undefined {
  const i = argv.indexOf('--db');
  if (i !== -1 && typeof argv[i + 1] === 'string' && argv[i + 1] !== '') {
    return argv[i + 1] as string;
  }
  const fromEnv = process.env['RECENSE_DB'];
  if (fromEnv !== undefined) return fromEnv;
  if (opts.fallbackToDefault !== false) return defaultDbPath();
  return undefined;
}
```

**File parsing pattern to mirror for settings.json** (`runtime-config.ts` lines 75-92):
```typescript
// loadConfiguredEnv reads KEY=VALUE lines with comment/blank skipping.
// The settings loader will use JSON.parse instead of line splitting,
// but the existsSync guard + try/catch + return-empty-on-failure posture is identical.
export function loadConfiguredEnv(
  envPath: string = sleepEnvPath(),
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(envPath)) return out;
  try {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      out[t.slice(0, eq)] = t.slice(eq + 1);
    }
  } catch {
    return {};
  }
  return out;
}
```

**Set-only-if-missing / env-wins precedence** (`runtime-config.ts` lines 140-149):
```typescript
// hydrateRuntimeEnv: env vars already set are NEVER overwritten (env wins).
// This is the precedence shape for: env > settings.json > DEFAULT_CONFIG.
export function hydrateRuntimeEnv(envPath: string = sleepEnvPath()): string[] {
  const applied: string[] = [];
  for (const [k, v] of Object.entries(loadConfiguredEnv(envPath))) {
    if (process.env[k] === undefined) {
      process.env[k] = v;
      applied.push(k);
    }
  }
  return applied;
}
```

**Core guardrail posture** (mirrors fail-safe defaults throughout the codebase — `DEFAULT_CONFIG` in `src/lib/config.ts` line 808):
```typescript
enabledSources: [], // default-off fail-safe; D-12 analogy: settings.json that disables
                    // extract/reconsolidation must be hard-rejected by the loader
```

**What to build:** `settings-loader.ts` exports:
- `defaultSettingsPath()` — `~/.config/recense/settings.json`
- `loadSettingsFile(path?)` — reads JSON, returns `SettingsFile | null` (null on missing/parse error, never throws)
- `loadMergedConfig(dbPath, env?, settingsPath?)` — returns `EngineConfig` with precedence: env overrides > settings.json overrides > preset defaults > `DEFAULT_CONFIG`
- Hard-rejects (strips silently) any settings that try to disable `consolSkipThreshold < 0` or similar core-moat levers (D-12)

---

### `src/adapter/config-cli.ts` (NEW — CLI dispatcher, request-response)

**Analog:** `src/adapter/recense-scheduler.ts` (exported dispatcher) + `src/adapter/recense.ts` (dispatch wiring)

**Exported dispatcher pattern to copy** (`recense-scheduler.ts` lines 185-224):
```typescript
// config-cli.ts exports runConfigCommand(sub, args) — mirroring runSchedulerCommand.
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
    case 'status': ...
      break;
    case 'run': ...
      break;
    default:
      process.stderr.write('Usage: recense scheduler install|status|run\n');
      process.exit(1);
  }
}
```

**Dispatcher wiring in `recense.ts` to add a new `config` case** (`recense.ts` lines 72-76):
```typescript
// Add after the 'scheduler' case — same non-auto-invoking exported-function pattern.
case 'scheduler': {
  const sched = require('./recense-scheduler') as { runSchedulerCommand: (s: string | undefined, r: string[]) => void };
  sched.runSchedulerCommand(sub, rest);
  break;
}
// New case to add:
// case 'config': {
//   const cfg = require('./config-cli') as { runConfigCommand: (s: string | undefined, r: string[]) => void };
//   cfg.runConfigCommand(sub, rest);
//   break;
// }
```

**Subcommand shape** (planner's discretion per CONTEXT.md; follow `scheduler install|status|run` shape):
- `recense config show` — print effective merged config (table: lever → value → source)
- `recense config get <key>` — print one lever value + source
- `recense config set <key> <value>` — write override into settings.json
- `recense config preset <lite|standard|full>` — set preset, clear conflicting overrides
- `recense config apply` — regenerate launchd plist from settings.json frequency lever (calls `runSchedulerCommand('install', [])`)

**File I/O pattern from `installMacOSScheduler`** (`recense-scheduler.ts` lines 62-95):
```typescript
// writeFileSync(plistDst, plistContent) — atomic write, no temp-file dance needed at this scale.
// The settings-loader's write path copies this exact approach for settings.json.
writeFileSync(plistDst, plistContent);
```

---

### `src/viz/server.ts` (MODIFY — add settings + usage-readout routes)

**Analog:** `src/viz/server.ts` existing routes (self — all patterns are already established here)

**GET route pattern to copy** (`src/viz/server.ts` lines 642-698, `/doc/staleness`):
```typescript
// GET /settings — read-only return of current settings.json merged config
if (url === '/doc/staleness') {
  ...
  try {
    ...
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ generated_at, stale, tombstoned }));
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('internal error');
  }
  return;
}
```

**GET-only guard to copy** (`src/viz/server.ts` lines 708-712):
```typescript
// Apply to GET /settings and GET /usage routes.
if (req.method !== 'GET') {
  res.writeHead(405, { 'content-type': 'text/plain' });
  res.end('method not allowed');
  return;
}
```

**POST route pattern to copy** (`src/viz/server.ts` lines 857-868, `/doc/generate`):
```typescript
// POST /settings — write settings.json then return updated effective config.
// The viz server's DB handle is read-only; settings.json writes go to the filesystem,
// not through the DB (consistent with T-27-11 read-only DB posture).
if (url === '/doc/generate' && req.method === 'POST') {
  const rawSlug = new URLSearchParams(req.url?.split('?')[1] ?? '').get('slug') ?? '';
  ...
  return;
}
```

**Request body reading pattern** (no existing example in server.ts — needs to be added for POST /settings):
```typescript
// Read chunked POST body before parsing JSON (standard Node.js http pattern).
// Mirror the existing pattern: never parse url/query from req.body, always URLSearchParams.
// For POST /settings the body is JSON; collect chunks then JSON.parse.
let body = '';
req.on('data', chunk => { body += chunk; });
req.on('end', () => {
  try {
    const payload = JSON.parse(body);
    // ... validate, write, respond
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('bad json');
  }
});
```

**Usage-readout route — DB query pattern to copy** (`src/viz/server.ts` lines 281-285, compiled prepared statement):
```typescript
// Compile GET /usage statement once (same T-01-SQL pattern as other stmts).
const stmtSearch = db.prepare(`
  SELECT f.node_id AS id FROM node_fts f ...
`);
// New usage stmt mirrors this — compile once in startVizServer, use in handler:
// const stmtUsage30d = db.prepare(`
//   SELECT feature_tag, model, SUM(input_tokens) AS input_tokens, ...
//   FROM token_usage_ledger WHERE ts > ? GROUP BY feature_tag, model
// `);
```

**Security note:** the viz server's DB is opened read-only (`{ readonly: true }` line 141). Settings reads via the DB are therefore fine; writes require a separate writable DB open or filesystem-only JSON writes. Given D-03 (settings.json is the persisted store), the settings routes use the filesystem only — consistent with T-27-11.

---

### `src/viz/modules/settings.js` (NEW — component/module, request-response)

**Analog:** `src/viz/modules/reader.js`

**Module init signature pattern** (`reader.js` line 95):
```javascript
// All viz modules export a single init<Name>(ctx) function.
// The settings module mirrors this exactly.
export function initReader(ctx) {
  let currentSlug = new URLSearchParams(location.search).get('doc') || 'tonos';
  const panel = document.getElementById('reader');
  const body = document.getElementById('reader-body');
  ...
  if (!panel || !body || !btn) return; // guard: no-op when panel absent
}
// New module shape:
// export function initSettings(ctx) {
//   const panel = document.getElementById('settings-panel');
//   if (!panel) return;
//   ...
// }
```

**Show/hide pattern** (`reader.js` lines 130-155):
```javascript
function show() {
  panel.classList.add('open');
  document.documentElement.classList.add('reader-open');
  btn.textContent = 'Brain';
  if (!loaded) { load(); loaded = true; }
}
function hide() {
  panel.classList.remove('open');
  document.documentElement.classList.remove('reader-open');
  btn.textContent = 'Reader';
}
btn.addEventListener('click', () => (panel.classList.contains('open') ? hide() : show()));
```

**Fetch + non-fatal error pattern** (`reader.js` lines 343-364, `fetchMeta`):
```javascript
async function fetchMeta() {
  try {
    const res = await fetch('/doc/meta?' + docQuery());
    if (!res.ok) return;        // non-fatal: silently bail
    const data = await res.json();
    citedFactIds = Array.isArray(data.citedFactIds) ? data.citedFactIds : [];
  } catch (_) {
    // Meta failure is non-fatal — doc still renders.
  }
}
// Settings fetch mirrors this exactly:
// async function loadSettings() {
//   try {
//     const res = await fetch('/settings');
//     if (!res.ok) return;
//     const data = await res.json();
//     renderSettings(data);
//   } catch (_) { /* non-fatal */ }
// }
```

**POST trigger pattern** (`reader.js` lines 500-502):
```javascript
await fetch('/doc/generate?slug=' + encodeURIComponent(currentSlug), { method: 'POST' });
// Settings save mirrors this:
// await fetch('/settings', {
//   method: 'POST',
//   headers: { 'content-type': 'application/json' },
//   body: JSON.stringify({ preset, overrides }),
// });
```

**Security — textContent only** (`reader.js` lines 452-463):
```javascript
// ALL DB-sourced / user-controlled strings use textContent, NEVER innerHTML.
// The only innerHTML is renderMarkdown output (all values escaped via escapeHtml first).
heading.textContent = 'Referenced by'; // T-10-12
a.textContent = bl.label || bl.slug;   // T-10-12/T-27-08
// Settings panel mirrors: toggle labels, preset names, usage readout numbers → textContent.
```

**Module import from corpus.js** (`corpus.js` line 26):
```javascript
import { createTransition } from './transition.js';
// Settings module may import from transition.js for panel slide-in animation.
```

---

### Token-usage ledger table + live usage sink wiring (MODIFY `src/db/schema.ts` + `src/adapter/sleep-pass-cli.ts`)

**Analog A: `src/model/claude-headless-client.ts`** — the `setHeadlessUsageSink` seam

**`HeadlessUsage` interface to extend with feature tag** (`claude-headless-client.ts` lines 61-66):
```typescript
export interface HeadlessUsage {
  model: string;
  usage?: Record<string, number>;
  total_cost_usd?: number;
  duration_ms?: number;
}
// Phase 44 extends this with a feature_tag field:
// export interface HeadlessUsage {
//   model: string;
//   feature_tag?: string;  // 'extract' | 'judge' | 'corpus_gen' | 'schema_abstract'
//   usage?: Record<string, number>;
//   total_cost_usd?: number;
//   duration_ms?: number;
// }
```

**`setHeadlessUsageSink` seam** (`claude-headless-client.ts` lines 73-82):
```typescript
let usageSink: ((u: HeadlessUsage) => void) | null = null;

export function setHeadlessUsageSink(fn: ((u: HeadlessUsage) => void) | null): void {
  usageSink = fn;
}
// Production sink (Phase 44):
// setHeadlessUsageSink((u) => {
//   db.prepare(`INSERT INTO token_usage_ledger ...`).run(
//     Date.now(), u.feature_tag ?? 'unknown', u.model,
//     u.usage?.input_tokens ?? 0, u.usage?.output_tokens ?? 0,
//     u.usage?.cache_creation_input_tokens ?? 0, u.usage?.cache_read_input_tokens ?? 0,
//     u.total_cost_usd ?? 0,
//   );
// });
```

**Sink emit guard** (`claude-headless-client.ts` lines 342-349):
```typescript
// Sink is already wrapped in try/catch — a throwing sink NEVER affects production.
// The production ledger sink writes are therefore best-effort; a failing DB write
// does NOT abort the sleep pass (mirrors the EVAL-04 posture).
if (usageSink !== null) {
  try {
    usageSink({ model: useModel, usage: envelope.usage, ... });
  } catch {
    // Sink errors are swallowed — best-effort emit guard.
  }
}
```

**Analog B: `scripts/eval/cost-benefit-harness.cjs`** — install/uninstall pattern

**Sink install + uninstall in finally** (`cost-benefit-harness.cjs` lines 381-407):
```javascript
// Install BEFORE runConsolidation; uninstall in finally — belt-and-suspenders.
setHeadlessUsageSink(u => {
  if (!perModelCalls[u.model]) perModelCalls[u.model] = [];
  perModelCalls[u.model].push({ usage: u.usage, total_cost_usd: u.total_cost_usd, duration_ms: u.duration_ms });
});
try {
  await runConsolidation(scratchDb, scratchPath, process.env, ...);
} finally {
  setHeadlessUsageSink(null); // clear on both success and error paths
}
```

**Retail-$ translation pattern to copy** (`cost-benefit-harness.cjs` lines 65-103):
```javascript
// PRICES table: { model: { input_per_m, output_per_m, cache_write_per_m, cache_read_per_m } }
// Token→$ formula: copy retailUsd(model, usage) verbatim for the readout route.
const PRICES = {
  'claude-haiku-4-5':  { input_per_m: 0.80, output_per_m: 4.00, ... },
  'claude-sonnet-4-6': { input_per_m: 3.00, output_per_m: 15.00, ... },
};
function retailUsd(model, usage) {
  const p = PRICES[model];
  if (!p || !usage) return 0;
  const inp    = (usage.input_tokens  || 0) / 1e6 * p.input_per_m;
  const out    = (usage.output_tokens || 0) / 1e6 * p.output_per_m;
  const cwrite = (usage.cache_creation_input_tokens  || 0) / 1e6 * p.cache_write_per_m;
  const cread  = (usage.cache_read_input_tokens  || 0) / 1e6 * p.cache_read_per_m;
  return inp + out + cwrite + cread;
}
```

**Ledger table schema** — add to `src/db/schema.ts` using the existing `db.prepare(...).run()` migration pattern already in that file:
```sql
CREATE TABLE IF NOT EXISTS token_usage_ledger (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       INTEGER NOT NULL,          -- Date.now() ms
  feature_tag TEXT NOT NULL,          -- 'extract'|'judge'|'corpus_gen'|'schema_abstract'
  model    TEXT NOT NULL,
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
  total_cost_usd      REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_token_usage_ledger_ts ON token_usage_ledger (ts);
```

---

### `src/lib/config.ts` (MODIFY — add preset/SettingsFile types)

**Analog:** `src/lib/config.ts` self — follow existing `EngineConfig` interface + `DEFAULT_CONFIG` patterns

**Existing `DEFAULT_CONFIG` spread pattern** (`config.ts` lines 712-821) — DO NOT modify this object. The settings loader inserts a new merge step OVER it:
```typescript
// Current consumer pattern (e.g. run-sleep-pass.ts line 21, sleep-pass-cli.ts):
import { DEFAULT_CONFIG } from '../lib/config';
const config: EngineConfig = { ...DEFAULT_CONFIG, dbPath };
// Phase 44: consumers call loadMergedConfig(dbPath) from settings-loader instead.
// The settings-loader does: { ...DEFAULT_CONFIG, ...presetDefaults[preset], ...overrides }
// Env vars then override specific fields by name (env > file > DEFAULT_CONFIG).
```

**Existing cost lever fields to expose in SettingsFile** (`config.ts` lines 254, 263, 557, 785):
```typescript
consolSkipThreshold: number;            // line 254 — default 0.2
consolSkipThresholdAssistant: number;   // line 263 — default 0.5
corpusSubjectDriftThreshold: number;    // line 559 — default 3
// Also exposed: RECENSE_CORPUS_GEN (skip corpus), RECENSE_CORPUS_GEN_MAX (25 cap)
// These are currently env-only; settings.json gives them a disk-override path (D-06).
```

**Additions to `config.ts`:** export a `SettingsFile` interface and `PRESET_CONFIGS` map:
```typescript
// New types to add to config.ts (do NOT change DEFAULT_CONFIG):
export type PresetName = 'lite' | 'standard' | 'full';
export interface SettingsFile {
  preset: PresetName;
  overrides: Partial<Pick<EngineConfig,
    'consolSkipThreshold' | 'consolSkipThresholdAssistant' |
    'corpusSubjectDriftThreshold'
  >> & {
    corpusGen?: boolean;       // maps to RECENSE_CORPUS_GEN !== '0'
    corpusGenMax?: number;     // maps to RECENSE_CORPUS_GEN_MAX
    sleepFrequencyHours?: number; // applied by recense config apply → scheduler reinstall
  };
}
export const PRESET_CONFIGS: Record<PresetName, Partial<Omit<EngineConfig, 'dbPath'>>> = {
  lite:     { /* extract + reconsolidation only: corpusGen=false, schemaInduction=false */ },
  standard: { /* + schema abstraction; DEFAULT_CONFIG values */ },
  full:     { /* + corpus docs: corpusGen=true, corpusGenMax=25 */ },
};
```

---

### `src/consolidation/run-sleep-pass.ts` (MODIFY — lines 563-629)

**Analog:** `src/adapter/runtime-config.ts` `resolveEnabledSources` pattern (lines 122-126) — env var wins, else use config value

**Current pattern to replace** (`run-sleep-pass.ts` lines 565, 621):
```typescript
// BEFORE: reads env directly, settings.json has no effect
if (env['RECENSE_CORPUS_GEN'] !== '0') {
  ...
  const maxDocs = parseInt(env['RECENSE_CORPUS_GEN_MAX'] ?? '25', 10) || 25;
```

**Replacement pattern to follow** (`runtime-config.ts` lines 122-126):
```typescript
// resolveEnabledSources: env wins; else returns config value (default-off posture preserved).
export function resolveEnabledSources(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env['RECENSE_ENABLED_SOURCES'];
  if (raw === undefined) return [];        // env absent → use config/default
  return raw.split(',')...;               // env present → env wins
}
// AFTER: env wins; else merged config value (D-05 / D-06):
// const corpusGen  = env['RECENSE_CORPUS_GEN']  !== undefined
//                  ? env['RECENSE_CORPUS_GEN'] !== '0'
//                  : mergedConfig.corpusGen ?? true;
// const maxDocs   = env['RECENSE_CORPUS_GEN_MAX'] !== undefined
//                  ? parseInt(env['RECENSE_CORPUS_GEN_MAX'], 10) || 25
//                  : mergedConfig.corpusGenMax ?? 25;
```

**Note:** `runConsolidation(db, dbPath, env, log)` signature already takes `env`. The merged config object needs to be passed in too. The planner should add a `config?` parameter (optional, with DEFAULT_CONFIG fallback) rather than changing the call signature everywhere at once.

---

### `src/adapter/ingest-project-cli.ts` (MODIFY — lines 769, 795)

**Analog:** `src/consolidation/run-sleep-pass.ts` lines 563-629 (sibling caller — identical replacement)

**Current pattern** (`ingest-project-cli.ts` lines 769, 795):
```typescript
// Line 769 — identical guard as run-sleep-pass.ts line 565:
if (process.env['RECENSE_CORPUS_GEN'] !== '0') {
  ...
  // Line 795 — identical parse as run-sleep-pass.ts line 621:
  const maxDocs = parseInt(process.env['RECENSE_CORPUS_GEN_MAX'] ?? '25', 10) || 25;
```

**Apply the same replacement as run-sleep-pass.ts.** The `config` object already exists at this call site as `const config: EngineConfig = { ...DEFAULT_CONFIG, dbPath, ... }` — replace it with `loadMergedConfig(dbPath)` so settings.json overrides take effect here too (D-06).

---

### `src/adapter/recense-scheduler.ts` (MODIFY — frequency-apply regen)

**Analog:** `src/adapter/recense-scheduler.ts` `installMacOSScheduler()` (self)

**Pattern to call from `recense config apply`** (`recense-scheduler.ts` lines 62-95):
```typescript
// installMacOSScheduler() reads env for RECENSE_SLEEP_ENV, writes the plist,
// then runs bootout → enable → bootstrap.
// recense config apply simply calls runSchedulerCommand('install', []) after
// writing the new frequency into settings.json.
function installMacOSScheduler(): void {
  const { plistTemplate, wrapperPath } = resolveScriptPaths();
  ...
  const plistContent = readFileSync(plistTemplate, 'utf8')
    .replace(/__WRAPPER__/g, wrapperPath)
    .replace(/__ENV_FILE__/g, envFilePath);
  writeFileSync(plistDst, plistContent);
  ...
  // Idempotent bootout → enable → bootstrap
  try { execSync(`launchctl bootout ${domain}/${label}`, { stdio: 'ignore' }); } catch {}
  try { execSync(`launchctl enable ${domain}/${label}`, { stdio: 'ignore' }); } catch {}
  execSync(`launchctl bootstrap ${domain} "${plistDst}"`, { stdio: 'pipe' });
}
```

**The plist template** (`scripts/com.recense.sleep-pass.plist.template`) will need a `__FREQUENCY__` placeholder added alongside the existing `__WRAPPER__` and `__ENV_FILE__` substitutions, so frequency from settings.json propagates to the launchd `StartInterval` key.

---

## Shared Patterns

### Fail-Safe / Fail-Closed Default Posture
**Source:** `src/lib/config.ts` lines 808, 795-796; `src/adapter/runtime-config.ts` lines 106-108
**Apply to:** settings loader (D-12 guardrail), all new routes (bad-input → 400/403, not 500), usage sink (best-effort — never aborts the pass)
```typescript
// DEFAULT_CONFIG: enabledSources: []     — default-off
// DEFAULT_CONFIG: channel.enable: false  — fail-closed
// settings loader: hard-reject configs that disable extract+reconsolidation
// resolveEnabledSources: absent env → return []  (not an error, just default)
```

### Error Handling in Routes
**Source:** `src/viz/server.ts` (every route handler)
**Apply to:** all new viz-server routes (GET /settings, POST /settings, GET /usage)
```typescript
try {
  // ... handler logic
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
} catch (err) {
  res.writeHead(500, { 'content-type': 'text/plain' });
  res.end('internal error');  // never leak stack/SQL detail
}
return;
```

### DNS Rebinding Guard
**Source:** `src/viz/server.ts` lines 382-387
**Apply to:** all new viz-server routes (inherited automatically since they sit inside the same `http.createServer` handler)
```typescript
// Already in place — all routes share this guard at the top of the request handler.
const requestHost = req.headers['host'] ?? '';
if (requestHost !== `127.0.0.1:${port}` && requestHost !== `localhost:${port}`) {
  res.writeHead(403, { 'content-type': 'text/plain' });
  res.end('forbidden');
  return;
}
```

### Usage Sink — Best-Effort / Never-Abort Pattern
**Source:** `src/model/claude-headless-client.ts` lines 342-349
**Apply to:** the production ledger sink installed in `sleep-pass-cli.ts`
```typescript
// Sink is ALWAYS wrapped in try/catch inside the headless client.
// A failing DB write inside the sink NEVER aborts the sleep pass.
if (usageSink !== null) {
  try { usageSink({ ... }); } catch { /* swallowed */ }
}
```

### `hydrateRuntimeEnv` Call Site Pattern (for new consumer paths)
**Source:** `src/adapter/recense.ts` lines 31-32
**Apply to:** any new CLI entry points that need settings awareness at startup
```typescript
// Hydrate env from sleep.env before any config reading, so the new settings
// loader sees the SAME env that the background jobs do.
(require('./runtime-config') as typeof import('./runtime-config')).hydrateRuntimeEnv();
```

### CLI Spawn Dispatch — `require.main === module` Guard
**Source:** `src/adapter/recense.ts` lines 85-95, `spawnScript` function lines 43-48
**Apply to:** `recense config` dispatch (if config-cli.ts uses a require.main guard for test isolation)
```typescript
function spawnScript(name: string, argv: string[]): never {
  const { spawnSync } = require('child_process') as typeof import('child_process');
  const { resolve }   = require('path') as typeof import('path');
  const r = spawnSync(process.execPath, [resolve(__dirname, name), ...argv], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
```

---

## No Analog Found

No files in this phase are without a close analog. All patterns are covered by existing codebase files.

---

## Metadata

**Analog search scope:** `src/adapter/`, `src/viz/`, `src/lib/`, `src/model/`, `src/consolidation/`, `src/db/`, `scripts/eval/`, `apps/tray/src/`
**Files scanned:** 10 files read in full; 2 files read at targeted offsets
**Pattern extraction date:** 2026-06-24
