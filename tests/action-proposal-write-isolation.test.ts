/**
 * D-43-for-proposals — the named sentinel closing EMIT-05's largest correctness risk: a
 * consumer's approve/reject decision on a proposal writes proposal status and nothing else,
 * ever. This defect class has shipped twice before in this codebase (a pre-launch critical
 * finding and v9.0's live self-confirmation bug, C-2) under review discipline alone — both
 * times the convention comment was there and it shipped anyway. Two independent layers exist
 * because of that history: the static layer (a) catches a future edit at review time by
 * scanning the exact three modules on the approve/reject path for belief-write-shaped tokens;
 * the runtime layer (b) catches an indirect write the token list never anticipated by
 * comparing the WHOLE `node` and `edge` tables, byte-for-byte, across a real approve and a
 * real reject over a graph with varied strengths and confidences.
 *
 * Layer (a) mirrors tests/no-ats-domain-table.test.ts's exported-predicate / real-scan /
 * planted-offender shape and tests/emission-hold-sentinel.test.ts's balanced-block
 * extraction + comment-stripping idiom (each consumer keeps its own copy of that idiom per
 * that file's own convention — not exported, not imported across test files).
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { initSchema } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import { SemanticStore } from '../src/db/semantic-store';
import { EpisodicStore } from '../src/db/episode-store';
import { ActionProposalStore } from '../src/db/action-proposal-store';
import type { ActionProposalRecord } from '../src/db/action-proposal-store';
import { wireMemoryEngine, ProposalStaleError } from '../src/adapter/memory-ops';
import { MockModelProvider } from '../src/model/provider';

const STORE_PATH = resolve(__dirname, '..', 'src', 'db', 'action-proposal-store.ts');
const MEMORY_OPS_PATH = resolve(__dirname, '..', 'src', 'adapter', 'memory-ops.ts');
const SERVE_CLI_PATH = resolve(__dirname, '..', 'src', 'adapter', 'serve-cli.ts');

function makeTempDbPath(prefix: string): string {
  return join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

// ---------------------------------------------------------------------------
// Layer (a) — static predicate
// ---------------------------------------------------------------------------

/**
 * Forbidden belief-write tokens (D-43-for-proposals). The SQL group catches a hand-written
 * statement against node/edge; the API group catches a call through SemanticStore/
 * StrengthDecayManager. Matched case-insensitively for the SQL forms (SQL keywords are
 * conventionally uppercase but this must not rely on convention) and case-sensitively for the
 * API forms (these are real identifiers — case-insensitive matching would over-flag prose).
 * Exported so the it.each planted-offender suite below draws from the SAME list the predicate
 * checks — two independently maintained lists is the exact duplication defect this guard
 * exists to prevent (the ATS_DOMAIN_TOKENS rationale, restated).
 */
const SQL_WRITE_TOKENS: readonly string[] = [
  'UPDATE node',
  'INSERT INTO node',
  'DELETE FROM node',
  'UPDATE edge',
  'INSERT INTO edge',
  'DELETE FROM edge',
];

const API_WRITE_TOKENS: readonly string[] = [
  'upsertNode',
  'upsertEdge',
  'setEmbedding',
  'upsertNodeTemporal',
  'recordContradiction',
  '.tombstone(',
  '.strengthen(',
];

export const FORBIDDEN_BELIEF_WRITE_TOKENS: readonly string[] = [...SQL_WRITE_TOKENS, ...API_WRITE_TOKENS];

/** Strip `//` and `/* *\/` comments from an already-extracted block (never the whole file —
 * that would destroy the anchor text used to locate the block in the first place). */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ');
}

/** Extract the balanced `{ ... }` block starting at `openBraceIdx` (inclusive of both braces). */
function extractBalancedBlockFromBrace(src: string, openBraceIdx: number): string {
  let depth = 0;
  let j = openBraceIdx;
  do {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') depth--;
    j++;
  } while (depth > 0 && j < src.length);
  return src.slice(openBraceIdx, j);
}

/**
 * Locate the balanced block anchored by `anchorText`, whose real opening brace is the LAST
 * '{' before the first newline following the anchor. This matters because BOTH shipped
 * function-declaration signatures (`async function approveProposal(id: string):
 * Promise<{ status: string }> {`) contain an inline `{ status: string }` type-literal brace
 * pair BEFORE the real function-body brace — a naive forward `indexOf('{', anchorIdx)` would
 * grab that inner literal's brace and depth-match closed at its own `}`, extracting the wrong
 * (and far too short) block. The shipped if-block conditions place their real opening brace at
 * the end of the anchor's own source line too, so one rule covers both region shapes.
 *
 * Returns null when the anchor is not found — silently skipped (never thrown), so synthetic
 * partial fixtures stay usable; the real-source test separately asserts every anchor IS
 * present, so a silently-skipped anchor cannot make that scan vacuous.
 */
function extractAnchoredBlock(text: string, anchorText: string): string | null {
  const anchorIdx = text.indexOf(anchorText);
  if (anchorIdx === -1) return null;
  const lineEnd = text.indexOf('\n', anchorIdx);
  const searchEnd = lineEnd === -1 ? text.length : lineEnd;
  const openBrace = text.lastIndexOf('{', searchEnd);
  if (openBrace === -1 || openBrace < anchorIdx) return null;
  return extractBalancedBlockFromBrace(text, openBrace);
}

interface RegionAnchor {
  label: string;
  region: string | null;
}

/**
 * The three scan targets on the approve/reject path, region-by-region:
 *   - action-proposal-store.ts: the WHOLE file (it exists only to own this table).
 *   - memory-ops.ts: the balanced bodies of approveProposal/rejectProposal.
 *   - serve-cli.ts: the balanced bodies of the two /v1/proposals route blocks.
 * Five regions total — matches the acceptance criterion that all five anchors are located.
 */
function anchorsForFile(filePath: string, text: string): RegionAnchor[] {
  if (filePath.endsWith('action-proposal-store.ts')) {
    return [{ label: 'action-proposal-store.ts (whole file)', region: text }];
  }
  if (filePath.endsWith('memory-ops.ts')) {
    return [
      { label: 'memory-ops.ts approveProposal', region: extractAnchoredBlock(text, 'async function approveProposal(') },
      { label: 'memory-ops.ts rejectProposal', region: extractAnchoredBlock(text, 'async function rejectProposal(') },
    ];
  }
  if (filePath.endsWith('serve-cli.ts')) {
    return [
      {
        label: 'serve-cli.ts GET /v1/proposals',
        region: extractAnchoredBlock(text, "url === '/v1/proposals' && req.method === 'GET'"),
      },
      {
        label: 'serve-cli.ts POST /v1/proposals/:id',
        region: extractAnchoredBlock(text, "startsWith('/v1/proposals/')"),
      },
    ];
  }
  return [];
}

/**
 * Returns offender descriptions for files whose relevant scan region contains a forbidden
 * belief-write token, or [] if clean. A region that could not be located (anchor not found)
 * is silently skipped — see extractAnchoredBlock's doc comment.
 */
export function findProposalWriteIsolationOffenders(
  files: Array<{ path: string; text: string }>,
): string[] {
  const offenders: string[] = [];
  for (const { path: filePath, text } of files) {
    for (const { label, region } of anchorsForFile(filePath, text)) {
      if (region === null) continue;
      const stripped = stripComments(region);
      const strippedLower = stripped.toLowerCase();
      for (const token of FORBIDDEN_BELIEF_WRITE_TOKENS) {
        const isSql = SQL_WRITE_TOKENS.includes(token);
        const found = isSql ? strippedLower.includes(token.toLowerCase()) : stripped.includes(token);
        if (found) {
          offenders.push(`${label}: contains forbidden token "${token}"`);
        }
      }
    }
  }
  return offenders;
}

/**
 * Forbidden import specifiers/identifiers for the store module (D-43-for-proposals'
 * import-boundary half): a proposal-store import of the semantic-store write API or the
 * strength/decay module would be a write path this scan's token list could never anticipate.
 * Explicitly permitted (never flagged, and not in this list): better-sqlite3, ../lib/clock,
 * ../db/schema, ../model/claim-extractor.
 */
const FORBIDDEN_STORE_IMPORT_TOKENS: readonly string[] = [
  'semantic-store',
  'strength/decay',
  'StrengthDecayManager',
];

export function findProposalStoreImportOffenders(text: string): string[] {
  const offenders: string[] = [];
  const importLines = text.split('\n').filter((line) => /^\s*import\b/.test(line));
  for (const token of FORBIDDEN_STORE_IMPORT_TOKENS) {
    if (importLines.some((line) => line.includes(token))) {
      offenders.push(`import statement references forbidden module/identifier "${token}"`);
    }
  }
  return offenders;
}

// ---------------------------------------------------------------------------
// Layer (a) — tests
// ---------------------------------------------------------------------------

describe('D-43-for-proposals — layer (a): static write-isolation scan', () => {
  it('findProposalWriteIsolationOffenders returns [] over the three real scan targets', () => {
    const files = [
      { path: STORE_PATH, text: readFileSync(STORE_PATH, 'utf8') },
      { path: MEMORY_OPS_PATH, text: readFileSync(MEMORY_OPS_PATH, 'utf8') },
      { path: SERVE_CLI_PATH, text: readFileSync(SERVE_CLI_PATH, 'utf8') },
    ];
    expect(findProposalWriteIsolationOffenders(files)).toEqual([]);
  });

  it('findProposalStoreImportOffenders returns [] for the real store module', () => {
    const text = readFileSync(STORE_PATH, 'utf8');
    expect(findProposalStoreImportOffenders(text)).toEqual([]);
  });

  it('all five scan-region anchors are located in the real source (non-vacuousness)', () => {
    const files = [
      { path: STORE_PATH, text: readFileSync(STORE_PATH, 'utf8') },
      { path: MEMORY_OPS_PATH, text: readFileSync(MEMORY_OPS_PATH, 'utf8') },
      { path: SERVE_CLI_PATH, text: readFileSync(SERVE_CLI_PATH, 'utf8') },
    ];
    const anchors = files.flatMap(({ path: filePath, text }) => anchorsForFile(filePath, text));
    // Five anchors: action-proposal-store.ts (whole file) + approveProposal + rejectProposal
    // + the two serve-cli.ts route blocks. A silently-skipped anchor above would make the
    // real-source [] assertion vacuous; this test proves none were silently skipped.
    expect(anchors).toHaveLength(5);
    for (const { label, region } of anchors) {
      expect(region, `anchor not found: ${label}`).not.toBeNull();
    }
  });

  it('flags a planted "UPDATE node SET s = 1" inside a synthetic approveProposal block', () => {
    const synthetic = `
      async function approveProposal(id: string): Promise<{ status: string }> {
        UPDATE node SET s = 1;
        return { status: 'approved' };
      }
    `;
    const offenders = findProposalWriteIsolationOffenders([
      { path: 'src/adapter/memory-ops.ts', text: synthetic },
    ]);
    expect(offenders.length).toBeGreaterThan(0);
  });

  it.each(FORBIDDEN_BELIEF_WRITE_TOKENS)(
    'flags a planted occurrence of forbidden token "%s"',
    (token) => {
      const synthetic = `// synthetic fixture\nconst offender = "${token}";\n`;
      const offenders = findProposalWriteIsolationOffenders([
        { path: 'src/db/action-proposal-store.ts', text: synthetic },
      ]);
      expect(offenders.length).toBeGreaterThan(0);
    },
  );

  it('SQL forms match case-insensitively', () => {
    const synthetic = 'const s = "update node set s = 1";';
    const offenders = findProposalWriteIsolationOffenders([
      { path: 'src/db/action-proposal-store.ts', text: synthetic },
    ]);
    expect(offenders.length).toBeGreaterThan(0);
  });

  it('returns [] for a fixture where the only occurrence is inside a comment', () => {
    const synthetic = `
      async function approveProposal(id: string): Promise<{ status: string }> {
        // UPDATE node SET s = 1 -- historical note, not live code
        /* upsertNode(...) used to live here */
        return { status: 'approved' };
      }
    `;
    const offenders = findProposalWriteIsolationOffenders([
      { path: 'src/adapter/memory-ops.ts', text: synthetic },
    ]);
    expect(offenders).toEqual([]);
  });

  it('permits a SELECT read against node (only writes are forbidden)', () => {
    const synthetic = `
      async function approveProposal(id: string): Promise<{ status: string }> {
        const row = db.prepare('SELECT tombstoned FROM node WHERE id = @id').get({ id });
        return { status: 'approved' };
      }
    `;
    const offenders = findProposalWriteIsolationOffenders([
      { path: 'src/adapter/memory-ops.ts', text: synthetic },
    ]);
    expect(offenders).toEqual([]);
  });
});

describe('D-43-for-proposals — layer (a): store import-boundary scan', () => {
  it.each(['semantic-store', 'strength/decay', 'StrengthDecayManager'])(
    'flags an import statement referencing "%s"',
    (token) => {
      const synthetic = `import { X } from '../${token}';\n`;
      expect(findProposalStoreImportOffenders(synthetic).length).toBeGreaterThan(0);
    },
  );

  it('permits the real module\'s actual imports (better-sqlite3, ../lib/clock, ../model/claim-extractor)', () => {
    const synthetic = [
      "import Database from 'better-sqlite3';",
      "import type { Clock } from '../lib/clock';",
      "import type { IntentConfidence } from '../model/claim-extractor';",
    ].join('\n');
    expect(findProposalStoreImportOffenders(synthetic)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Layer (b) — runtime whole-table isolation
// ---------------------------------------------------------------------------

describe('D-43-for-proposals — layer (b): runtime whole-table write isolation', () => {
  let tmpDbPath: string;
  let tmpLockPath: string;
  let closeEngine: (() => void) | undefined;

  afterEach(() => {
    try { closeEngine?.(); } catch { /* ignore */ }
    try { unlinkSync(tmpDbPath); } catch { /* ignore */ }
    delete process.env['RECENSE_LOCK_PATH'];
    try { unlinkSync(tmpLockPath); } catch { /* ignore */ }
  });

  it('approving one proposal and rejecting another leaves node and edge byte-identical, and the two proposals reach terminal statuses', async () => {
    // Per-test lock path — the default lock path is a single shared /tmp file, and
    // approveProposal/rejectProposal take the same acquireLockWithRetry() gate as every
    // other write path, so a shared path would contend with unrelated tests running
    // concurrently (mirrors tests/online-llm-free-sentinel.test.ts's convention).
    tmpLockPath = makeTempDbPath('write-isolation-lock');
    process.env['RECENSE_LOCK_PATH'] = tmpLockPath;
    tmpDbPath = makeTempDbPath('write-isolation');
    const setupDb = new Database(tmpDbPath);
    initSchema(setupDb);
    const clock = new FakeClock(Date.UTC(2026, 0, 1));
    const config = { ...DEFAULT_CONFIG, dbPath: tmpDbPath };
    const store = new SemanticStore(setupDb, clock, config);
    const episodes = new EpisodicStore(setupDb, clock, config);

    // Deliberately varied s/c/prev_value/pending_contradictions/last_access across several
    // nodes — a snapshot over uniformly-default rows would not distinguish "nothing was
    // written" from "everything was written to the same defaults" (at least 3 distinct s
    // values, at least 2 distinct c values, below).
    const entityId = 'node-entity-acme';
    const beliefIdA = 'node-belief-a';
    const beliefIdB = 'node-belief-b';
    const otherId = 'node-other';
    store.upsertNode({ id: entityId, type: 'entity', value: 'Acme Corp', origin: 'observed', s: 0.9, c: 0.9, last_access: 1_000 });
    store.upsertNode({
      id: beliefIdA, type: 'fact', value: 'Acme status: submitted', origin: 'observed',
      s: 0.2, c: 0.4, last_access: 2_000, prev_value: 'Acme status: draft',
    });
    store.upsertNode({ id: beliefIdB, type: 'fact', value: 'Globex status: interviewing', origin: 'observed', s: 0.6, c: 0.8, last_access: 3_000 });
    store.upsertNode({ id: otherId, type: 'fact', value: 'unrelated fact', origin: 'observed', s: 0.05, c: 0.95, last_access: 4_000 });
    store.recordContradiction(beliefIdB, { episode_id: 'ep-seed', session_id: 'sess-seed', origin: 'observed' });

    store.upsertEdge({ src: entityId, dst: beliefIdA, rel: 'has_status', w: 0.5, kind: 'relation' });
    store.upsertEdge({ src: entityId, dst: beliefIdB, rel: 'has_status', w: 0.7, kind: 'relation' });

    const episode = episodes.append({
      content: 'Acme: application submitted. Globex: moved to interviewing.',
      origin: 'observed', salience: 0.9, hard_keep: 1, role: 'user',
      session_id: 'sess-write-isolation', source: 'gmail',
    });

    const proposalStore = new ActionProposalStore(setupDb, clock);
    // Real wall-clock time, NOT the FakeClock used to seed node/episode rows above:
    // approveProposal's staleness check (classifyProposalStaleness) is gated on
    // realClock.nowMs() (memory-ops.ts always uses the real clock for write timestamps),
    // so expires_at must be anchored to real time or every approve would look expired.
    const nowMs = Date.now();
    const proposalA: ActionProposalRecord = {
      id: 'proposal-approve-me', kind: 'belief',
      entity_node_id: entityId, entity_descriptor: 'Acme Corp',
      belief_node_id: beliefIdA,
      change_field: 'status', change_from: 'draft', change_to: 'submitted',
      evidence_episode: episode.id, evidence_quote: 'application submitted',
      confidence: 'high', schema_version: 17, status: 'pending',
      created_at: nowMs, updated_at: nowMs, expires_at: nowMs + 1_000_000,
    };
    const proposalB: ActionProposalRecord = {
      id: 'proposal-reject-me', kind: 'belief',
      entity_node_id: entityId, entity_descriptor: 'Acme Corp',
      belief_node_id: beliefIdB,
      change_field: 'status', change_from: 'submitted', change_to: 'interviewing',
      evidence_episode: episode.id, evidence_quote: 'moved to interviewing',
      confidence: 'medium', schema_version: 17, status: 'pending',
      created_at: nowMs, updated_at: nowMs, expires_at: nowMs + 1_000_000,
    };
    proposalStore.insert(proposalA);
    proposalStore.insert(proposalB);
    setupDb.close();

    const wired = await wireMemoryEngine({
      dbPath: tmpDbPath,
      provider: new MockModelProvider(),
      source: 'http',
      separateReadHandle: true,
    });
    closeEngine = wired.close;
    const { ops } = wired;

    const verifyBeforeDb = new Database(tmpDbPath);
    const nodeBefore = verifyBeforeDb.prepare('SELECT * FROM node ORDER BY id').all();
    const edgeBefore = verifyBeforeDb.prepare('SELECT * FROM edge ORDER BY src, dst, rel').all();
    verifyBeforeDb.close();

    await ops.approveProposal(proposalA.id);
    await ops.rejectProposal(proposalB.id);

    const verifyAfterDb = new Database(tmpDbPath);
    const nodeAfter = verifyAfterDb.prepare('SELECT * FROM node ORDER BY id').all();
    const edgeAfter = verifyAfterDb.prepare('SELECT * FROM edge ORDER BY src, dst, rel').all();
    const proposalARow = verifyAfterDb.prepare('SELECT * FROM action_proposal WHERE id = ?').get(proposalA.id) as ActionProposalRecord;
    const proposalBRow = verifyAfterDb.prepare('SELECT * FROM action_proposal WHERE id = ?').get(proposalB.id) as ActionProposalRecord;
    verifyAfterDb.close();

    // Layer (b)'s whole point: node and edge are byte-identical across a real approve AND a
    // real reject, compared via toEqual over SELECT * (not a COUNT(*) or a checksum).
    expect(nodeAfter).toEqual(nodeBefore);
    expect(edgeAfter).toEqual(edgeBefore);

    // Non-vacuousness: the equality above is not passing because nothing happened.
    expect(proposalARow.status).toBe('approved');
    expect(proposalBRow.status).toBe('rejected');
    expect(proposalARow.updated_at).not.toBe(proposalARow.created_at);
    expect(proposalBRow.updated_at).not.toBe(proposalBRow.created_at);
  });

  it('an approve refused as stale (belief node tombstoned before the call) also leaves node/edge byte-identical apart from the tombstone the test itself applied', async () => {
    tmpLockPath = makeTempDbPath('write-isolation-stale-lock');
    process.env['RECENSE_LOCK_PATH'] = tmpLockPath;
    tmpDbPath = makeTempDbPath('write-isolation-stale');
    const setupDb = new Database(tmpDbPath);
    initSchema(setupDb);
    const clock = new FakeClock(Date.UTC(2026, 0, 1));
    const config = { ...DEFAULT_CONFIG, dbPath: tmpDbPath };
    const store = new SemanticStore(setupDb, clock, config);
    const episodes = new EpisodicStore(setupDb, clock, config);

    const entityId = 'node-entity-stale';
    const beliefId = 'node-belief-stale';
    store.upsertNode({ id: entityId, type: 'entity', value: 'Initech', origin: 'observed', s: 0.7, c: 0.6, last_access: 1_000 });
    store.upsertNode({ id: beliefId, type: 'fact', value: 'Initech status: submitted', origin: 'observed', s: 0.3, c: 0.5, last_access: 2_000 });
    store.upsertEdge({ src: entityId, dst: beliefId, rel: 'has_status', w: 0.4, kind: 'relation' });

    const episode = episodes.append({
      content: 'Initech: application submitted.',
      origin: 'observed', salience: 0.9, hard_keep: 1, role: 'user',
      session_id: 'sess-stale', source: 'gmail',
    });

    const proposalStore = new ActionProposalStore(setupDb, clock);
    // Real wall-clock time, NOT the FakeClock used to seed node/episode rows above:
    // approveProposal's staleness check (classifyProposalStaleness) is gated on
    // realClock.nowMs() (memory-ops.ts always uses the real clock for write timestamps),
    // so expires_at must be anchored to real time or every approve would look expired.
    const nowMs = Date.now();
    const proposal: ActionProposalRecord = {
      id: 'proposal-stale', kind: 'belief',
      entity_node_id: entityId, entity_descriptor: 'Initech',
      belief_node_id: beliefId,
      change_field: 'status', change_from: null, change_to: 'submitted',
      evidence_episode: episode.id, evidence_quote: 'application submitted',
      confidence: 'high', schema_version: 17, status: 'pending',
      created_at: nowMs, updated_at: nowMs, expires_at: nowMs + 1_000_000,
    };
    proposalStore.insert(proposal);

    // The belief moved on via ordinary reconsolidation before this proposal was approved —
    // tombstone it BEFORE the "before" snapshot, so the snapshot comparison below isolates
    // the approve() call's effect specifically, not this setup step's own write.
    store.tombstone(beliefId);
    setupDb.close();

    const wired = await wireMemoryEngine({
      dbPath: tmpDbPath,
      provider: new MockModelProvider(),
      source: 'http',
      separateReadHandle: true,
    });
    closeEngine = wired.close;
    const { ops } = wired;

    const verifyBeforeDb = new Database(tmpDbPath);
    const nodeBefore = verifyBeforeDb.prepare('SELECT * FROM node ORDER BY id').all();
    const edgeBefore = verifyBeforeDb.prepare('SELECT * FROM edge ORDER BY src, dst, rel').all();
    verifyBeforeDb.close();

    await expect(ops.approveProposal(proposal.id)).rejects.toBeInstanceOf(ProposalStaleError);

    const verifyAfterDb = new Database(tmpDbPath);
    const nodeAfter = verifyAfterDb.prepare('SELECT * FROM node ORDER BY id').all();
    const edgeAfter = verifyAfterDb.prepare('SELECT * FROM edge ORDER BY src, dst, rel').all();
    const proposalRow = verifyAfterDb.prepare('SELECT * FROM action_proposal WHERE id = ?').get(proposal.id) as ActionProposalRecord;
    verifyAfterDb.close();

    expect(nodeAfter).toEqual(nodeBefore);
    expect(edgeAfter).toEqual(edgeBefore);

    // Non-vacuousness: the refusal recorded a durable terminal status (D-10), it did not
    // silently no-op.
    expect(proposalRow.status).toBe('superseded');
  });
});
