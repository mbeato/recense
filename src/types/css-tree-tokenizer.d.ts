/**
 * Local ambient declaration for the `css-tree/tokenizer` subpath (62-16-PLAN.md, Task 2).
 *
 * css-tree ships no types of its own, and `@types/css-tree@2.3.11` does NOT declare this
 * subpath — verified during planning: with `@types/css-tree` installed, `tsc` still fails
 * TS7016 on `import { tokenize, tokenTypes } from 'css-tree/tokenizer'`. `@types/css-tree`
 * is therefore deliberately NOT a dependency of this project.
 *
 * This declaration exposes ONLY the two exports `src/` is permitted to use — `tokenize`
 * and `tokenTypes` — deliberately, not the full css-tree API surface. Declaring only the
 * adopted surface means an accidental future import of the bare `css-tree` package (its
 * parser, lexer, walker or generator) from a file under `src/` fails to compile, since no
 * ambient declaration exists for that import path from `src/`'s perspective. The css-tree
 * parser IS used, intentionally, by a test-only liveness oracle under `tests/support/` —
 * that file imports the bare package directly and is typed by css-tree's own untyped
 * (implicit `any`) module resolution, which is acceptable in `tests/` but not in `src/`.
 *
 * Lives under `src/` (not `tests/` or a root `types/` dir) because root `tsconfig.json`'s
 * `include` is `["src", "scripts"]` — `src/` is the one root whose compile-time surface
 * this declaration exists to constrain.
 *
 * ENFORCEMENT (as of 62-23-PLAN.md; was documented-but-unenforced prose from 62-17 until
 * then, per WR-10 in `62-REVIEW.md`): the program-global `declare module 'css-tree'` in
 * `tests/support/css-tree-ambient.d.ts` that the oracle relies on is visible ONLY to the
 * separate `tests/tsconfig.json` project — root `tsconfig.json`'s `include` no longer
 * covers `tests/`, so that ambient declaration is out of scope for anything type-checked
 * as part of `src/`. A file under `src/` importing the bare `css-tree` package therefore
 * fails `tsc --noEmit -p tsconfig.json` with TS7016, exactly as this paragraph claims. This
 * is proven by construction (a probe file that fails to compile, then compiles once
 * removed — recorded verbatim in `62-23-SUMMARY.md`) and locked by a shipped, non-vacuous
 * regression test at `tests/src-import-boundary.test.ts`.
 */
declare module 'css-tree/tokenizer' {
  /**
   * Tokenizes `source`, invoking `onToken` once per token with the token's numeric type
   * (compare against `tokenTypes` by name, never by literal) and its `[start, end)` byte
   * offsets into `source`.
   */
  export function tokenize(
    source: string,
    onToken: (type: number, start: number, end: number) => void
  ): void;

  /** Maps token type name (e.g. `'Comment'`) to its numeric type value. */
  export const tokenTypes: Readonly<Record<string, number>>;
}
