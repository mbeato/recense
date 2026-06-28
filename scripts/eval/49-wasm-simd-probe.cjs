/**
 * 49-wasm-simd-probe — does a WASM SIMD (f32x4) dot-product scan give the ~4× the project
 * needs to keep the EXACT brute-force scan fast AND portable (no node-gyp)?
 *
 * Compares, on held-out novel queries over the real (scaled) brain distribution:
 *   - scalar JS  : the current production-style float32 dot scan (baseline).
 *   - wasm-simd  : a hand-written WAT f32x4 dot-product kernel, assembled in-process via the
 *                  pure-JS `wabt` devDep (a production kernel would ship a prebuilt .wasm; wabt
 *                  is measurement-only). Same math, byte-portable, runs in any Node — no native build.
 *
 * Reports kernel-only p95 (the part SIMD accelerates), full per-query p95 (kernel + norm-divide +
 * top-k, identical post-processing on both arms), and recall@10 of wasm-topk vs scalar-exact topk
 * (should be ~1.0 — this is exact, not approximate). Read-only on the live brain. Run from project root.
 */
'use strict';
const os = require('os'), path = require('path'), fs = require('fs');
const Database = require('better-sqlite3');
const wabtInit = require('wabt');
const DIST = path.resolve(process.cwd(), 'dist/src');
const { DEFAULT_CONFIG } = require(DIST + '/lib/config');
const DIMS = DEFAULT_CONFIG.embeddingDimensions || 1536; // 1536 % 4 == 0
const DB_PATH = process.env.RECENSE_DB_PATH || path.join(os.homedir(), '.config/recense/recense.db');
const K = 10, NQUERY = 60, REPEATS = 5, JITTER = 0.05;
const SCALES = [14000, 50000];

function pct(a,p){ const s=[...a].sort((x,y)=>x-y); const i=Math.ceil(p/100*s.length)-1; return s[Math.max(0,Math.min(i,s.length-1))]; }
function l2(v,o,d){ let s=0; for(let i=0;i<d;i++){const x=v[o+i];s+=x*x;} return Math.sqrt(s); }
function dec(b){ return new Float32Array(b.buffer,b.byteOffset,b.byteLength/4); }
function r32(seed){ let a=seed>>>0; return ()=>{a|=0;a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;}; }
function gauss(r){ let u=0,v=0; while(u===0)u=r(); while(v===0)v=r(); return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v); }
function topkFromScores(sc,n,k){ const idx=Array.from({length:n},(_,i)=>i); idx.sort((a,b)=>sc[b]-sc[a]); return idx.slice(0,k); }
function recall(a,e,k){ const s=new Set(e.slice(0,k)); let h=0; for(let i=0;i<Math.min(k,a.length);i++) if(s.has(a[i])) h++; return h/k; }

// hand-written SIMD dot-scan kernel: out[r] = dot(q, matrix_row_r), via f32x4.
const WAT = `
(module
  (import "env" "mem" (memory $mem 1))
  (func (export "scan") (param $qPtr i32) (param $mPtr i32) (param $outPtr i32) (param $n i32) (param $dimsBytes i32)
    (local $r i32) (local $i i32) (local $rowBase i32) (local $acc v128)
    (local.set $r (i32.const 0))
    (block $rdone (loop $rloop
      (br_if $rdone (i32.ge_u (local.get $r) (local.get $n)))
      (local.set $rowBase (i32.add (local.get $mPtr) (i32.mul (local.get $r) (local.get $dimsBytes))))
      (local.set $acc (v128.const i32x4 0 0 0 0))
      (local.set $i (i32.const 0))
      (block $idone (loop $iloop
        (br_if $idone (i32.ge_u (local.get $i) (local.get $dimsBytes)))
        (local.set $acc
          (f32x4.add (local.get $acc)
            (f32x4.mul
              (v128.load (i32.add (local.get $qPtr) (local.get $i)))
              (v128.load (i32.add (local.get $rowBase) (local.get $i))))))
        (local.set $i (i32.add (local.get $i) (i32.const 16)))
        (br $iloop)))
      (f32.store (i32.add (local.get $outPtr) (i32.mul (local.get $r) (i32.const 4)))
        (f32.add
          (f32.add (f32x4.extract_lane 0 (local.get $acc)) (f32x4.extract_lane 1 (local.get $acc)))
          (f32.add (f32x4.extract_lane 2 (local.get $acc)) (f32x4.extract_lane 3 (local.get $acc)))))
      (local.set $r (i32.add (local.get $r) (i32.const 1)))
      (br $rloop)))))
`;

(async function main(){
  const wabt = await wabtInit();
  const mod = wabt.parseWat('dotscan.wat', WAT, { simd: true });
  const { buffer: wasmBytes } = mod.toBinary({});
  const wasmModule = await WebAssembly.compile(wasmBytes);

  const db = new Database(DB_PATH,{readonly:true,fileMustExist:true});
  const rows = db.prepare('SELECT embedding FROM node WHERE embedding IS NOT NULL AND tombstoned = 0').all();
  db.close();
  const liveN = rows.length;
  const live = new Float32Array(liveN*DIMS);
  for(let r=0;r<liveN;r++) live.set(dec(rows[r].embedding).subarray(0,DIMS), r*DIMS);
  console.error('live nodes:', liveN);

  const rs=r32(0xBEEF); const held=new Set(); while(held.size<NQUERY) held.add(Math.floor(rs()*liveN));
  const heldArr=[...held];
  const out={ meta:{ probe:'49-wasm-simd', live_nodes:liveN, n_queries:NQUERY, k:K, dims:DIMS, repeats:REPEATS, kernel:'f32x4 dot, hand-WAT via wabt', note:'wasm SIMD = exact dot (not approximate); recall vs scalar topk should be ~1.0' }, results:[] };

  for (const N of SCALES) {
    const rc=r32(N>>>0); const flat=new Float32Array(N*DIMS);
    let w=0; for(let i=0;i<liveN && w<N;i++){ if(held.has(i)) continue; flat.set(live.subarray(i*DIMS,(i+1)*DIMS),w*DIMS); w++; }
    const anchorN=w;
    for(let r=w;r<N;r++){ const src=(Math.floor(rc()*anchorN))*DIMS,dst=r*DIMS; for(let i=0;i<DIMS;i++) flat[dst+i]=flat[src+i]+JITTER*gauss(rc); const nn=l2(flat,dst,DIMS)||1; for(let i=0;i<DIMS;i++) flat[dst+i]/=nn; }
    const norms=new Float64Array(N); for(let r=0;r<N;r++) norms[r]=l2(flat,r*DIMS,DIMS)||1;
    const queries=heldArr.map(i=>{ const v=live.slice(i*DIMS,(i+1)*DIMS); return { vec:v, n:l2(v,0,DIMS)||1 }; });

    // ---- wasm memory layout: [query 1536f][matrix N*1536f][scores N f] ----
    const qBytes=DIMS*4, mBytes=N*DIMS*4, sBytes=N*4;
    const total=qBytes+mBytes+sBytes;
    const pages=Math.ceil(total/65536)+4;
    const memory=new WebAssembly.Memory({ initial:pages, maximum:pages });
    const inst=await WebAssembly.instantiate(wasmModule, { env:{ mem:memory } });
    const scan=inst.exports.scan;
    const qPtr=0, mPtr=qBytes, outPtr=qBytes+mBytes, dimsBytes=DIMS*4;
    new Float32Array(memory.buffer, mPtr, N*DIMS).set(flat); // load corpus once
    const scoreView=new Float32Array(memory.buffer, outPtr, N);
    const qView=new Float32Array(memory.buffer, qPtr, DIMS);

    // ---- scalar JS raw-dot scan (kernel-only) ----
    function scalarDot(q, dotOut){ for(let r=0;r<N;r++){ let d=0; const o=r*DIMS; for(let i=0;i<DIMS;i++) d+=q.vec[i]*flat[o+i]; dotOut[r]=d; } }
    const scalarDotBuf=new Float64Array(N);
    function scalarFull(q){ scalarDot(q, scalarDotBuf); const sc=new Float64Array(N); for(let r=0;r<N;r++) sc[r]=scalarDotBuf[r]/(q.n*norms[r]); return topkFromScores(sc,N,K); }
    function wasmKernel(q){ qView.set(q.vec); scan(qPtr,mPtr,outPtr,N,dimsBytes); }
    function wasmFull(q){ qView.set(q.vec); scan(qPtr,mPtr,outPtr,N,dimsBytes); const sc=new Float64Array(N); for(let r=0;r<N;r++) sc[r]=scoreView[r]/(q.n*norms[r]); return topkFromScores(sc,N,K); }

    // correctness: wasm topk vs scalar topk
    let rc10=0,rc5=0;
    for(const q of queries){ const a=wasmFull(q), e=scalarFull(q); rc5+=recall(a,e,5); rc10+=recall(a,e,10); }

    // kernel-only timing
    const sKern=[],wKern=[],sFull=[],wFull=[];
    for(const q of queries){ scalarDot(q,scalarDotBuf); wasmKernel(q); } // warm
    for(let rep=0;rep<REPEATS;rep++){ let t0=process.hrtime.bigint(); for(const q of queries) scalarDot(q,scalarDotBuf); let t1=process.hrtime.bigint(); sKern.push(Number(t1-t0)/1e6/queries.length);
      t0=process.hrtime.bigint(); for(const q of queries) wasmKernel(q); t1=process.hrtime.bigint(); wKern.push(Number(t1-t0)/1e6/queries.length);
      t0=process.hrtime.bigint(); for(const q of queries) scalarFull(q); t1=process.hrtime.bigint(); sFull.push(Number(t1-t0)/1e6/queries.length);
      t0=process.hrtime.bigint(); for(const q of queries) wasmFull(q); t1=process.hrtime.bigint(); wFull.push(Number(t1-t0)/1e6/queries.length); }

    const r={ n:N,
      scalar_kernel_p95_ms:+pct(sKern,95).toFixed(3), wasm_kernel_p95_ms:+pct(wKern,95).toFixed(3),
      scalar_full_p95_ms:+pct(sFull,95).toFixed(3), wasm_full_p95_ms:+pct(wFull,95).toFixed(3),
      kernel_speedup:+(pct(sKern,95)/pct(wKern,95)).toFixed(2), full_speedup:+(pct(sFull,95)/pct(wFull,95)).toFixed(2),
      wasm_recall_at_5:+(rc5/queries.length).toFixed(4), wasm_recall_at_10:+(rc10/queries.length).toFixed(4) };
    out.results.push(r);
    console.error(`N=${N}  scalar kernel ${r.scalar_kernel_p95_ms}ms -> wasm ${r.wasm_kernel_p95_ms}ms (${r.kernel_speedup}x) | full ${r.scalar_full_p95_ms}->${r.wasm_full_p95_ms}ms (${r.full_speedup}x) | recall@10=${r.wasm_recall_at_10}`);
  }
  fs.mkdirSync('scripts/eval/results',{recursive:true});
  fs.writeFileSync('scripts/eval/results/49-wasm-simd.json', JSON.stringify(out,null,2)+'\n');
  console.error('wrote scripts/eval/results/49-wasm-simd.json');
})().catch(e=>{ console.error('FAILED:', e); process.exit(1); });
