# Phase 65: Belief-Gated Status Drift + Provenance-Distinctness Fix - Pattern Map

**Mapped:** 2026-08-02
**Files analyzed:** 9 (2 new modules + 7 modified)
**Analogs found:** 9 / 9

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|--------------------|------|-----------|-----------------|---------------|
| `src/consolidation/strip-quoted.ts` (NEW — D-06 stripper) | utility | transform | `src/source/strip-hidden.ts` | role-match (compile-once regex discipline, pure/total/idempotent contract) |
| `src/consolidation/status-drift.ts` (NEW — drift layer, D-01 discretion: standalone module) | service | transform / event-driven | `src/consolidation/entity-resolution.ts` | exact (standalone, DB-typed, called-from-consolidator-branch seam; Phase 64's own D-01 precedent this phase is told to mirror) |
| `src/adapter/ingest-cli.ts` (sessionId mint, :184-191) | controller (CLI orchestrator) | event-driven / batch | itself (modify in place) | exact — self-analog, narrow edit |
| `src/source/gmail-adapter.ts` (`RawGmailMessage`, `normalizeGmailMessage`) | source-adapter | transform / request-response | itself (modify in place) | exact — self-analog, narrow edit |
| `src/source/source-adapter.ts` (`NormalizedRecord`) | model (interface) | transform | itself (modify in place) | exact — self-analog, narrow edit |
| `src/consolidation/update-decision.ts` (`countDistinctProvenance` fallback edit ONLY) | service (pure functions) | transform | itself (modify in place) | exact — self-analog, narrow edit; `routeContradiction` NOT touched |
| `src/lib/types.ts` (`PendingContradiction` — optional `provenance_key` fallback field) | model | transform | itself (modify in place) | exact — self-analog, narrow edit |
| `src/lib/config.ts` (optional `contradictionNBySource` dark knob) | config | transform | `consolSkipThresholdBySource` (config.ts:782, same file) | exact — in-file sibling pattern |
| `tests/status-drift.test.ts` (NEW) | test | transform | `tests/update-decision.test.ts` (pure-function unit tests) + `tests/consolidation-intent.test.ts` (consolidator-integration harness) | exact (two-layer: pure-fn unit tests + consolidator wiring test) |
| `tests/strip-quoted.test.ts` (NEW) | test | transform | `tests/entity-resolution.test.ts` (standalone-module test, no provider) | role-match |
| `scripts/eval/drift-05-dry-run.cjs` (NEW — D-14/D-15 measurement harness) | utility (eval script) | batch | `scripts/eval/correctness-harness.cjs` | exact (belief-correction accuracy harness, dry-run flag convention, scratch-DB discipline) |

## Pattern Assignments

### `src/consolidation/strip-quoted.ts` (NEW, utility, transform)

**Analog:** `src/source/strip-hidden.ts`

**Module doc-block + compile-once regex discipline** (strip-hidden.ts:1-20, 256):
```typescript
/**
 * stripHiddenContent — pure, deterministic markup + hidden-content stripper (EMAIL-03).
 * ...
 * All regexes are compiled ONCE at module load — never per call — mirroring redact.ts's
 * compile-once discipline. Global regexes have their `lastIndex` reset immediately before
 * each manual `.exec()` loop for the same reason `redactSecrets` does...
 */
const INVISIBLE_CODEPOINTS_RE = /[\p{Default_Ignorable_Code_Point}\u2028\u2029]/gu;
```
Copy this exact discipline for the D-06 stripper: compile every quote/forward-boundary regex
(`>`-quote line prefix, `On ... wrote:` boundary, `---------- Forwarded message ----------`-style
markers) as module-scope `const X_RE = /.../` — never inline in the function body.

**Contract block to replicate verbatim in spirit** (strip-hidden.ts:124-130):
```typescript
 * Contract:
 *  - Pure: no side effects, no I/O, no randomness, no clock read (LLM-free online path).
 *  - Idempotent: stripHiddenContent(stripHiddenContent(x)) === stripHiddenContent(x).
 *  - Total: never throws, for any string including empty/malformed/unterminated/deeply
 *    nested input.
 *  - Monotone toward less content: for adversarial or malformed input, the output is a
 *    subset-shaped reduction of the input — never the raw input passed through.
```
The D-06 stripper needs the same four guarantees (pure/idempotent/total/monotone-toward-less)
— write this contract block into the new file's doc comment, adjusted for quote/forward markers.

**Exported narrow-scope sibling function pattern** (strip-hidden.ts:1517-1519):
```typescript
export function stripInvisibleCodepoints(text: string): string {
  return text.replace(INVISIBLE_CODEPOINTS_RE, '');
}
```
Mirrors what D-06/D-07 need: one narrow exported function (e.g. `stripQuotedForwarded(text): string`)
plus a residual-emptiness helper (e.g. `isNearEmptyResidual(text): boolean`) — do NOT fold the
near-empty check into the stripper itself; keep them as two small exported functions, mirroring
how `stripInvisibleCodepoints` stays separate from the full `stripHiddenContent` pipeline for
callers needing only one stage.

**Where it is called from** (gmail-adapter.ts:60, 513-517) — the calling convention to mirror:
```typescript
import { stripHiddenContent, stripInvisibleCodepoints } from './strip-hidden';
...
const strippedBody =
  raw.bodyText.length <= MAX_STRIP_INPUT_CODE_UNITS
    ? stripHiddenContent(raw.bodyText)
    : STRIP_INPUT_OMITTED_MARKER;
```
D-06 says the new stripper applies "only on the provenance/distinctness path" — so it is called
from `status-drift.ts` (or wherever the distinctness key is computed), NOT from
`normalizeGmailMessage`. Do not add a second call site inside `gmail-adapter.ts`.

---

### `src/consolidation/status-drift.ts` (NEW, service, transform/event-driven)

**Analog:** `src/consolidation/entity-resolution.ts` (Phase 64's standalone-module-called-from-branch precedent, explicitly named in CONTEXT.md D-01 discretion as the seam to mirror)

**Module doc-block shape to copy** (entity-resolution.ts:1-49):
```typescript
/**
 * EntityResolver — standalone, reusable entity-resolution seam (Phase 64, Plan 64-02).
 *
 * Two responsibilities, both exported for reuse: ...
 *
 * Design decisions implemented here (CONTEXT.md D-01/D-02/...):
 *  D-01  Standalone module, not inlined into consolidator.ts — ...
 *  D-04  Zero net-new LLM calls — TYPE-LEVEL guarantee: the constructor below has no
 *        `ModelProvider` parameter, so this module cannot call a provider even by mistake.
 *  ...
 *
 * Known precision limits (stated honestly, not hidden): ...
 */
import Database from 'better-sqlite3';
import type { SemanticStore } from '../db/semantic-store';
import type { EngineConfig } from '../lib/config';
```
Copy the "zero net-new LLM calls — TYPE-LEVEL guarantee" pattern exactly: the drift layer's
constructor/function signature must have NO `ModelProvider` parameter, mirroring D-04 here,
since D-13's sentinel test (contradict_hold → zero emission-point invocations) and the
LLM-free-drift-layer requirement both depend on this being enforced by the type, not by
discipline alone.

**Confident-or-null / abstain-shaped decision result type** (entity-resolution.ts:83-96):
```typescript
export type ResolutionResult =
  | { resolved: true; nodeId: string; descriptor: string; score: number; channelCounts: ChannelCounts; }
  | { resolved: false; reason: 'no-candidates' | 'below-floor' | 'margin-too-close'; topScore?: number; channelCounts: ChannelCounts; };
```
Mirror this discriminated-union shape for the drift layer's own decision type, e.g.
`DriftDecision = { action: 'hold' } | { action: 'proceed'; dampedMagnitude: number }` — a
tagged union over the D-09 damping / D-10 lattice / D-11 event_ts-guard outcomes, so a
`contradict_hold`-unreachable-from-emission invariant (D-13) is checkable by exhaustive
switch rather than string comparison.

**Read-only / no-writes contract to copy** (entity-resolution.ts:33-37, 149-165):
```typescript
 *  D-12  Read-only contract: this module never calls `upsertNode`, `upsertEdge`, `strengthen`,
 *        or `tombstone`, and never opens a transaction. Its only SQL is two read-only prepared
 *        SELECTs plus reads through `store` ...
```
The drift layer is consulted BEFORE the claim reaches `routeContradiction` (D-11's "not by
modifying routeContradiction" instruction) — so it should be similarly read-only / pure-decision,
called from inside the consolidator's hold branch, never itself mutating the graph.

**Consolidator call site + insertion point** — the "hold" branch this phase's drift-layer output
(confidence damping, lattice check, event_ts guard) plugs into (consolidator.ts:1427-1470,
primary branch; :1582-1610, secondary-contradiction mirror):
```typescript
} else {
  // action === 'hold'
  // D-19: record ONLY if the episode is provenance-eligible.
  if (
    decision.claimOrigin !== 'inferred' &&
    decision.episodeSourceInferenceId === null
  ) {
    this.store.recordContradiction(decision.bestCandidateId, {
      episode_id: episodeId,
      session_id: decision.episodeSessionId,
      origin: decision.claimOrigin,
    } satisfies PendingContradiction);

    const updatedNode = this.store.getNode(decision.bestCandidateId);
    if (updatedNode) {
      const entries = safeParseContradictions(updatedNode.pending_contradictions);
      const distinctCount = countDistinctProvenance(entries);

      if (distinctCount >= this.config.contradictionN) {
        // force-destabilize ...
      }
    }
  }
}
```
This is the exact seam where D-09 (confidence damping), D-10 (lattice-aware confidence
lowering — but note D-10 says the lattice lives in the CLASSIFIER PROMPT, not here; this
module only CONSUMES the already-lowered confidence), and D-11's `event_ts` guard combine:
before `routeContradiction` is called at :1350/:1555, the drift layer inspects
`decision.claimIntentConfidence` / `decision.claimIntentStatus` (already threaded per Phase
63/64, see `ClaimDecision` below) plus the candidate node's most recent supporting-evidence
`event_ts`, and either (a) passes `decision.magnitude` through unchanged/damped to
`routeContradiction`, or (b) short-circuits straight to a `hold`-shaped outcome that never
reaches `routeContradiction` at all. `routeContradiction` itself (update-decision.ts:45-61)
is NOT modified — the guard sits structurally BEFORE it, exactly as D-11 requires.

**`ClaimDecision` fields this phase reads (already threaded by Phase 63/64)** (consolidator.ts:152-234):
```typescript
interface ClaimDecision {
  ...
  claimIntentStatus?: IntentStatus;
  claimIntentEntity?: string;
  claimIntentConfidence?: IntentConfidence;
  claimResolvedEntityId?: string;
  claimResolvedEntityDescriptor?: string;
  ...
}
```
Phase 65 is the FIRST consumer of `claimIntentConfidence` / `claimResolvedEntityId` per their
own doc comments ("INERT this phase (D-08/D-09): nothing consumes this field... Phase 65 is the
first consumer"). No new field needs adding to `ClaimDecision` for the damping mechanic itself —
consume what is already there.

**Hard-stop discipline the drift layer must inherit, not re-implement** (consolidator.ts:691, 804, 1021-1026 — comment pattern to replicate in the new module's own doc block):
```typescript
// ── WR-01 / CR-01 / ACT-03: hard stop — no graph effects for inferred, echo, or hitl episodes ──
```
Any drift-layer call site must be positioned textually AFTER this hard stop (mirrors how
Phase 63/64 fields are filled) — do not re-check `origin === 'inferred'` a second time with
different logic; inherit the guard by call-site position, as CONTEXT.md's Integration Points
section states explicitly ("strictly after the :643 hard-stop, inheriting the structural guards").

---

### `src/adapter/ingest-cli.ts` (modified — D-02 primary mechanism)

**Analog:** self (narrow edit to existing mint site)

**Current mint site** (ingest-cli.ts:181-196):
```typescript
const appendBatch = db.transaction((batch: NormalizedRecord[]) => {
  for (const r of batch) {
    // recordEvent is synchronous (better-sqlite3 invariant — no await inside tx)
    pipeline.recordEvent({
      content: r.content,
      role: r.role,
      origin: r.origin,
      sessionId: `ingest:${r.source}`,
      source: r.source,
      externalId: r.external_id,
      eventTs: r.event_ts ?? null,
    });
    appended++;
  }
});
```
D-02 default: change `sessionId: \`ingest:${r.source}\`` to derive a richer per-email key when
`r.source === 'gmail'` (or generically, when the adapter attaches distinctness metadata), e.g.
`ingest:gmail:<derived-key>` from sender-domain + threadId carried on the record (see
`NormalizedRecord` extension below). Non-gmail sources keep the literal `ingest:${r.source}`
unchanged — this is a source-conditional branch inside the existing transaction loop, not a
new function. If the D-02 blast-radius audit forces the fallback shape instead, this call site
is UNCHANGED and the fallback field is threaded through `recordEvent`'s options into
`PendingContradiction.provenance_key` at record time instead (see `types.ts` entry below).

**Blast-radius audit surface** (grep list from CONTEXT.md's Integration Points, not yet read —
flag for planner/research pass, do not skip): `src/recall/index.ts`, `src/eval/snapshot.ts`,
`src/db/episode-store.ts`, `src/adapter/memory-ops.ts`, `src/responder/index.ts`,
`src/ingest/pipeline.ts` — every `session_id`/`sessionId` consumer must be checked for semantic
breakage under per-thread granularity before D-02's default ships live.

---

### `src/source/gmail-adapter.ts` (modified — D-04/D-05 thread lineage + sender capture)

**Analog:** self (narrow edit to existing shapes)

**`RawGmailMessage` extension site** (gmail-adapter.ts:71-88):
```typescript
export interface RawGmailMessage {
  /** Gmail API message id (immutable, used as external_id — D-59). */
  id: string;
  headers: {
    from: string;
    subject: string;
    date: string;
  };
  bodyText: string;
}
```
Add `threadId: string` (D-04: Gmail's server-assigned `threadId`, already returned by
`messages.get` — wiring only, zero new API calls) as a sibling to `id`, with a doc comment
mirroring the `id` field's style (`/** Gmail API thread id (server-assigned, D-04) — used for
provenance-distinctness thread lineage; do NOT reconstruct from References/In-Reply-To. */`).

**Sender-controlled-input normalization discipline to mirror** (gmail-adapter.ts:497-529,
517-518 specifically):
```typescript
const strippedFrom = stripInvisibleCodepoints(raw.headers.from);
const strippedSubject = stripInvisibleCodepoints(raw.headers.subject);
```
D-05: the normalized-sender-identity derivation (domain or address, parsed from `From:`) must
run `stripInvisibleCodepoints` first, exactly like `strippedFrom` above, before any
normalization/hashing into the distinctness key — same call, same ordering discipline
(invisible-codepoint stripping before any pattern match, so a payload cannot fragment the
parse with zero-width characters).

**`normalizeGmailMessage` return-site extension** (gmail-adapter.ts:540-553):
```typescript
return {
  content,
  source: 'gmail',
  external_id: raw.id,
  origin: 'observed',
  event_ts: parseEmailDate(raw.headers.date, nowMs),
  role: 'user',
};
```
Add whatever new `NormalizedRecord` field(s) carry threadId + normalized-sender (see
`source-adapter.ts` entry below) to this return object, computed from `raw.threadId` and
`strippedFrom` — both already in scope at this point in the function.

---

### `src/source/source-adapter.ts` (modified — `NormalizedRecord` metadata threading)

**Analog:** self (interface extension, mirrors `event_ts`'s own addition)

**Existing optional-field precedent to copy exactly** (source-adapter.ts:125-131):
```typescript
  /**
   * Optional source-asserted event time in epoch ms (EMAIL-04). Omit or set null when the
   * source asserts no event time. NOT a salience hint (D-60 still forbids adapters from
   * carrying salience) and NOT an alternative dedup key (D-59 still owns dedup via
   * (source, external_id)) — see invariant 6 above.
   */
  event_ts?: number | null;
```
This is the exact template for adding `threadId?: string` / `senderKey?: string` (or a single
`provenanceKey?: string` pre-composed field, per D-01's "planner discretion" on composition):
optional, doc-commented with which invariant it does NOT participate in (not a dedup key per
D-59, not a salience hint per D-60), source-specific (gmail-only; other adapters omit it).

**Invariant-list update site** (source-adapter.ts:68-79) — add a 7th bullet mirroring bullet 6's
style ("An adapter that sets event_ts must have derived it from source-asserted data...") for
the new field's provenance-honesty contract (e.g. "An adapter that sets threadId must use the
source's server-assigned lineage, never sender-controlled header reconstruction — D-04").

---

### `src/consolidation/update-decision.ts` (modified — fallback edit site ONLY, D-02 fallback shape)

**Analog:** self — modify `countDistinctProvenance` only if the D-02 default (richer `sessionId`
mint) fails the blast-radius audit. `routeContradiction` (:45-61) and `isOscillation` (:74-77)
are LOCKED — do not touch.

**Current implementation** (update-decision.ts:79-98):
```typescript
export function countDistinctProvenance(entries: PendingContradiction[]): number {
  const sessions = new Set<string>();
  for (const entry of entries) {
    if (entry.origin !== 'inferred') {
      sessions.add(entry.session_id);
    }
  }
  return sessions.size;
}
```
Fallback-shape edit (only if D-02 default is rejected by the audit): count
`entry.provenance_key ?? entry.session_id` instead of `entry.session_id`, preserving the
`origin !== 'inferred'` exclusion untouched:
```typescript
sessions.add(entry.provenance_key ?? entry.session_id);
```
This is the ONLY line that changes in this function under the fallback path — the D-19
inferred-exclusion and the Set-based dedup structure are preserved byte-identical otherwise.

---

### `src/lib/types.ts` (modified — `PendingContradiction` fallback field, conditional on D-02 fallback)

**Analog:** self — extend the existing interface with the same doc-comment density.

**Current shape** (types.ts:9-18):
```typescript
/**
 * One provenance-distinct contradiction record stored in node.pending_contradictions.
 * Carries session_id + origin so force-destabilization can count distinct sessions
 * while excluding inferred-origin entries (D-19, mirrors the strengthen() origin-guard).
 */
export interface PendingContradiction {
  episode_id: string;
  session_id: string;
  origin: Origin;
}
```
Fallback addition (only if D-02's session_id-mint default fails the audit):
```typescript
export interface PendingContradiction {
  episode_id: string;
  session_id: string;
  origin: Origin;
  /** Optional richer distinctness key (D-02 fallback, DRIFT-03). When present,
   *  countDistinctProvenance counts this instead of session_id. Written at record
   *  time only for sources that compute one (gmail); absent elsewhere. */
  provenance_key?: string;
}
```

---

### `src/lib/config.ts` (modified — D-16 optional dark knob, `contradictionNBySource`)

**Analog:** `consolSkipThresholdBySource` (same file, config.ts:40-51 interface + 780-796 default value)

**Interface doc-comment pattern to copy** (config.ts:42-51):
```typescript
  /**
   * Per-source consolidation skip threshold (D-60, mirrors consolSkipThresholdAssistant).
   * Sources not listed fall back to consolSkipThreshold (global 0.2 default).
   * 'gmail': 0.4 → higher bar; most email is lower-signal than conversation turns.
   * 'granola': 0.25 → slightly above default; transcripts denser but noisier.
   * D-13 calibration placeholders — tune against real consolidation cost vs. recall.
   * Reversibility: remove an entry to restore the global consolSkipThreshold for that source.
   */
  consolSkipThresholdBySource: Record<string, number>;
```

**Default-value pattern to copy** (config.ts:780-795):
```typescript
  // Per-source consolidation skip threshold (D-60, mirrors consolSkipThresholdAssistant).
  // Sources not listed fall back to the per-role default (consolSkipThreshold / consolSkipThresholdAssistant).
  consolSkipThresholdBySource: {
    'claude-code': 0.5, // COST-02 (Phase 42-04, 2026-06-25): ...
    gmail: 0.4,         // higher bar: email is lower-signal; aggressive skip saves LLM budget
    ...
  },
```
D-16's `contradictionNBySource: Record<string, number>` should be added as a sibling field on
`SalienceConfig` (or a new top-level `EngineConfig` field, matching wherever `contradictionN`
itself lives — currently `EngineConfig.contradictionN`, config.ts:88 interface / :808 default,
NOT inside `SalienceConfig`) with the identical "sources not listed fall back to the global
default" contract, default `{}` (absent/3 per D-16 — i.e. an empty object, since `contradictionN`
itself already defaults to 3 at config.ts:808). Mirror the doc-comment density and the
"Reversibility: remove an entry to restore X" closing line exactly.

**Global default this knob overrides per-source** (config.ts:84-88, 808):
```typescript
  /**
   * Number of distinct provenance contradictions before force-destabilization
   * (Chen-2020 threshold). N=3 balances noise tolerance vs. responsiveness.
   */
  contradictionN: number;
  ...
  contradictionN: 3,
```

---

### `tests/status-drift.test.ts` (NEW)

**Analog A (pure-function unit tests):** `tests/update-decision.test.ts` (full file, 190 lines —
read completely; it is the DIRECT locked-test template for DRIFT-03's own required tests)

**Structure to copy** (update-decision.test.ts:1-18, 137-189):
```typescript
/**
 * Unit tests for the pure PE-gated routing functions (spec §4, D-15/D-16/D-19/D-20).
 * All functions under test are pure — no DB, no network, no clock side-effects.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { PendingContradiction } from '../src/lib/types';
import { routeContradiction, isOscillation, countDistinctProvenance } from '../src/consolidation/update-decision';

describe('countDistinctProvenance', () => {
  it('three entries across two session_ids → 2 (counts distinct sessions)', () => {
    const entries: PendingContradiction[] = [
      { episode_id: 'e1', session_id: 'session-a', origin: 'observed' },
      { episode_id: 'e2', session_id: 'session-a', origin: 'observed' }, // duplicate session
      { episode_id: 'e3', session_id: 'session-b', origin: 'observed' },
    ];
    expect(countDistinctProvenance(entries)).toBe(2);
  });
  ...
});
```
D-07's locked test pair (3-independent → 3, 3-forwards → 1) belongs in this exact
`describe('countDistinctProvenance', ...)` block if the D-02 default ships (feeding
per-thread-derived `session_id` values into the same pure function), or as a new
`describe('countDistinctProvenance with provenance_key', ...)` block under the fallback shape.
Also add a `describe('drift layer', ...)` block for the confidence-damping / lattice / event_ts
guard functions in the new `status-drift.ts` module, same style: no DB, no clock, pure inputs.

**Analog B (consolidator-integration harness):** `tests/consolidation-intent.test.ts` (563 lines
— read completely for full harness; excerpt below is the reusable skeleton)

**Harness skeleton to copy** (consolidation-intent.test.ts:1-100):
```typescript
/**
 * Tests for CLASSIFY-02 intent-field threading through the consolidator (Phase 63-04).
 * ...
 * Observation seam (D-08): the intent fields are inert this phase — nothing consumes them...
 * This file uses an instance-level spy (not a subclass — `applyDecision` is a TS `private`
 * method, so a real subclass override would collide at the type level) that monkey-patches
 * the single `Consolidator` instance under test to capture the `ClaimDecision` array...
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import { initSchema } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
...
function makeSyntheticEmbedFn(dims: number): (text: string) => Float32Array { ... }
function makeZeroEmbedFn(dims: number): (_text: string) => Float32Array { ... }
function makeAlwaysSameEmbedFn(dims: number): (_text: string) => Float32Array { ... }

interface Harness {
  db: Database.Database;
  clock: FakeClock;
  episodes: EpisodicStore;
  store: SemanticStore;
  strength: StrengthDecayManager;
  retriever: CandidateRetriever;
  config: EngineConfig;
}
```
This is the exact harness shape for D-13's sentinel test ("an ambiguous single email → hold →
zero emission-point invocations"): use the same monkey-patch-the-sink or
monkey-patch-`applyDecision` spy technique (since `sink.emit` is the emission-point surface a
`contradict_hold` outcome must never reach) rather than subclassing.

---

### `tests/strip-quoted.test.ts` (NEW)

**Analog:** `tests/entity-resolution.test.ts` (standalone-module test, no provider, no consolidator)

**Structure to copy** (entity-resolution.test.ts:1-52):
```typescript
/**
 * EntityResolver unit tests — Phase 64, Plan 64-02 (D-13 minimum test set).
 * Constructs EntityResolver directly against an in-memory SQLite DB ... no Consolidator,
 * no ModelProvider, no provider stub of any kind.
 */
import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { initSchema } from '../src/db/schema';
...
function makeHarness(configOverrides: Partial<EngineConfig> = {}): Harness { ... }
```
The D-06 stripper needs no DB/harness at all (pure string→string function) — model this test
file more narrowly on the pure-function half of `tests/update-decision.test.ts` instead
(`describe('isOscillation', ...)` block, update-decision.test.ts:104-135) for the
input/output table-test style, while keeping entity-resolution.test.ts's file-header discipline
("no provider stub of any kind" honesty framing) for the doc comment.

---

### `scripts/eval/drift-05-dry-run.cjs` (NEW — D-14/D-15 measurement harness)

**Analog:** `scripts/eval/correctness-harness.cjs` (404 lines — the exact belief-correction
accuracy harness D-15 says to extend)

**Header + CLI-arg + dry-run-flag convention to copy** (correctness-harness.cjs:1-39):
```javascript
/**
 * EVAL-02 Correctness Harness — belief-correction (recense) vs ADD-only baseline.
 *
 * Run:
 *   npm run build && node scripts/eval/correctness-harness.cjs --dry-run
 *   npm run build && ANTHROPIC_API_KEY=... OPENAI_API_KEY=... node scripts/eval/correctness-harness.cjs
 * ...
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i !== -1 ? process.argv[i + 1] : d; };
const DRY_RUN   = process.argv.includes('--dry-run');
const CASES_PATH = arg('--cases', 'scripts/eval/cases/correctness-cases.json');
const OUT        = arg('--out',   'scripts/eval/results/correctness-PENDING.json');
```

**Compiled-dist-import convention** (correctness-harness.cjs:41-56):
```javascript
// ---- compiled engine modules (require npm run build first) ------------------
const Database                = require('better-sqlite3');
const { initSchema }          = require('../../dist/src/db/schema');
const { DEFAULT_CONFIG }      = require('../../dist/src/lib/config');
const { realClock }           = require('../../dist/src/lib/clock');
...
const { runConsolidation }    = require('../../dist/src/consolidation/run-sleep-pass');
```

**API-key guard for real (non-dry) runs** (correctness-harness.cjs:76-80):
```javascript
if (!DRY_RUN) {
  const missing = [];
  if (!process.env.ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
  if (!process.env.OPENAI_API_KEY)    missing.push('OPENAI_API_KEY');
```
D-14's dry-run-against-real-multi-email-status-threads discipline and D-15's honest-methodology
requirement both map onto this file's conventions directly: `--dry-run` mode should run the new
distinctness key + drift layer computing-and-logging-only (per D-14, "ships behind a config knob
defaulting to old behavior"), a real-run mode ingests the founder's actual inbox status threads
and reports before/after belief-correction accuracy with methodology stated inline in the output
JSON — same `--cases`/`--out` arg convention, same scratch-DB-per-case discipline
(correctness-harness.cjs:12 "Every case uses a fresh scratch DB under os.tmpdir()").

---

## Shared Patterns

### Compile-once regex discipline (LLM-free, deterministic transforms)
**Source:** `src/source/strip-hidden.ts:256` (`const INVISIBLE_CODEPOINTS_RE = /.../gu;` at module
scope) and its own doc-block (lines 13-17) explaining why.
**Apply to:** `src/consolidation/strip-quoted.ts` — every quote/forward-boundary pattern must be a
module-scope `const`, never constructed inside the exported function.

### Standalone module, called from a consolidator branch, no ModelProvider parameter
**Source:** `src/consolidation/entity-resolution.ts` (D-01/D-04 in its own doc block, lines 16, 23-24)
**Apply to:** `src/consolidation/status-drift.ts` — same shape: a class or set of pure functions
taking `(db, store, config)` or narrower, with a type-level guarantee (no `ModelProvider` param)
backing the zero-net-new-LLM-calls claim, called from inside `Consolidator`'s existing
hold-branch rather than inlined into `consolidator.ts` itself.

### Hard-stop inheritance by call-site position, never re-implemented
**Source:** `src/consolidation/consolidator.ts:691` (`// ── WR-01 / CR-01 / ACT-03: hard stop — no
graph effects for inferred, echo, or hitl episodes ──`) plus the repeated comment at :804, :1021-1026
explaining "textually AFTER the hard stop... inherits that guard by construction."
**Apply to:** the drift layer's call site inside `applyDecision`/`applySecondaryContradiction` —
position it after the existing hard stop; do not add a second inferred/echo/hitl check with
different logic.

### Sender-controlled-input normalization (invisible-codepoint stripping before parsing)
**Source:** `src/source/gmail-adapter.ts:497-529` (`stripInvisibleCodepoints` applied to
`From:`/`Subject:` before any pattern work, doc-commented as "sender-controlled input... run
BEFORE the provenance header is joined").
**Apply to:** the D-05 normalized-sender-identity derivation inside `status-drift.ts` (or wherever
the distinctness key is composed) — strip invisible codepoints from the `From:` header value
before extracting/normalizing the domain or address.

### Dark-knob config convention (new behavior defaults to old behavior)
**Source:** `src/lib/config.ts:772-795` (`sourceWeights` / `consolSkipThresholdBySource` — "Per-source
X (D-60, mirrors Y). Sources not listed fall back to the global default. Reversibility: remove an
entry to restore...").
**Apply to:** D-16's `contradictionNBySource` and D-14's distinctness-key enablement flag — both
must default to the pre-Phase-65 behavior and be reversible by removing/unsetting the knob.

### PendingContradiction / countDistinctProvenance — the mechanism this phase feeds, not replaces
**Source:** `src/consolidation/update-decision.ts:79-98` + `src/lib/types.ts:9-18`.
**Apply to:** every DRIFT-03 change — the Set-based distinct-session counting structure and the
`origin !== 'inferred'` exclusion (D-19) must survive unchanged; only what POPULATES the counted
key changes (D-02 default: `session_id` itself; D-02 fallback: a new `provenance_key` field).

### Belief-correction accuracy measurement — extend, don't reinvent
**Source:** `scripts/eval/correctness-harness.cjs` (`--dry-run` flag, scratch-DB-per-case, compiled
`dist/` imports, `--cases`/`--out` args, honest-methodology doc-comment style throughout).
**Apply to:** D-15's harness extension and D-14's dry-run script — same CLI conventions, same
"state methodology, claim nothing the measurement doesn't show" discipline already present in
this file's own header comment (lines 20-25, the "corrected scoring... an approximation" honesty
note).

## No Analog Found

None — every file in CONTEXT.md's canonical_refs + code_context has either a strong self-analog
(narrow edits to existing files) or a strong cross-file analog (new modules mapped to Phase 64's
entity-resolution.ts / strip-hidden.ts / correctness-harness.cjs precedents). The one genuine
unknown — exact key composition and mechanism placement (D-02 default vs. fallback) — is a
locked research-pass decision per CONTEXT.md, not a missing-analog gap; both shapes are patterned
above so the planner can proceed either way once the blast-radius audit resolves it.

## Metadata

**Analog search scope:** `src/consolidation/`, `src/source/`, `src/adapter/`, `src/lib/`, `src/db/`,
`tests/`, `scripts/eval/` — directories named in CONTEXT.md's canonical_refs and code_context
sections exclusively (no broader repo scan needed; the phase's own context already pinpointed
every seam with line numbers).
**Files scanned:** 15 read directly (`entity-resolution.ts`, `update-decision.ts`, `strip-hidden.ts`
[targeted sections], `gmail-adapter.ts` [targeted sections], `source-adapter.ts`, `ingest-cli.ts`
[targeted sections], `consolidator.ts` [targeted sections], `types.ts` [targeted], `config.ts`
[targeted], `episode-order.ts` [full], `schema.ts` [targeted], `update-decision.test.ts` [full],
`consolidation-intent.test.ts` [targeted], `entity-resolution.test.ts` [targeted],
`correctness-harness.cjs` [targeted]) + `ls`/`grep`/`wc -l` reconnaissance over
`src/consolidation/`, `tests/`, `scripts/eval/`.
**Pattern extraction date:** 2026-08-02
