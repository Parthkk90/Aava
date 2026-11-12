/**
 * Verifies release/SHA256SUMS against its NIP-94 signature and the published
 * release key (docs/RELEASE_KEY), then checks every listed file in a directory.
 *
 *   pnpm exec tsx scripts/verify-release.ts [dir-with-files=apps/web/dist]
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyEvent, type NostrEvent } from "nostr-tools/pure";

const ROOT = join(import.meta.dirname, "..");
const dir = process.argv[2] ?? join(ROOT, "apps", "web", "dist");
const sums = readFileSync(join(ROOT, "release", "SHA256SUMS"), "utf8");
const sig = JSON.parse(readFileSync(join(ROOT, "release", "SHA256SUMS.sig.json"), "utf8")) as NostrEvent;
const releaseKey = readFileSync(join(ROOT, "docs", "RELEASE_KEY"), "utf8").trim();

const problems: string[] = [];
if (!verifyEvent({ ...sig })) problems.push("signature invalid");
if (sig.pubkey !== releaseKey) problems.push(`signed by ${sig.pubkey}, expected release key ${releaseKey}`);
const digest = createHash("sha256").update(sums).digest("hex");
if (sig.tags.find((t) => t[0] === "x")?.[1] !== digest) problems.push("SHA256SUMS does not match the signed digest");
for (const line of sums.trim().split("\n")) {
  const [hash, file] = [line.slice(0, 64), line.slice(66)];
  const p = join(dir, file);
  if (!existsSync(p)) problems.push(`missing ${file}`);
  else if (createHash("sha256").update(readFileSync(p)).digest("hex") !== hash) problems.push(`hash mismatch ${file}`);
}
if (problems.length) {
  console.error(`✘ release verification failed:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`✔ release verified: ${sums.trim().split("\n").length} files, signed by ${releaseKey}`);
