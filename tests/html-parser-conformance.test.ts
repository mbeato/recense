/**
 * HTML Standard §13.2.5 conformance gate for `htmlparser2@10.0.0` (62-21-PLAN.md, Task 3).
 *
 * Every row in Block 1 below is transcribed from the HTML Standard itself (WHATWG §13.2.5) —
 * deliberately NOT from `62-REVIEW.md`'s repro history. Two findings from that review,
 * CR-07 (HTML character references in `class`/`id`/`style` attribute values are never
 * decoded by the current hand-rolled scanner) and CR-10 (a `<style>` inside an HTML comment
 * hijacks stage 2's harvest), happen to fall out of rows §13.2.5.72 and the CR-10 row below —
 * but the gate is wider than those two repros and was built independently of them, mirroring
 * `tests/css-tokenizer-conformance.test.ts`'s own inversion (WR-09, `62-REVIEW.md`: "every
 * shipped oracle was drawn from the same enumeration it existed to validate" was named as
 * the root cause behind three waves of missed defects there). If a future `htmlparser2`
 * upgrade ever disagrees with a row marked as spec-conformant below, THE CORRECT RESPONSE IS
 * TO ESCALATE THE DEPENDENCY, NOT TO RELAX THE ROW — this table is the spec, not a snapshot
 * of observed behavior. Do not edit those rows to match new implementation behavior.
 *
 * TWO ROWS ARE DELIBERATELY NOT WRITTEN AS SPEC-CONFORMANT, because htmlparser2 measurably
 * is not conformant there (62-21 Task 2's C2 evaluation, decision table in
 * `62-21-SUMMARY.md`) — writing them as passing spec assertions would be exactly the
 * "relax the row to match implementation" failure mode this file exists to prevent in the
 * other direction. Both are named explicitly as MEASURED DEVIATIONS, cross-checked against
 * `parse5@7.3.0` (which conforms on both, confirming these are real htmlparser2 gaps, not a
 * quirk of HTML itself) even though parse5 was disqualified on other grounds (C3 totality —
 * see the Task 2 decision table):
 *   1. `</style foo>` (a RAWTEXT close tag carrying trailing garbage before its own `>`):
 *      htmlparser2 correctly isolates the ELEMENT'S CONTENT (`.legal{display:none}` is never
 *      contaminated), but the `closetag`/following-`text` event's OWN offset metadata is
 *      truncated at the first whitespace after the tag name — it does not extend through the
 *      real closing `>`. A consumer needing the true element-end offset (stage 4's deletion
 *      range) must forward-scan from the truncated offset to the next literal `>` — see the
 *      pinned numbers in Block 2 and the residual noted in `62-21-SUMMARY.md` for 62-22.
 *   2. `</style/>` (a RAWTEXT close tag using self-closing-tag syntax): htmlparser2 does not
 *      recognize this as a close tag AT ALL — the element never closes, and everything
 *      through EOF (including any legitimate trailing content) is swallowed as RAWTEXT. This
 *      is a genuine htmlparser2 defect, not spec-permitted implementation slack: per
 *      §13.2.5.12 (RAWTEXT end tag name state), an "appropriate end tag token" (name matches
 *      the open element) transitions to the self-closing-start-tag state on `/`, which emits
 *      the tag on `>` regardless of the (semantically ignored, for a non-void element) flag —
 *      parse5 implements exactly this and closes the element correctly. Named as the
 *      D-62-21-01 residual for 62-22: this input shape must stay served by a narrow,
 *      hand-rolled fallback rather than htmlparser2's own close-tag recognition.
 *
 * Block 2 pins htmlparser2's OBSERVED (not spec-mandated) offset semantics — "characterized
 * deviations," not §13.2.5 claims — so a future upgrade that silently changes any of them
 * (including a welcome fix to either deviation above) fails loudly here instead of quietly
 * breaking 62-22's offset arithmetic.
 *
 * Every assertion below references `htmlparser2` directly. This file must never import the
 * markup stripper module (`src/source/`), which does not consume this parser yet at this
 * point in the wave order (62-22/62-24 are the integration plans).
 */
import { describe, it, expect } from 'vitest';
import { Parser } from 'htmlparser2';

/** One parsed event, with the Parser's own `startIndex`/`endIndex` snapshotted at emit time. */
interface ParseEvent {
  type: 'opentagname' | 'attribute' | 'opentag' | 'closetag' | 'text' | 'comment' | 'pi';
  name?: string;
  value?: string;
  data?: string;
  attribs?: Record<string, string>;
  isImplied?: boolean;
  start: number;
  end: number;
}

/** Runs `html` through a fresh `Parser`, recording every callback with its offset snapshot. */
function traceEvents(html: string): ParseEvent[] {
  const events: ParseEvent[] = [];
  let parser: Parser;
  const handler = {
    onopentagname(name: string) {
      events.push({ type: 'opentagname', name, start: parser.startIndex, end: parser.endIndex });
    },
    onattribute(name: string, value: string) {
      events.push({ type: 'attribute', name, value, start: parser.startIndex, end: parser.endIndex });
    },
    onopentag(name: string, attribs: Record<string, string>) {
      events.push({ type: 'opentag', name, attribs, start: parser.startIndex, end: parser.endIndex });
    },
    onclosetag(name: string, isImplied: boolean) {
      events.push({ type: 'closetag', name, isImplied, start: parser.startIndex, end: parser.endIndex });
    },
    ontext(text: string) {
      events.push({ type: 'text', value: text, start: parser.startIndex, end: parser.endIndex });
    },
    oncomment() {
      events.push({ type: 'comment', start: parser.startIndex, end: parser.endIndex });
    },
    onprocessinginstruction(name: string, data: string) {
      events.push({ type: 'pi', name, data, start: parser.startIndex, end: parser.endIndex });
    },
  };
  parser = new Parser(handler, { decodeEntities: true });
  parser.write(html);
  parser.end();
  return events;
}

/** Parses a single-tag fixture and returns one attribute's DECODED value. */
function attrValue(html: string, tagName: string, attrName: string): string | undefined {
  let found: string | undefined;
  const handler = {
    onopentag(name: string, attribs: Record<string, string>) {
      if (name === tagName) found = attribs[attrName];
    },
  };
  const parser = new Parser(handler, { decodeEntities: true });
  parser.write(html);
  parser.end();
  return found;
}

/** [start, end] INCLUSIVE slice — htmlparser2's own offset convention (Block 2, row 1). */
function sliceInclusive(html: string, start: number, end: number): string {
  return html.slice(start, end + 1);
}

describe('htmlparser2@10.0.0 conformance — HTML Standard §13.2.5', () => {
  describe('§13.2.5.72 character reference state, ATTRIBUTE context (CR-07)', () => {
    it('a decimal numeric reference decodes: class="leg&#97;l" -> "legal"', () => {
      expect(attrValue('<div class="leg&#97;l">', 'div', 'class')).toBe('legal');
    });

    it('a decimal numeric reference decodes: style="display&#58;none" -> "display:none"', () => {
      expect(attrValue('<div style="display&#58;none">', 'div', 'style')).toBe('display:none');
    });

    it('a NAMED reference decodes: style="display&colon;none" -> "display:none"', () => {
      expect(attrValue('<div style="display&colon;none">', 'div', 'style')).toBe('display:none');
    });
  });

  describe('§13.2.5.72 attribute-specific rule: a named reference not followed by ";" and followed by "=" or an alphanumeric is NOT decoded inside an attribute value', () => {
    it('NOT decoded: &ampy (no ";", followed by alphanumeric "y") stays literal', () => {
      expect(attrValue('<div data-a="x&ampy">', 'div', 'data-a')).toBe('x&ampy');
    });

    it('NOT decoded: &amp=y (no ";", followed by "=") stays literal', () => {
      expect(attrValue('<div data-a="x&amp=y">', 'div', 'data-a')).toBe('x&amp=y');
    });

    it('DECODED: &amp;y (with ";") decodes despite being followed by alphanumeric', () => {
      expect(attrValue('<div data-a="x&amp;y">', 'div', 'data-a')).toBe('x&y');
    });

    it('DECODED: &amp!y (no ";", but followed by "!" — neither "=" nor alphanumeric) still decodes', () => {
      expect(attrValue('<div data-a="x&amp!y">', 'div', 'data-a')).toBe('x&!y');
    });
  });

  describe('§13.2.5.41-45 comment states', () => {
    it('<!--x--> is a comment spanning exactly its delimiters', () => {
      const html = 'a<!--x-->b';
      const events = traceEvents(html);
      const comment = events.find(e => e.type === 'comment')!;
      expect(sliceInclusive(html, comment.start, comment.end)).toBe('<!--x-->');
    });

    it('<!--> (abrupt-closing empty comment) is a comment', () => {
      const html = 'a<!-->b';
      const events = traceEvents(html);
      const comment = events.find(e => e.type === 'comment')!;
      expect(sliceInclusive(html, comment.start, comment.end)).toBe('<!-->');
    });

    it('<!---> (abrupt-closing near-empty comment) is a comment', () => {
      const html = 'a<!--->b';
      const events = traceEvents(html);
      const comment = events.find(e => e.type === 'comment')!;
      expect(sliceInclusive(html, comment.start, comment.end)).toBe('<!--->');
    });

    it('<!x> is a BOGUS comment, not an element — routed through onprocessinginstruction (not oncomment), spanning exactly its delimiters', () => {
      const html = 'a<!x>b';
      const events = traceEvents(html);
      expect(events.find(e => e.type === 'comment')).toBeUndefined();
      const pi = events.find(e => e.type === 'pi')!;
      expect(pi).toBeDefined();
      expect(sliceInclusive(html, pi.start, pi.end)).toBe('<!x>');
    });

    it('an unterminated <!--x (no closing -->) is a comment running to EOF', () => {
      const html = 'a<!--x';
      const events = traceEvents(html);
      const comment = events.find(e => e.type === 'comment')!;
      // Overrun-by-1 past html.length — pinned precisely in Block 2, row 2.
      expect(html.slice(comment.start, Math.min(comment.end + 1, html.length))).toBe('<!--x');
    });
  });

  describe('§13.2.5.1-20 RAWTEXT: nothing inside <style> is a tag except its own end tag', () => {
    it('a "<span>"-shaped sequence inside <style> content is never tokenized as a tag', () => {
      const html = '<style>.a{color:red}<span>not-a-tag</style>after';
      const events = traceEvents(html);
      expect(events.find(e => e.type === 'opentagname' && e.name === 'span')).toBeUndefined();
      const text = events.find(e => e.type === 'text' && e.value?.includes('.a{color:red}'))!;
      expect(text.value).toBe('.a{color:red}<span>not-a-tag');
    });

    it('an unterminated <style> (no close tag at all) runs to EOF; content is captured in full with no overrun', () => {
      const html = '<style>.legal{display:none}';
      const events = traceEvents(html);
      const text = events.find(e => e.type === 'text')!;
      expect(text.value).toBe('.legal{display:none}');
      expect(html.slice(text.start, text.end + 1)).toBe('.legal{display:none}');
      const closetag = events.find(e => e.type === 'closetag')!;
      expect(closetag.isImplied).toBe(true);
    });

    it('</style foo> (trailing garbage before the close ">") does not corrupt captured content, but its own offsets are truncated before the real ">" (MEASURED — see Block 2 for the pinned numbers and 62-22\'s required forward-scan correction)', () => {
      const html = '<style>.legal{display:none}</style foo>after';
      const events = traceEvents(html);
      const text = events.find(e => e.type === 'text')!;
      expect(text.value).toBe('.legal{display:none}');
      const closetag = events.find(e => e.type === 'closetag')!;
      expect(closetag.isImplied).toBe(false);
      // The trailing "after" text value is still correctly isolated (no "foo>" contamination
      // of its VALUE) even though its reported START offset is not the true post-">" index.
      const trailingText = events.filter(e => e.type === 'text')[1]!;
      expect(trailingText.value).toBe('after');
    });

    it('</style/> (self-closing-tag syntax on the end tag) does NOT close the element — MEASURED DEVIATION, not spec-conformant (parse5 closes this correctly; see file header and 62-21-SUMMARY.md D-62-21-01)', () => {
      const html = '<style>.legal{display:none}</style/>after';
      const events = traceEvents(html);
      // Per spec this should close at the "/" + ">" (matching parse5's own measured
      // behavior) with "after" recovered as separate trailing text. htmlparser2 instead
      // swallows everything to EOF as RAWTEXT content — asserted here as the ACTUAL,
      // deviant behavior, not the spec-correct one.
      const text = events.find(e => e.type === 'text')!;
      expect(text.value).toBe('.legal{display:none}</style/>after');
      const closetag = events.find(e => e.type === 'closetag')!;
      expect(closetag.isImplied).toBe(true); // synthetic EOF-implied close, not a real match
    });
  });

  describe('CR-10: a <style> opening tag inside an HTML comment is comment DATA, not a live element', () => {
    it('the only <style> ELEMENT in "<!-- <style> --><style>.legal{display:none}</style>" is the second one, with content exactly ".legal{display:none}"', () => {
      const html = '<!-- <style> --><style>.legal{display:none}</style>';
      const events = traceEvents(html);
      const comment = events.find(e => e.type === 'comment')!;
      expect(sliceInclusive(html, comment.start, comment.end)).toBe('<!-- <style> -->');

      const opentagnames = events.filter(e => e.type === 'opentagname' && e.name === 'style');
      expect(opentagnames).toHaveLength(1);

      const text = events.find(e => e.type === 'text')!;
      expect(text.value).toBe('.legal{display:none}');
    });
  });
});

describe('htmlparser2@10.0.0 — characterized deviations (NOT §13.2.5 claims; pin OBSERVED offset behavior so a future upgrade fails loudly instead of silently shifting 62-22\'s deletion ranges)', () => {
  it('offsets are [start, end] INCLUSIVE (not [start, end) exclusive like css-tree/parse5) — a 8-char comment "<!--x-->" reports start=0, end=7', () => {
    const html = '<!--x-->';
    const events = traceEvents(html);
    const comment = events.find(e => e.type === 'comment')!;
    expect(comment.start).toBe(0);
    expect(comment.end).toBe(7);
    expect(html.length).toBe(8);
  });

  it('an unterminated comment\'s end offset overruns html.length by exactly 1: "a<!--x" (length 6) reports end=6', () => {
    const html = 'a<!--x';
    const events = traceEvents(html);
    const comment = events.find(e => e.type === 'comment')!;
    expect(comment.start).toBe(1);
    expect(comment.end).toBe(6);
    expect(html.length).toBe(6);
    expect(comment.end - (html.length - 1)).toBe(1);
  });

  it('an implied (EOF-synthesized) end tag reports start=end=html.length, one past the last valid index', () => {
    const html = '<style>.legal{display:none}';
    const events = traceEvents(html);
    const closetag = events.find(e => e.type === 'closetag')!;
    expect(closetag.isImplied).toBe(true);
    expect(closetag.start).toBe(html.length);
    expect(closetag.end).toBe(html.length);
  });

  it('self-closing start-tag syntax "<style/>" is a spec-correct no-op (style is not a void element): the element opens normally and swallows trailing content as RAWTEXT until a real close tag or EOF, exactly like a bare "<style>"', () => {
    const html = '<style/>after';
    const events = traceEvents(html);
    const opentag = events.find(e => e.type === 'opentag')!;
    expect(sliceInclusive(html, opentag.start, opentag.end)).toBe('<style/>');
    const text = events.find(e => e.type === 'text')!;
    expect(text.value).toBe('after');
    const closetag = events.find(e => e.type === 'closetag')!;
    expect(closetag.isImplied).toBe(true);
  });

  it('RAWTEXT close-tag-with-trailing-garbage: "</style foo>" pins the exact truncated closetag/text offsets 62-22 must forward-scan past to reach the real ">"', () => {
    const html = '<style>.legal{display:none}</style foo>after';
    const events = traceEvents(html);
    const closetag = events.find(e => e.type === 'closetag')!;
    // Truncated at the first whitespace after the tag name (index 34 = the space in
    // "</style foo>"), NOT at the real closing ">" (index 38).
    expect(closetag.start).toBe(27);
    expect(closetag.end).toBe(34);
    expect(html.slice(closetag.start, closetag.end + 1)).toBe('</style ');
    expect(html.indexOf('>', closetag.end)).toBe(38); // the true element-end a forward scan must find
    const trailingText = events.filter(e => e.type === 'text')[1]!;
    // The reported START offset for the following text is likewise stale — it does not
    // point past the real ">" (index 38), even though the text VALUE itself is correct.
    expect(trailingText.start).toBe(35);
    expect(trailingText.value).toBe('after');
  });

  it('RAWTEXT self-closing-end-tag non-closure: "</style/>" pins the exact (deviant) offsets — the whole remainder of the document, including "after", is reported as style content', () => {
    const html = '<style>.legal{display:none}</style/>after';
    const events = traceEvents(html);
    const text = events.find(e => e.type === 'text')!;
    expect(text.start).toBe(7);
    expect(text.end).toBe(html.length - 1);
    const closetag = events.find(e => e.type === 'closetag')!;
    expect(closetag.isImplied).toBe(true);
    expect(closetag.start).toBe(html.length);
  });
});

describe('htmlparser2@10.0.0 — totality (Block 3): must never throw and must always terminate', () => {
  /** Seeded LCG (Numerical Recipes constants) — NOT Math.random — matching the deterministic
   * generator convention already shipped in `tests/css-tokenizer-conformance.test.ts`. */
  function makeLcg(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }

  // Hostile-input generator, HTML-specific alphabet: tag delimiters, quotes, comment/RAWTEXT
  // markers, entity fragments (well-formed and malformed), lone surrogates, and NUL —
  // mirroring the shape of the css-tokenizer-conformance hostile alphabet.
  const HOSTILE_ALPHABET = [
    '<', '>', '/', '"', "'", '=', '!', '-', '?',
    '<!--', '-->', '<!', '<style', '</style', '<span', '</span', '<div', '</div',
    '\0', String.fromCharCode(0xd800), String.fromCharCode(0xdfff),
    '&', '&amp', '&amp;', '&#97;', '&#x61;', '&colon;', '&notit',
    ' ', '\n', '\t', 'a', 'b', 'c', ':', ';', '{', '}', 'display', 'none',
  ];

  function generateHostile(rand: () => number): string {
    const pieceCount = 5 + Math.floor(rand() * 20);
    let s = '';
    for (let p = 0; p < pieceCount; p++) {
      s += HOSTILE_ALPHABET[Math.floor(rand() * HOSTILE_ALPHABET.length)];
    }
    return s;
  }

  it('parsing never throws, over >= 20000 seeded hostile inputs', () => {
    const rand = makeLcg(0xdead10cc);
    const N = 20000;
    const throwFailures: number[] = [];
    for (let i = 0; i < N; i++) {
      const src = generateHostile(rand);
      try {
        const parser = new Parser({}, { decodeEntities: true });
        parser.write(src);
        parser.end();
      } catch {
        throwFailures.push(i);
      }
    }
    expect(throwFailures).toEqual([]);
  });

  it('parsing always terminates (bounded wall-clock per input, no pathological hang), over the same >= 20000 seeded hostile inputs', () => {
    const rand = makeLcg(0xc0ffee00);
    const N = 20000;
    const start = performance.now();
    for (let i = 0; i < N; i++) {
      const src = generateHostile(rand);
      const parser = new Parser({}, { decodeEntities: true });
      parser.write(src);
      parser.end();
    }
    const elapsed = performance.now() - start;
    // Each input is small (a few hundred bytes at most); 20000 of them completing well
    // under a second rules out per-input pathological blowup, not just a global timeout race.
    expect(elapsed).toBeLessThan(5000);
  });
});
