/**
 * Reader layer (READER-02) — DB-backed project deep-dive with Reader/Brain toggle.
 *
 * The hero interaction: read prose → click a cited claim → the atom it came from is
 * selected in the graph (camera-focus + existing detail panel) → toggle to Brain →
 * graph is FOCUSED on this doc's cited atoms with selection preserved → toggle back.
 *
 * renderMarkdown is a PURE string→string function (no DOM) so it is unit-testable in node.
 * Module top-level is side-effect-free; all DOM access is inside initReader.
 *
 * Security: all node/fact values go through escapeHtml before any innerHTML assignment
 * (T-10-12 / T-27-08). The only innerHTML assignment is renderMarkdown output (pure,
 * all user-supplied text escaped). Fact values in the detail panel use textContent (detail.js).
 */

const FACT_LINK = /\[([^\]]+)\]\(recense:\/\/fact\/([0-9a-f-]{36})\)/g;
const DOC_LINK = /\[([^\]]+)\]\(recense:\/\/doc\/([a-z0-9-]+)\)/g;

// Poll interval when waiting for lazy generation (ms).
const POLL_MS = 2000;
// Maximum poll attempts (~120s at 2s intervals) before giving up.
const POLL_MAX = 60;

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
  const slug = new URLSearchParams(location.search).get('doc') || 'tonos';
  const panel = document.getElementById('reader');
  const body = document.getElementById('reader-body');
  const titleEl = document.getElementById('reader-title');
  const btn = document.getElementById('btn-reader');
  if (!panel || !body || !btn) return;

  let loaded = false;
  // citedFactIds fetched from /doc/meta; used for graph focus.
  let citedFactIds = [];

  // ── Show / hide ────────────────────────────────────────────────────────────

  function show() {
    panel.classList.add('open');
    document.documentElement.classList.add('reader-open');
    btn.textContent = 'Brain';
    if (!loaded) { load(); loaded = true; }
    // When showing reader, apply graph focus on cited atoms (READER-02).
    applyGraphFocus(citedFactIds);
  }

  function hide() {
    panel.classList.remove('open');
    document.documentElement.classList.remove('reader-open');
    btn.textContent = 'Reader';
    // Lift graph focus so all nodes are visible in brain view.
    liftGraphFocus();
  }

  btn.addEventListener('click', () => (panel.classList.contains('open') ? hide() : show()));

  // Deep-link: /?doc=<slug>&reader=1 opens the reader on load.
  if (new URLSearchParams(location.search).has('reader')) show();

  // ── Load (DB-backed, lazy-aware) ───────────────────────────────────────────

  async function load() {
    if (titleEl) titleEl.textContent = slug;
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
    while (attempts < POLL_MAX) {
      const res = await fetch('/doc?slug=' + encodeURIComponent(slug));
      if (res.ok) {
        const md = await res.text();
        // T-10-12/T-27-08: only innerHTML from renderMarkdown output (all values escaped).
        body.innerHTML = renderMarkdown(md);
        wireFactLinks();
        // Fetch /doc/meta for cited ids (graph focus).
        await fetchMeta();
        return;
      }
      if (res.status === 202) {
        // D-03: single honest loading state — show progress, poll.
        attempts++;
        const dots = '.'.repeat((attempts % 4) + 1);
        body.textContent = `generating doc${dots} (${attempts}/${POLL_MAX})`;
        await sleep(POLL_MS);
        continue;
      }
      // Other error.
      throw new Error('GET /doc → ' + res.status);
    }
    throw new Error('timed out waiting for doc generation');
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // ── /doc/meta — cited fact ids for graph focus (READER-02) ────────────────

  async function fetchMeta() {
    try {
      const res = await fetch('/doc/meta?slug=' + encodeURIComponent(slug));
      if (!res.ok) return;
      const data = await res.json();
      citedFactIds = Array.isArray(data.citedFactIds) ? data.citedFactIds : [];
      // Store on ctx so other modules (detail.js) can see the cited set.
      ctx.citedFactIds = citedFactIds;
      // Re-apply focus if the reader is currently open.
      if (panel.classList.contains('open')) {
        applyGraphFocus(citedFactIds);
      }
    } catch (_) {
      // Meta failure is non-fatal — doc still renders.
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

  function wireFactLinks() {
    let missing = 0;
    body.querySelectorAll('a.fact-ref[data-fact]').forEach(a => {
      const id = a.getAttribute('data-fact');
      const node = ctx.idMap && ctx.idMap.get(id);
      if (!node) { a.classList.add('fact-missing'); missing++; return; }
      a.addEventListener('click', ev => {
        ev.preventDefault();
        // prose → atom: close reader, select the cited node (camera-focus + detail panel).
        // Selection is NOT cleared on hide() — it persists across the toggle (READER-02).
        hide();
        if (ctx.selectNode) ctx.selectNode(node);
      });
    });
    if (missing && ctx.logEvent) ctx.logEvent(`reader: ${missing} cited fact(s) not in graph`);
  }
}
