import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import * as nip44 from "nostr-tools/nip44";
import { verifyEvent } from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";
import { foundry } from "viem/chains";
import type { RunningRelay } from "@relaymesh/relay";
import { TokenRegistry, DEMO_TOKEN_ADDRESS } from "@relaymesh/chain";
import { ANVIL_ACCOUNTS, deployDemoToken, devClients, mintDemoToken, startAnvil, type Anvil } from "@relaymesh/chain/testing";
import { ContactWalletPolicy, RequestLedger, createPaymentRequest, toWire, typedDataFor, verifyPaymentRequest } from "@relaymesh/payments";
import { MemoryStore } from "@relaymesh/identity";
import { OBSERVATORY_TESTS, isKnownTracker, runTest } from "@relaymesh/observatory";
import { allStored, makePeer, twoRelays, waitFor, ANVIL_PRIVATE_KEYS, type Peer } from "./harness.ts";

const ROOT = join(import.meta.dirname, "..", "..");

describe("CROPS · Privacy", () => {
  let relays: RunningRelay[];
  let alice: Peer;
  let bob: Peer;
  let anvil: Anvil;
  const SECRET = "P-01 marker: the meeting moved to the north entrance";

  beforeAll(async () => {
    relays = await twoRelays();
    alice = await makePeer(relays.map((r) => r.url));
    bob = await makePeer(relays.map((r) => r.url));
    anvil = await startAnvil();
    await deployDemoToken(anvil.rpcUrl);
    await mintDemoToken(anvil.rpcUrl, DEMO_TOKEN_ADDRESS, ANVIL_ACCOUNTS[1]!, 10_000_000n);

    await alice.messenger.send([bob.pubkey], { type: "text", content: SECRET });
    // A full payment request round-trip so wallet data has a chance to leak (P-05, P-06).
    const { walletClient } = devClients(anvil.rpcUrl);
    const req = createPaymentRequest({ creatorPubkey: alice.pubkey, creatorWallet: ANVIL_ACCOUNTS[2]!, chainId: 31337, token: DEMO_TOKEN_ADDRESS, recipient: ANVIL_ACCOUNTS[2]!, amount: 1_000_000n });
    const signature = await walletClient.signTypedData({ account: ANVIL_ACCOUNTS[2]!, ...typedDataFor(req), chain: foundry } as never);
    await alice.messenger.send([bob.pubkey], { type: "payment-request", content: JSON.stringify(toWire({ request: req, signature })) });
    await waitFor(() => bob.inbox.length >= 2, 10_000, "bob to receive both messages");
  }, 60_000);

  afterAll(async () => {
    await alice?.stop();
    await bob?.stop();
    for (const r of relays ?? []) await r.close();
    await anvil?.stop();
  });

  it("P-01 relay-stored message contents are not plaintext", () => {
    const stored = allStored(relays);
    expect(stored.length).toBeGreaterThanOrEqual(4); // 2 messages × (bob + self copy) × relays
    for (const e of stored) expect(JSON.stringify(e)).not.toContain(SECRET);
    expect(bob.inbox.some((m) => m.content === SECRET)).toBe(true);
  });

  it("P-02 private messages use the NIP-17 / NIP-59 construction", () => {
    const toBob = allStored(relays).filter((e) => e.tags.some((t) => t[0] === "p" && t[1] === bob.pubkey));
    expect(toBob.length).toBeGreaterThan(0);
    for (const wrap of toBob) {
      expect(wrap.kind).toBe(1059);
      expect(wrap.tags).toEqual([["p", bob.pubkey]]);
      expect(wrap.pubkey).not.toBe(alice.pubkey); // one-time key
      expect(verifyEvent({ ...wrap })).toBe(true);
      const seal = JSON.parse(nip44.decrypt(wrap.content, nip44.getConversationKey(bob.sk, wrap.pubkey)));
      expect(seal.kind).toBe(13);
      expect(seal.tags).toEqual([]);
      expect(seal.pubkey).toBe(alice.pubkey);
      expect(verifyEvent(seal)).toBe(true);
      const rumor = JSON.parse(nip44.decrypt(seal.content, nip44.getConversationKey(bob.sk, seal.pubkey)));
      expect(rumor.kind).toBe(14);
      expect(rumor.sig).toBeUndefined(); // rumors are unsigned (deniability)
    }
  });

  it("P-03 the frontend makes no third-party analytics requests", () => {
    execSync("pnpm --filter @relaymesh/web build", { cwd: ROOT, stdio: "ignore" });
    const dist = join(ROOT, "apps", "web", "dist");
    const files: string[] = [];
    const walk = (d: string) => readdirSync(d).forEach((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : files.push(join(d, f))));
    walk(dist);
    const urls = new Set<string>();
    for (const f of files.filter((x) => /\.(js|html|css)$/.test(x))) {
      for (const m of readFileSync(f, "utf8").matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) urls.add(m[1]!.toLowerCase());
    }
    const trackers = [...urls].filter(isKnownTracker);
    expect(trackers).toEqual([]);
    const html = readFileSync(join(dist, "index.html"), "utf8");
    expect(html).not.toMatch(/<script[^>]+src="https?:/);
    expect(html).not.toMatch(/<link[^>]+href="https?:/);
    expect(html).toContain("Content-Security-Policy");
  }, 120_000);

  it("P-04 network connections are inventoried, including every relay socket", async () => {
    const inventory = OBSERVATORY_TESTS.find((t) => t.id === "OBS-04")!;
    const ok = await runTest(inventory, { mesh: alice.mesh, networkEntries: () => [], allowedOrigins: () => relays.map((r) => r.url) });
    expect(ok.status).toBe("PASS");
    for (const r of relays) expect(ok.evidence.join("\n")).toContain(r.url.replace(/\/$/, ""));
    const bad = await runTest(inventory, { mesh: alice.mesh, networkEntries: () => [{ url: "https://collector.example.net/x", kind: "fetch" }], allowedOrigins: () => relays.map((r) => r.url) });
    expect(bad.status).toBe("FAIL");
  });

  it("P-05 relay operators never receive wallet or identity private keys", () => {
    const blob = JSON.stringify(allStored(relays)).toLowerCase();
    for (const k of ANVIL_PRIVATE_KEYS) expect(blob).not.toContain(k);
    for (const sk of [alice.sk, bob.sk]) expect(blob).not.toContain(bytesToHex(sk));
  });

  it("P-06 chat identity and wallet address are never published together (or at all) to relays", () => {
    const stored = allStored(relays);
    const blob = JSON.stringify(stored).toLowerCase();
    for (const w of ANVIL_ACCOUNTS.slice(0, 3)) expect(blob).not.toContain(w.toLowerCase().slice(2));
    // Alice's key never appears as a signer: only as the recipient tag of her own history copy
    // (the documented self-copy timing limitation in docs/PRIVACY.md).
    expect(stored.some((e) => e.pubkey === alice.pubkey)).toBe(false);
    const aliceTagged = stored.filter((e) => e.tags.some((t) => t[1] === alice.pubkey));
    for (const e of aliceTagged) expect(e.tags).toEqual([["p", alice.pubkey]]);
  });

  it("P-06 the recipient can still verify the request it received privately", async () => {
    const req = bob.inbox.find((m) => m.type === "payment-request")!;
    const r = await verifyPaymentRequest(req.content, {
      expectedChainId: 31337,
      tokens: new TokenRegistry(),
      policy: new ContactWalletPolicy({ [alice.pubkey]: [ANVIL_ACCOUNTS[2]!] }),
      ledger: new RequestLedger(new MemoryStore()),
      messageAuthor: req.from,
    });
    expect(r.ok).toBe(true);
  });

  it("P-08 privacy limitations are documented", () => {
    const doc = readFileSync(join(ROOT, "docs", "PRIVACY.md"), "utf8").toLowerCase();
    for (const topic of ["forward secrecy", "ip address", "recipient", "timing", "turn", "on-chain", "tor", "self-copy"]) expect(doc, `PRIVACY.md must discuss "${topic}"`).toContain(topic);
    expect(existsSync(join(ROOT, "docs", "THREAT_MODEL.md"))).toBe(true);
  });
});
