# Phase 45: Subscription-Default Install & Billing-Leak Warning - Pattern Map

**Mapped:** 2026-06-26
**Files analyzed:** 6 (4 code, 2 docs)
**Analogs found:** 4 / 4 code files (docs need no code analog)

> All analogs are **in-repo, same module** as the files being modified. Three of the four
> code files are *modified in place*, so the dominant pattern source is the file's own existing
> structure. The one new file (settings.json detector helper) has an exact analog in
> `src/adapter/settings-loader.ts`.

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/lib/config.ts` (MODIFY) | config | n/a (constant + type) | self — `DEFAULT_CONFIG` block `config.ts:757` + comment `config.ts:135-137` | in-place |
| `src/adapter/recense-init.ts` (MODIFY) | CLI / wizard | request-response (interactive prompt) | self — existing wizard steps + `writeEnvFile` | in-place |
| `src/adapter/recense-doctor.ts` (MODIFY) | CLI / health-audit | batch (dimension checks) | self — `CheckResult` dimension pattern (`checkServeToken`, `checkScheduler`) | in-place |
| **NEW** settings.json `ANTHROPIC_API_KEY` detector | utility | file-I/O (safe JSON read → bool) | `src/adapter/settings-loader.ts:loadSettingsFile` (`:54-63`) | exact |
| `README.md` (MODIFY) | docs | n/a | none needed | docs |
| `docs/evals.md` (MODIFY) | docs | n/a | none needed | docs |

**Where shared helpers live:** `src/lib/` (pure, dependency-free helpers: `hash.ts`, `scope.ts`,
`clock.ts`) and `src/adapter/` (runtime/IO helpers consumed by CLIs: `runtime-config.ts`,
`settings-loader.ts`). The new detector reads `~/.claude/settings.json` (file IO, consumed by two
adapter CLIs) → belongs in `src/adapter/`, alongside `settings-loader.ts` and `runtime-config.ts`.
**Note:** `settings-loader.ts` already owns recense's *own* `~/.config/recense/settings.json`;
the new detector targets the *Claude Code* `~/.claude/settings.json`. Keep them distinct — same
read-posture, different file. Discretion (D-14) allows either a new small module or an exported
function in `recense-init.ts`; the cleanest single-reader home is a new `src/adapter/` module
exported and imported by both init and doctor.

---

## Pattern Assignments

### `src/lib/config.ts` (config — default flip + comment, D-01/D-02)

**Analog:** self.

**DEFAULT_CONFIG default to flip** (`config.ts:757`):
```typescript
  modelProvider: 'anthropic',
```
→ change to `'claude-headless'`. Per-role models below are already correct — **do not touch**
(`config.ts:766-767`):
```typescript
  claudeHeadlessModel: 'claude-sonnet-4-6',        // resolved default = judge model (higher-stakes)
  claudeHeadlessJudgeModel: 'claude-sonnet-4-6',   // spike 003: Sonnet judge on Max
```

**Stale comment to update** (`config.ts:135-137`) — the load-bearing phrase is on line 136:
```typescript
   * 'claude-headless' shells out to the first-party `claude -p` binary on the founder's
   * Max subscription (spike 003; QUICK-260617-qat) — opt-in via env ONLY, default unchanged.
```
The clause `opt-in via env ONLY, default unchanged` is now false. Also note line 131
`Default 'anthropic' = ZERO behavior change.` is stale once the default flips. Both comments must
reflect subscription-as-default.

**Headless resolution lives elsewhere — read-only context** (`src/model/anthropic-client.ts:104-110`):
```typescript
export function resolveModelId(config: EngineConfig): string {
  if (config.modelProvider === 'vertex') return config.vertexModel;
  if (config.modelProvider === 'local') return config.localModel;
  if (config.modelProvider === 'deepseek') return config.deepseekModel;
  if (config.modelProvider === 'claude-headless') return config.claudeHeadlessModel;
  return config.anthropicModel;
}
```
This already handles `'claude-headless'` correctly. The default flip needs **no change here** —
flipping the default just makes this branch the resolved-by-default path. The per-role overlay is
`resolveProviderOverlay` (`src/consolidation/run-sleep-pass.ts:202`).

**Fallout to fix (D-03 — grep, don't guess).** Tests/comments that assert/assume the old default:
- `tests/sleep-pass-provider.test.ts:21` — `expect(overlay.modelProvider).toBe('anthropic');`
  (and `:9` comment "unknown value → falls back to DEFAULT_CONFIG.modelProvider (fail safe)").
  This is the canonical "asserts the anthropic default" test that will break.
- `src/adapter/backfill-subjects-cli.ts:85` — comment already pre-empts the new default:
  `falls back to DEFAULT_CONFIG.modelProvider (claude-headless).` Already consistent; leave as-is.
- `tests/provider.test.ts:223,254` — explicitly pass `modelProvider: 'anthropic' as const`; these
  set the provider explicitly, so they do **not** depend on the default. Verify, don't assume.
- The doctor API-key check (`recense-doctor.ts:88-144`) reads the default indirectly — handled
  under D-11 below, not here.

---

### `src/adapter/recense-init.ts` (CLI/wizard — provider step + subscription path, D-04..D-10)

**Analog:** self. The new provider step must match the existing wizard's prompt + step idiom.

**Choice-prompt affordance to reuse (D-04, D-91 discretion).** There is **no list-select prompt
library** in this wizard — choices are done with the plain `ask()` readline helper and a
default-in-brackets convention. The provider step must follow this same style, not introduce a new
prompt lib. `ask()` (`recense-init.ts:259-265`):
```typescript
function ask(rl: Rl, question: string, defaultVal?: string): Promise<string> {
  const promptStr =
    defaultVal != null ? `${question} [${defaultVal}]: ` : `${question}: `;
  return new Promise(res =>
    rl.question(promptStr, ans => res(ans.trim() || defaultVal || '')),
  );
}
```
Existing default-pre-selected y/N choice to mirror for the subscription default
(`recense-init.ts:456`):
```typescript
  const seedAnswer = await ask(rl, '\nSeed from your MEMORY.md now? [y/N]', 'N');
```
→ The billing/provider step should be an `ask()` call whose default makes Subscription the
pre-selected option (e.g. a `[1]` / `[S]` default), matching this bracket-default idiom.

**Wizard spine to splice into** (`recense-init.ts:368-426`). The provider step belongs **before**
the Anthropic-key prompt so it can gate it. Current ordering (the `D-89 Step` comments are the
canonical step markers):
```typescript
  // ── D-89 Step 1: DB path ──
  const defaultDb = existing.get('RECENSE_DB') ?? defaultDbPath();
  const dbPath = await ask(rl, 'DB path', defaultDb);

  // ── D-89 Steps 2-3: API keys with live validation ──
  const anthropicKey = await promptAndValidateKey(
    rl, 'ANTHROPIC_API_KEY', existing.get('ANTHROPIC_API_KEY') ?? '', 'anthropic',
  );
  const openaiKey = await promptAndValidateKey(
    rl, 'OPENAI_API_KEY', existing.get('OPENAI_API_KEY') ?? '', 'openai',
  );
```
D-05/D-08: on the subscription path, **skip** the `promptAndValidateKey(... 'anthropic')` call
entirely (do not prompt). On the direct-API path, keep it unchanged. The OpenAI prompt (D-10)
runs on every path — keep it.

**How `sleep.env` is written today (D-06).** The wizard never writes individual lines — it builds
a `vars` record and calls `writeEnvFile`. Add `RECENSE_MODEL_PROVIDER=claude-headless` to `vars`
on the subscription path. Spine (`recense-init.ts:381-383`, `:417-426`):
```typescript
  const envPath =
    process.env['RECENSE_SLEEP_ENV'] ??
    join(homedir(), '.config', 'recense', 'sleep.env');
  ...
  const vars: Record<string, string> = {};
  for (const [k, v] of existing) vars[k] = v;
  vars['RECENSE_NODE_BIN'] = nodeBin;
  vars['RECENSE_DB'] = dbPath;
  if (anthropicKey) vars['ANTHROPIC_API_KEY'] = anthropicKey;
  if (openaiKey) vars['OPENAI_API_KEY'] = openaiKey;

  writeEnvFile(envPath, vars);
```
→ On subscription path: `vars['RECENSE_MODEL_PROVIDER'] = 'claude-headless';` and do **not** set
`vars['ANTHROPIC_API_KEY']`. `writeEnvFile` (`recense-init.ts:104-137`) already preserves
existing keys and updates-in-place, so this is the correct single insertion point.
**Prefer `sleepEnvPath()` from `runtime-config.ts:27` over re-deriving the path** — the wizard
currently inlines the join at `:381-383`; the doctor and the rest of the codebase use the helper.

**Acknowledge-gate pattern (D-07).** The gate consumes the new settings.json detector (below).
The retry/`y`-confirm idiom to mirror is the existing `[s]kip` confirm in `promptAndValidateKey`
(`recense-init.ts:342-349`) — a single `askSecret`/`ask` read followed by a lowercase-compare:
```typescript
      const next = await askSecret(rl, `  Re-enter ${label} (or 's' to skip validation): `);
      if (next.toLowerCase() === 's') { ... return ...; }
```
→ Gate: `if (detectorSaysKeyPresent) { print billing warning; const ans = await ask(rl, '...continue? [y/N]', 'N'); if (ans.toLowerCase() !== 'y') process.exit(1); }`. **No file edits**
(honesty constraint). Print warning to stdout; do not touch `~/.claude/settings.json`.

**Testability convention the new logic must follow** (`recense-init.ts:19-21`, `59`): all real
side-effect logic lives in `// ── Exported testable helpers ──` pure functions; `main()` is never
run in tests. Any new provider-choice / gate logic that needs a test must be factored into an
exported pure helper (the detector already is). The init test file
(`tests/recense-init.test.ts:40-47`) imports exactly the exported helpers and mocks
`@anthropic-ai/sdk` / `openai` via `vi.hoisted` + `vi.mock` (`:14-38`).

---

### `src/adapter/recense-doctor.ts` (CLI/health-audit — billing dimension + CLI check + reworked API-key, D-11/D-12/D-13)

**Analog:** self. New dimensions must match the existing `CheckResult` dimension shape exactly.

**The dimension contract** (`recense-doctor.ts:42-48`) — every check returns this; new dimensions
must too:
```typescript
export interface CheckResult { ok: boolean; detail: string; }
function pass(detail: string): CheckResult { return { ok: true,  detail }; }
function fail(detail: string): CheckResult { return { ok: false, detail }; }
```

**Closest dimension shape to copy for the new billing-posture + claude-CLI checks** — a synchronous
check that branches on local state and returns pass/fail with a `run \`...\`` hint. `checkScheduler`
(`recense-doctor.ts:155-177`) is the best analog for the claude-CLI probe (D-13) because it already
shells out with `spawnSync(..., { stdio: 'pipe' })` and maps exit status to pass/fail:
```typescript
export function checkScheduler(): CheckResult {
  if (process.platform === 'darwin') {
    const result = spawnSync('launchctl', ['list', 'com.recense.sleep-pass'], { stdio: 'pipe' });
    if (result.status === 0) {
      return pass('com.recense.sleep-pass registered (macOS launchd)');
    }
    return fail('com.recense.sleep-pass not registered — run `recense scheduler install`');
  }
  ...
}
```
→ D-13 claude-CLI check: `spawnSync(bin, [<cheap non-billed flag>], { stdio: 'pipe' })` where
`bin = process.env['RECENSE_CLAUDE_BIN'] || 'claude'` (mirror the bin resolution from
`claude-headless-client.ts:208`). On non-zero/spawn-error →
`fail('claude CLI not found / not logged in — run \`claude login\`')`. **The "cheap, non-billed
probe" (D-13 discretion) must not spawn an inference call** — a `--version`/help/auth-status style
invocation, never `claude -p`. Confirm the chosen flag does not bill.

**Closest dimension shape for billing-posture (D-12)** — a check that reads local config/files and
branches, like `checkServeToken` (`recense-doctor.ts:281-301`), which `existsSync`-guards, reads
file state, and returns multiple pass/fail outcomes:
```typescript
export function checkServeToken(envPath: string = sleepEnvPath()): CheckResult {
  if (!existsSync(envPath)) {
    return pass('RECENSE_SERVE_TOKEN not set (no serve token needed unless running `recense serve`)');
  }
  ...
  const env = resolveExistingEnv(envPath);
  const token = env.get('RECENSE_SERVE_TOKEN');
  if (!token) { return pass('...'); }
  return pass('RECENSE_SERVE_TOKEN set, env file mode 0600');
}
```
→ `checkBillingPosture(settingsOverridePath?)`: resolve active provider (read configured env via
`loadConfiguredEnv`/`resolveExistingEnv` for `RECENSE_MODEL_PROVIDER`, falling back to
`DEFAULT_CONFIG.modelProvider`), call the shared detector, and:
`if (subscription && keyPresent) return fail('ANTHROPIC_API_KEY in ~/.claude/settings.json will
bill direct API even on subscription — remove it from the env block');` else `pass(...)`. **Take
an override path param** for testing — exactly like `checkHooks(settingsOverridePath?)`
(`recense-doctor.ts:190-191`) and `checkServeToken(envPath?)`.

**Reworking the API-key dimension (D-11).** Current `checkApiKeys` (`recense-doctor.ts:88-144`)
hard-fails when `ANTHROPIC_API_KEY` is missing (`:95-97`):
```typescript
  if (!anthropicKey) {
    results.push('ANTHROPIC missing');
    anyFail = true;
  } else { ... live call ... }
```
→ Under subscription mode a missing Anthropic key is **expected**: emit
`✓ subscription mode (Anthropic API key not needed)` and do **not** set `anyFail`. OpenAI branch
(`:121-140`) stays a hard fail when missing. Direct-API mode keeps current behavior. Provider is
read the same way the billing dimension reads it (single source — consider a shared
`resolveActiveProvider()` so D-11 and D-12 agree). Note `checkApiKeys` already references
`DEFAULT_CONFIG.anthropicModel`/`DEFAULT_CONFIG.openaiEmbedModel` (`:104`,`:129`) — that import is
already present (`:36`).

**How dimensions are registered and how exit-1 is tallied** (`recense-doctor.ts:305-347`). New
dimensions must be added to the `dimensions[]` array and **count toward the failure tally** (D-12
"counts toward the exit-1 failure tally"):
```typescript
  const dimensions: DoctorDimension[] = [
    { name: 'DB',          result: checkDb(dbPath)      },
    { name: 'API keys',    result: checkApiKeys()        },
    { name: 'Scheduler',   result: checkScheduler()      },
    { name: 'Hooks',       result: checkHooks()          },
    { name: 'Node ABI',    result: checkNodeAbi()        },
    { name: 'Serve token', result: checkServeToken()     },
  ];
  ...
  let failures = 0;
  for (const dim of dimensions) {
    const r = await dim.result;
    const icon = r.ok ? '✓' : '✗';
    process.stdout.write(`  ${icon} ${dim.name}: ${r.detail}\n`);
    if (!r.ok) { failures++; }
  }
  ...
  process.exitCode = failures > 0 ? 1 : 0;   // CR-02: never process.exit() in try/finally
```
→ Append `{ name: 'Billing', result: checkBillingPosture() }` and
`{ name: 'claude CLI', result: checkClaudeCli() }`. Because a returned `ok:false` auto-increments
`failures`, the billing dimension counts toward exit-1 **for free** — no special handling. The
header doc comment at `recense-doctor.ts:3-16` ("6-dimension … audit") must be updated to the new
dimension count.

**Doctor test pattern** (`tests/recense-doctor.test.ts`): each exported check is tested directly
with a temp settings.json written via `writeFileSync`/`mkdirSync` to `tmpdir()` and the override
path passed in (`:147-166` for `checkHooks`). New `checkBillingPosture` / `checkClaudeCli` tests
mirror this; provider-toggle tests set the provider via the override-path env file or a passed
config, matching the matrix in CONTEXT.md §Testing.

---

### NEW: settings.json `ANTHROPIC_API_KEY` detector (utility — safe JSON read → boolean, D-14)

**Analog (exact):** `src/adapter/settings-loader.ts:loadSettingsFile` (`:54-63`). This is the
canonical "read a JSON config file safely, never throw, return a typed result" helper in the repo:
```typescript
export function loadSettingsFile(path: string = defaultSettingsPath()): SettingsFile | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isSettingsFileShape(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}
```
**The load-bearing posture (D-14 "handle present / absent / missing-file / malformed-JSON"):**
`existsSync` guard → `try { JSON.parse } catch { return <neutral> }`. The detector returns a
**boolean** instead of an object, but the same four-outcome contract maps exactly:
absent file → `false`, parse error → `false`, key absent → `false`, key present → `true`.

**Secondary in-module analogs** (both already read `~/.claude/settings.json` this exact way):
- `recense-init.ts:mergeSettingsHooks` (`:188-195`) — `existsSync` + `try JSON.parse catch (log)`.
- `recense-doctor.ts:checkHooks` (`:192-201`) — `existsSync` → `fail(... not found)`, then
  `try JSON.parse catch → fail(parse error)`. This is the doctor-context shape (returns
  `CheckResult`, not bool) — useful to see how the **same file read** is consumed differently by
  the two callers, confirming D-14's "one reader, two consumers."

**Suggested signature (discretion D-14):**
```typescript
// reads ~/.claude/settings.json `env` block; true iff ANTHROPIC_API_KEY is set & non-empty.
export function settingsHasAnthropicKey(settingsPath: string = join(homedir(), '.claude', 'settings.json')): boolean
```
Default path = `join(homedir(), '.claude', 'settings.json')` (the exact path used at
`recense-init.ts:443` and `recense-doctor.ts:191`). **Accept an override path param** so both the
init-gate test and the doctor-dimension test can point at a temp file (mirrors `checkHooks`
override convention). The `env` block is `settings.env.ANTHROPIC_API_KEY`; guard each level
defensively since the file shape is user-owned and arbitrary.

**Test pattern:** mirror `tests/recense-doctor.test.ts:147-205` — write temp settings.json variants
(key-present / key-absent / no-file / malformed) to `tmpdir()`, pass the path, assert the boolean.

---

## Shared Patterns

### Safe user-owned JSON read (never throw)
**Source:** `src/adapter/settings-loader.ts:54-63` (canonical); also `recense-init.ts:188-195`,
`recense-doctor.ts:192-201`.
**Apply to:** the new detector.
```typescript
if (!existsSync(path)) return <neutral>;
try { const parsed = JSON.parse(readFileSync(path, 'utf8')); /* ...narrow... */ }
catch { return <neutral>; }
```

### `~/.claude/settings.json` path resolution
**Source:** `recense-init.ts:443` and `recense-doctor.ts:191`:
```typescript
const settingsPath = join(homedir(), '.claude', 'settings.json');
```
**Apply to:** the detector's default path. (Distinct from recense's own
`~/.config/recense/settings.json` in `settings-loader.ts:defaultSettingsPath()`.)

### `claude` binary resolution
**Source:** `src/model/claude-headless-client.ts:208` / `:310`:
```typescript
const bin = process.env['RECENSE_CLAUDE_BIN'] || 'claude';
```
**Apply to:** doctor D-13 claude-CLI probe (so tests can point `RECENSE_CLAUDE_BIN` at a stub).

### sleep.env path + provider resolution
**Source:** `src/adapter/runtime-config.ts` — `sleepEnvPath()` (`:27`), `loadConfiguredEnv()`
(`:75`), and the env-key idiom `RECENSE_MODEL_PROVIDER`.
**Apply to:** init (write `RECENSE_MODEL_PROVIDER`) and doctor (read it to determine active
provider). Use these helpers rather than re-deriving the path.

### CheckResult dimension + failure-tally
**Source:** `recense-doctor.ts:42-48` (`CheckResult`/`pass`/`fail`) + `:317-346` (registration loop
and `failures` tally → `process.exitCode`).
**Apply to:** both new doctor dimensions — returning `fail(...)` auto-counts toward exit-1.

### Spawn-status → pass/fail probe
**Source:** `recense-doctor.ts:155-177` (`checkScheduler`, `spawnSync(..., { stdio: 'pipe' })`).
**Apply to:** doctor D-13 claude-CLI presence/login probe.

### Exported-pure-helper testability
**Source:** `recense-init.ts:19-21,59` (helpers exported; `main()` never tested) +
`recense-doctor.ts` exported checks + `tests/recense-{init,doctor}.test.ts` (temp-file + override
path; mock SDKs via `vi.hoisted`/`vi.mock`).
**Apply to:** detector + new doctor dimensions + any new init gate logic.

---

## No Analog Found

None for code. The two docs files (`README.md`, `docs/evals.md`) are prose-only edits with no
code-pattern analog (D-15/D-16) — flagged here for completeness:

| File | Role | Data Flow | Note |
|------|------|-----------|------|
| `README.md` | docs | n/a | Quickstart prereqs + footgun line; honesty constraints apply (no "no keys needed"). |
| `docs/evals.md` | docs | n/a | Staleness note on `granite4.1:8b + qwen3.6:35b-a3b`; do **not** rewrite baseline numbers. |

---

## Metadata

**Analog search scope:** `src/lib/`, `src/adapter/`, `src/model/`, `src/consolidation/`, `tests/`.
**Files scanned:** config.ts, recense-init.ts, recense-doctor.ts, runtime-config.ts,
settings-loader.ts, anthropic-client.ts, claude-headless-client.ts, run-sleep-pass.ts (ref),
recense-init.test.ts, recense-doctor.test.ts, sleep-pass-provider.test.ts (ref).
**Pattern extraction date:** 2026-06-26.
