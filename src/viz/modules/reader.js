/**
 * Reader layer (THROWAWAY slice) — renders a generated project deep-dive and wires
 * inline fact-refs down into the brain graph.
 *
 * The hero interaction: read prose → click a cited claim → the atom it came from is
 * selected in the graph (camera-focus + existing detail panel). A toggle flips between
 * the reader overlay and the brain underneath.
 *
 * renderMarkdown is a PURE string→string function (no DOM) so it is unit-testable in node.
 * Module top-level is side-effect-free; all DOM access is inside initReader.
 */

const FACT_LINK = /\[([^\]]+)\]\(recense:\/\/fact\/([0-9a-f-]{36})\)/g;
const DOC_LINK = /\[([^\]]+)\]\(recense:\/\/doc\/([a-z0-9-]+)\)/g;

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
    // doc-ref: rendered as a chip (no handler in the slice)
    .replace(DOC_LINK, (_m, text, id) => `<a class="doc-ref" data-doc="${id}" href="#">${text}</a>`)
    // plain markdown links → keep only the visible text (no outbound nav in the reader)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

/** Minimal markdown → HTML for the generated-doc subset (headings, hr, lists, paragraphs). */
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
  const term = new URLSearchParams(location.search).get('doc') || 'tonos';
  const panel = document.getElementById('reader');
  const body = document.getElementById('reader-body');
  const titleEl = document.getElementById('reader-title');
  const btn = document.getElementById('btn-reader');
  if (!panel || !body || !btn) return;

  let loaded = false;

  function show() {
    panel.classList.add('open');
    document.documentElement.classList.add('reader-open');
    btn.textContent = 'Brain';
    if (!loaded) { load(); loaded = true; }
  }
  function hide() {
    panel.classList.remove('open');
    document.documentElement.classList.remove('reader-open');
    btn.textContent = 'Reader';
  }
  btn.addEventListener('click', () => (panel.classList.contains('open') ? hide() : show()));

  // Deep-link: /?doc=<term>&reader=1 opens the reader on load (also used for verification).
  if (new URLSearchParams(location.search).has('reader')) show();

  async function load() {
    if (titleEl) titleEl.textContent = term;
    body.textContent = 'loading…';
    try {
      const md = await fetch('/doc?term=' + encodeURIComponent(term)).then(r => {
        if (!r.ok) throw new Error('GET /doc → ' + r.status);
        return r.text();
      });
      body.innerHTML = renderMarkdown(md);
      wireFactLinks();
    } catch (e) {
      body.textContent = 'failed to load doc: ' + String(e);
    }
  }

  function wireFactLinks() {
    let missing = 0;
    body.querySelectorAll('a.fact-ref[data-fact]').forEach(a => {
      const id = a.getAttribute('data-fact');
      const node = ctx.idMap && ctx.idMap.get(id);
      if (!node) { a.classList.add('fact-missing'); missing++; return; }
      a.addEventListener('click', ev => {
        ev.preventDefault();
        // prose → atom: drop the reader, select the cited node (camera-focus + detail panel)
        hide();
        if (ctx.selectNode) ctx.selectNode(node);
      });
    });
    if (missing && ctx.logEvent) ctx.logEvent(`reader: ${missing} cited fact(s) not in graph`);
  }
}
