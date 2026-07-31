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
 * Lives under `src/` (not `tests/` or a root `types/` dir) because `tsconfig.json`'s
 * `include` is exactly `["src", "tests", "scripts"]` — nothing outside those three roots
 * is type-checked at all, so this declaration must live inside one of them, and `src/` is
 * the one whose compile-time surface it exists to constrain.
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
