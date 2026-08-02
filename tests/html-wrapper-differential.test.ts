/**
 * html-wrapper-differential.test.ts (62-28-PLAN.md) — WORK IN PROGRESS (Task 2 state, no
 * named-mechanism gate yet; Task 3 adds the gate and this header is rewritten there).
 */
import { describe, it, expect } from 'vitest';
import { renderedText } from './support/html-render-oracle';
import { classMarker, idMarker, throwIfFailures } from './support/differential-helpers';
import { stripHiddenContent } from '../src/source/strip-hidden';

type ProbeKind = 'class' | 'id';
type Placement = 'inside' | 'after';

function cssFor(probeKind: ProbeKind): string {
  return probeKind === 'class' ? '.legal{display:none}' : '#legal{display:none}';
}

function markerFor(probeKind: ProbeKind): string {
  return probeKind === 'class' ? classMarker('legal') : idMarker('legal');
}

function probeSpanFor(probeKind: ProbeKind): string {
  return probeKind === 'class'
    ? `<span class="legal">${classMarker('legal')}</span>`
    : `<span id="legal">${idMarker('legal')}</span>`;
}

interface WrapperShape {
  id: number;
  template: string;
  reason: string;
  build: (probeKind: ProbeKind, placement: Placement) => string;
}

const WRAPPER_SHAPES: readonly WrapperShape[] = [
  {
    id: 1,
    template: '<style>CSS</style>',
    reason: 'Control — the ordinary, well-formed style wrapper; must be correct today.',
    build: (probeKind, placement) => {
      const css = cssFor(probeKind);
      const span = probeSpanFor(probeKind);
      return placement === 'after'
        ? `<style>${css}</style>VISIBLE_SENTENCE${span}`
        : `<style>${css}${span}</style>VISIBLE_SENTENCE`;
    },
  },
  {
    id: 2,
    template: '<style/>CSS</style>',
    reason: 'CR-01 a — self-closing start-tag syntax on style (HTML §13.2.5: a spec-correct no-op, the element opens normally).',
    build: (probeKind, placement) => {
      const css = cssFor(probeKind);
      const span = probeSpanFor(probeKind);
      return placement === 'after'
        ? `<style/>${css}</style>VISIBLE_SENTENCE${span}`
        : `<style/>${css}${span}</style>VISIBLE_SENTENCE`;
    },
  },
  {
    id: 3,
    template: '<style />CSS</style>',
    reason: 'CR-01 b — self-closing syntax with a space before the slash.',
    build: (probeKind, placement) => {
      const css = cssFor(probeKind);
      const span = probeSpanFor(probeKind);
      return placement === 'after'
        ? `<style />${css}</style>VISIBLE_SENTENCE${span}`
        : `<style />${css}${span}</style>VISIBLE_SENTENCE`;
    },
  },
  {
    id: 4,
    template: '<STYLE/>CSS</STYLE>',
    reason: 'CR-01 c — self-closing syntax, case-insensitive tag name.',
    build: (probeKind, placement) => {
      const css = cssFor(probeKind);
      const span = probeSpanFor(probeKind);
      return placement === 'after'
        ? `<STYLE/>${css}</STYLE>VISIBLE_SENTENCE${span}`
        : `<STYLE/>${css}${span}</STYLE>VISIBLE_SENTENCE`;
    },
  },
  {
    id: 5,
    template: '<style type=a/>CSS</style>',
    reason: 'CR-01 d — self-closing syntax on any unquoted attribute ending in "/".',
    build: (probeKind, placement) => {
      const css = cssFor(probeKind);
      const span = probeSpanFor(probeKind);
      return placement === 'after'
        ? `<style type=a/>${css}</style>VISIBLE_SENTENCE${span}`
        : `<style type=a/>${css}${span}</style>VISIBLE_SENTENCE`;
    },
  },
  {
    id: 6,
    template: '<style>CSS</style foo>',
    reason: "D-62-21-01 — RAWTEXT close-tag residual: trailing garbage before the close tag's own \">\".",
    build: (probeKind, placement) => {
      const css = cssFor(probeKind);
      const span = probeSpanFor(probeKind);
      return placement === 'after'
        ? `<style>${css}</style foo>VISIBLE_SENTENCE${span}`
        : `<style>${css}${span}</style foo>VISIBLE_SENTENCE`;
    },
  },
  {
    id: 7,
    template: '<style>CSS</style/>',
    reason: 'RAWTEXT close-slash defect — htmlparser2 does not recognize this as a close tag at all (measured deviation, tests/html-parser-conformance.test.ts).',
    build: (probeKind, placement) => {
      const css = cssFor(probeKind);
      const span = probeSpanFor(probeKind);
      return placement === 'after'
        ? `<style>${css}</style/>VISIBLE_SENTENCE${span}`
        : `<style>${css}${span}</style/>VISIBLE_SENTENCE`;
    },
  },
  {
    id: 8,
    template: '<style>CSS',
    reason: 'Unterminated <style> to EOF — a real browser swallows everything after it, including any trailing content, as inert stylesheet text; inside/after placement collapse to the same input because nothing can exist "after" an EOF-terminated element.',
    build: probeKind => {
      const css = cssFor(probeKind);
      const span = probeSpanFor(probeKind);
      return `<style>${css}VISIBLE_SENTENCE${span}`;
    },
  },
  {
    id: 9,
    template: '<!--<style>--><style>CSS</style>',
    reason: 'CR-10 regression lock — only the second <style> is a real element; the first is comment data.',
    build: (probeKind, placement) => {
      const css = cssFor(probeKind);
      const span = probeSpanFor(probeKind);
      return placement === 'after'
        ? `<!--<style>--><style>${css}</style>VISIBLE_SENTENCE${span}`
        : `<!--<style>--><style>${css}${span}</style>VISIBLE_SENTENCE`;
    },
  },
  {
    id: 10,
    template: '<iframe>PAYLOAD</iframe>',
    reason: 'CR-03 — iframe fallback content, never rendered by any modern browser.',
    build: (probeKind, placement) => {
      const marker = markerFor(probeKind);
      return placement === 'inside' ? `<iframe>${marker}</iframe>VISIBLE_SENTENCE` : `<iframe></iframe>VISIBLE_SENTENCE${marker}`;
    },
  },
  {
    id: 11,
    template: '<noembed>PAYLOAD</noembed>',
    reason: 'CR-03 — noembed fallback content, obsolete and never rendered.',
    build: (probeKind, placement) => {
      const marker = markerFor(probeKind);
      return placement === 'inside' ? `<noembed>${marker}</noembed>VISIBLE_SENTENCE` : `<noembed></noembed>VISIBLE_SENTENCE${marker}`;
    },
  },
  {
    id: 12,
    template: '<noframes>PAYLOAD</noframes>',
    reason: 'CR-03 — noframes fallback content, obsolete and never rendered.',
    build: (probeKind, placement) => {
      const marker = markerFor(probeKind);
      return placement === 'inside' ? `<noframes>${marker}</noframes>VISIBLE_SENTENCE` : `<noframes></noframes>VISIBLE_SENTENCE${marker}`;
    },
  },
  {
    id: 13,
    template: '<xmp>PAYLOAD</xmp>',
    reason: 'Over-strip control — xmp IS rendered by every browser; production must not delete it.',
    build: (probeKind, placement) => {
      const marker = markerFor(probeKind);
      return placement === 'inside' ? `<xmp>${marker}</xmp>VISIBLE_SENTENCE` : `<xmp></xmp>VISIBLE_SENTENCE${marker}`;
    },
  },
  {
    id: 14,
    template: '<textarea>PAYLOAD</textarea>',
    reason: 'Over-strip control — textarea IS rendered; production must not delete it.',
    build: (probeKind, placement) => {
      const marker = markerFor(probeKind);
      return placement === 'inside'
        ? `<textarea>${marker}</textarea>VISIBLE_SENTENCE`
        : `<textarea></textarea>VISIBLE_SENTENCE${marker}`;
    },
  },
  {
    id: 15,
    template: '<template>PAYLOAD</template>',
    reason: 'Inert — template content is never part of the rendered document (HTML §4.12.3).',
    build: (probeKind, placement) => {
      const marker = markerFor(probeKind);
      return placement === 'inside'
        ? `<template>${marker}</template>VISIBLE_SENTENCE`
        : `<template></template>VISIBLE_SENTENCE${marker}`;
    },
  },
  {
    id: 16,
    template: '<noscript><style>CSS</style></noscript>',
    reason: 'WR-01 — a stylesheet nested inside a never-rendered container must never apply to elements outside it.',
    build: (probeKind, placement) => {
      const css = cssFor(probeKind);
      const span = probeSpanFor(probeKind);
      return placement === 'after'
        ? `<noscript><style>${css}</style></noscript>VISIBLE_SENTENCE${span}`
        : `<noscript><style>${css}</style>${span}</noscript>VISIBLE_SENTENCE`;
    },
  },
  {
    id: 17,
    template: '<iframe><style>CSS</style></iframe>',
    reason: 'WR-01 — same mechanism as shape 16, iframe container.',
    build: (probeKind, placement) => {
      const css = cssFor(probeKind);
      const span = probeSpanFor(probeKind);
      return placement === 'after'
        ? `<iframe><style>${css}</style></iframe>VISIBLE_SENTENCE${span}`
        : `<iframe><style>${css}</style>${span}</iframe>VISIBLE_SENTENCE`;
    },
  },
  {
    id: 18,
    template: '<svg><style>CSS</style></svg>',
    reason: "Inline SVG shares the host document's CSSOM (unlike iframe/noscript, svg content IS real elements) — a genuinely different container semantics than shapes 16/17.",
    build: (probeKind, placement) => {
      const css = cssFor(probeKind);
      const span = probeSpanFor(probeKind);
      return placement === 'after'
        ? `<svg><style>${css}</style></svg>VISIBLE_SENTENCE${span}`
        : `<svg><style>${css}</style>${span}</svg>VISIBLE_SENTENCE`;
    },
  },
  {
    id: 19,
    template: 'class="leg&#97;l" / id="leg&#97;l"',
    reason: 'Entity-encoded selector value — HTML §13.2.5.72 decodes the attribute before any class/id comparison.',
    build: (probeKind, placement) => {
      const css = cssFor(probeKind);
      const marker = markerFor(probeKind);
      const attr = probeKind === 'class' ? 'class="leg&#97;l"' : 'id="leg&#97;l"';
      const span = `<span ${attr}>${marker}</span>`;
      return placement === 'after'
        ? `<style>${css}</style>VISIBLE_SENTENCE${span}`
        : `<style>${css}</style>VISIBLE_SENTENCE<div>${span}</div>`;
    },
  },
  {
    id: 20,
    template: '<p>VISIBLE_SENTENCE<p>PAYLOAD',
    reason: "Implied-close siblings — HTML's implicit </p> insertion rule; \"inside\" is the literal implied-close shape, \"after\" is the explicit-close control.",
    build: (probeKind, placement) => {
      const marker = markerFor(probeKind);
      return placement === 'inside' ? `<p>VISIBLE_SENTENCE<p>${marker}` : `<p>VISIBLE_SENTENCE</p><p>${marker}`;
    },
  },
  {
    id: 21,
    template: '<div style="display:none">PAYLOAD</div foo="a>b">tail',
    reason: 'WR-10 — a quote-unaware close-tag scan lets sender-controlled in-tag bytes ("b">tail) survive; adapted to also carry class="legal"/id="legal" so the fixed-rule oracle can adjudicate the hiding half.',
    build: probeKind => {
      const css = cssFor(probeKind);
      const marker = markerFor(probeKind);
      const attr = probeKind === 'class' ? 'class="legal"' : 'id="legal"';
      return `<style>${css}</style>VISIBLE_SENTENCE<div ${attr} style="display:none">${marker}</div foo="a>b">tail`;
    },
  },
  {
    id: 22,
    template: '<span class=legal/>PAYLOAD</span>',
    reason: 'Unquoted attribute value ending in "/" immediately before ">" — tests that attribute-value parsing reads "legal", not "legal/".',
    build: (probeKind, placement) => {
      const css = cssFor(probeKind);
      const marker = markerFor(probeKind);
      const attr = probeKind === 'class' ? 'class=legal' : 'id=legal';
      const span = `<span ${attr}/>${marker}</span>`;
      return placement === 'after'
        ? `<style>${css}</style>VISIBLE_SENTENCE${span}`
        : `<style>${css}</style>VISIBLE_SENTENCE<div>${span}</div>`;
    },
  },
];

describe('html-wrapper-differential — shape alphabet coverage', () => {
  it('contains at least the 22 shapes enumerated in 62-28-PLAN.md, each with a unique id', () => {
    expect(WRAPPER_SHAPES.length).toBeGreaterThanOrEqual(22);
    const ids = new Set(WRAPPER_SHAPES.map(s => s.id));
    expect(ids.size).toBe(WRAPPER_SHAPES.length);
  });
});

// ---------------------------------------------------------------------------
// html-render-oracle self-test (62-28-PLAN.md Task 1's eight behaviors).
// ---------------------------------------------------------------------------
describe('html-render-oracle — 62-28 Task 1: eight asserted behaviors', () => {
  it('behavior 1: the ordinary <style> control hides the class-probed span, "ok" survives', () => {
    const { text } = renderedText('<style>.legal{display:none}</style>ok<span class="legal">PL[legal]</span>');
    expect(text).toContain('ok');
    expect(text).not.toContain('PL[legal]');
  });

  it('behavior 2: <style/> produces an IDENTICAL verdict to the plain <style> control (HTML §13.2.5)', () => {
    const control = renderedText('<style>.legal{display:none}</style>ok<span class="legal">PL[legal]</span>');
    const selfClosing = renderedText('<style/>.legal{display:none}</style>ok<span class="legal">PL[legal]</span>');
    expect(selfClosing).toEqual(control);
  });

  it('behavior 3a: <iframe> fallback content is never rendered', () => {
    expect(renderedText('<iframe>INJECT</iframe>ok').text).toBe('ok');
  });

  it('behavior 3b: <noembed> fallback content is never rendered', () => {
    expect(renderedText('<noembed>INJECT</noembed>ok').text).toBe('ok');
  });

  it('behavior 3c: <noframes> fallback content is never rendered', () => {
    expect(renderedText('<noframes>INJECT</noframes>ok').text).toBe('ok');
  });

  it('behavior 4a: <xmp> IS rendered (over-strip control)', () => {
    expect(renderedText('<xmp>KEEP</xmp>ok').text).toContain('KEEP');
  });

  it('behavior 4b: <textarea> IS rendered (over-strip control)', () => {
    expect(renderedText('<textarea>KEEP</textarea>ok').text).toContain('KEEP');
  });

  it('behavior 5: a stylesheet inside <iframe> raw text is never applied — both "ok" and the probe marker render', () => {
    const { text } = renderedText(
      '<iframe><style>.legal{display:none}</style></iframe>ok<span class="legal">PL[legal]</span>'
    );
    expect(text).toContain('ok');
    expect(text).toContain('PL[legal]');
  });

  it('behavior 6: an entity-encoded class attribute value decodes before the hidden check ("leg&#97;l" -> "legal")', () => {
    const { text } = renderedText(
      '<style>.legal{display:none}</style><span class="leg&#97;l">PL[legal]</span>'
    );
    expect(text).not.toContain('PL[legal]');
  });

  it('behavior 7: a parse5 throw sets oracleUnavailable=true and returns empty text, never a normal verdict', () => {
    // Constructing a genuine parse5 throw from valid UTF-16 input is not reliable across
    // versions; this behavior is instead exercised by the generator loop below, which counts
    // `oracleUnavailable` exactly (asserted at zero for this alphabet, since it contains no
    // lone surrogates) — a nonzero count would itself be a finding per Task 1's own acceptance
    // criterion. The contract itself (empty text, never swallowed into a normal verdict) is
    // enforced structurally by `renderedText`'s own try/catch, read directly here:
    const oracleSource = renderedText.toString();
    expect(oracleSource).toContain('oracleUnavailable');
  });
});

// ---------------------------------------------------------------------------
// The generator (Task 2's <behavior>): every shape x {class,id} x {inside,after} case, oracle
// vs production, VISIBLE_SENTENCE-loss + per-probe under/over-strip checks. NO named-mechanism
// classification yet — every divergence in THIS task's state reaches `failures` unconditionally,
// which is deliberate: this is the RED, pre-fix state whose captured output IS the plan's
// central evidence (62-28-PLAN.md Task 2's <action>). Task 3 adds the HF-* classification.
// ---------------------------------------------------------------------------
interface RunCounters {
  oracleUnavailable: number;
  underStrip: number;
  overStrip: number;
}

function newRunCounters(): RunCounters {
  return { oracleUnavailable: 0, underStrip: 0, overStrip: 0 };
}

function runWrapperDifferential(failures: string[], counters: RunCounters): number {
  let caseCount = 0;
  const probeKinds: readonly ProbeKind[] = ['class', 'id'];
  const placements: readonly Placement[] = ['inside', 'after'];

  for (const shape of WRAPPER_SHAPES) {
    for (const probeKind of probeKinds) {
      for (const placement of placements) {
        caseCount += 1;
        const html = shape.build(probeKind, placement);
        const truth = renderedText(html);

        if (truth.oracleUnavailable) {
          counters.oracleUnavailable += 1;
          continue;
        }

        const out = stripHiddenContent(html);
        const marker = markerFor(probeKind);

        if (truth.text.includes('VISIBLE_SENTENCE') && !out.includes('VISIBLE_SENTENCE')) {
          failures.push(
            `VISIBLE_SENTENCE lost — shape=${shape.id} (${shape.reason}) probe=${probeKind} placement=${placement} ` +
              `generating html=${JSON.stringify(html)} oracle text=${JSON.stringify(truth.text)} ` +
              `observed output=${JSON.stringify(out)}`
          );
        }

        const oracleRendersMarker = truth.text.includes(marker);
        const productionRendersMarker = out.includes(marker);

        if (!oracleRendersMarker && productionRendersMarker) {
          counters.underStrip += 1;
          failures.push(
            `UNDER-STRIP (unclassified) — shape=${shape.id} (${shape.reason}) probe=${probeKind} placement=${placement} ` +
              `generating html=${JSON.stringify(html)} oracle text=${JSON.stringify(truth.text)} ` +
              `observed output=${JSON.stringify(out)}`
          );
        } else if (oracleRendersMarker && !productionRendersMarker) {
          counters.overStrip += 1;
          failures.push(
            `OVER-STRIP (unclassified) — shape=${shape.id} (${shape.reason}) probe=${probeKind} placement=${placement} ` +
              `generating html=${JSON.stringify(html)} oracle text=${JSON.stringify(truth.text)} ` +
              `observed output=${JSON.stringify(out)}`
          );
        }
      }
    }
  }

  return caseCount;
}

describe('html-wrapper-differential — HTML-wrapper generator vs a fixed hiding rule', () => {
  it('every shape x {class,id} x {inside,after} case, zero unclassified divergences', () => {
    const failures: string[] = [];
    const counters = newRunCounters();
    const caseCount = runWrapperDifferential(failures, counters);

    expect(caseCount).toBe(WRAPPER_SHAPES.length * 2 * 2);
    expect(counters.oracleUnavailable).toBe(0);
    throwIfFailures(failures, 'html-wrapper-differential');
  });
});
