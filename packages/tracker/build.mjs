// Minifies src/qwa.js → dist/t.js and reports its size.
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

await build({
  entryPoints: ["src/qwa.js"],
  outfile: "dist/t.js",
  bundle: false,
  minify: true,
  target: ["es2017"],
  legalComments: "none",
  banner: { js: "/*! Quick Web Analytics tracker · MIT */" },
});
const out = readFileSync("dist/t.js");
console.log(`dist/t.js: ${out.length} B, ${gzipSync(out).length} B gzipped`);
