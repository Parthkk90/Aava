import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { createRequire } from "node:module";

/**
 * Production Content-Security-Policy. connect-src must allow user-chosen relays
 * and RPC endpoints (any wss/https host), which is why the Observatory also
 * inventories every contacted origin. Headers-only directives
 * (frame-ancestors) are set by the hosting config in infra/.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  // data: lets the Helios light client fetch its inlined WebAssembly (local bytes, no network).
  "connect-src 'self' data: wss: ws: https: http://127.0.0.1:* http://localhost:*",
  // Same-origin only: the Anon-RPC harness bootstrap page (sandboxed by the harness to an opaque origin).
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "worker-src 'self'",
].join("; ");

/**
 * Anon-RPC harness bootstrap page. Our CSP has no 'unsafe-inline', so the
 * harness's default srcdoc iframe cannot run; it must load a same-origin page
 * (SPEC §5 iframeUrl). The script is copied verbatim from the installed
 * @anon-rpc/browser-harness so it always matches the harness version.
 * Hosting must allow this one page to be framed by the app (infra/web/nginx.conf).
 */
const ANON_IFRAME_HTML = `<!doctype html><meta charset="utf-8"><title>anon-rpc sandbox</title><script src="./anon-rpc-iframe.js"></script>
`;

/**
 * Third-party files that must be served verbatim at fixed paths, in dev and in the build:
 *  - the Anon-RPC harness bootstrap page and script (above);
 *  - Kohaku's Tornado state-manager worker and the MSM worker it loads from its own directory
 *    (both self-contained bundles; the plugin is told the worker URL at runtime).
 */
function verbatimAssetsPlugin(): Plugin {
  const req = createRequire(import.meta.url);
  const tornadoDir = () => dirname(req.resolve("@kohaku-eth/tornado-cash/state-manager.worker.js"));
  const assets: Record<string, [string, () => string]> = {
    "anon-rpc-iframe.html": ["text/html; charset=utf-8", () => ANON_IFRAME_HTML],
    "anon-rpc-iframe.js": ["text/javascript; charset=utf-8", () => readFileSync(req.resolve("@anon-rpc/browser-harness/iframe-boot.js"), "utf8")],
    "kohaku/state-manager.worker.js": ["text/javascript; charset=utf-8", () => readFileSync(join(tornadoDir(), "state-manager.worker.js"), "utf8")],
    "kohaku/msm-worker.browser.js": ["text/javascript; charset=utf-8", () => readFileSync(join(tornadoDir(), "msm-worker.browser.js"), "utf8")],
  };
  return {
    name: "relaymesh-verbatim-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const asset = assets[(req.url?.split("?")[0] ?? "").replace(/^\//, "")];
        if (asset) res.setHeader("content-type", asset[0]).end(asset[1]());
        else next();
      });
    },
    generateBundle() {
      for (const [fileName, [, source]] of Object.entries(assets)) this.emitFile({ type: "asset", fileName, source: source() });
    },
  };
}

function cspPlugin(): Plugin {
  return {
    name: "relaymesh-csp",
    apply: "build",
    transformIndexHtml(html) {
      return html.replace("<!--CSP-->", `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`);
    },
  };
}

/**
 * Writes release.json: SHA-256 of every file in the output directory, plus a
 * root hash over the list. Hashes are computed from the files on disk after
 * the build has finished writing, since later plugins may still rewrite
 * chunk code during generateBundle.
 */
function releaseManifestPlugin(version: string): Plugin {
  return {
    name: "relaymesh-release-manifest",
    apply: "build",
    enforce: "post",
    writeBundle(opts) {
      const outDir = opts.dir!;
      const files: { path: string; sha256: string }[] = [];
      const walk = (d: string) => {
        for (const f of readdirSync(d)) {
          const p = join(d, f);
          if (statSync(p).isDirectory()) walk(p);
          else files.push({ path: relative(outDir, p).replaceAll("\\", "/"), sha256: createHash("sha256").update(readFileSync(p)).digest("hex") });
        }
      };
      walk(outDir);
      const list = files.filter((f) => f.path !== "release.json").sort((a, b) => a.path.localeCompare(b.path));
      const rootHash = createHash("sha256").update(list.map((f) => `${f.path}:${f.sha256}`).join("\n")).digest("hex");
      writeFileSync(join(outDir, "release.json"), JSON.stringify({ version, rootHash, files: list }, null, 2));
    },
  };
}

// @kohaku-eth/tornado-cash 0.1.0-alpha.31 maps its "#worker-loader" import (browser condition) to an
// unpublished src/*.ts file; point it at the published browser build instead.
const tornadoWorkerLoader = join(dirname(createRequire(import.meta.url).resolve("@kohaku-eth/tornado-cash/state-manager.worker.js")), "worker-loader.browser.js");

export default defineConfig({
  base: "./",
  resolve: { alias: [{ find: /^#worker-loader$/, replacement: tornadoWorkerLoader }] },
  plugins: [react(), tailwind(), cspPlugin(), verbatimAssetsPlugin(), releaseManifestPlugin(process.env.npm_package_version ?? "0.0.0")],
  // RELAYMESH_DEBUG_BUILD=1 produces an unminified build (for diagnosing e2e failures only).
  build: { target: "es2022", sourcemap: false, minify: process.env.RELAYMESH_DEBUG_BUILD !== "1" },
  server: { port: 5173, strictPort: true },
});
