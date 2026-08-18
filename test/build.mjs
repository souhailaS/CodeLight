import { readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const outdir = resolve(here, "..", "out", "test");
const names = (await readdir(here)).filter((name) => name.endsWith(".test.ts"));

await rm(outdir, { recursive: true, force: true });

await build({
  entryPoints: names.map((name) => join(here, name)),
  bundle: true,
  outdir,
  outExtension: { ".js": ".cjs" },
  alias: { vscode: resolve(here, "fakevscode.ts") },
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: "inline",
  logLevel: "warning"
});
