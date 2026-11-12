import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Address } from "viem";
import { DEMO_TOKEN_ADDRESS } from "@relaymesh/chain";
import { ANVIL_ACCOUNTS, deployDemoToken, devClients, mintDemoToken, startAnvil, transferDemoToken, type Anvil } from "@relaymesh/chain/testing";
import { MemoryStore } from "@relaymesh/identity";
import { BlindTokenIssuer, BlindTokenRedeemer, BlindTokenWallet, localAttestation } from "./index.ts";

const [deployer, buyer, treasury] = ANVIL_ACCOUNTS as [Address, Address, Address];
const DENOM = 1_000n;

describe("blind tokens (experimental, RFC 9578 type 0x0002)", () => {
  let anvil: Anvil;
  let issuer: BlindTokenIssuer;
  let redeemer: BlindTokenRedeemer;

  beforeAll(async () => {
    anvil = await startAnvil();
    await deployDemoToken(anvil.rpcUrl, deployer);
    await mintDemoToken(anvil.rpcUrl, DEMO_TOKEN_ADDRESS, buyer, 1_000_000n);
    issuer = await BlindTokenIssuer.create({
      experimental: true,
      name: "issuer.relaymesh.local",
      denomination: DENOM,
      chainId: 31337,
      token: DEMO_TOKEN_ADDRESS,
      treasury,
      verifier: devClients(anvil.rpcUrl).publicClient,
      store: new MemoryStore(),
    });
    redeemer = new BlindTokenRedeemer({ experimental: true, issuerName: issuer.name, issuerPublicKey: issuer.publicKey, originInfo: ["merchant.relaymesh.local"], spent: new MemoryStore() });
  }, 60_000);
  afterAll(async () => anvil?.stop());

  it("refuses to run unless explicitly enabled", async () => {
    expect(() => new BlindTokenWallet({} as never)).toThrow(/experimental/);
    expect(localAttestation().status).toBe("not-verified");
  });

  it("issues against a verified top-up, redeems once, and rejects double spends and top-up replay", async () => {
    const wallet = new BlindTokenWallet({ experimental: true });
    const prepared = await wallet.prepare(redeemer.challengeBytes(), await issuer.publicKeyBytes(), 3);
    const topUp = await transferDemoToken(anvil.rpcUrl, DEMO_TOKEN_ADDRESS, buyer, treasury, 3n * DENOM);
    const responses = await issuer.issue({ txHash: topUp, payer: buyer }, prepared.requests);
    expect(await prepared.finalize(responses)).toBe(3);

    const t1 = wallet.take()!;
    expect(await redeemer.redeem(t1)).toMatchObject({ ok: true });
    expect(await redeemer.redeem(t1)).toEqual({ ok: false, reason: "token already spent" });
    expect(await redeemer.redeem(wallet.take()!)).toMatchObject({ ok: true });

    // The same top-up cannot mint more tokens.
    const again = await new BlindTokenWallet({ experimental: true }).prepare(redeemer.challengeBytes(), await issuer.publicKeyBytes(), 1);
    await expect(issuer.issue({ txHash: topUp, payer: buyer }, again.requests)).rejects.toThrow(/already used/);
  }, 60_000);

  it("rejects underpaid top-ups and tokens bound to another merchant's challenge", async () => {
    const wallet = new BlindTokenWallet({ experimental: true });
    const prepared = await wallet.prepare(redeemer.challengeBytes(), await issuer.publicKeyBytes(), 2);
    const underpaid = await transferDemoToken(anvil.rpcUrl, DEMO_TOKEN_ADDRESS, buyer, treasury, DENOM);
    await expect(issuer.issue({ txHash: underpaid, payer: buyer }, prepared.requests)).rejects.toThrow(/not verified/);

    const other = new BlindTokenRedeemer({ experimental: true, issuerName: issuer.name, issuerPublicKey: issuer.publicKey, originInfo: ["other-merchant.example"], spent: new MemoryStore() });
    const w2 = new BlindTokenWallet({ experimental: true });
    const p2 = await w2.prepare(other.challengeBytes(), await issuer.publicKeyBytes(), 1);
    const paid = await transferDemoToken(anvil.rpcUrl, DEMO_TOKEN_ADDRESS, buyer, treasury, DENOM);
    await p2.finalize(await issuer.issue({ txHash: paid, payer: buyer }, p2.requests));
    expect(await redeemer.redeem(w2.take()!)).toEqual({ ok: false, reason: "token was issued for a different challenge" });
    expect(await redeemer.redeem(new Uint8Array([1, 2, 3]))).toEqual({ ok: false, reason: "malformed token" });
  }, 60_000);

  it("the issuer never sees the token nonce it signs (blindness)", async () => {
    const wallet = new BlindTokenWallet({ experimental: true });
    const prepared = await wallet.prepare(redeemer.challengeBytes(), await issuer.publicKeyBytes(), 1);
    const paid = await transferDemoToken(anvil.rpcUrl, DEMO_TOKEN_ADDRESS, buyer, treasury, DENOM);
    await prepared.finalize(await issuer.issue({ txHash: paid, payer: buyer }, prepared.requests));
    const token = Buffer.from(wallet.take()!).toString("hex");
    const nonce = token.slice(4, 68); // token_type (2 bytes) || nonce (32 bytes) || ...
    const seenByIssuer = Buffer.from(prepared.requests[0]!).toString("hex");
    expect(seenByIssuer).not.toContain(nonce);
  }, 60_000);
});
