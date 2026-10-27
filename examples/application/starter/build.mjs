import { build } from "esbuild";
import { fileURLToPath } from "node:url";

await build({
  entryPoints: [fileURLToPath(new URL("browser.mjs", import.meta.url))],
  outfile: fileURLToPath(new URL("public/app.js", import.meta.url)),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
});
