/**
 * @module transition
 * recense viz — brain ⇄ corpus transition controller.
 *
 * Owns the orchestrated camera move + crossfade between the 3D brain (#graph) and the
 * SEPARATE 2D corpus canvas (#corpus-graph). One interruptible state machine; corpus.js
 * drives it via toCorpus()/toBrain() and hands it a "ready" promise for the corpus content.
 *
 * Feel (founder-chosen): the brain recedes FIRST, then the map fades in over the 2nd half.
 *
 * Lessons baked in from the patch-era — do NOT regress these:
 *  1. Capture the EXACT pre-pull-back camera and restore it on return. (ctx.recenter only
 *     resets z, leaving the pulled-back x/y, so reusing it compounded the zoom-out.)
 *  2. markActive() before each camera move to suppress stats.js's idle camera drift, which
 *     otherwise fights the cameraPosition tween → snappy/jerky swaps after idling.
 *  3. Opacity-ONLY fades. Never put a CSS transform on #corpus-graph: the 2D force-graph's
 *     zoomToFit reads getBoundingClientRect, which a transform distorts → off-center fit.
 *  4. The corpus is PREPARED (settled + pinned + fit) by the caller BEFORE reveal; this
 *     controller never fits and never reveals an unsettled graph (→ no rubberband).
 */

const DUR = 750;        // total transition duration (ms)
const PULL_K = 2.3;     // camera pull-back factor (brain recedes to 2.3× its home distance)
const REVEAL_AT = 0.40; // start fading the map in at this fraction of DUR (brain recedes first)

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {Object} ctx shared viz context (ctx.Graph = the 3D brain instance; ctx.markActive;
 *   ctx.recenter as a fallback home).
 * @param {{brainEl: HTMLElement, corpusEl: HTMLElement, onBeforeReveal?: Function}} els
 *   onBeforeReveal runs once the corpus is mounted+ready and about to fade in, while the
 *   container is display:block (real dimensions) — the caller fits the pinned graph here.
 */
export function createTransition(ctx, { brainEl, corpusEl, onBeforeReveal }) {
  // 'brain' | 'toCorpus' | 'corpus' | 'toBrain'
  let state = 'brain';
  let homeCam = null; // exact brain-view camera captured right before the pull-back

  const markActive = () => { if (typeof ctx.markActive === 'function') ctx.markActive(); };
  const canCam = () => !!(ctx.Graph && typeof ctx.Graph.cameraPosition === 'function');

  function pullBackCamera() {
    if (!canCam()) return;
    const p = ctx.Graph.cameraPosition();
    if (!p) return;
    homeCam = { x: p.x, y: p.y, z: p.z }; // lesson 1: exact home, restored verbatim
    ctx.Graph.cameraPosition(
      { x: p.x * PULL_K, y: p.y * PULL_K, z: p.z * PULL_K }, { x: 0, y: 0, z: 0 }, DUR,
    );
  }
  function diveCamera() {
    if (canCam() && homeCam) {
      ctx.Graph.cameraPosition({ x: homeCam.x, y: homeCam.y, z: homeCam.z }, { x: 0, y: 0, z: 0 }, DUR);
    } else if (typeof ctx.recenter === 'function') {
      ctx.recenter(DUR);
    }
  }
  function fadeBrain(to) {
    if (!brainEl) return;
    brainEl.style.transition = `opacity ${DUR}ms ease`;
    brainEl.style.visibility = '';
    brainEl.style.opacity = String(to);
  }

  /**
   * Brain → Corpus. `ready` resolves once the corpus content is prepared (settled + pinned +
   * fit), or resolves for empty/error (caller has shown the status overlay). Sequenced: the
   * brain recedes immediately; the map fades in once it's BOTH ready and past REVEAL_AT·DUR.
   */
  async function toCorpus(ready) {
    if (state === 'corpus' || state === 'toCorpus') return;
    state = 'toCorpus';
    markActive();           // lesson 2: suppress idle drift for the whole move
    pullBackCamera();       // brain recedes (real 3D camera tween)
    fadeBrain(0);           // ...and fades out so it never bleeds through the map
    corpusEl.classList.add('open'); // mount the corpus (display:block, opacity 0)
    try { await Promise.all([Promise.resolve(ready), delay(Math.round(DUR * REVEAL_AT))]); } catch (_) { /* reveal anyway */ }
    if (state !== 'toCorpus') return;   // interrupted by toBrain()
    // Fit the pinned graph now — container is display:block (real rect), positions frozen.
    if (typeof onBeforeReveal === 'function') { try { onBeforeReveal(); } catch (_) { /* ignore */ } }
    corpusEl.classList.add('corpus-in'); // CSS fades the (pinned, settled, just-fit) map in
    await delay(DUR);
    if (state === 'toCorpus') state = 'corpus';
  }

  /** Corpus → Brain. Corpus fades out while the camera dives to the exact home + brain fades in. */
  async function toBrain() {
    if (state === 'brain' || state === 'toBrain') return;
    state = 'toBrain';
    markActive();
    corpusEl.classList.remove('corpus-in'); // fade the map out
    fadeBrain(1);                           // brain fades back in
    diveCamera();                           // ...to the exact saved home (no compounding)
    await delay(DUR);
    if (state === 'toBrain') {
      corpusEl.classList.remove('open');    // unmount once fully faded
      state = 'brain';
    }
  }

  /**
   * Re-assert the corpus-shown state WITHOUT a camera move — used when a reader that was
   * opened over the corpus closes (the camera never left corpus framing).
   */
  function assertCorpus() {
    state = 'corpus';
    corpusEl.classList.add('open');
    corpusEl.classList.add('corpus-in');
    if (brainEl) brainEl.style.opacity = '0';
  }

  return {
    toCorpus,
    toBrain,
    assertCorpus,
    isCorpus: () => state === 'corpus' || state === 'toCorpus',
    state: () => state,
  };
}
