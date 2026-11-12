import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import * as nip59 from "nostr-tools/nip59";
import * as nip19 from "nostr-tools/nip19";
import { generateSecretKey, getEventHash, getPublicKey } from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";
import { foundry } from "viem/chains";
import type { Address, Hash } from "viem";
import type { RunningRelay } from "@relaymesh/relay";
import { startRelay } from "@relaymesh/relay";
import { IdentityVault, MemoryStore, createIdentityBackup, generateIdentitySecret, restoreIdentityBackup } from "@relaymesh/identity";
import { openGiftWrap } from "@relaymesh/messaging";
import { ManifestError, signOperatorManifest, verifyOperatorManifest } from "@relaymesh/relay-mesh";
import { TokenRegistry, DEMO_TOKEN_ADDRESS, verifyTokenTransfer } from "@relaymesh/chain";
import { ANVIL_ACCOUNTS, deployDemoToken, devClients, mintDemoToken, startAnvil, transferDemoToken, type Anvil } from "@relaymesh/chain/testing";
import {
  ContactWalletPolicy,
  RequestLedger,
  UnauthorizedExecutionError,
  createPaymentRequest,
  executeApprovedPayment,
  settlePayment,
  toWire,
  typedDataFor,
  verifyPaymentRequest,
  type PaymentRequest,
  type PaymentWallet,
} from "@relaymesh/payments";
import { makePeer, twoRelays, waitFor, type Peer } from "./harness.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const [deployer, payer, creatorWallet, attackerWallet] = ANVIL_ACCOUNTS as [Address, Address, Address, Address];

describe("CROPS · Security", () => {
  let anvil: Anvil;
  const creatorNostr = generateSecretKey();
  const creatorPub = getPublicKey(creatorNostr);

  beforeAll(async () => {
    anvil = await startAnvil();
    await deployDemoToken(anvil.rpcUrl, deployer);
    await mintDemoToken(anvil.rpcUrl, DEMO_TOKEN_ADDRESS, payer, 1_000_000_000n, deployer);
  }, 60_000);
  afterAll(async () => anvil?.stop());

  /** Requests are signed through the node's eth_signTypedData_v4, exactly as a wallet would. */
  async function signed(over: Partial<Parameters<typeof createPaymentRequest>[0]> = {}, signer: Address = creatorWallet) {
    const req = createPaymentRequest({ creatorPubkey: creatorPub, creatorWallet: signer, chainId: 31337, token: DEMO_TOKEN_ADDRESS, recipient: creatorWallet, amount: 5_000_000n, ...over });
    const signature = await devClients(anvil.rpcUrl).walletClient.signTypedData({ account: signer, ...typedDataFor(req), chain: foundry } as never);
    return { req, wire: toWire({ request: req, signature }) };
  }
  const ctx = (ledger = new RequestLedger(new MemoryStore())) => ({
    expectedChainId: 31337,
    tokens: new TokenRegistry(),
    policy: new ContactWalletPolicy({ [creatorPub]: [creatorWallet] }),
    ledger,
    messageAuthor: creatorPub,
  });
  const tampered = (wire: object, edit: (r: Record<string, unknown>) => void) => {
    const copy = JSON.parse(JSON.stringify(wire)) as { request: Record<string, unknown> };
    edit(copy.request);
    return copy;
  };

  it("S-01 keys come from the platform CSPRNG and generation refuses without one", () => {
    const keys = new Set(Array.from({ length: 500 }, () => bytesToHex(generateIdentitySecret())));
    expect(keys.size).toBe(500);
    const spy = vi.spyOn(globalThis, "crypto", "get").mockReturnValue(undefined as never);
    expect(() => generateIdentitySecret()).toThrow(/secure random/);
    spy.mockRestore();
    // No package source uses Math.random.
    const offenders: string[] = [];
    const walk = (d: string) =>
      readdirSync(d).forEach((f) => {
        const p = join(d, f);
        if (statSync(p).isDirectory()) return f !== "node_modules" && walk(p);
        if (/\.(ts|tsx)$/.test(f) && !f.endsWith(".test.ts") && readFileSync(p, "utf8").includes("Math.random")) offenders.push(p);
      });
    walk(join(ROOT, "packages"));
    walk(join(ROOT, "apps"));
    expect(offenders).toEqual([]);
  });

  it("S-02 private keys are never written to storage in plaintext", async () => {
    const kv = new MemoryStore();
    const vault = new IdentityVault(kv);
    await vault.create("a long enough password");
    const sk = vault.secretKey();
    const hex = bytesToHex(sk);
    const nsec = nip19.nsecEncode(sk);
    for (const v of kv.data.values()) {
      expect(v).not.toContain(hex);
      expect(v).not.toContain(nsec);
    }
    // The web app forbids localStorage writes at lint level and stores only through IndexedDB/vault.
    const eslint = readFileSync(join(ROOT, "eslint.config.js"), "utf8");
    expect(eslint).toContain('object: "localStorage", property: "setItem"');
  });

  it("S-03 identity recovery works on a fresh installation, including history from relays", async () => {
    const relay = await startRelay({ port: 0 });
    const kvA = new MemoryStore();
    const alice = await makePeer([relay.url], undefined, kvA);
    const bob = await makePeer([relay.url]);
    await alice.messenger.send([bob.pubkey], { type: "text", content: "before the wipe" });
    await waitFor(() => bob.inbox.length === 1);
    const backup = JSON.stringify(createIdentityBackup(alice.sk, "backup password 123"));
    await alice.stop();

    // Fresh installation: empty storage, identity restored from the file, history re-synced from the relay.
    const fresh = new IdentityVault(new MemoryStore());
    const restored = await fresh.importSecret(restoreIdentityBackup(backup, "backup password 123"), "new device password");
    expect(restored.pubkey).toBe(alice.pubkey);
    const alice2 = await makePeer([relay.url], fresh.secretKey(), new MemoryStore());
    await waitFor(() => alice2.store.all().some((m) => m.content === "before the wipe"), 10_000, "history resync");
    await alice2.stop();
    await bob.stop();
    await relay.close();
  }, 30_000);

  it("S-04 invalid signed messages are rejected", async () => {
    const alice = generateSecretKey();
    const bob = generateSecretKey();
    const B = getPublicKey(bob);
    // Impersonation: Mallory seals a rumor that claims Alice as author.
    const rumor = { kind: 14, content: "hi", tags: [["p", B]], created_at: 1_700_000_000, pubkey: getPublicKey(alice) } as ReturnType<typeof nip59.createRumor>;
    rumor.id = getEventHash(rumor);
    expect(() => openGiftWrap(nip59.createWrap(nip59.createSeal(rumor, generateSecretKey(), B), B), bob)).toThrow();
    // Content altered after hashing.
    const r2 = nip59.createRumor({ kind: 14, content: "pay 1", tags: [["p", B]] }, alice);
    expect(() => openGiftWrap(nip59.createWrap(nip59.createSeal({ ...r2, content: "pay 1000" }, alice, B), B), bob)).toThrow(/Rumor id/);
    // Relays refuse events with bad signatures.
    const relay = await startRelay({ port: 0 });
    const peer = await makePeer([relay.url]);
    const wrap = nip59.wrapEvent({ kind: 14, content: "x", tags: [["p", B]] }, alice, B);
    const res = await peer.mesh.publish({ ...wrap, content: wrap.content.slice(0, -4) + "AAAA" });
    expect(res.outcomes[0]!.ok).toBe(false);
    expect(relay.storedEvents()).toHaveLength(0);
    await peer.stop();
    await relay.close();
  });

  it("S-05 altered payment recipients are rejected", async () => {
    const { wire } = await signed();
    expect(await verifyPaymentRequest(tampered(wire, (r) => (r.recipient = attackerWallet)), ctx())).toMatchObject({ ok: false, code: "invalid-signature" });
  });

  it("S-06 altered amounts are rejected", async () => {
    const { wire } = await signed();
    expect(await verifyPaymentRequest(tampered(wire, (r) => (r.amount = "999999999")), ctx())).toMatchObject({ ok: false, code: "invalid-signature" });
  });

  it("S-07 wrong chain ids are rejected", async () => {
    const { wire } = await signed();
    expect(await verifyPaymentRequest(tampered(wire, (r) => (r.chainId = 100)), ctx())).toMatchObject({ ok: false, code: "invalid-signature" });
    expect(await verifyPaymentRequest((await signed({ chainId: 10200 })).wire, ctx())).toMatchObject({ ok: false, code: "wrong-chain" });
  });

  it("S-08 expired payment requests are rejected", async () => {
    const { wire } = await signed({ ttlSec: 30, now: Math.floor(Date.now() / 1000) - 60 });
    expect(await verifyPaymentRequest(wire, ctx())).toMatchObject({ ok: false, code: "expired" });
  });

  it("S-09 duplicate requests are rejected", async () => {
    const c = ctx();
    const { wire } = await signed();
    const first = await verifyPaymentRequest(wire, c);
    if (!first.ok) throw new Error(first.reason);
    await c.ledger.register(first.signed, first.digest);
    expect(await verifyPaymentRequest(wire, c)).toMatchObject({ ok: false, code: "duplicate" });
  });

  it("S-10 unauthorized transactions cannot execute", async () => {
    const c = ctx();
    const { wire, req } = await signed();
    const v = await verifyPaymentRequest(wire, c);
    if (!v.ok) throw new Error(v.reason);
    await c.ledger.register(v.signed, v.digest);
    let walletTouched = false;
    const wallet: PaymentWallet = { account: async () => payer, chainId: async () => 31337, transferToken: async () => ((walletTouched = true), `0x${"0".repeat(64)}` as Hash) };
    await expect(executeApprovedPayment(c.ledger, req.requestId, wallet)).rejects.toThrow(UnauthorizedExecutionError);
    await expect(executeApprovedPayment(c.ledger, `0x${"1".repeat(64)}`, wallet)).rejects.toThrow(UnauthorizedExecutionError);
    // A forged request re-signed by an attacker's wallet never reaches the ledger.
    expect(await verifyPaymentRequest((await signed({ recipient: attackerWallet }, attackerWallet)).wire, c)).toMatchObject({ ok: false, code: "unauthorized-creator" });
    expect(walletTouched).toBe(false);
  });

  it("S-11 fake transaction success is rejected", async () => {
    const c = ctx();
    const { wire, req } = await signed({ amount: 3_000_000n });
    const v = await verifyPaymentRequest(wire, c);
    if (!v.ok) throw new Error(v.reason);
    await c.ledger.register(v.signed, v.digest);
    await c.ledger.approve(req.requestId, "user");
    const decoy = await transferDemoToken(anvil.rpcUrl, DEMO_TOKEN_ADDRESS, payer, creatorWallet, 1n);
    await executeApprovedPayment(c.ledger, req.requestId, { account: async () => payer, chainId: async () => 31337, transferToken: async () => decoy });
    const report = await settlePayment(c.ledger, req.requestId, devClients(anvil.rpcUrl).publicClient, 1);
    expect(report.status).toBe("failed");
    expect((await c.ledger.get(req.requestId))?.state).toBe("failed");
    // An unknown hash is never "paid".
    const unknown = await verifyTokenTransfer(devClients(anvil.rpcUrl).publicClient, `0x${"ef".repeat(32)}`, { chainId: 31337, token: DEMO_TOKEN_ADDRESS, from: payer, to: creatorWallet, amount: 1n }, 1);
    expect(unknown.status).not.toBe("verified");
  });

  it("S-12 wrong token contracts are rejected (request and receipt)", async () => {
    expect(await verifyPaymentRequest((await signed({ token: "0x000000000000000000000000000000000000dEaD" })).wire, ctx())).toMatchObject({ ok: false, code: "unsupported-token" });
    const lookalike = await deployDemoToken(anvil.rpcUrl, attackerWallet, "RelayMesh Demo Dollar", "rmUSD");
    await mintDemoToken(anvil.rpcUrl, lookalike, payer, 10n ** 12n, attackerWallet);
    const tx = await transferDemoToken(anvil.rpcUrl, lookalike, payer, creatorWallet, 5_000_000n);
    const r = await verifyTokenTransfer(devClients(anvil.rpcUrl).publicClient, tx, { chainId: 31337, token: DEMO_TOKEN_ADDRESS, from: payer, to: creatorWallet, amount: 5_000_000n }, 1);
    expect(r.status).toBe("failed");
  });

  describe("relay failover", () => {
    let relays: RunningRelay[];
    let alice: Peer;
    let bob: Peer;
    beforeAll(async () => {
      relays = await twoRelays();
      alice = await makePeer(relays.map((r) => r.url));
      bob = await makePeer(relays.map((r) => r.url));
    });
    afterAll(async () => {
      await alice?.stop();
      await bob?.stop();
      for (const r of relays ?? []) await r.close().catch(() => {});
    });

    it("S-13 conversation continues when one relay is shut down", async () => {
      await alice.messenger.send([bob.pubkey], { type: "text", content: "via both" });
      await waitFor(() => bob.inbox.some((m) => m.content === "via both"));
      await relays[0]!.close();
      await waitFor(() => alice.mesh.openRelays().length === 1 && bob.mesh.openRelays().length === 1, 10_000, "failover detection");
      const sent = await alice.messenger.send([bob.pubkey], { type: "text", content: "via relay B only" });
      expect(sent.status).toBe("sent");
      await waitFor(() => bob.inbox.some((m) => m.content === "via relay B only"));
      await bob.messenger.send([alice.pubkey], { type: "text", content: "reply via B" });
      await waitFor(() => alice.inbox.some((m) => m.content === "reply via B"));
    });
  });

  it("S-14 malicious or invalid operator manifests are rejected", () => {
    const op = generateSecretKey();
    const now = Math.floor(Date.now() / 1000);
    const input = { operator: { id: "op", name: "Op" }, relayUrl: "wss://relay.op.example", protocols: ["nostr"], capabilities: ["nip-01" as const], software: { name: "x", version: "1" } };
    const good = signOperatorManifest(input, op, now);
    expect(verifyOperatorManifest(good).manifest.operator.id).toBe("op");
    const cases: [string, unknown, string][] = [
      ["tampered url", { ...good, content: good.content.replace("relay.op.example", "evil.example") }, "bad-signature"],
      ["forged signature", { ...good, sig: "0".repeat(128) }, "bad-signature"],
      ["expired", signOperatorManifest({ ...input, validForSec: 10 }, op, now - 100), "expired"],
      ["impostor key for a pinned operator", signOperatorManifest(input, generateSecretKey(), now), "pinned-key-mismatch"],
      ["wrong event kind", { ...good, kind: 1 }, "wrong-kind"],
      ["garbage", "{oops", "malformed"],
    ];
    for (const [name, input, code] of cases) {
      let got = "accepted";
      try {
        verifyOperatorManifest(input, { pinnedKeys: { op: getPublicKey(op) } });
      } catch (e) {
        got = e instanceof ManifestError ? e.code : `error:${(e as Error).message}`;
      }
      expect(got, name).toBe(code);
    }
  });
});

export type { PaymentRequest };
