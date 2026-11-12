import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { createPublicClient, http } from "viem";
import { foundry } from "viem/chains";
import { verifyEvent, type NostrEvent } from "nostr-tools/pure";
import { startRelay } from "@relaymesh/relay";
import { IdentityVault, MemoryStore } from "@relaymesh/identity";
import { importRelayConfig } from "@relaymesh/relay-mesh";
import { DEMO_TOKEN_ADDRESS, verifyTokenTransfer } from "@relaymesh/chain";
import { ANVIL_ACCOUNTS, deployDemoToken, mintDemoToken, startAnvil, transferDemoToken, type Anvil } from "@relaymesh/chain/testing";
import { makePeer, waitFor } from "./harness.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("CROPS · Censorship resistance", () => {
  it("C-01 messages flow across independently operated relays", async () => {
    // Two relays with different operators/ports; each peer only shares ONE relay with the other at a time.
    const a = await startRelay({ port: 0, name: "Operator A" });
    const b = await startRelay({ port: 0, name: "Operator B" });
    const alice = await makePeer([a.url, b.url]);
    const bob = await makePeer([b.url]);
    await alice.messenger.send([bob.pubkey], { type: "text", content: "independent" });
    await waitFor(() => bob.inbox.some((m) => m.content === "independent"));
    expect(a.storedEvents().length).toBeGreaterThan(0);
    expect(b.storedEvents().length).toBeGreaterThan(0);
    await alice.stop();
    await bob.stop();
    await a.close();
    await b.close();
  });

  it("C-02 no central relay registry is required", () => {
    // Relays come only from user settings / env; importing a bundle without any manifest works.
    const imported = importRelayConfig({ format: "relaymesh.relay-config", v: 1, relays: [{ url: "wss://relay.example.org" }] });
    expect(imported.relays[0]!.url).toBe("wss://relay.example.org");
    const settingsSrc = read("apps/web/src/runtime/settings.ts");
    expect(settingsSrc).toContain("VITE_DEFAULT_RELAYS");
    // The app never fetches a remote relay list.
    const srcFiles = readdirSync(join(ROOT, "apps/web/src/runtime")).map((f) => read(`apps/web/src/runtime/${f}`)).join("\n");
    expect(srcFiles).not.toMatch(/fetch\(["'`]https?:\/\/[^"'`]*registry/i);
  });

  it("C-03 operates entirely against manually configured infrastructure", async () => {
    const relay = await startRelay({ port: 0, name: "manual" });
    const alice = await makePeer([relay.url]);
    const bob = await makePeer([relay.url]);
    await alice.messenger.send([bob.pubkey], { type: "text", content: "manual infra" });
    await waitFor(() => bob.inbox.some((m) => m.content === "manual infra"));
    await alice.stop();
    await bob.stop();
    await relay.close();
  });

  it("C-04 identities and history survive the loss of all infrastructure", async () => {
    const relay = await startRelay({ port: 0 });
    const kv = new MemoryStore();
    const vault = new IdentityVault(kv);
    await vault.create("a long enough password");
    const alice = await makePeer([relay.url], vault.secretKey(), kv);
    const bob = await makePeer([relay.url]);
    await alice.messenger.send([bob.pubkey], { type: "text", content: "kept locally" });
    await relay.close(); // every relay gone
    await waitFor(() => alice.mesh.openRelays().length === 0);
    const queued = await alice.messenger.send([bob.pubkey], { type: "text", content: "written offline" });
    expect(queued.status).toBe("queued");
    await alice.store.flush();
    await alice.stop();
    await bob.stop();
    vault.lock();
    // Re-open from storage only.
    const again = new IdentityVault(kv);
    const id = await again.unlock("a long enough password");
    expect(id.pubkey).toBe(alice.pubkey);
    const offline = await makePeer([], again.secretKey(), kv).catch(() => null);
    expect(offline?.store.all().map((m) => m.content)).toEqual(expect.arrayContaining(["kept locally", "written offline"]));
    await offline?.stop();
  });

  describe("C-05 users can change RPC providers", () => {
    let anvil: Anvil;
    let other: Anvil;
    beforeAll(async () => {
      anvil = await startAnvil();
      other = await startAnvil();
    }, 60_000);
    afterAll(async () => {
      await anvil?.stop();
      await other?.stop();
    });

    it("verifies the same receipt through different endpoints and rejects an endpoint that does not have it", async () => {
      const [deployer, payer, payee] = ANVIL_ACCOUNTS as [`0x${string}`, `0x${string}`, `0x${string}`];
      await deployDemoToken(anvil.rpcUrl, deployer);
      await mintDemoToken(anvil.rpcUrl, DEMO_TOKEN_ADDRESS, payer, 100n);
      const tx = await transferDemoToken(anvil.rpcUrl, DEMO_TOKEN_ADDRESS, payer, payee, 42n);
      const expected = { chainId: 31337, token: DEMO_TOKEN_ADDRESS, from: payer, to: payee, amount: 42n };
      const via = (url: string) => createPublicClient({ chain: foundry, transport: http(url) });
      expect((await verifyTokenTransfer(via(anvil.rpcUrl), tx, expected, 1)).status).toBe("verified");
      expect((await verifyTokenTransfer(via(anvil.rpcUrl.replace("127.0.0.1", "localhost")), tx, expected, 1)).status).toBe("verified");
      // A different node (another chain history) cannot confirm it: never "verified".
      expect((await verifyTokenTransfer(via(other.rpcUrl), tx, expected, 1)).status).not.toBe("verified");
    });
  });

  it("C-06 the frontend can be self-hosted from any static location", () => {
    if (!existsSync(join(ROOT, "apps/web/dist/index.html"))) execSync("pnpm --filter @relaymesh/web build", { cwd: ROOT, stdio: "ignore" });
    const html = read("apps/web/dist/index.html");
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThan(0);
    // Relative paths, or inline data: URLs (e.g. the empty favicon), never absolute server paths.
    for (const r of refs) expect(r.startsWith("./") || r.startsWith("data:"), `asset reference ${r} must be relative`).toBe(true);
    expect(read("apps/web/src/main.tsx")).toContain("createHashRouter"); // no server rewrites needed
    expect(existsSync(join(ROOT, "infra/web/nginx.conf"))).toBe(true);
  }, 120_000);
});

describe("CROPS · Open source", () => {
  const workspacePkgs = () =>
    ["packages", "apps"].flatMap((d) =>
      readdirSync(join(ROOT, d))
        .filter((p) => existsSync(join(ROOT, d, p, "package.json")))
        .map((p) => ({ path: `${d}/${p}`, pkg: JSON.parse(read(`${d}/${p}/package.json`)) as { name: string; license?: string; dependencies?: Record<string, string> } })),
    );

  it("O-01 all application source is licensed and published", () => {
    expect(read("LICENSE")).toMatch(/MIT License/);
    for (const { path, pkg } of workspacePkgs()) expect(pkg.license, `${path} license`).toBe("MIT");
    let remote = "";
    try {
      remote = execSync("git remote get-url origin", { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch {
      /* no remote */
    }
    expect(remote, "the repository must be pushed to a public remote (git remote 'origin')").toMatch(/^https:\/\//);
  });

  it("O-02 every runtime dependency has a license record", () => {
    const inventory = JSON.parse(read("docs/third-party-licenses.json")) as Record<string, { version: string; license: string }>;
    for (const { pkg } of workspacePkgs()) {
      for (const dep of Object.keys(pkg.dependencies ?? {})) {
        if (dep.startsWith("@relaymesh/")) continue;
        expect(inventory[dep], `license record for ${dep}`).toBeDefined();
        expect(inventory[dep]!.license, `license of ${dep}`).toMatch(/\S/);
        expect(inventory[dep]!.license).not.toBe("UNKNOWN");
      }
    }
  });

  it("O-03 releases are signed", () => {
    const sumsPath = join(ROOT, "release", "SHA256SUMS");
    const sigPath = join(ROOT, "release", "SHA256SUMS.sig.json");
    expect(existsSync(sumsPath) && existsSync(sigPath), "no signed release found in release/ (run scripts/sign-release.ts with the maintainer key)").toBe(true);
    const sig = JSON.parse(readFileSync(sigPath, "utf8")) as NostrEvent;
    const releaseKey = read("docs/RELEASE_KEY").trim();
    expect(verifyEvent({ ...sig })).toBe(true);
    expect(sig.pubkey).toBe(releaseKey);
    expect(sig.tags.find((t) => t[0] === "x")?.[1]).toBe(execSync(`node -e "process.stdout.write(require('crypto').createHash('sha256').update(require('fs').readFileSync(process.argv[1])).digest('hex'))" "${sumsPath}"`).toString());
  });

  it("O-04 build instructions are documented", () => {
    const readme = read("README.md");
    for (const cmd of ["pnpm install", "pnpm dev", "pnpm build", "docker compose", "pnpm test"]) expect(readme, `README must document "${cmd}"`).toContain(cmd);
  });

  it("O-05 security test instructions are public", () => {
    const sec = read("docs/SECURITY.md");
    expect(sec).toContain("pnpm test:crops");
    expect(sec).toMatch(/report/i);
    expect(read("docs/CROPS.md")).toContain("P-01");
  });
});
