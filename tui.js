// OpenCode v2 directory entrypoint.
//
// Why this file exists: the v2 server only advertises a plugin's TUI
// component (`features.tui`, which is what makes the CLI attempt to load it)
// when a `tui` file exists at the plugin directory root. The `./tui` export
// map entry alone (pointing at `./dist/tui.js`) is not enough: without this
// file the CLI never attempts to load the TUI at all.
//
// v1 resolution is unchanged: v1 uses `package.json` `exports["./tui"]`
// which still points at `./dist/tui.js`.
//
// Single writer for all TUI behavior remains `src/tui.tsx` (v1 component) and
// `src/cli.tsx` (v2 CLI adapter); this module intentionally contains no logic.
export { default } from "./dist/tui.js";
export * from "./dist/tui.js";
