/**
 * Untyped ambient declaration for the FULL `css-tree` package, scoped to `tests/` only.
 *
 * `src/types/css-tree-tokenizer.d.ts` declares a typed, narrow surface (`tokenize` +
 * `tokenTypes`) for the `css-tree/tokenizer` subpath — the only surface `src/` may use.
 * The test-only liveness oracle (`tests/support/css-liveness-oracle.ts`) needs the css-tree
 * PARSER (`parse`, `walk`, `ident`) — a deliberately different, wider surface that must
 * never be reachable from `src/`. `@types/css-tree` is not installed (62-16-PLAN.md, Task
 * 2), so without this declaration `tsc` fails TS7016 on `import ... from 'css-tree'`
 * anywhere under `tests/`. This grants the whole package an implicit `any` shape rather
 * than a precise one — acceptable here because the oracle is test-only ground truth, never
 * shipped, and its own tests are what catch a misuse of the API, not the type checker.
 */
declare module 'css-tree';
