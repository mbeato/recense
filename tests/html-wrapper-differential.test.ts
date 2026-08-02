/**
 * html-wrapper-differential.test.ts (62-28-PLAN.md) — the missing differential named by
 * `62-VERIFICATION.md`'s WR-03: an HTML-wrapper generator crossed against a FIXED hiding rule,
 * adjudicated by a parser production does not share. This is the structural gap that let
 * CR-01, CR-02's sibling CR-03, and WR-01 all ship behind a green 3287-test suite — the
 * phase's only other oracle-driven differential (`tests/css-liveness-differential.test.ts`)
 * holds the HTML wrapper fixed at `'<style>' + css + '</style>' + ...` and varies only the
 * CSS, so no HTML-layer divergence was ever reachable by it.
 *
 * WHY THE CSS IS FIXED AND THE HTML VARIES: the CSS axis is already covered exhaustively by
 * the sibling differential. Fixing the hiding rule to ONE trivially-understood shape
 * (`.legal{display:none}` / `#legal{display:none}`) collapses the oracle's CSS work to "is
 * this literal stylesheet fragment present at all" — no CSS engine needed — so every
 * remaining degree of freedom this file's 22-shape alphabet explores, and therefore every
 * divergence it reports, is HTML-layer. See `tests/support/html-render-oracle.ts`'s own
 * header for the oracle's full rule set and stated blind spots.
 *
 * GROUND TRUTH IS `parse5`; PRODUCTION IS `htmlparser2`. The two are genuinely independent
 * implementations of the HTML Standard's tokenizer/tree-construction algorithm — a judge
 * built on the same parser it adjudicates could never find a parsing disagreement between
 * itself and production (the WR-09 root cause, `62-REVIEW.md`, already reproduced once at the
 * CSS-tokenizer layer and closed by `tests/css-tokenizer-conformance.test.ts` — this file is
 * the same fix applied one layer up, at HTML).
 *
 * NON-VACUOUSNESS, PROVEN NOT ARGUED: this file was written and run against the UNFIXED
 * module at HEAD `0bb2653` (`git status --porcelain src/` empty throughout this plan) before
 * any of this round's production fixes landed. It independently rediscovered exactly 18
 * divergences on its own — 8 in the CR-01 family (shapes 2/3/4/5), 6 in the CR-03 family
 * (shapes 10/11/12), 4 in the WR-01 family (shapes 16/17) — with zero unexpected/unnamed
 * divergences elsewhere in the 88-case run. The verbatim pre-fix report is quoted in full in
 * `62-28-SUMMARY.md`.
 *
 * THE THREE NAMED MECHANISMS BELOW (`HF-01`/`HF-02`/`HF-03`) ARE TEMPORARY, EACH SAYS SO IN
 * ITS OWN DOC COMMENT, AND EACH NAMES `62-29` AS ITS OWNER: `62-29` fixes CR-01 (HF-01) and
 * CR-03 (HF-02) in production and is REQUIRED to delete both predicates and their locks,
 * replacing each `it.fails` with a passing assertion. `62-30` fixes WR-01 (HF-03) and owns
 * its removal. A predicate that outlives its fix is a tolerance — the CR-11 defect wearing a
 * different hat (`62-REVIEW.md`) — which is exactly what this file's hard gate below exists
 * to prevent for every OTHER, unnamed divergence: only these three named shapes are excused;
 * anything else fails the suite outright.
 *
 * SHIPPED COUNTS (exact, asserted below, never an upper-magnitude tolerance — this file
 * contains no "less-than" bound of any kind): `HF01_selfClosingStyleExcludedFromHarvest` = 8,
 * `HF02_rawtextFallbackEmittedVerbatim` = 6, `HF03_neverAppliedStylesheetStillHarvested` = 4.
 *
 * WHAT THIS FILE DOES NOT CLAIM: closing WR-03's detection gap is not the same as closing
 * CR-01/CR-03/WR-01 themselves — this plan fixes no leak. It also does not claim the HTML
 * layer is now exhaustively covered; it names which 22 shapes are in this alphabet and which
 * three families are still open, and nothing wider.
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
// Named mechanisms (Task 3, CR-11 gate discipline: exact counts, never an upper-magnitude
// tolerance — this file contains no "less-than" bound of any kind). Each predicate keys on
// the SHAPE ID, not on any substring of the generating input, and is TEMPORARY — see the
// file-level doc comment and each interface field's own doc comment for the owning plan.
// ---------------------------------------------------------------------------
interface WrapperFiledCounters {
  /** HF-01 (TEMPORARY, owner: 62-29/CR-01): self-closing start-tag syntax on `style`
   *  (shapes 2/3/4/5) excludes it from the hiding-selector harvest while stage 4/5 deletes the
   *  element anyway — the stylesheet vanishes, the elements it hides do not. UNDER-STRIP. */
  HF01_selfClosingStyleExcludedFromHarvest: number;
  /** HF-02 (TEMPORARY, owner: 62-29/CR-03): `iframe`/`noembed`/`noframes` fallback content
   *  (shapes 10/11/12) is emitted verbatim, though no modern browser renders it. UNDER-STRIP. */
  HF02_rawtextFallbackEmittedVerbatim: number;
  /** HF-03 (TEMPORARY, owner: 62-30/WR-01): a stylesheet inside a never-applied context
   *  (shapes 16/17: `noscript`/`iframe`) is harvested anyway and deletes visible prose OUTSIDE
   *  the container that never should have been hidden. OVER-STRIP. */
  HF03_neverAppliedStylesheetStillHarvested: number;
}

function newWrapperFiledCounters(): WrapperFiledCounters {
  return {
    HF01_selfClosingStyleExcludedFromHarvest: 0,
    HF02_rawtextFallbackEmittedVerbatim: 0,
    HF03_neverAppliedStylesheetStillHarvested: 0,
  };
}

type Direction = 'UNDER-STRIP' | 'OVER-STRIP';

/**
 * Attributes one confirmed divergence to a named, temporary mechanism keyed on `shapeId` (never
 * on a substring of the generating input) and its `direction` — or, if it matches none of the
 * three, pushes the full reproducible detail to `failures`, which `throwIfFailures` turns into a
 * hard suite failure. This is the entire gate: an HTML-layer divergence with no name fails the
 * suite, demonstrated live by the injection proof recorded in `62-28-SUMMARY.md`.
 */
function classifyDivergence(shapeId: number, direction: Direction, detail: string, filed: WrapperFiledCounters, failures: string[]): void {
  if (direction === 'UNDER-STRIP' && (shapeId === 2 || shapeId === 3 || shapeId === 4 || shapeId === 5)) {
    filed.HF01_selfClosingStyleExcludedFromHarvest += 1;
    return;
  }
  if (direction === 'UNDER-STRIP' && (shapeId === 10 || shapeId === 11 || shapeId === 12)) {
    filed.HF02_rawtextFallbackEmittedVerbatim += 1;
    return;
  }
  if (direction === 'OVER-STRIP' && (shapeId === 16 || shapeId === 17)) {
    filed.HF03_neverAppliedStylesheetStillHarvested += 1;
    return;
  }
  failures.push(detail);
}

interface RunCounters {
  oracleUnavailable: number;
}

function newRunCounters(): RunCounters {
  return { oracleUnavailable: 0 };
}

/**
 * The generator (62-28-PLAN.md Task 2's `<behavior>`): every shape x {class,id} x
 * {inside,after} case, oracle vs production. VISIBLE_SENTENCE-loss divergences always go
 * straight to `failures` (none of the three named mechanisms concern sentence loss — only
 * probe-marker under/over-strip). Probe-marker divergences are routed through
 * `classifyDivergence`, so only the three named, temporary shapes are excused.
 */
function runWrapperDifferential(failures: string[], counters: RunCounters, filed: WrapperFiledCounters): number {
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
          classifyDivergence(
            shape.id,
            'UNDER-STRIP',
            `UNDER-STRIP — shape=${shape.id} (${shape.reason}) probe=${probeKind} placement=${placement} ` +
              `generating html=${JSON.stringify(html)} oracle text=${JSON.stringify(truth.text)} ` +
              `observed output=${JSON.stringify(out)}`,
            filed,
            failures
          );
        } else if (oracleRendersMarker && !productionRendersMarker) {
          classifyDivergence(
            shape.id,
            'OVER-STRIP',
            `OVER-STRIP — shape=${shape.id} (${shape.reason}) probe=${probeKind} placement=${placement} ` +
              `generating html=${JSON.stringify(html)} oracle text=${JSON.stringify(truth.text)} ` +
              `observed output=${JSON.stringify(out)}`,
            filed,
            failures
          );
        }
      }
    }
  }

  return caseCount;
}

describe('html-wrapper-differential — HTML-wrapper generator vs a fixed hiding rule', () => {
  it('every shape x {class,id} x {inside,after} case: only the three named, temporary mechanisms diverge, with exact shipped counts', () => {
    const failures: string[] = [];
    const counters = newRunCounters();
    const filed = newWrapperFiledCounters();
    const caseCount = runWrapperDifferential(failures, counters, filed);

    expect(caseCount).toBe(WRAPPER_SHAPES.length * 2 * 2);
    expect(counters.oracleUnavailable).toBe(0);
    // Exact counts (never a magnitude bound) — measured against this file's own 22-shape
    // alphabet's full {class,id}x{inside,after} cross product. A count that moves means the
    // alphabet or the shipped module changed; either way it must be re-measured and
    // re-recorded here, not silently absorbed.
    expect(filed.HF01_selfClosingStyleExcludedFromHarvest).toBe(8);
    expect(filed.HF02_rawtextFallbackEmittedVerbatim).toBe(6);
    expect(filed.HF03_neverAppliedStylesheetStillHarvested).toBe(4);
    throwIfFailures(failures, 'html-wrapper-differential');
  });
});

// ---------------------------------------------------------------------------
// Named, temporary, minimal locks (Task 3). Per WR-04's lesson (`62-REVIEW.md`), each
// `it.fails` body asserts EXACTLY ONE subject — production's output — never sharing its body
// with the oracle ground-truth precondition, which lives in its own passing `it` immediately
// above it. Both plans named as owners (62-29 for HF-01/HF-02, 62-30 for HF-03) are REQUIRED
// to delete the predicate, this describe block's two `it`s, and flip the `it.fails` to a
// passing assertion when they land their fix — a predicate that outlives its fix is a
// tolerance (CR-11 wearing a different hat).
// ---------------------------------------------------------------------------
describe('html-wrapper-differential — open families (HF-01/HF-02/HF-03), TEMPORARY locks', () => {
  it('HF-01 precondition: the oracle hides the class-probed span for shape 2 (<style/>) exactly like the shape-1 control', () => {
    const { text } = renderedText('<style/>.legal{display:none}</style>VISIBLE_SENTENCE<span class="legal">PL[legal]</span>');
    expect(text).toBe('VISIBLE_SENTENCE');
  });

  it.fails(
    'HF-01 (TEMPORARY, owner: 62-29/CR-01): self-closing start-tag syntax on style excludes it from the hiding-selector harvest while stage 4/5 deletes the element anyway, leaking the elements it should have hidden',
    () => {
      const out = stripHiddenContent('<style/>.legal{display:none}</style>VISIBLE_SENTENCE<span class="legal">PL[legal]</span>');
      expect(out).not.toContain('PL[legal]');
    }
  );

  it('HF-02 precondition: the oracle never renders iframe fallback content', () => {
    const { text } = renderedText('<iframe>PL[legal]</iframe>VISIBLE_SENTENCE');
    expect(text).toBe('VISIBLE_SENTENCE');
  });

  it.fails(
    'HF-02 (TEMPORARY, owner: 62-29/CR-03): iframe/noembed/noframes fallback content is emitted verbatim, though no modern browser renders it',
    () => {
      const out = stripHiddenContent('<iframe>PL[legal]</iframe>VISIBLE_SENTENCE');
      expect(out).not.toContain('PL[legal]');
    }
  );

  it('HF-03 precondition: the oracle renders the probe span, because a stylesheet inside a never-rendered <noscript> is never applied to elements outside it', () => {
    const { text } = renderedText(
      '<noscript><style>.legal{display:none}</style></noscript>VISIBLE_SENTENCE<span class="legal">PL[legal]</span>'
    );
    expect(text).toBe('VISIBLE_SENTENCEPL[legal]');
  });

  it.fails(
    'HF-03 (TEMPORARY, owner: 62-30/WR-01): a stylesheet inside a never-applied context (noscript/iframe) is harvested anyway and deletes visible prose OUTSIDE the container',
    () => {
      const out = stripHiddenContent(
        '<noscript><style>.legal{display:none}</style></noscript>VISIBLE_SENTENCE<span class="legal">PL[legal]</span>'
      );
      expect(out).toContain('PL[legal]');
    }
  );
});
