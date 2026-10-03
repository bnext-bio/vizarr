// Bundles the anywidget front-end (python/js/widget.js) together with the
// vizarr viewer into a single self-contained ES module at
// python/src/vizarr/_widget.js, which the Python package ships and loads via
// anywidget's `_esm`. Everything is inlined (no CDN, no sibling chunks).
import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["python/js/widget.js"],
  outfile: "python/src/vizarr/_widget.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  // es2022 so top-level await (used by some deps) is preserved rather than erroring.
  target: "es2022",
  jsx: "automatic",
  minify: true,
  legalComments: "none",
  define: {
    "import.meta.vitest": "undefined",
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  logLevel: "info",
});
