import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { foundry } from "viem/chains";
import type { Address, Hash } from "viem";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { TokenRegistry, DEMO_TOKEN_ADDRESS } from "@relaymesh/chain";
import { ANVIL_ACCOUNTS, deployDemoToken, devClients, mintDemoToken, startAnvil, transferDemoToken, type Anvil } from "@relaymesh/chain/testing";
import {
  ContactWalletPolicy,
  RequestLedger,
  TreasuryPolicy,
  UnauthorizedExecutionError,
  communityIdFromString,
  createPaymentRequest,
  executeApprovedPayment,
  settlePayment,
  toWire,
  typedDataFor,
  verifyPaymentRequest,
  type PaymentRequest,
  type PaymentWallet,
  type SignedPaymentRequest,
} from "./index.ts";

class MapStore {
  m = new Map<string, string>();
  async get(k: string) {
    return this.m.get(k);
  }
  async set(k: string, v: string) {
    this.m.set(k, v);
  }
}

const creator = privateKeyToAccount(generatePrivateKey());
const attackerWallet = privateKeyToAccount(generatePrivateKey());
const creatorNostr = getPublicKey(generateSecretKey());
const RECIPIENT = "0x1111111111111111111111111111111111111111" as Address;
const ATTACKER = "0x2222222222222222222222222222222222222222" as Address;

async function sign(req: PaymentRequest, account = creator): Promise<SignedPaymentRequest> {
  return { request: req, signature: await account.signTypedData(typedDataFor(req)) };
}

function baseRequest(over: Partial<Parameters<typeof createPaymentRequest>[0]> = {}) {
  return createPaymentRequest({
    creatorPubkey: creatorNostr,
    creatorWallet: creator.address,
    chainId: 31337,
    token: DEMO_TOKEN_ADDRESS,
    recipient: RECIPIENT,
    amount: 5_000_000n,
    description: "Hosting for March",
    ...over,
  });
}

function ctx(over: Partial<Parameters<typeof verifyPaymentRequest>[1]> = {}) {
  return {
    expectedChainId: 31337,
    tokens: new TokenRegistry(),
    policy: new ContactWalletPolicy({ [creatorNostr]: [creator.address] }),
    ledger: new RequestLedger(new MapStore()),
    messageAuthor: creatorNostr,
    ...over,
  };
}

/** Simulates an attacker editing the JSON in transit. */
function tamper(signed: SignedPaymentRequest, edit: (r: Record<string, unknown>) => void) {
  const wire = JSON.parse(JSON.stringify(toWire(signed))) as { request: Record<string, unknown> };
  edit(wire.request);
  return wire;
}

describe("payment request verification", () => {
  it("accepts a valid request and records evidence", async () => {
    const r = await verifyPaymentRequest(toWire(await sign(baseRequest())), ctx());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.steps.map((s) => s.check)).toEqual(["schema", "signature", "author", "chain", "token", "expiry", "policy", "replay"]);
  });

  it("S-05 rejects a modified recipient", async () => {
    const r = await verifyPaymentRequest(tamper(await sign(baseRequest()), (q) => (q.recipient = ATTACKER)), ctx());
    expect(r).toMatchObject({ ok: false, code: "invalid-signature" });
  });

  it("S-06 rejects a modified amount", async () => {
    const r = await verifyPaymentRequest(tamper(await sign(baseRequest()), (q) => (q.amount = "5000000000")), ctx());
    expect(r).toMatchObject({ ok: false, code: "invalid-signature" });
  });

  it("S-07 rejects a modified chain id and a request for another chain", async () => {
    const tampered = await verifyPaymentRequest(tamper(await sign(baseRequest()), (q) => (q.chainId = 100)), ctx());
    expect(tampered).toMatchObject({ ok: false, code: "invalid-signature" });
    const other = await verifyPaymentRequest(toWire(await sign(baseRequest({ chainId: 100 }))), ctx());
    expect(other).toMatchObject({ ok: false, code: "wrong-chain" });
  });

  it("S-08 rejects expired requests", async () => {
    const req = baseRequest({ ttlSec: 60, now: Math.floor(Date.now() / 1000) - 120 });
    const r = await verifyPaymentRequest(toWire(await sign(req)), ctx());
    expect(r).toMatchObject({ ok: false, code: "expired" });
  });

  it("S-09 rejects duplicate request ids", async () => {
    const c = ctx();
    const wire = toWire(await sign(baseRequest()));
    const first = await verifyPaymentRequest(wire, c);
    expect(first.ok).toBe(true);
    if (first.ok) await c.ledger.register(first.signed, first.digest);
    const second = await verifyPaymentRequest(wire, c);
    expect(second).toMatchObject({ ok: false, code: "duplicate" });
  });

  it("S-12 rejects unsupported token contracts, even with a familiar symbol", async () => {
    const r = await verifyPaymentRequest(toWire(await sign(baseRequest({ token: "0x000000000000000000000000000000000000dEaD" }))), ctx());
    expect(r).toMatchObject({ ok: false, code: "unsupported-token" });
  });

  it("rejects an attacker who re-signs an altered request with their own wallet", async () => {
    const forged = baseRequest({ creatorWallet: attackerWallet.address, recipient: ATTACKER });
    const r = await verifyPaymentRequest(toWire(await sign(forged, attackerWallet)), ctx());
    expect(r).toMatchObject({ ok: false, code: "unauthorized-creator" });
  });

  it("rejects when the chat sender is not the declared creator", async () => {
    const r = await verifyPaymentRequest(toWire(await sign(baseRequest())), ctx({ messageAuthor: getPublicKey(generateSecretKey()) }));
    expect(r).toMatchObject({ ok: false, code: "author-mismatch" });
  });

  it("does not silently trust an unknown contact wallet", async () => {
    const r = await verifyPaymentRequest(toWire(await sign(baseRequest())), ctx({ policy: new ContactWalletPolicy() }));
    expect(r).toMatchObject({ ok: false, code: "unknown-wallet" });
  });

  it("rejects malformed and over-specified payloads", async () => {
    const wire = toWire(await sign(baseRequest())) as unknown as Record<string, unknown>;
    expect(await verifyPaymentRequest({ ...wire, extra: 1 }, ctx())).toMatchObject({ ok: false, code: "malformed" });
    expect(await verifyPaymentRequest("{not json", ctx())).toMatchObject({ ok: false, code: "malformed" });
    expect(await verifyPaymentRequest(tamper(await sign(baseRequest()), (q) => (q.amount = "-1")), ctx())).toMatchObject({ ok: false, code: "malformed" });
  });

  it("enforces treasury policies", async () => {
    const communityId = communityIdFromString("demo-collective");
    const policy = new TreasuryPolicy({ communityId, authorizedSigners: [{ wallet: creator.address, pubkey: creatorNostr }], allowedRecipients: [RECIPIENT], maxAmount: { [DEMO_TOKEN_ADDRESS.toLowerCase()]: 10_000_000n } });
    expect((await verifyPaymentRequest(toWire(await sign(baseRequest({ communityId }))), ctx({ policy }))).ok).toBe(true);
    expect(await verifyPaymentRequest(toWire(await sign(baseRequest({ communityId, recipient: ATTACKER }))), ctx({ policy }))).toMatchObject({ code: "recipient-not-allowed" });
    expect(await verifyPaymentRequest(toWire(await sign(baseRequest({ communityId, amount: 10_000_001n }))), ctx({ policy }))).toMatchObject({ code: "amount-exceeds-limit" });
    expect(await verifyPaymentRequest(toWire(await sign(baseRequest()))
      , ctx({ policy }))).toMatchObject({ code: "unauthorized-creator" });
  });
});

describe("ledger and execution", () => {
  it("S-10 refuses to execute unapproved, declined, or expired requests", async () => {
    const c = ctx();
    const r = await verifyPaymentRequest(toWire(await sign(baseRequest())), c);
    if (!r.ok) throw new Error(r.reason);
    await c.ledger.register(r.signed, r.digest);
    let walletCalled = false;
    const wallet: PaymentWallet = {
      account: async () => ANVIL_ACCOUNTS[1]!,
      chainId: async () => 31337,
      transferToken: async () => {
        walletCalled = true;
        return `0x${"00".repeat(32)}` as Hash;
      },
    };
    const id = r.signed.request.requestId;
    await expect(executeApprovedPayment(c.ledger, id, wallet)).rejects.toThrow(UnauthorizedExecutionError);
    await c.ledger.decline(id);
    await expect(executeApprovedPayment(c.ledger, id, wallet)).rejects.toThrow(/not approved/);
    await expect(c.ledger.approve(id, "user")).rejects.toThrow(/Cannot move/);
    expect(walletCalled).toBe(false);
  });

  it("refuses execution when the wallet is on the wrong chain", async () => {
    const c = ctx();
    const r = await verifyPaymentRequest(toWire(await sign(baseRequest())), c);
    if (!r.ok) throw new Error(r.reason);
    await c.ledger.register(r.signed, r.digest);
    await c.ledger.approve(r.signed.request.requestId, "user");
    const wallet: PaymentWallet = { account: async () => ANVIL_ACCOUNTS[1]!, chainId: async () => 100, transferToken: async () => { throw new Error("must not be called"); } };
    await expect(executeApprovedPayment(c.ledger, r.signed.request.requestId, wallet)).rejects.toThrow(/chain 100/);
  });
});

describe("end to end on anvil", () => {
  let anvil: Anvil;
  const [deployer, payer, payee] = ANVIL_ACCOUNTS as [Address, Address, Address];

  beforeAll(async () => {
    anvil = await startAnvil();
    await deployDemoToken(anvil.rpcUrl, deployer);
    await mintDemoToken(anvil.rpcUrl, DEMO_TOKEN_ADDRESS, payer, 100_000_000n, deployer);
  }, 60_000);
  afterAll(async () => anvil?.stop());

  function anvilWallet(account: Address): PaymentWallet {
    const { walletClient, publicClient } = devClients(anvil.rpcUrl);
    return {
      account: async () => account,
      chainId: async () => walletClient.getChainId(),
      transferToken: async (token, to, amount) => {
        const hash = await walletClient.writeContract({ address: token, abi: (await import("@relaymesh/chain/demo-token")).demoTokenAbi, functionName: "transfer", args: [to, amount], account, chain: foundry });
        await publicClient.waitForTransactionReceipt({ hash });
        return hash;
      },
    };
  }

  it("signs via the node wallet, verifies, pays, and verifies the receipt", async () => {
    const { walletClient, publicClient } = devClients(anvil.rpcUrl);
    const req = baseRequest({ creatorWallet: payee, recipient: payee, amount: 7_000_000n });
    const signature = await walletClient.signTypedData({ account: payee, ...typedDataFor(req) });
    const c = ctx({ policy: new ContactWalletPolicy({ [creatorNostr]: [payee] }) });
    const v = await verifyPaymentRequest(toWire({ request: req, signature }), c);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    await c.ledger.register(v.signed, v.digest);
    await c.ledger.approve(req.requestId, "user");
    const hash = await executeApprovedPayment(c.ledger, req.requestId, anvilWallet(payer));
    const report = await settlePayment(c.ledger, req.requestId, publicClient, 1);
    expect(report.status).toBe("verified");
    const entry = await c.ledger.get(req.requestId);
    expect(entry).toMatchObject({ state: "paid", txHash: hash, payer });
  });

  it("S-11 does not mark paid when the wallet returns a hash for a different payment", async () => {
    const { publicClient } = devClients(anvil.rpcUrl);
    const req = baseRequest({ creatorWallet: creator.address, recipient: payee, amount: 9_000_000n });
    const c = ctx();
    const v = await verifyPaymentRequest(toWire(await sign(req)), c);
    if (!v.ok) throw new Error(v.reason);
    await c.ledger.register(v.signed, v.digest);
    await c.ledger.approve(req.requestId, "user");
    // A malicious/buggy wallet returns the hash of an unrelated, smaller transfer.
    const decoyHash = await transferDemoToken(anvil.rpcUrl, DEMO_TOKEN_ADDRESS, payer, payee, 1n);
    const lyingWallet: PaymentWallet = { account: async () => payer, chainId: async () => 31337, transferToken: async () => decoyHash };
    await executeApprovedPayment(c.ledger, req.requestId, lyingWallet);
    const report = await settlePayment(c.ledger, req.requestId, publicClient, 1);
    expect(report.status).toBe("failed");
    expect((await c.ledger.get(req.requestId))?.state).toBe("failed");
  });
});
