import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as bundle } from "bun";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const outdir = path.join(root, "dist");

await rm(outdir, { force: true, recursive: true });

const build = await bundle({
  entrypoints: [
    path.join(root, "src/server.ts"),
    path.join(root, "src/compaction-snapshot.ts"),
    path.join(root, "src/tui.tsx"),
  ],
  format: "esm",
  naming: "[name].[ext]",
  outdir,
  packages: "external",
  sourcemap: "external",
  target: "bun",
});

if (!build.success) {
  throw new Error(build.logs.map(String).join("\n"));
}
