/**
 * Reader layer (READER-02/03) — DB-backed project deep-dive with Reader/Brain toggle
 * and citation staleness detection (D-10).
 *
 * The hero interaction: read prose → click a cited claim → the atom it came from is
 * selected in the graph (camera-focus + existing detail panel) → toggle to Brain →
 * graph is FOCUSED on this doc's cited atoms with selection preserved → toggle back.
 *
 * READER-03 additions:
 *   - After wireFactLinks(), fetches /doc/staleness?slug= to classify cited refs.
 *   - Prepends a .staleness-banner summarising stale/tombstoned count + regenerate CTA.
 *   - Marks inline .fact-stale (changed) and .fact-tombstoned (removed/non-clickable) refs.
 *   - Stores ctx.staleFactIds (Set) + ctx.staleFactPrevValues (Map id→prev_value) so
 *     detail.js can show the prev_value→value diff row when a stale atom is selected.
 *   - Regenerate button → POST /doc/generate?slug= (force), then polls until doc reloads.
 *
 * renderMarkdown is a PURE string→string function (no DOM) so it is unit-testable in node.
 * Module top-level is side-effect-free; all DOM access is inside initReader.
 *
 * Security: all node/fact values go through escapeHtml before any innerHTML assignment
 * (T-10-12 / T-27-08). The only innerHTML assignment is renderMarkdown output (pure,
 * all user-supplied text escaped). Staleness banner count text and prev_value diff row
 * use textContent (never innerHTML with node values — T-27-12).
 * Fact values in the detail panel use textContent (detail.js).
 */

const FACT_LINK = /\[([^\]]+)\]\(recense:\/\/fact\/([0-9a-f-]{36})\)/g;
const DOC_LINK = /\[([^\]]+)\]\(recense:\/\/doc\/([a-z0-9-]+)\)/g;

// Poll interval when waiting for lazy generation (ms).
const POLL_MS = 2000;
// Maximum poll attempts (~120s at 2s intervals) before giving up.
const POLL_MAX = 60;
// Typical schema-doc generation wall-time (headless judge-tier, ~4k-token cited prose).
// Measured ~42s on the live brain; used only to drive the progress-bar ETA estimate.
const GEN_ESTIMATE_MS = 45000;

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Inline tokens — run on an already-escaped line (markdown delimiters survive escaping). */
function renderInline(line) {
  return line
    // fact-ref: carry the id on a data attribute; reader wires the click handler later
    .replace(FACT_LINK, (_m, text, id) => `<a class="fact-ref" data-fact="${id}" href="#">${text}</a>`)
    // doc-ref: rendered as a chip (no handler in this iteration)
    .replace(DOC_LINK, (_m, text, id) => `<a class="doc-ref" data-doc="${id}" href="#">${text}</a>`)
    // plain markdown links → keep only the visible text (no outbound nav in the reader)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

/** Minimal markdown → HTML for the generated-doc subset (headings, hr, lists, paragraphs).
 *  All user-supplied text runs through escapeHtml before renderInline — T-10-12/T-27-08.
 */
export function renderMarkdown(md) {
  const lines = md.split('\n');
  const out = [];
  let inList = false;
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (/^#{1,6}\s/.test(line)) {
      closeList();
      const level = line.match(/^#+/)[0].length;
      const text = renderInline(escapeHtml(line.replace(/^#+\s/, '')));
      out.push(`<h${level}>${text}</h${level}>`);
    } else if (/^---+$/.test(line)) {
      closeList();
      out.push('<hr/>');
    } else if (/^\s*-\s/.test(line)) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${renderInline(escapeHtml(line.replace(/^\s*-\s/, '')))}</li>`);
    } else if (line.trim() === '') {
      closeList();
    } else {
      closeList();
      out.push(`<p>${renderInline(escapeHtml(line))}</p>`);
    }
  }
  closeList();
  return out.join('\n');
}

export function initReader(ctx) {
  // currentSlug is mutable: the deep-link path seeds it from the URL, but the
  // in-place corpus opener (openReader) can re-target it to another doc's slug
  // WITHOUT a page navigation (Fix B — no brain detour).
  let currentSlug = new URLSearchParams(location.search).get('doc') || 'tonos';
  const panel = document.getElementById('reader');
  const body = document.getElementById('reader-body');
  const titleEl = document.getElementById('reader-title');
  const btn = document.getElementById('btn-reader');
  const closeBtn = document.getElementById('reader-close');
  if (!panel || !body || !btn) return;

  // Provenance of the current reader open:
  //   'brain'  → opened from the 3D brain (the 27-03 hero path) — toggle/close
  //              restores the brain + applies/lifts graph focus (existing behavior).
  //   'corpus' → opened in-place over the flat 2D corpus (Fix B) — close returns to
  //              the corpus; the brain is NEVER shown and graph-focus is skipped.
  let openFrom = 'brain';

  let loaded = false;
  // citedFactIds fetched from /doc/meta; used for graph focus.
  let citedFactIds = [];
  // Staleness state (READER-03): populated from /doc/staleness after wireFactLinks().
  // staleFactIds: Set of factId strings whose last_access > doc.generated_at.
  // staleFactPrevValues: Map factId → prev_value string (for diff in atom panel).
  let staleFactIds = new Set();
  let staleFactPrevValues = new Map();

  // ── Show / hide ────────────────────────────────────────────────────────────

  function show() {
    panel.classList.add('open');
    document.documentElement.classList.add('reader-open');
    btn.textContent = 'Brain';
    if (!loaded) { load(); loaded = true; }
    // Graph focus on cited atoms is a BRAIN-only enhancement (READER-02): only
    // apply it when the reader was opened from the brain. When opened over the
    // corpus (Fix B) the brain is hidden, so focusing it is pointless.
    if (openFrom === 'brain') applyGraphFocus(citedFactIds);
  }

  function hide() {
    panel.classList.remove('open');
    document.documentElement.classList.remove('reader-open');
    btn.textContent = 'Reader';
    if (openFrom === 'corpus') {
      // Opened in-place over the corpus (Fix B): closing returns to the corpus —
      // do NOT show the brain or lift its focus. The corpus stayed mounted
      // underneath the overlay, so removing the .open class is all that's needed.
      if (typeof ctx.returnToCorpus === 'function') ctx.returnToCorpus();
      return;
    }
    // Brain path (the 27-03 hero interaction): lift graph focus so all nodes
    // are visible in brain view.
    liftGraphFocus();
  }

  btn.addEventListener('click', () => (panel.classList.contains('open') ? hide() : show()));

  // In-panel close: the open #reader panel covers #btn-reader, so the toggle is
  // unreachable from inside the reader. The header × calls hide() (which lifts focus).
  if (closeBtn) closeBtn.addEventListener('click', () => hide());

  // Escape closes the reader when open (only when the reader has focus context —
  // guarded so it never swallows Escape for other surfaces when the reader is hidden).
  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && panel.classList.contains('open')) hide();
  });

  // Deep-link: /?doc=<slug>&reader=1 opens the reader on load (brain provenance).
  if (new URLSearchParams(location.search).has('reader')) show();

  // currentDocId: when a doc is opened by NODE id (a doc-ref click, Fix B) rather than
  // by slug, the server endpoints are queried with ?id= (which resolves exact-or-unique-
  // prefix → slug server-side). null = slug-addressed (the normal slug path).
  let currentDocId = null;

  /**
   * Build the doc query string for the server endpoints. Prefers ?id= when the doc
   * was opened by node id (doc-ref click), else ?slug=. The server resolves ?id=
   * (exact-or-unique-prefix) to the live doc, so truncated generated doc-refs work.
   */
  function docQuery() {
    return currentDocId
      ? 'id=' + encodeURIComponent(currentDocId)
      : 'slug=' + encodeURIComponent(currentSlug);
  }

  // ── In-place reader opener (Fix B — corpus doc-node entry + doc-ref click, D-08) ──
  // openReader(slug, { from, docId }) re-targets the reader and shows the #reader
  // overlay WITHOUT any page navigation. corpus.js calls it with a slug + from:'corpus'
  // (the corpus doc-node click); the in-prose doc-ref click calls it with {docId, from}
  // (a doc NODE id, resolved server-side via ?id=). The overlay slides in over whatever
  // is underneath (corpus or brain); closing returns there.
  ctx.openReader = function openReader(targetSlug, opts) {
    const from = (opts && opts.from) || 'brain';
    const docId = (opts && opts.docId) || null;
    openFrom = from;
    // A re-target happens when the slug OR the docId differs from the current doc.
    const slugChanged = targetSlug && targetSlug !== currentSlug;
    const idChanged = docId && docId !== currentDocId;
    if (slugChanged || idChanged) {
      // New target doc: reset load state so the new prose is fetched fresh and stale
      // state from the prior doc does not bleed in.
      if (targetSlug) currentSlug = targetSlug;
      currentDocId = docId; // null for slug-addressed opens; set for id-addressed
      loaded = false;
      citedFactIds = [];
      ctx.citedFactIds = citedFactIds;
      staleFactIds = new Set();
      staleFactPrevValues = new Map();
      ctx.staleFactIds = staleFactIds;
      ctx.staleFactPrevValues = staleFactPrevValues;
      body.textContent = '';
    }
    show();
  };

  // NOTE: the doc→doc corpus graph (READER-04, #btn-corpus) is a SEPARATE flat 2D
  // Obsidian-style view owned by corpus.js — it is NOT a data-swap on the 3D brain.
  // reader.js only owns the prose reader + fact-ref→atom focus + this in-place opener.

  // ── Load (DB-backed, lazy-aware) ───────────────────────────────────────────

  async function load() {
    if (titleEl) titleEl.textContent = currentSlug;
    body.textContent = 'loading…';
    try {
      await loadWithPoll();
    } catch (e) {
      body.textContent = 'failed to load doc: ' + String(e);
    }
  }

  /**
   * Fetch /doc?slug=<slug>. If the server returns 202 {status:'generating'}, show a
   * progress state and poll until markdown arrives (D-02/D-03 single loading path).
   */
  async function loadWithPoll() {
    let attempts = 0;
    let progress = null;
    try {
      while (attempts < POLL_MAX) {
        const res = await fetch('/doc?' + docQuery());
        // IMPORTANT: must be `=== 200`, NOT `res.ok` — 202 ("generating") is also a 2xx,
        // so `res.ok` would swallow it and render the raw {"status":"generating"} JSON as
        // the doc body. Only a real 200 carries markdown.
        if (res.status === 200) {
          const md = await res.text();
          if (progress) progress.done();
          // T-10-12/T-27-08: only innerHTML from renderMarkdown output (all values escaped).
          body.innerHTML = renderMarkdown(md);
          wireFactLinks();
          // Fetch staleness data (READER-03): marks inline refs + shows banner.
          await fetchStaleness();
          // Fetch backlinks (WIKI-02, 39-01): appends "Referenced by" section at doc bottom.
          await fetchBacklinks();
          // Fetch /doc/meta for cited ids (graph focus).
          await fetchMeta();
          return;
        }
        if (res.status === 202) {
          // D-03: single honest loading state — a real elapsed/ETA progress bar (built
          // once on the first 202; it animates independently of the 2s poll cadence).
          attempts++;
          if (!progress) progress = startGenProgress();
          await sleep(POLL_MS);
          continue;
        }
        // Other error.
        throw new Error('GET /doc → ' + res.status);
      }
      throw new Error('timed out waiting for doc generation');
    } finally {
      if (progress) progress.stop();
    }
  }

  /**
   * Build + animate the generation progress bar. There is no server-side progress signal
   * for a single LLM generation, so the bar is a time-based ESTIMATE: it eases toward
   * (but never reaches) 100% on an exponential curve calibrated to GEN_ESTIMATE_MS, and
   * snaps to 100% only when the real doc arrives. Honest about the estimate via "~Ns left".
   * Returns { stop, done } to tear down the animation interval.
   */
  function startGenProgress() {
    body.textContent = '';
    const wrap = document.createElement('div');
    wrap.className = 'doc-progress';
    const track = document.createElement('div');
    track.className = 'doc-progress-track';
    const fill = document.createElement('div');
    fill.className = 'doc-progress-fill';
    track.appendChild(fill);
    const label = document.createElement('div');
    label.className = 'doc-progress-label';
    wrap.appendChild(track);
    wrap.appendChild(label);
    body.appendChild(wrap);

    const start = performance.now();
    const TAU = GEN_ESTIMATE_MS * 0.5; // ~87% at the estimate, ~98% at 2× it; never 100%.
    function tick() {
      const elapsed = performance.now() - start;
      const f = 1 - Math.exp(-elapsed / TAU);
      fill.style.width = (f * 100).toFixed(1) + '%';
      const secs = Math.floor(elapsed / 1000);
      const remain = Math.round((GEN_ESTIMATE_MS - elapsed) / 1000);
      label.textContent = remain > 0
        ? `generating · ${secs}s elapsed · ~${remain}s left`
        : `generating · ${secs}s elapsed · finishing up…`;
    }
    tick();
    const id = setInterval(tick, 150);
    return {
      stop() { clearInterval(id); },
      done() { clearInterval(id); fill.style.width = '100%'; },
    };
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // ── /doc/meta — cited fact ids for graph focus (READER-02) ────────────────

  async function fetchMeta() {
    try {
      const res = await fetch('/doc/meta?' + docQuery());
      if (!res.ok) return;
      const data = await res.json();
      citedFactIds = Array.isArray(data.citedFactIds) ? data.citedFactIds : [];
      // Store on ctx so other modules (detail.js) can see the cited set.
      ctx.citedFactIds = citedFactIds;
      // If this doc was opened by id (doc-ref click), the server resolved the slug —
      // adopt it so the title is correct and future fetches can use the slug directly.
      if (data.slug && data.slug !== currentSlug) {
        currentSlug = data.slug;
        if (titleEl) titleEl.textContent = currentSlug;
      }
      // Re-apply focus if the reader is currently open.
      if (panel.classList.contains('open')) {
        applyGraphFocus(citedFactIds);
      }
    } catch (_) {
      // Meta failure is non-fatal — doc still renders.
    }
  }

  // ── Staleness (READER-03, D-10) ────────────────────────────────────────────
  // Fetches /doc/staleness?slug=, marks changed/tombstoned inline refs, prepends
  // the .staleness-banner (with regenerate CTA), and stores stale ids on ctx so
  // the atom panel (detail.js) can show the prev_value→value diff row.

  async function fetchStaleness() {
    try {
      const res = await fetch('/doc/staleness?' + docQuery());
      if (!res.ok) return; // non-fatal: staleness is an enhancement, not load-critical
      const data = await res.json();
      const staleList = Array.isArray(data.stale) ? data.stale : [];
      const tombstonedList = Array.isArray(data.tombstoned) ? data.tombstoned : [];

      // Build lookup structures.
      staleFactIds = new Set(staleList.map(s => s.factId));
      staleFactPrevValues = new Map(staleList.map(s => [s.factId, s.prev_value]));
      const tombstonedSet = new Set(tombstonedList);

      // Store on ctx so detail.js can access the stale set when populating the atom panel.
      ctx.staleFactIds = staleFactIds;
      ctx.staleFactPrevValues = staleFactPrevValues;

      // Mark inline refs.
      body.querySelectorAll('a.fact-ref[data-fact]').forEach(a => {
        const id = a.getAttribute('data-fact');
        if (tombstonedSet.has(id)) {
          a.classList.add('fact-tombstoned');
          // Tombstoned refs are non-clickable (no navigate-to-atom).
          a.style.pointerEvents = 'none';
          a.setAttribute('aria-label', 'cited fact was removed');
          a.setAttribute('title', 'cited fact was removed');
        } else if (staleFactIds.has(id)) {
          a.classList.add('fact-stale');
          // Store prev_value on dataset for any downstream consumers.
          const pv = staleFactPrevValues.get(id);
          if (pv != null) a.dataset.prevValue = pv;
        }
      });

      // If nothing is stale/tombstoned, skip the banner.
      const totalChanged = staleList.length + tombstonedList.length;
      if (totalChanged === 0) return;

      // Prepend .staleness-banner to reader-body (T-27-12: count text via textContent only).
      const banner = document.createElement('div');
      banner.className = 'staleness-banner';

      const msgEl = document.createElement('span');
      // Build a human-readable summary without innerHTML with data.
      const parts = [];
      if (staleList.length > 0) parts.push(staleList.length + ' cited fact' + (staleList.length > 1 ? 's' : '') + ' changed');
      if (tombstonedList.length > 0) parts.push(tombstonedList.length + ' removed');
      msgEl.textContent = parts.join(', ') + ' since this was written';

      const regenBtn = document.createElement('button');
      regenBtn.className = 'btn-regen';
      regenBtn.textContent = 'regenerate';
      regenBtn.addEventListener('click', () => regenerate());

      banner.appendChild(msgEl);
      banner.appendChild(regenBtn);
      // Prepend: insert before the first child (if any), or append if body is empty.
      body.insertBefore(banner, body.firstChild);
    } catch (_) {
      // Staleness fetch failure is non-fatal — doc still renders correctly.
    }
  }

  // ── Backlinks (WIKI-02, 39-01) ─────────────────────────────────────────────
  // Appends a "Referenced by" section at the BOTTOM of the doc body listing other
  // live docs that link here via doc_link/doc_reference/doc_containment edges.
  // If no incoming links exist, returns silently (no empty chrome — must-have truth #2).
  // Security: all DB-sourced strings set via textContent only (T-10-12/T-27-08).

  async function fetchBacklinks() {
    try {
      const res = await fetch('/doc/backlinks?' + docQuery());
      if (!res.ok) return; // non-fatal: backlinks are an enhancement, not load-critical
      const data = await res.json();
      const links = Array.isArray(data.backlinks) ? data.backlinks : [];
      if (links.length === 0) return; // no incoming links → no section (must-have truth #2)

      const section = document.createElement('div');
      section.className = 'backlinks-section';

      const heading = document.createElement('div');
      heading.className = 'backlinks-heading';
      heading.textContent = 'Referenced by'; // textContent only — T-10-12

      const list = document.createElement('ul');
      list.className = 'backlinks-list';
      for (const bl of links) {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.className = 'doc-ref';
        a.setAttribute('data-doc', bl.srcId);
        a.setAttribute('href', '#');
        a.textContent = bl.label || bl.slug; // textContent only — T-10-12/T-27-08
        a.addEventListener('click', ev => {
          ev.preventDefault();
          ctx.openReader(null, { from: openFrom, docId: bl.srcId });
        });
        li.appendChild(a);
        list.appendChild(li);
      }
      section.appendChild(heading);
      section.appendChild(list);
      body.appendChild(section); // APPEND (not prepend) — staleness banner stays at top (D-07)
    } catch (_) {
      // Backlinks fetch failure is non-fatal — doc still renders correctly.
    }
  }

  // ── Regenerate (READER-03) ──────────────────────────────────────────────────
  // Force-rebuilds the doc from current facts via POST /doc/generate?slug= then
  // polls until the fresh doc is ready and reloads it (reusing the poll loop).

  async function regenerate() {
    try {
      // Remove the stale banner immediately to signal the action was taken.
      const existingBanner = body.querySelector('.staleness-banner');
      if (existingBanner) existingBanner.remove();
      body.insertBefore(
        Object.assign(document.createElement('div'), {
          className: 'reader-loading',
          textContent: 'regenerating doc…',
        }),
        body.firstChild,
      );

      // POST /doc/generate — force-regen (returns 202 immediately).
      await fetch('/doc/generate?slug=' + encodeURIComponent(currentSlug), { method: 'POST' });

      // Clear the body and reload via the existing poll loop.
      // Regeneration supersedes the doc node (new id), so drop any id-addressing and
      // reload by slug — currentSlug is authoritative here (fetchMeta adopted it on the
      // prior load if this doc was opened by id).
      currentDocId = null;
      loaded = false;
      body.textContent = '';
      staleFactIds = new Set();
      staleFactPrevValues = new Map();
      ctx.staleFactIds = staleFactIds;
      ctx.staleFactPrevValues = staleFactPrevValues;
      await loadWithPoll();
    } catch (e) {
      // Non-fatal: show an inline error.
      const errEl = document.createElement('div');
      errEl.className = 'reader-loading';
      errEl.textContent = 'regenerate failed: ' + String(e);
      body.insertBefore(errEl, body.firstChild);
    }
  }

  // ── Graph focus on cited atoms (READER-02, client-side — D-CONTEXT) ────────
  // When the reader is open, dim nodes that are NOT in the cited set so the brain
  // is "focused" on this doc's atoms. Selection is never cleared by the toggle.

  function applyGraphFocus(ids) {
    if (!ctx.Graph || !ids || ids.length === 0) return;
    const citedSet = new Set(ids);
    try {
      ctx.Graph
        .nodeColor(node => {
          if (!node || !node.id) return null;
          if (node.type === 'doc') return 'rgba(140,150,165,0.15)';
          return citedSet.has(node.id)
            ? null  // null → let graph.js / lod.js apply normal color
            : 'rgba(80,60,90,0.18)';  // dim non-cited nodes
        })
        .linkColor(link => {
          const sid = typeof link.source === 'object' ? link.source.id : link.source;
          const tid = typeof link.target === 'object' ? link.target.id : link.target;
          if (link.kind === 'cites') return null; // keep cites edges visible
          return (citedSet.has(sid) || citedSet.has(tid))
            ? null
            : 'rgba(80,60,90,0.12)';
        });
    } catch (_) {
      // Graph not yet ready — focus will be applied on next show().
    }
  }

  function liftGraphFocus() {
    if (!ctx.Graph) return;
    try {
      // Restore default color delegation (null = let graph.js decide).
      ctx.Graph.nodeColor(null).linkColor(null);
    } catch (_) { /* ignore */ }
  }

  // ── wireFactLinks ──────────────────────────────────────────────────────────
  // Wires BOTH inline ref kinds after each (re-)render:
  //   .fact-ref[data-fact] → drop to the brain at that atom (the hero interaction)
  //   .doc-ref[data-doc]   → open the referenced doc IN PLACE (Fix B, doc→doc nav)

  function wireFactLinks() {
    let missing = 0;
    body.querySelectorAll('a.fact-ref[data-fact]').forEach(a => {
      const id = a.getAttribute('data-fact');
      const node = ctx.idMap && ctx.idMap.get(id);
      if (!node) { a.classList.add('fact-missing'); missing++; return; }
      a.addEventListener('click', ev => {
        ev.preventDefault();
        // prose → atom: close reader, select the cited node (camera-focus + detail panel).
        // This is the explicit hero interaction (READER-02) — it ALWAYS drops to the
        // brain, even when the reader was opened in-place over the corpus (Fix B): the
        // user is deliberately choosing to inspect this atom in the brain. So force the
        // brain return path here regardless of openFrom, and ensure the brain is shown.
        if (openFrom === 'corpus' && typeof ctx.showBrainFromCorpus === 'function') {
          ctx.showBrainFromCorpus();
        }
        openFrom = 'brain';
        // Selection is NOT cleared on hide() — it persists across the toggle (READER-02).
        hide();
        if (ctx.selectNode) ctx.selectNode(node);
      });
    });

    // doc-ref → open the referenced doc IN PLACE (Fix B). data-doc carries the target
    // doc NODE id (canonicalized to a full id by the generator). We open it via the
    // in-place opener with the CURRENT `from` preserved: a doc-ref clicked while reading
    // over the corpus keeps the new doc in the corpus overlay (close → back to corpus);
    // over the brain it stays a brain-context open. The server resolves the id (?id=,
    // exact-or-unique-prefix) → slug, so even a truncated generated doc-ref works.
    body.querySelectorAll('a.doc-ref[data-doc]').forEach(a => {
      const docId = a.getAttribute('data-doc');
      if (!docId) return;
      a.addEventListener('click', ev => {
        ev.preventDefault();
        ctx.openReader(null, { from: openFrom, docId });
      });
    });

    if (missing && ctx.logEvent) ctx.logEvent(`reader: ${missing} cited fact(s) not in graph`);
  }
}
