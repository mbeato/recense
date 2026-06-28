/**
 * 49-fast-exact-probe — can a ZERO-DEP faster exact scan close the latency gap without ANN?
 *
 * Compares three pure-JS, dependency-free variants of the exact brute-force scan, all measured
 * against the float32 exact scan as recall ground truth, on HELD-OUT novel queries:
 *   (A) float32  — the current production exact scan (baseline + ground truth).
 *   (B) int8     — per-vector symmetric int8 quantization (4× less memory traffic on the scan).
 *   (C) rdim-D   — Gaussian random projection 1536 → D dims (scan cost linear in dims).
 *
 * Goal: if (B) or (C) gets the exact scan comfortably under the felt-path budget at real scale
 * with recall@10 ≈ 1.0, the native-ANN dependency question is MOOT at recense's scale.
 * Read-only on the live brain. Run from project root.
 */
'use strict';
const os = require('os'), path = require('path'), fs = require('fs');
const Database = require('better-sqlite3');
const DIST = path.resolve(process.cwd(), 'dist/src');
const { DEFAULT_CONFIG } = require(DIST + '/lib/config');
const DIMS = DEFAULT_CONFIG.embeddingDimensions || 1536;
const DB_PATH = process.env.RECENSE_DB_PATH || path.join(os.homedir(), '.config/recense/recense.db');
const K = 10, NQUERY = 60, REPEATS = 3, JITTER = 0.05;
const RDIMS = [384, 512];
const SCALES = [14000, 50000];

function pct(a, p){ const s=[...a].sort((x,y)=>x-y); const i=Math.ceil(p/100*s.length)-1; return s[Math.max(0,Math.min(i,s.length-1))]; }
function l2(v,o,d){ let s=0; for(let i=0;i<d;i++){const x=v[o+i];s+=x*x;} return Math.sqrt(s); }
function dec(b){ return new Float32Array(b.buffer,b.byteOffset,b.byteLength/4); }
function r32(seed){ let a=seed>>>0; return ()=>{a|=0;a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;}; }
function gauss(r){ let u=0,v=0; while(u===0)u=r(); while(v===0)v=r(); return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v); }
function topk(scores, n, k){ const idx=Array.from({length:n},(_,i)=>i); idx.sort((a,b)=>scores[b]-scores[a]); return idx.slice(0,k); }
function recall(ann, exact, k){ const e=new Set(exact.slice(0,k)); let h=0; for(let i=0;i<Math.min(k,ann.length);i++) if(e.has(ann[i])) h++; return h/k; }

const db = new Database(DB_PATH,{readonly:true,fileMustExist:true});
const rows = db.prepare('SELECT embedding FROM node WHERE embedding IS NOT NULL AND tombstoned = 0').all();
db.close();
const liveN = rows.length;
const live = new Float32Array(liveN*DIMS);
for(let r=0;r<liveN;r++) live.set(dec(rows[r].embedding).subarray(0,DIMS), r*DIMS);
console.error('live nodes:', liveN);

// held-out novel queries (excluded from every corpus)
const rs = r32(0xBEEF); const held = new Set();
while(held.size < NQUERY) held.add(Math.floor(rs()*liveN));
const heldArr=[...held];

// one Gaussian projection matrix per RDIM (shared across scales; built once)
const projMats = {};
for (const D of RDIMS){
  const rp = r32(0x1234 + D);
  const M = new Float32Array(D*DIMS);
  for (let i=0;i<D*DIMS;i++) M[i] = gauss(rp);
  projMats[D] = M;
}
function project(M, D, src, off){ const out=new Float32Array(D); for(let d=0;d<D;d++){ let s=0; const mo=d*DIMS; for(let i=0;i<DIMS;i++) s+=M[mo+i]*src[off+i]; out[d]=s; } return out; }

const out = { meta:{ probe:'49-fast-exact', live_nodes:liveN, n_queries:NQUERY, k:K, held_out:true, rdims:RDIMS, scales:SCALES, note:'zero-dep exact variants; float32 is ground truth' }, results:[] };

for (const N of SCALES) {
  // build corpus excluding held-out queries (real anchor + jitter top-up)
  const rc=r32(N>>>0); const flat=new Float32Array(N*DIMS);
  let w=0; for(let i=0;i<liveN && w<N;i++){ if(held.has(i)) continue; flat.set(live.subarray(i*DIMS,(i+1)*DIMS),w*DIMS); w++; }
  const anchorN=w;
  for(let r=w;r<N;r++){ const src=(Math.floor(rc()*anchorN))*DIMS,dst=r*DIMS; for(let i=0;i<DIMS;i++) flat[dst+i]=flat[src+i]+JITTER*gauss(rc); const nn=l2(flat,dst,DIMS)||1; for(let i=0;i<DIMS;i++) flat[dst+i]/=nn; }
  const norms=new Float64Array(N); for(let r=0;r<N;r++) norms[r]=l2(flat,r*DIMS,DIMS)||1;

  const queries = heldArr.map(i=>{ const v=live.slice(i*DIMS,(i+1)*DIMS); return { vec:v, n:l2(v,0,DIMS)||1 }; });

  // ---- (A) float32 exact (ground truth + baseline latency) ----
  function f32scores(q){ const sc=new Float64Array(N); for(let r=0;r<N;r++){ let d=0; const o=r*DIMS; for(let i=0;i<DIMS;i++) d+=q.vec[i]*flat[o+i]; sc[r]=d/(q.n*norms[r]); } return sc; }
  const gt = queries.map(q=>topk(f32scores(q),N,K));
  const f32lat=[]; for(const q of queries) f32scores(q);
  for(let rep=0;rep<REPEATS;rep++){ const t0=process.hrtime.bigint(); for(const q of queries) f32scores(q); const t1=process.hrtime.bigint(); f32lat.push(Number(t1-t0)/1e6/queries.length); }

  // ---- (B) int8 quantized (per-vector symmetric) ----
  const q8 = new Int8Array(N*DIMS); const scale=new Float64Array(N);
  for(let r=0;r<N;r++){ const o=r*DIMS; let mx=0; for(let i=0;i<DIMS;i++){const a=Math.abs(flat[o+i]); if(a>mx)mx=a;} const sc=(mx/127)||1e-9; scale[r]=sc; for(let i=0;i<DIMS;i++) q8[o+i]=Math.max(-127,Math.min(127,Math.round(flat[o+i]/sc))); }
  function i8scores(q){ // quantize query
    let mx=0; for(let i=0;i<DIMS;i++){const a=Math.abs(q.vec[i]); if(a>mx)mx=a;} const qs=(mx/127)||1e-9;
    const qq=new Int8Array(DIMS); for(let i=0;i<DIMS;i++) qq[i]=Math.max(-127,Math.min(127,Math.round(q.vec[i]/qs)));
    const sc=new Float64Array(N); for(let r=0;r<N;r++){ let d=0; const o=r*DIMS; for(let i=0;i<DIMS;i++) d+=qq[i]*q8[o+i]; sc[r]=d*scale[r]/norms[r]; } return sc; // qs & q.n constant per query → omitted from ranking
  }
  const i8tk=queries.map(q=>topk(i8scores(q),N,K));
  let i8r5=0,i8r10=0; for(let i=0;i<queries.length;i++){ i8r5+=recall(i8tk[i],gt[i],5); i8r10+=recall(i8tk[i],gt[i],10); }
  const i8lat=[]; for(const q of queries) i8scores(q);
  for(let rep=0;rep<REPEATS;rep++){ const t0=process.hrtime.bigint(); for(const q of queries) i8scores(q); const t1=process.hrtime.bigint(); i8lat.push(Number(t1-t0)/1e6/queries.length); }

  const rung = { n:N, float32:{ p50_ms:+pct(f32lat,50).toFixed(3), p95_ms:+pct(f32lat,95).toFixed(3) },
    int8:{ recall_at_5:+(i8r5/queries.length).toFixed(4), recall_at_10:+(i8r10/queries.length).toFixed(4), p50_ms:+pct(i8lat,50).toFixed(3), p95_ms:+pct(i8lat,95).toFixed(3) }, rdim:{} };

  // ---- (C) reduced-dim (Gaussian random projection) ----
  for (const D of RDIMS){
    const M=projMats[D];
    const proj=new Float32Array(N*D); const pn=new Float64Array(N);
    for(let r=0;r<N;r++){ const pv=project(M,D,flat,r*DIMS); proj.set(pv,r*D); pn[r]=l2(pv,0,D)||1; }
    function rscores(q){ const pv=project(M,D,q.vec,0); const qn=l2(pv,0,D)||1; const sc=new Float64Array(N); for(let r=0;r<N;r++){ let d=0; const o=r*D; for(let i=0;i<D;i++) d+=pv[i]*proj[o+i]; sc[r]=d/(qn*pn[r]); } return sc; }
    const rtk=queries.map(q=>topk(rscores(q),N,K));
    let r5=0,r10=0; for(let i=0;i<queries.length;i++){ r5+=recall(rtk[i],gt[i],5); r10+=recall(rtk[i],gt[i],10); }
    const rl=[]; for(const q of queries) rscores(q);
    for(let rep=0;rep<REPEATS;rep++){ const t0=process.hrtime.bigint(); for(const q of queries) rscores(q); const t1=process.hrtime.bigint(); rl.push(Number(t1-t0)/1e6/queries.length); }
    rung.rdim[D]={ recall_at_5:+(r5/queries.length).toFixed(4), recall_at_10:+(r10/queries.length).toFixed(4), p50_ms:+pct(rl,50).toFixed(3), p95_ms:+pct(rl,95).toFixed(3) };
    console.error(`N=${N} rdim-${D}  r@10=${(r10/queries.length).toFixed(4)} p95=${pct(rl,95).toFixed(2)}ms`);
  }
  console.error(`N=${N}  f32 p95=${pct(f32lat,95).toFixed(2)}ms | int8 r@10=${(i8r10/queries.length).toFixed(4)} p95=${pct(i8lat,95).toFixed(2)}ms`);
  out.results.push(rung);
}
fs.mkdirSync('scripts/eval/results',{recursive:true});
fs.writeFileSync('scripts/eval/results/49-fast-exact.json', JSON.stringify(out,null,2)+'\n');
console.error('wrote scripts/eval/results/49-fast-exact.json');
