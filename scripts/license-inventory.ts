/**
 * Writes docs/third-party-licenses.json: license, version and repository for
 * every third-party runtime dependency of every workspace package, read from
 * the installed package manifests. Run after `pnpm install`:  pnpm license-inventory
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const ALLOWED = /^(MIT|ISC|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|Unlicense|0BSD|MPL-2\.0|CC0-1\.0|BlueOak-1\.0\.0)( OR .*)?$|^\((MIT|Apache-2\.0) OR /;

interface Entry {
  version: string;
  license: string;
  repository?: string;
  usedBy: string[];
  note?: string;
}

/**
 * Packages whose manifest declares no license. Recorded as UNDECLARED with what we know, and still
 * reported for review: we do not guess a license on the author's behalf.
 */
const UNDECLARED: Record<string, string> = {
  "@kohaku-eth/plugins":
    "No license field in package.json and no LICENSE file in github.com/ethereum/kohaku (checked 2026-11-06). Sibling packages @kohaku-eth/provider and @kohaku-eth/tornado-cash are MIT. Required by @kohaku-eth/tornado-cash. Needs confirmation from the Kohaku maintainers.",
};

const out: Record<string, Entry> = {};
const problems: string[] = [];

for (const dir of ["packages", "apps"]) {
  for (const name of readdirSync(join(ROOT, dir))) {
    const pkgDir = join(ROOT, dir, name);
    const manifest = join(pkgDir, "package.json");
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { name: string; dependencies?: Record<string, string> };
    const req = createRequire(manifest);
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      if (dep.startsWith("@relaymesh/")) continue;
      let depManifestPath: string;
      try {
        depManifestPath = req.resolve(`${dep}/package.json`);
      } catch {
        // Packages with strict "exports" may hide package.json; fall back to node_modules lookup.
        depManifestPath = join(pkgDir, "node_modules", dep, "package.json");
      }
      const d = JSON.parse(readFileSync(depManifestPath, "utf8")) as { version: string; license?: string | { type: string }; repository?: string | { url: string } };
      const declared = typeof d.license === "string" ? d.license : d.license?.type;
      const license = declared ?? (UNDECLARED[dep] ? "UNDECLARED" : "UNKNOWN");
      const entry: Entry = out[dep] ?? { version: d.version, license, usedBy: [] };
      if (!declared && UNDECLARED[dep]) entry.note = UNDECLARED[dep];
      const repo = typeof d.repository === "string" ? d.repository : d.repository?.url;
      if (repo) entry.repository = repo;
      entry.usedBy = [...new Set([...entry.usedBy, pkg.name])];
      out[dep] = entry;
      if (!ALLOWED.test(license)) problems.push(`${dep}@${d.version}: ${license}`);
    }
  }
}

const sorted = Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(join(ROOT, "docs", "third-party-licenses.json"), JSON.stringify(sorted, null, 2) + "\n");
console.log(`Recorded ${Object.keys(sorted).length} runtime dependencies in docs/third-party-licenses.json`);
if (problems.length) {
  console.error(`Licenses needing review:\n  ${problems.join("\n  ")}`);
  process.exitCode = 1;
}
