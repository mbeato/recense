;;
;; simd-kernel.wat — fused f32x4 cosine kernel for recense exact-scan retrieval.
;;
;; Computes cosine(query, matrix_row[r]) = dot(q, row_r) x (1/||row_r||) x (1/||q||)
;; for all r in [0, n), storing results directly in the scores region.  One pass —
;; no separate scalar norm-divide loop (D-01).
;;
;; Import : env.mem  — shared WebAssembly.Memory (query + matrix + rnPtr + scores regions)
;; Export : scan(qPtr, mPtr, rnPtr, outPtr, recipQNorm, n, dimsBytes)
;;
;;   qPtr       i32  — byte offset of query f32[dim]  (must be 16-byte aligned)
;;   mPtr       i32  — byte offset of matrix f32[n*dim], row-major  (must be 16-byte aligned;
;;                      each row starts at mPtr + r * dimsBytes, also aligned)
;;   rnPtr      i32  — byte offset of precomputed reciprocal-norm region f32[n]:
;;                      rnPtr[r] = 1/||row_r||  (caller pre-divides; zero row-norm -> 0 ->
;;                      score 0, matching the JS denom-guard in cosineSimF32)
;;   outPtr     i32  — byte offset of the scores output region f32[n]
;;   recipQNorm f32  — 1/||q|| for this query  (zero query-norm -> 0 -> all scores 0)
;;   n          i32  — number of rows (count)
;;   dimsBytes  i32  — dim * 4  (requires dim % 4 == 0; loader falls back to scalar otherwise)
;;
;; The kernel trusts the caller for pointer/length safety.  Region-bounds enforcement
;; lives in the loader (Plan 02, T-51-2x).
;;
(module
  (import "env" "mem" (memory $mem 1))
  (func (export "scan")
    (param $qPtr i32)
    (param $mPtr i32)
    (param $rnPtr i32)
    (param $outPtr i32)
    (param $recipQNorm f32)
    (param $n i32)
    (param $dimsBytes i32)
    (local $r i32)
    (local $i i32)
    (local $rowBase i32)
    (local $acc v128)

    ;; outer loop: r = 0 .. n-1
    (local.set $r (i32.const 0))
    (block $rdone
      (loop $rloop
        (br_if $rdone (i32.ge_u (local.get $r) (local.get $n)))

        ;; rowBase = mPtr + r * dimsBytes
        (local.set $rowBase
          (i32.add
            (local.get $mPtr)
            (i32.mul (local.get $r) (local.get $dimsBytes))))

        ;; acc = 0.0 (all four f32 lanes)
        (local.set $acc (v128.const i32x4 0 0 0 0))

        ;; inner loop: i = 0, 16, 32, ... dimsBytes-16
        ;; acc += q[i..i+3] * row[i..i+3]  (four f32 SIMD lanes per step)
        (local.set $i (i32.const 0))
        (block $idone
          (loop $iloop
            (br_if $idone (i32.ge_u (local.get $i) (local.get $dimsBytes)))
            (local.set $acc
              (f32x4.add (local.get $acc)
                (f32x4.mul
                  (v128.load (i32.add (local.get $qPtr) (local.get $i)))
                  (v128.load (i32.add (local.get $rowBase) (local.get $i))))))
            (local.set $i (i32.add (local.get $i) (i32.const 16)))
            (br $iloop)))

        ;; horizontal sum of the four lanes -> raw dot product for row r
        ;; then: cosine = rawDot * rnPtr[r] * recipQNorm
        ;; store cosine to outPtr[r]
        (f32.store
          (i32.add (local.get $outPtr) (i32.mul (local.get $r) (i32.const 4)))
          (f32.mul
            (f32.mul
              (f32.add
                (f32.add
                  (f32x4.extract_lane 0 (local.get $acc))
                  (f32x4.extract_lane 1 (local.get $acc)))
                (f32.add
                  (f32x4.extract_lane 2 (local.get $acc))
                  (f32x4.extract_lane 3 (local.get $acc))))
              (f32.load
                (i32.add (local.get $rnPtr) (i32.mul (local.get $r) (i32.const 4)))))
            (local.get $recipQNorm)))

        ;; r++
        (local.set $r (i32.add (local.get $r) (i32.const 1)))
        (br $rloop)))))
