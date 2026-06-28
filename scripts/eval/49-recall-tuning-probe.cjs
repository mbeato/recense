/**
 * 49-recall-tuning-probe — answers the SCALE-01 follow-up: what is the REAL HNSW recall on
 * NOVEL queries (not corpus self-matches), and can ef_search tune it to near-exact cheaply?
 *
 * Difference from 49-crossover-spike.cjs: the query vectors are HELD OUT of the corpus, so the
 * exact top-k are genuine distinct neighbors — recall@k now measures true ANN quality, not the
 * trivial self-match. Sweeps ef_search to show the recall/latency knob. Read-only on the live DB.
 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const Database = require('better-sqlite3');
const DIST = path.resolve(__dirname, '../../dist/src');
const { cosineSimF32 } = require(DIST + '/retrieval/topk');
const { DEFAULT_CONFIG } = require(DIST + '/lib/config');
const DIMS = DEFAULT_CONFIG.embeddingDimensions || 1536;
const DB_PATH = process.env.RECENSE_DB_PATH || path.join(os.homedir(), '.config/recense/recense.db');
const K = 10, NQUERY = 60, REPEATS = 3, JITTER = 0.05;
const EF_SWEEP = [64, 128, 256, 512];
const SCALES = [14000, 50000];

function pct(a, p){ if(!a.length) return 0; const s=[...a].sort((x,y)=>x-y); const i=Math.ceil(p/100*s.length)-1; return s[Math.max(0,Math.min(i,s.length-1))]; }
function l2(v,o,d){ let s=0; for(let i=0;i<d;i++){const x=v[o+i]; s+=x*x;} return Math.sqrt(s); }
function dec(buf){ return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength/4); }
function rng32(seed){ let a=seed>>>0; return ()=>{ a|=0;a=(a+0x6D2B79F5)|0; let t=Math.imul(a^(a>>>15),1|a); t=(t+Math.imul(t^(t>>>7),61|t))^t; return ((t^(t>>>14))>>>0)/4294967296; }; }
function gauss(r){ let u=0,v=0; while(u===0)u=r(); while(v===0)v=r(); return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v); }

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
const rows = db.prepare('SELECT id, embedding FROM node WHERE embedding IS NOT NULL AND tombstoned = 0').all();
db.close();
const liveN = rows.length;
const live = new Float32Array(liveN * DIMS);
for (let r=0;r<liveN;r++) live.set(dec(rows[r].embedding).subarray(0,DIMS), r*DIMS);
console.error(`live nodes: ${liveN}`);

// Hold out NQUERY real live vectors as the query set; they are EXCLUDED from every corpus.
const rsel = rng32(0xBEEF);
const heldIdx = new Set();
while (heldIdx.size < NQUERY) heldIdx.add(Math.floor(rsel()*liveN));
const heldArr = [...heldIdx];
const queries = heldArr.map(i => { const v = live.slice(i*DIMS,(i+1)*DIMS); return { vec: v, n: l2(v,0,DIMS)||1 }; });
const heldSet = heldIdx;

const hnsw = require('hnswlib-node');
const out = { meta:{ probe:'49-recall-tuning', live_nodes:liveN, n_queries:NQUERY, k:K, held_out:true, ef_sweep:EF_SWEEP, scales:SCALES }, results:[] };

for (const N of SCALES) {
  // build a corpus of N vectors that EXCLUDES the held-out queries: real anchor (non-held live) + jittered top-up.
  const rc = rng32(N>>>0);
  const flat = new Float32Array(N*DIMS); const norms = new Float64Array(N);
  let w = 0;
  for (let i=0;i<liveN && w<N;i++){ if(heldSet.has(i)) continue; flat.set(live.subarray(i*DIMS,(i+1)*DIMS), w*DIMS); w++; }
  const anchorN = w;
  for (let r=w;r<N;r++){ const src=(Math.floor(rc()*anchorN))*DIMS, dst=r*DIMS; for(let i=0;i<DIMS;i++) flat[dst+i]=flat[src+i]+JITTER*gauss(rc); const nn=l2(flat,dst,DIMS)||1; for(let i=0;i<DIMS;i++) flat[dst+i]/=nn; }
  for (let r=0;r<N;r++) norms[r]=l2(flat,r*DIMS,DIMS)||1;

  // exact ground-truth top-k per query (genuine neighbors — query is NOT in corpus).
  const exact = queries.map(q=>{ const sc=new Float64Array(N); for(let r=0;r<N;r++){ let d=0; const o=r*DIMS; for(let i=0;i<DIMS;i++) d+=q.vec[i]*flat[o+i]; sc[r]=d/(q.n*norms[r]); } const idx=Array.from({length:N},(_,i)=>i); idx.sort((a,b)=>sc[b]-sc[a]); return idx.slice(0,K); });

  // build HNSW once (M=16, efC=200), then sweep ef_search for recall/latency.
  const index = new hnsw.HierarchicalNSW('cosine', DIMS);
  index.initIndex(N, 16, 200);
  for (let r=0;r<N;r++) index.addPoint(Array.from(flat.subarray(r*DIMS,(r+1)*DIMS)), r);
  const qArr = queries.map(q=>Array.from(q.vec));

  for (const ef of EF_SWEEP) {
    index.setEf(ef);
    let r5=0,r10=0;
    for (let qi=0;qi<queries.length;qi++){ const res=index.searchKnn(qArr[qi],K).neighbors; const ex=exact[qi]; const e5=new Set(ex.slice(0,5)), e10=new Set(ex.slice(0,10)); let h5=0,h10=0; for(let i=0;i<K;i++){ if(i<5&&e5.has(res[i]))h5++; if(e10.has(res[i]))h10++; } r5+=h5/5; r10+=h10/10; }
    // latency p95 (per-query) over REPEATS, warm-up discarded
    const lat=[]; for(const qa of qArr) index.searchKnn(qa,K);
    for(let rep=0;rep<REPEATS;rep++){ const t0=process.hrtime.bigint(); for(const qa of qArr) index.searchKnn(qa,K); const t1=process.hrtime.bigint(); lat.push(Number(t1-t0)/1e6/qArr.length); }
    out.results.push({ n:N, ef_search:ef, recall_at_5:+(r5/queries.length).toFixed(4), recall_at_10:+(r10/queries.length).toFixed(4), ann_p95_ms:+pct(lat,95).toFixed(3) });
    console.error(`N=${N} ef=${ef}  r@5=${(r5/queries.length).toFixed(4)} r@10=${(r10/queries.length).toFixed(4)} p95=${pct(lat,95).toFixed(2)}ms`);
  }
}
fs.mkdirSync('scripts/eval/results',{recursive:true});
fs.writeFileSync('scripts/eval/results/49-recall-tuning.json', JSON.stringify(out,null,2)+'\n');
console.error('wrote scripts/eval/results/49-recall-tuning.json');
