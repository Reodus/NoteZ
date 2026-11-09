import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { cpSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";

/** pdf.js character maps and standard fonts at /pdfjs/cmaps/ and
 * /pdfjs/standard_fonts/: served in dev, copied into dist/ by a build. */
function pdfjsAssets(): Plugin {
  const dirs = ["cmaps", "standard_fonts"];
  const src = join("node_modules", "pdfjs-dist");
  return {
    name: "notez-pdfjs-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = /^\/pdfjs\/(cmaps|standard_fonts)\/([\w.\-]+)$/.exec((req.url ?? "").split("?")[0]);
        const file = m && join(src, m[1], m[2]);
        if (!file || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader("Content-Type", "application/octet-stream");
        res.end(readFileSync(file));
      });
    },
    writeBundle(opts) {
      for (const d of dirs) cpSync(join(src, d), join(opts.dir ?? "dist", "pdfjs", d), { recursive: true });
    },
  };
}

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// The UI is loaded by Electron: from this dev server in `npm run dev`,
// from dist/ (via the app:// protocol) in a packaged build.
export default defineConfig({
  plugins: [solid(), pdfjsAssets()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/core/**", "**/release/**"] },
  },
});
