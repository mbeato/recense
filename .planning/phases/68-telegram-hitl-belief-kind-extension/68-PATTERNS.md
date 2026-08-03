# Phase 68: Telegram HITL Belief-Kind Extension - Pattern Map

**Mapped:** 2026-08-03
**Files analyzed:** 8 (2 modified, 4-5 new, tests bucketed separately)
**Analogs found:** 8 / 8

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|--------------------|------|-----------|-----------------|----------------|
| `clients/telegram/types.ts` (extend) | model | transform | live file itself — `StoredProposal` interface, `ProposalAction` type | exact (extend-in-place) |
| `clients/telegram/belief-proposal-client.ts` (NEW) | service | request-response | `clients/proposal-reference/proposal-client.ts` | exact |
| `clients/telegram/index.ts` (extend: poll fn + callback branch) | controller | event-driven (poll) + request-response (callback) | `clients/proposal-reference/index.ts` (`runSyncPass`) for the outcome-loop shape; `clients/telegram/index.ts` itself (`runClientTick` guard discipline :242-267, callback drain :410-484, `handleProposalAction` :1036-1148) for the in-repo dispatch idiom | exact (two analogs, complementary) |
| `clients/telegram/state.ts` (extend: approval-rate counters) | utility | file-I/O | live file itself (`writeStateCursor`/`readStateCursor` atomic tmp→rename pattern) | exact (extend-in-place) |
| `clients/telegram/proposal-store.ts` | model/service | CRUD | READ-ONLY — reuse as-is, zero diff | n/a (consume, don't modify) |
| `clients/telegram/proposal-engine.ts` | service | transform | READ-ONLY — reuse as-is (bypass, don't call) | n/a (consume, don't modify) |
| Belief decision-message renderer (new fn(s) in index.ts or a new small module) | component | transform | `renderProposalCard` / `proposalKeyboard` (`clients/telegram/index.ts` :583-602) | exact |
| `clients/telegram/tests/belief-*.test.ts` (NEW) | test | — | `clients/proposal-reference/tests/sync-loop.test.ts` (stub-server behavioral proof); `clients/telegram/tests/import-boundary.test.ts` (guard already scans new files) | exact |
| `tests/telegram-belief-e2e.test.ts` (NEW, optional per D-10) | test | — | `tests/proposal-reference-e2e.test.ts` | exact |

## Pattern Assignments

### `clients/telegram/types.ts` — extend `StoredProposal` into a discriminated union (D-01)

**Analog:** the live file itself (no existing `kind` field today — confirmed by direct read).

**Current shape** (lines 96-141, verbatim) — `StoredProposal` is a single flat interface, **not yet a union**, and carries **no `kind` field**:
```typescript
export interface StoredProposal {
  id: string;
  serverName: string;
  tool: string;
  args: Record<string, unknown>;
  nodeId: string;
  dueAt: string;
  maxTtlMs: number;
  createdAt: string;
  destructive: boolean;
  expectedConfirmValue: string;
}

export type ProposalAction = 'approve' | 'edit' | 'reject' | 'snooze';
```
D-01 requires: give the existing member an explicit literal `kind` (e.g. `'tool'`) and add a second member `kind: 'belief'` — this is the "if the union currently has no kind field" branch named in CONTEXT.md D-01. **This is the one file whose current shape genuinely differs from what CONTEXT.md hedges about — flag it to the planner exactly like this**, since it means the existing member's shape also gets a new required field (a small, mechanical, additive change — every `StoredProposal` literal constructed in `index.ts`/`proposal-engine.ts`, e.g. the one built at index.ts:737-748, needs `kind: 'tool'` added, still zero behavior change).

**Fields the belief member needs** — mirror `ActionProposalRecord` from `clients/proposal-reference/proposal-client.ts` (lines 22-57), transcribed locally per the same CONSUME-02-style discipline this client already follows for `McpServerConfig`/`SurfaceItem` (declared locally, never imported from `src/`):
```typescript
export type ProposalKind = 'belief';           // mirror proposal-client.ts:23
export type ProposalStatus =                    // mirror proposal-client.ts:26 (only what's needed client-side)
  'pending' | 'approved' | 'rejected' | 'superseded' | 'expired';

export interface StoredBeliefProposal {
  kind: 'belief';
  id: string;                 // server's sha256-hex proposal id — validate ^[0-9a-f]{64}$ before path use (D-04)
  entityDescriptor: string;
  changeField: string;
  changeFrom: string | null;  // verbatim sentence — never normalized (D-05)
  changeTo: string;           // status token — verbatim (D-05)
  evidenceQuote: string;      // rendered as fenced data only, never a gate (D-05/D-06)
  confidence: 'high' | 'medium' | 'low'; // categorical only — no numeric anywhere (D-06)
  expiresAt: number;          // epoch ms from server record — drives isExpired via dueAt/maxTtlMs mapping
  localStatus: 'pending' | 'terminal';   // client-local status tracking mirrors local-store.ts LocalRow shape
  createdAt: string;          // ISO 8601 — required by isExpired's createdAt+maxTtlMs check
}
```
**Zero-diff constraint note:** `proposal-store.ts`'s `isExpired()` reads `p.dueAt` and `p.createdAt + p.maxTtlMs` off whatever `StoredProposal` shape is passed — it is untyped-shape-agnostic at the field level ONLY if the belief member also carries `dueAt`/`maxTtlMs`/`createdAt` fields (or the planner maps `expires_at` → a synthesized `dueAt`+`maxTtlMs=0` pair at bridge time so `isExpired` "just works" unmodified). This is the concrete mechanism by which belief-kind rides the existing store with zero code changes — get this field mapping exactly right in the plan.

---

### `clients/telegram/belief-proposal-client.ts` (NEW) — HTTP bridge to `/v1/proposals`

**Analogs:**
1. `clients/proposal-reference/proposal-client.ts` (full file, 173 lines) — the proven consumer of this exact contract.
2. `clients/telegram/memory-client.ts` (lines 94-122) — this client's own HTTP factory conventions (Bearer built once, `AbortSignal.timeout`, throw-on-non-2xx).

**Imports pattern** (proposal-client.ts has zero imports — mirror exactly):
```typescript
// Zero src/ imports — CONSUME-02 / CLIENT-01. Node global `fetch` only.
```

**Id validation (copy verbatim — 67's WR-04 lesson, named explicitly in D-04):**
```typescript
// proposal-client.ts:68
const PROPOSAL_ID_RE = /^[0-9a-f]{64}$/;
```
```typescript
// proposal-client.ts:154-159 pattern
async approve(id: string): Promise<void> {
  if (!PROPOSAL_ID_RE.test(id)) {
    throw new Error('malformed proposal id in list response — refusing to build request path');
  }
  await postAction('/v1/proposals/' + id + '/approve');
},
```

**Error type (copy verbatim shape):**
```typescript
// proposal-client.ts:79-86
export class ProposalHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super('serve HTTP ' + String(status));
    this.status = status;
    this.name = 'ProposalHttpError';
  }
}
```

**Factory / auth pattern** — merge proposal-client.ts's `createProposalClient` shape with memory-client.ts's Bearer-header-built-once convention:
```typescript
// memory-client.ts:105-122 (Bearer + timeout + throw-on-non-2xx idiom)
export function createMemoryClient(serveUrl: string, serveToken: string): MemoryClient {
  const authHeader = `Bearer ${serveToken}`;
  async function postJson(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${serveUrl}${path}`, {
      method: 'POST',
      headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error('serve HTTP ' + String(res.status));
    return res.json();
  }
  ...
```
```typescript
// proposal-client.ts:139-148 — GET /v1/proposals list shape
async listProposals(): Promise<ActionProposalRecord[]> {
  const res = await fetch(serveUrl + '/v1/proposals', {
    method: 'GET',
    headers: { 'Authorization': authHeader },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new ProposalHttpError(res.status);
  const body = await res.json() as { items?: unknown };
  return Array.isArray(body.items) ? body.items as ActionProposalRecord[] : [];
},
```

**Env/config conventions** — `clients/proposal-reference/config.ts:31-35` pattern (reuse `RECENSE_SERVE_URL`/`RECENSE_SERVE_TOKEN` — same env vars `clients/telegram/config.ts:56-58` already reads for `loadClientConfig`, no new env vars needed for the bridge's auth; a new poll-cadence constant is Claude's Discretion per D-03/D-03's "own tick" note):
```typescript
// clients/telegram/config.ts:56-58
const telegramToken = process.env['TELEGRAM_BOT_TOKEN'] ?? '';
const serveUrl = process.env['RECENSE_SERVE_URL'] ?? 'http://127.0.0.1:7701';
const serveToken = process.env['RECENSE_SERVE_TOKEN'] ?? '';
```

---

### `clients/telegram/index.ts` — new poll fn + callback branch (D-03, D-04)

**Analog A — tick/in-flight-guard discipline (copy the pattern, own new variable):**
```typescript
// index.ts:33-45
// ---------------------------------------------------------------------------
// In-process tick serialization guards
//
// tickInFlight: Set true BEFORE the first await inside runClientTick; cleared in
//   the outermost finally so it resets even on the early-return (ask error / idle)
//   paths. Prevents a second setInterval tick from overlapping with an in-flight respond.
//
// pushInFlight: Independent guard for runPushTick — the push timer and the reactive
//   tick run on separate setIntervals and must each have their own guard. Never share.
// ---------------------------------------------------------------------------

let tickInFlight = false;
let pushInFlight = false;
```
→ a new `beliefPollInFlight` module-level boolean, own `finally` block, same "never share guards between loops" discipline (D-03: "own tick + own in-flight guard").

**Analog B — the outcome-loop shape (list → map → act → refusal-branch) from `runSyncPass`:**
```typescript
// clients/proposal-reference/index.ts:120-160 (list, wire-shape gate, schema gate before per-item work)
const records = await client.listProposals();
report.listed = records.length;

if ((records as unknown[]).some(r => !isInspectableRecord(r))) {
  log('malformed item in list response ...'); return report;
}
const badSchema = records.find(r => r.schema_version !== PROPOSAL_SCHEMA_VERSION);
if (badSchema !== undefined) { log('schema mismatch ...'); return report; }
```
```typescript
// clients/proposal-reference/index.ts:213-267 — refusal-status branch, the exact
// semantics D-04 requires the Telegram bridge to replicate (401 abort, 503 defer,
// 409-on-resumed → needs_reconciliation, 409/404/400 → terminal refused)
if (err instanceof ProposalHttpError) {
  if (err.status === 401) { throw err; }               // auth broken — abort whole poll
  if (row !== undefined) {
    if (err.status === 503) { report.deferred++; continue; }   // not terminal, retry next tick
    if (err.status === 409 && resumed) { /* needs_reconciliation */ continue; }
    const refusalReason = refusalReasonForStatus(err.status);  // 400/404/409 → terminal
    if (refusalReason !== null) { /* mark row terminal */ continue; }
  }
}
```
D-04's language ("409-class → update message + mark local row terminal, never retry; 503 → leave pending, retry next tick") is this exact branch — copy the status-class mapping, not the local-row shape (Telegram's row is `StoredBeliefProposal.localStatus`, not `local-store.ts`'s `LocalRow`).

**Analog C — the in-repo dispatch idiom (callback_query drain, version-prefix routing) to extend with a `kind==='belief'` branch:**
```typescript
// index.ts:405-447 — version-prefix routing precedent; belief-kind adds a third
// branch keyed on decoded kind, analogous to how '2|' vs '1|' is already routed
//   '2|...' → decodeProposalCallbackData → handleProposalAction (approval flow)
//   '1|...' → decodeCallbackData → surfaceSeen (Phase-22 surface-seen flow, unchanged)
if (data.startsWith('2|')) {
  const decodedProposal = decodeProposalCallbackData(data);
  if (decodedProposal) {
    try {
      await handleProposalAction(transport, memoryClient, getApprovalMcpConfigs(), getApprovalStorePath(),
        cq.fromId, decodedProposal, approvalHooks?.connectionFactory);
    } catch (err) { log('handleProposalAction error: ' + String(err)); }
  } else { log('callback_query: v2 malformed proposal data — skipping'); }
  try { await transport.answerCallbackQuery(cq.id); } catch (e) { log(...); }
  continue;
}
```
D-02's dispatch-BEFORE-any-engine/LLM-path requirement maps directly onto this precedent: a `kind === 'belief'` check happens at the very top of whatever the new `handleBeliefProposalAction` (or equivalent) does — no `validateProposal` import/call in that function at all (fail-if-called stub in tests proves this, per D-10).

**Analog D — `handleProposalAction`'s action-branch structure (`clients/telegram/index.ts:1036-1148`)** is the shape to mirror for the belief equivalent: `reject` branch does local terminal-mark + audit (no engine call); `edit` branch short-circuits (D-02: "belief proposals can only be approved or rejected" reply, mirroring the edit-prompt send at index.ts:1089-1094 but replying with a refusal message instead of registering `pendingEdit`); `approve` branch calls the new belief-proposal-client instead of `executeStoredProposal`.

---

### `clients/telegram/state.ts` — approval-rate counters (D-09)

**Analog:** the live file's atomic-write pattern (only 40 lines, single cursor field today — extend the JSON document, don't replace the module):
```typescript
// state.ts:14-22 — atomic tmp→rename + 0600 pattern to replicate for the new counters
export function writeStateCursor(statePath: string, cursor: string | null): void {
  mkdirSync(dirname(statePath), { recursive: true });
  const tmp = join(dirname(statePath), `.telegram-state-${Date.now()}-${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify({ cursor }), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, statePath);
}
```
```typescript
// state.ts:31-39 — never-throws-on-read pattern to replicate
export function readStateCursor(statePath: string): string | null {
  try {
    if (!existsSync(statePath)) return null;
    const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as { cursor?: unknown };
    return typeof parsed.cursor === 'string' ? parsed.cursor : null;
  } catch { return null; }
}
```
Current persisted document is `{ cursor }` only — the plan needs to widen it to `{ cursor, beliefApprovalStats: { approved: number; rejected: number; refused: number } }` (or a sibling `readBeliefApprovalStats`/`writeBeliefApprovalStats` pair reusing the same tmp→rename helper) while keeping `cursor` read/write untouched (surgical extension, matches CLAUDE.md's "modify only what the request requires"). No cross-file analog exists for a *counter* shape specifically — `proposal-store.ts`'s `CapState { date, count }` (lines 35-38) is the closest sibling shape (also a small persisted counter object) worth mirroring for field naming symmetry.

---

### `clients/telegram/proposal-store.ts` / `proposal-engine.ts` — READ-ONLY reuse (zero-diff, D-01/D-02)

**No pattern extraction needed — these are consumed, not modified.** The exact API surface belief-kind rides:
```typescript
// proposal-store.ts:4 (module doc) — shape-agnostic persistence claim to hold belief-kind to
// Persists a single JSON document { proposals: StoredProposal[]; cap: { date: string; count: number } }
```
```typescript
// proposal-store.ts:115-117 — isExpired, the exact function belief-kind rides unmodified
export function isExpired(p: StoredProposal, now: number): boolean {
  return now > Date.parse(p.dueAt) || now > Date.parse(p.createdAt) + p.maxTtlMs;
}
```
`putProposal`/`getProposal`/`removeProposal`/`loadExecutable`/`tryReserveProposalSlot`/`getCapState` (proposal-store.ts full range 128-267) — all operate on `StoredProposal` generically; the belief-kind bridge calls these exactly as `index.ts` already does at :9's import list, with no signature change.

```typescript
// proposal-engine.ts:243 — validateProposal, the bypassed step (D-02).
// The belief dispatch branch (Analog C/D above) must not import or call this
// function at all in the belief-kind code path — a fail-if-called stub test
// proves the bypass (D-10).
export function validateProposal(rawJson: string | null, allowedTools: McpToolDescriptor[]): ValidatedProposal
```

**Verification obligation (D-10):** the plan's tests must assert `git diff --stat` is empty for these two files — this is a convention-enforced invariant test, not a promise (mirrors `import-boundary.test.ts`'s "guard the guard" MIN_SCANNED_FILES floor idiom at :46 for how to make an invariant fail loudly rather than pass vacuously).

---

### Decision-surface rendering (D-05, D-06) — approval message + inline keyboard

**Analog:** `clients/telegram/index.ts:576-602` (`renderProposalCard` + `proposalKeyboard`) — the existing tool-proposal approval card and its keyboard, the closest precedent for "structured fields only, no LLM prose":
```typescript
// index.ts:583-585 — DATA ONLY card rendering (the "never model prose" precedent to extend)
function renderProposalCard(proposal: StoredProposal): string {
  return `[Proposed Action]\nTool: ${proposal.tool}\nArgs: ${JSON.stringify(proposal.args)}\nDue: ${proposal.dueAt}`;
}
```
```typescript
// index.ts:593-602 — the tap-target-labeled keyboard pattern; D-05 requires belief
// buttons to carry the FROM→TO transition on the label itself (not a bare
// "Approve"), which is a stronger version of this same idiom (emoji + short label
// + encoded callback_data, ≤64-byte limit)
function proposalKeyboard(proposalId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: '✅ Approve', callback_data: encodeProposalCallbackData(proposalId, 'a') },
      { text: '✏️ Edit',   callback_data: encodeProposalCallbackData(proposalId, 'e') },
      { text: '❌ Reject', callback_data: encodeProposalCallbackData(proposalId, 'r') },
      { text: '💤 Snooze', callback_data: encodeProposalCallbackData(proposalId, 's') },
    ]],
  };
}
```
**Field source for the belief card** — `ActionProposalRecord` (`clients/proposal-reference/proposal-client.ts:40-57`) already carries exactly the D-05 field set (`entity_descriptor`, `change_field`, `change_from`, `change_to`, `evidence_quote`, `confidence`) and Phase 67's `index.ts:342-355` `list` command shows the precedent for which fields are safe to surface and which are forbidden:
```typescript
// clients/proposal-reference/index.ts:343-355 — the "only closed-vocabulary/structured
// fields" precedent (never evidence_quote as a gate, never raw prose) to extend for
// Telegram's decision message (D-05 additionally requires evidence_quote AS FENCED DATA
// on the message body, distinct from proposal-reference's CLI list which omits it)
console.log(JSON.stringify({
  id: r.id,
  entity_descriptor: r.entity_descriptor,
  change_field: r.change_field,
  change_to: r.change_to,
  confidence: r.confidence,
  expires_at: r.expires_at,
}));
```
**No numeric confidence structural test precedent** — no existing grep-absence test in this repo to copy verbatim; model the new one after `import-boundary.test.ts`'s file-scan-with-regex structure (`clients/telegram/tests/import-boundary.test.ts:34,62-76`): same `collectTsFiles` walk, different regex (`confidence\s*[<>]=?|confidence\s*===?\s*['"]?\d` or similar numeric-comparison shape) scanning `clients/telegram/*.ts` for confidence-gate logic.

**v4.0 D-09 typed-confirm precedent (referenced, NOT reused — deferred per CONTEXT.md deferred section):** `clients/telegram/tests/typed-confirm.test.ts` and `index.ts:1118-1141`'s destructive-confirm branch is the "fixed generic button becomes a conditioned reflex" precedent D-05 explicitly avoids repeating for belief-kind (no typed-confirm gate on belief approve — only the labeled-transition button is required).

---

### Batching (D-07)

**No direct precedent for message batching** exists in the codebase — the closest analog is the daily-cap COUNTER shape (`proposal-store.ts` `CapState { date, count }` :35-38 and `tryReserveProposalSlot` :238-258's `toLocalDate` local-day helper :216-221), which the plan should reuse for the **grouping key** (`toLocalDate`-style local-calendar-day helper), not for cap-counting itself (batching happens client-side before any `tryReserveProposalSlot` call — D-03 confirms belief prompts still count toward the existing cap once batched). This is a genuinely new piece of client logic (group-by `entityDescriptor` + local day, one `sendMessage` per group) with no existing analog to copy structurally — flag as **no analog** below for the grouping/collapse logic itself, while the local-day computation copies `toLocalDate` verbatim:
```typescript
// proposal-store.ts:216-221
function toLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
```

---

### Tests

**Analog 1 — `clients/proposal-reference/tests/sync-loop.test.ts`** (stub-server behavioral proof, full 462-line structure at a glance): `http.createServer` on a free port (lines 43-44, 113-145), one `it()` per refusal class (409 terminal :215, 409-resumed→needs_reconciliation :239, 503-retry :283, unknown schema stops sync :306, malformed item :318/329, unknown kind skips :341, auth 401 aborts :357, single-flight :370/387/395, quote-is-data :407, malformed id WR-04 :442) — this is the direct template for the belief poll's own stub-server test file (each of these cases has a direct D-04-mandated counterpart for the Telegram bridge).

**Analog 2 — `clients/telegram/tests/import-boundary.test.ts`** (full file, already read above) — the hardened guard that will scan every new file this phase adds; **confirmed it needs no changes** — its `MIN_SCANNED_FILES = 15` floor (line 46) is a lower bound, so adding new `.ts` files under `clients/telegram/` only strengthens the non-vacuousness check, and the `collectTsFiles` walk (lines 49-60) recurses the whole directory tree including any new subfolder.

**Analog 3 — `tests/proposal-reference-e2e.test.ts`** (full file, already read above) — the repo-level harness pattern (real `createBrainHttpServer` + `SemanticStore`/`ActionProposalStore` seeding + `getFreePort` + `makeLlmFreeProvider` fail-if-called provider) — D-10's optional e2e follows this exact structure, importing the new Telegram belief-bridge's public entry point the same way `tests/proposal-reference-e2e.test.ts:39` imports `syncProposals` from `clients/proposal-reference/index`.

**Vitest include — confirmed, no change needed:**
```
// vitest.config.ts:6
include: ['tests/**/*.test.ts', 'clients/telegram/tests/**/*.test.ts', 'clients/proposal-reference/tests/**/*.test.ts'],
```
`clients/telegram/tests/**/*.test.ts` already covers any new `belief-*.test.ts` file dropped into that directory — no vitest.config.ts edit required.

## Shared Patterns

### HTTP client factory (Bearer + timeout + throw-on-non-2xx)
**Source:** `clients/telegram/memory-client.ts:105-122`, `clients/proposal-reference/proposal-client.ts:109-148`
**Apply to:** `belief-proposal-client.ts` (new)
```typescript
const authHeader = `Bearer ${serveToken}`;
const res = await fetch(url, { headers: { 'Authorization': authHeader }, signal: AbortSignal.timeout(10_000) });
if (!res.ok) throw new ProposalHttpError(res.status); // or plain Error, per memory-client.ts precedent
```

### Refusal-status branch (401 abort / 503 defer / 409-class terminal)
**Source:** `clients/proposal-reference/index.ts:213-267`
**Apply to:** the new belief poll loop's approve/reject error handling (D-04)

### Never-throws atomic file read/write (tmp→rename, 0600, corrupt→safe-default)
**Source:** `clients/telegram/state.ts` (full file), `clients/telegram/proposal-store.ts:54-99`
**Apply to:** approval-rate counter persistence in `state.ts`

### Proposal id shape validation before path construction
**Source:** `clients/proposal-reference/proposal-client.ts:68, 154-159`
**Apply to:** `belief-proposal-client.ts` approve/reject calls (D-04)

### Structured-fields-only rendering, never model prose
**Source:** `clients/telegram/index.ts:576-585`, `clients/proposal-reference/index.ts:343-355`
**Apply to:** the belief decision message renderer (D-05/D-06)

### In-process per-loop guard, never shared
**Source:** `clients/telegram/index.ts:33-45`
**Apply to:** the new belief poll's own `beliefPollInFlight` guard (D-03)

### Import-boundary guard (zero src/ imports, static scan)
**Source:** `clients/telegram/tests/import-boundary.test.ts` (full file)
**Apply to:** all new files under `clients/telegram/` — no test changes needed, guard already covers them

## No Analog Found

| File/Concern | Role | Data Flow | Reason |
|---------------|------|-----------|--------|
| Batch-collapse logic (group pending belief proposals by `entityDescriptor` + local day into one prompt) | transform | batch | No existing grouping/collapse logic in this codebase — closest sibling is the daily-cap counter's local-day helper (`toLocalDate`), reused only for the day key, not the grouping algorithm itself |
| Approval-rate self-report cadence/format (D-09) | utility | transform | No existing "periodic stat surfaced in a message" precedent; the counter *storage* mirrors `CapState`/`state.ts`, but the surfacing cadence (every Nth decision / monthly) and message text are novel |
| No-numeric-confidence structural grep test | test | — | No existing absence-proof grep test for a *value* pattern (only the import-boundary guard scans for import specifiers); structure the new test after `import-boundary.test.ts`'s scan-and-regex shape, but the regex itself is new |

## Metadata

**Analog search scope:** `clients/telegram/`, `clients/proposal-reference/`, `tests/proposal-reference-e2e.test.ts`, `vitest.config.ts`
**Files scanned/read in full or targeted ranges:** `clients/telegram/types.ts`, `proposal-store.ts`, `state.ts`, `config.ts` (grep), `index.ts` (targeted ranges: 1-70, 218-320, 398-497, 555-775, 1016-1148), `proposal-engine.ts` (223-322, grep for full outline), `memory-client.ts` (1-130), `clients/telegram/tests/import-boundary.test.ts` (full), `clients/proposal-reference/proposal-client.ts` (full), `clients/proposal-reference/index.ts` (full), `clients/proposal-reference/config.ts` (grep), `clients/proposal-reference/tests/sync-loop.test.ts` (grep outline), `tests/proposal-reference-e2e.test.ts` (full)
**Pattern extraction date:** 2026-08-03
