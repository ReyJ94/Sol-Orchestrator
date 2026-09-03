// OpenCode v2 directory entrypoint.
//
// Why this file exists: the v2 server resolves a `file:` directory plugin to
// `<dir>/server.js`. This package keeps its implementation in `src/` built to
// `dist/` (see `scripts/build.ts`), so without this file v2 never attempts to
// load the plugin at all.
//
// v1 resolution is unchanged: v1 uses `package.json` `exports["./server"]`
// which still points at `./dist/server.js`.
//
// Single writer for all server behavior remains `src/server.ts`; this module
// intentionally contains no logic.
export { default } from "./dist/server.js";
