import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { initSchema } from '../src/db/schema';
import { SemanticStore } from '../src/db/semantic-store';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import { hasDistEntries, distSkipReason } from './support/dist-build';

const DIST = ['dist/src/eval/bridge-arms.js', 'dist/src/adapter/settings-loader.js'];
const SKIP = !hasDistEntries(...DIST);

describe.skipIf(SKIP)('bridge-harness.cjs smoke', () => {
  it('runs both modes on a scratch DB and writes the envelope (ids only, no values)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-smoke-'));
    const dbPath = path.join(dir, 'snap.db');
    const db = new Database(dbPath);
    initSchema(db);
    const store = new SemanticStore(db, new FakeClock(Date.UTC(2026, 0, 1)), { ...DEFAULT_CONFIG, dbPath });
    const vec = (i: number) => { const v = new Float32Array(16); v[i] = 1; return v; };
    const add = (id: string, value: string, i: number, type: 'fact' | 'entity' = 'fact') => {
      store.upsertNode({ id, type, value, origin: 'observed', s: 0.5 }); store.setEmbedding(id, vec(i));
    };
    add('seed', 'urby-www deploys to Cloudflare Pages', 0);
    add('bridge', 'Cloudflare', 1, 'entity');
    add('term', 'the dashboard custom domain attachment is locked', 2);
    store.upsertEdge({ src: 'seed', dst: 'bridge', rel: 'runs_on', w: 0.1, kind: 'relation' });
    store.upsertEdge({ src: 'bridge', dst: 'term', rel: 'extends', w: 0.1, kind: 'relation' });
    db.close();

    const probes = path.join(dir, 'probes.json');
    fs.writeFileSync(probes, JSON.stringify({
      _meta: { db_source: dbPath, generated_at: 'test', total: 1, strata: { 'entity:lo': 1 }, founder_signoff: 'test', cosine_ceiling: 0.5 },
      probes: [{
        id: 'bp001', query: 'urby-www deploys to Cloudflare Pages',
        seed: { id: 'seed', type: 'fact', value: 'urby-www deploys to Cloudflare Pages' },
        bridge: { id: 'bridge', type: 'entity', value: 'Cloudflare' },
        terminal: { id: 'term', type: 'fact', value: 'the dashboard custom domain attachment is locked' },
        path: [
          { src: 'seed', rel: 'runs_on', kind: 'relation', dir: 'fwd', dst: 'bridge' },
          { src: 'bridge', rel: 'extends', kind: 'relation', dir: 'fwd', dst: 'term' },
        ],
        seed_outdeg: 1, dilution: 'lo', stratum: 'entity:lo', cosine_seed_terminal: 0,
      }],
    }));
    const out = path.join(dir, 'out.json');
    const r = spawnSync(process.execPath, [
      'scripts/eval/bridge-harness.cjs', '--run', '--db', dbPath, '--probes', probes, '--out', out, '--mode', 'both',
    ], { encoding: 'utf8', env: { ...process.env, HOME: dir } });
    expect(r.status, r.stderr).toBe(0);
    const env = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(env.scores.oracle['ppr-exact'].r10).toBe(1);
    expect(env.scores.oracle.hybrid.r10).toBe(0);
    expect(env.scores.delta_vs_hybrid.oracle['ppr-exact'].r10).toBe(1);
    expect(env.scores.abstention).toBeNull();
    expect(JSON.stringify(env.per_probe)).not.toContain('Cloudflare');
  }, 60_000);

  it.skipIf(!SKIP)('skipped: ' + distSkipReason(...DIST), () => {});
});
