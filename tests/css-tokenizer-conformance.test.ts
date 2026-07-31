/**
 * §4.3 conformance gate for `css-tree@3.2.1`'s tokenizer (62-16-PLAN.md, Task 2).
 *
 * Every row in the first `describe` block below is transcribed from CSS Syntax Level 3
 * §4.3 itself — deliberately NOT from this phase's repro history (VF-01/CR-04/etc). That
 * inversion is the point: WR-09 (`62-REVIEW.md`) named "every shipped oracle was drawn
 * from the same enumeration it existed to validate" as the root cause behind three waves
 * of missed defects. If a future `css-tree` upgrade ever disagrees with a row here, THE
 * CORRECT RESPONSE IS TO ESCALATE THE DEPENDENCY, NOT TO RELAX THE ROW — this table is the
 * spec, not a snapshot of observed behavior. Do not edit these rows to match implementation
 * behavior.
 *
 * The second `describe` block pins css-tree's OBSERVED (not spec-mandated) offset-overrun
 * and BOM-skip behavior — "characterized deviations," not §4.3 claims — so a future
 * upgrade that silently changes either one fails loudly here instead of quietly breaking
 * 62-17's offset arithmetic.
 */
import { describe, it, expect } from 'vitest';
import { tokenize, tokenTypes } from 'css-tree/tokenizer';

// Module-scope reverse map: numeric token type -> name. Every assertion below references
// token types by NAME (via `tokenTypes`), never by numeric literal.
const TYPE_NAMES: Record<number, string> = {};
for (const [name, value] of Object.entries(tokenTypes)) {
  TYPE_NAMES[value] = name;
}

/** Tokenizes `source` into readable `[typeName, sourceSlice]` pairs for diff-friendly assertions. */
function tokenizeToPairs(source: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  tokenize(source, (type, start, end) => {
    pairs.push([TYPE_NAMES[type] ?? `UNKNOWN(${type})`, source.slice(start, end)]);
  });
  return pairs;
}

/** Seeded LCG (Numerical Recipes constants) — NOT Math.random — matching the deterministic
 * generator convention already shipped in `tests/strip-hidden.test.ts`. */
function makeLcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe('css-tree@3.2.1 tokenizer conformance — CSS Syntax Level 3 §4.3', () => {
  it('§4.3.2: a comment between two idents emits exactly one Comment spanning both delimiters', () => {
    expect(tokenizeToPairs('a/*x*/b')).toEqual([
      ['Ident', 'a'],
      ['Comment', '/*x*/'],
      ['Ident', 'b'],
    ]);
  });

  it('§4.3.2: an unterminated /* emits one Comment running to EOF', () => {
    expect(tokenizeToPairs('a/*x')).toEqual([
      ['Ident', 'a'],
      ['Comment', '/*x'],
    ]);
  });

  it('§4.3.5: a double-quoted string containing a raw newline emits BadString ending immediately past the newline, and the next token begins at that same offset', () => {
    const src = '.a{content:"x\n.legal{display:none}';
    const pairs: Array<[string, string, number, number]> = [];
    tokenize(src, (type, start, end) => {
      pairs.push([TYPE_NAMES[type]!, src.slice(start, end), start, end]);
    });
    const badStringIdx = pairs.findIndex(([name]) => name === 'BadString');
    expect(badStringIdx).toBeGreaterThanOrEqual(0);
    const badString = pairs[badStringIdx]!;
    expect(badString[1]).toBe('"x\n');
    const badStringEnd = badString[3];
    // The BAD-STRING token must end exactly at the index past the newline.
    expect(src.slice(0, badStringEnd).endsWith('\n')).toBe(true);
    const after = pairs.slice(badStringIdx + 1).map(([name, slice]) => [name, slice]);
    expect(after).toEqual([
      ['Delim', '.'],
      ['Ident', 'legal'],
      ['LeftCurlyBracket', '{'],
      ['Ident', 'display'],
      ['Colon', ':'],
      ['Ident', 'none'],
      ['RightCurlyBracket', '}'],
    ]);
    // The token immediately after BadString must begin at the same offset BadString ended.
    expect(pairs[badStringIdx + 1]![2]).toBe(badStringEnd);
  });

  it('§4.3.5: a backslash immediately before a newline inside a string is a valid escape — one String token', () => {
    expect(tokenizeToPairs('"a\\\nb"')).toEqual([['String', '"a\\\nb"']]);
  });

  it.each(['url', 'URL', 'Url'])(
    '§4.3.6: ident-sequence "%s" followed by ( emits one Url token, and /*…*/ inside it is NOT a Comment',
    name => {
      const pairs = tokenizeToPairs(`${name}(/*x*/y)`);
      expect(pairs).toEqual([['Url', `${name}(/*x*/y)`]]);
    }
  );

  it('§4.3.6: url( + whitespace + non-quote emits one Url token', () => {
    expect(tokenizeToPairs('url(  x)')).toEqual([['Url', 'url(  x)']]);
  });

  it('§4.3.6: url( + optional whitespace + quote emits Function + String + RightParenthesis, NOT a Url', () => {
    expect(tokenizeToPairs('url("x")')).toEqual([
      ['Function', 'url('],
      ['String', '"x"'],
      ['RightParenthesis', ')'],
    ]);
    expect(tokenizeToPairs('url(  "x")')).toEqual([
      ['Function', 'url('],
      ['WhiteSpace', '  '],
      ['String', '"x"'],
      ['RightParenthesis', ')'],
    ]);
  });

  it("§4.3.6: ident-sequence 'xurl' followed by ( emits Function, and a /*z*/ inside it emits Comment (CR-04's exact discriminator)", () => {
    expect(tokenizeToPairs('xurl(a/*z*/b)')).toEqual([
      ['Function', 'xurl('],
      ['Ident', 'a'],
      ['Comment', '/*z*/'],
      ['Ident', 'b'],
      ['RightParenthesis', ')'],
    ]);
  });

  it('§4.3.14: an unterminated url( emits one Url token to EOF', () => {
    const src = 'url(zzz}.legal{display:none}';
    expect(tokenizeToPairs(src)).toEqual([['Url', src]]);
  });

  it('§4.3.7: \\/ inside an ident keeps the / in the Ident, so no Comment for the next *', () => {
    expect(tokenizeToPairs('.a\\/*b{q:1}')).toEqual([
      ['Delim', '.'],
      ['Ident', 'a\\/'],
      ['Delim', '*'],
      ['Ident', 'b'],
      ['LeftCurlyBracket', '{'],
      ['Ident', 'q'],
      ['Colon', ':'],
      ['Number', '1'],
      ['RightCurlyBracket', '}'],
    ]);
  });

  it('§4.3.7: \\ + newline outside a string emits Delim(\\), and a following /*c*/ IS a Comment', () => {
    expect(tokenizeToPairs('\\\n/*c*/')).toEqual([
      ['Delim', '\\'],
      ['WhiteSpace', '\n'],
      ['Comment', '/*c*/'],
    ]);
  });

  it('§4.3.3/§4.3.4: #legal emits Hash; @media emits AtKeyword', () => {
    expect(tokenizeToPairs('#legal')).toEqual([['Hash', '#legal']]);
    expect(tokenizeToPairs('@media')).toEqual([['AtKeyword', '@media']]);
  });
});

describe('css-tree@3.2.1 tokenizer — characterized deviations (NOT §4.3 claims; pin observed behavior so a future upgrade fails loudly instead of silently breaking offset arithmetic)', () => {
  it('a leading U+FEFF BOM is skipped: the first token starts at offset 1, not 0', () => {
    const src = '﻿a';
    let firstStart: number | undefined;
    tokenize(src, (_type, start) => {
      if (firstStart === undefined) firstStart = start;
    });
    expect(firstStart).toBe(1);
  });

  // Hostile-input generator shared by both fuzz locks below. Alphabet deliberately includes
  // lone surrogates (U+D800, U+DFFF), NUL, backslash runs, url( runs, and deep {/( nesting.
  const HOSTILE_ALPHABET = [
    '<', '>', '/', '"', "'", '{', '}', '(', ')', '\\',
    '\\\\\\\\\\\\\\\\',
    '/*', '*/', 'url(', 'URL(', 'Url(', 'xurl(',
    '\0', String.fromCharCode(0xd800), String.fromCharCode(0xdfff),
    '{{{{{{{{', '((((((((',
    ' ', '\n', '\t', 'a', 'b', 'c', '-', '_', ':', ';', ',', '.', '#', '@', '0', '1',
  ];

  function generateHostile(rand: () => number): string {
    const pieceCount = 5 + Math.floor(rand() * 20);
    let s = '';
    for (let p = 0; p < pieceCount; p++) {
      s += HOSTILE_ALPHABET[Math.floor(rand() * HOSTILE_ALPHABET.length)];
    }
    return s;
  }

  it('end offsets never exceed source.length by more than 1, over >= 50000 seeded hostile inputs', () => {
    const rand = makeLcg(0xdead10cc);
    const N = 50000;
    let maxOverrun = -Infinity;
    for (let i = 0; i < N; i++) {
      const src = generateHostile(rand);
      tokenize(src, (_type, _start, end) => {
        const overrun = end - src.length;
        if (overrun > maxOverrun) maxOverrun = overrun;
      });
    }
    expect(maxOverrun).toBeLessThanOrEqual(1);
  });

  it('tokenize never throws, over >= 20000 seeded hostile inputs', () => {
    const rand = makeLcg(0xc0ffee00);
    const N = 20000;
    const throwFailures: number[] = [];
    for (let i = 0; i < N; i++) {
      const src = generateHostile(rand);
      try {
        tokenize(src, () => {});
      } catch {
        throwFailures.push(i);
      }
    }
    expect(throwFailures).toEqual([]);
  });
});
