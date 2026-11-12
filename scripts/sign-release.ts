/**
 * Builds release artifacts and signs them with the maintainer's release key.
 *
 *   RELEASE_NSEC=nsec1... pnpm exec tsx scripts/sign-release.ts
 *
 * Produces:
 *   release/SHA256SUMS            sha256 of every file in apps/web/dist
 *   release/SHA256SUMS.sig.json   NIP-94 (kind 1063) event signed by the release key,
 *                                 with ["x", sha256(SHA256SUMS)]
 * Verify with: pnpm exec tsx scripts/verify-release.ts
 *
 * The release key must never be committed. Its public key goes in docs/RELEASE_KEY.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { execSync } from "node:child_process";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import * as nip19 from "nostr-tools/nip19";

const ROOT = join(import.meta.dirname, "..");
const nsec = process.env.RELEASE_NSEC;
if (!nsec) {
  console.error("Set RELEASE_NSEC to the maintainer's release key (never commit it).");
  process.exit(1);
}
const decoded = nip19.decode(nsec);
if (decoded.type !== "nsec") throw new Error("RELEASE_NSEC is not an nsec");
const sk = decoded.data;

execSync("pnpm --filter @relaymesh/web build", { cwd: ROOT, stdio: "inherit" });
const dist = join(ROOT, "apps", "web", "dist");
const files: string[] = [];
const walk = (d: string) => readdirSync(d).forEach((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : files.push(join(d, f))));
walk(dist);
const lines = files
  .map((f) => `${createHash("sha256").update(readFileSync(f)).digest("hex")}  ${relative(dist, f).replaceAll("\\", "/")}`)
  .sort((a, b) => a.slice(66).localeCompare(b.slice(66)));
const sums = lines.join("\n") + "\n";
mkdirSync(join(ROOT, "release"), { recursive: true });
writeFileSync(join(ROOT, "release", "SHA256SUMS"), sums);
const digest = createHash("sha256").update(sums).digest("hex");
const version = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;
const commit = execSync("git rev-parse HEAD", { cwd: ROOT }).toString().trim();
const ev = finalizeEvent(
  {
    kind: 1063,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["x", digest],
      ["m", "text/plain"],
      ["alt", `Aava ${version} release checksums`],
      ["version", version],
      ["commit", commit],
    ],
    content: `Aava ${version} (${commit.slice(0, 12)}): SHA256SUMS signature`,
  },
  sk,
);
writeFileSync(join(ROOT, "release", "SHA256SUMS.sig.json"), JSON.stringify(ev, null, 2) + "\n");
console.log(`Signed release ${version} with ${nip19.npubEncode(getPublicKey(sk))}; SHA256SUMS digest ${digest}`);
