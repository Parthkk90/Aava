import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { foundry } from "viem/chains";
import type { Address, Hash } from "viem";
import { formatUnitsExact, parseUnitsExact, readTokenBalances, TokenRegistry, verifyTokenTransfer, DEFAULT_TOKENS, DEMO_TOKEN_ADDRESS } from "./index.ts";
import { ANVIL_ACCOUNTS, deployDemoToken, devClients, mineBlocks, mintDemoToken, startAnvil, transferDemoToken, type Anvil } from "./testing.ts";
import { demoTokenAbi } from "./demo-token.ts";

const [deployer, payer, payee, attacker] = ANVIL_ACCOUNTS as [Address, Address, Address, Address];

describe("amount parsing", () => {
  it("is exact and rejects excess precision", () => {
    expect(parseUnitsExact("12.5", 6)).toBe(12_500_000n);
    expect(formatUnitsExact(12_500_000n, 6)).toBe("12.5");
    expect(() => parseUnitsExact("0.0000001", 6)).toThrow();
    expect(() => parseUnitsExact("-1", 6)).toThrow();
    expect(() => parseUnitsExact("1e6", 6)).toThrow();
  });

  it("looks tokens up by address, never by symbol", () => {
    const reg = new TokenRegistry();
    expect(reg.find(31337, DEMO_TOKEN_ADDRESS.toLowerCase())?.symbol).toBe("rmUSD");
    expect(reg.find(31337, "0x000000000000000000000000000000000000dEaD")).toBeUndefined();
    expect(reg.find(100, DEMO_TOKEN_ADDRESS)).toBeUndefined();
    expect(DEFAULT_TOKENS.every((t) => /^0x[0-9a-fA-F]{40}$/.test(t.address))).toBe(true);
  });
});

describe("on-chain transfer verification (anvil)", () => {
  let anvil: Anvil;
  let token: Address;
  let lookalike: Address;
  let goodTx: Hash;
  const amount = 25_000_000n;

  beforeAll(async () => {
    anvil = await startAnvil();
    token = await deployDemoToken(anvil.rpcUrl, deployer);
    expect(token).toBe(DEMO_TOKEN_ADDRESS); // deterministic first deployment
    lookalike = await deployDemoToken(anvil.rpcUrl, attacker, "RelayMesh Demo Dollar", "rmUSD");
    await mintDemoToken(anvil.rpcUrl, token, payer, 1_000_000_000n, deployer);
    await mintDemoToken(anvil.rpcUrl, lookalike, payer, 1_000_000_000n, attacker);
    goodTx = await transferDemoToken(anvil.rpcUrl, token, payer, payee, amount);
  }, 60_000);

  afterAll(async () => {
    await anvil?.stop();
  });

  const client = () => devClients(anvil.rpcUrl).publicClient;
  const expected = () => ({ chainId: 31337, token, from: payer, to: payee, amount });

  it("verifies a genuine transfer", async () => {
    const r = await verifyTokenTransfer(client(), goodTx, expected(), 1);
    expect(r.status).toBe("verified");
    expect(r.checks.every((c) => c.ok)).toBe(true);
  });

  it("rejects a mismatched recipient, amount, or sender", async () => {
    expect((await verifyTokenTransfer(client(), goodTx, { ...expected(), to: attacker }, 1)).status).toBe("failed");
    expect((await verifyTokenTransfer(client(), goodTx, { ...expected(), amount: amount + 1n }, 1)).status).toBe("failed");
    expect((await verifyTokenTransfer(client(), goodTx, { ...expected(), from: attacker }, 1)).status).toBe("failed");
  });

  it("rejects a payment made with a look-alike token (same name and symbol, different contract)", async () => {
    const fakeTx = await transferDemoToken(anvil.rpcUrl, lookalike, payer, payee, amount);
    const r = await verifyTokenTransfer(client(), fakeTx, expected(), 1);
    expect(r.status).toBe("failed");
    expect(r.checks.find((c) => c.name === "Transfer emitted by expected token")?.ok).toBe(false);
  });

  it("rejects fake success: a reverted transaction", async () => {
    const { walletClient, publicClient } = devClients(anvil.rpcUrl);
    const hash = await walletClient.writeContract({
      address: token,
      abi: demoTokenAbi,
      functionName: "transfer",
      args: [payee, 10n ** 30n],
      account: payer,
      chain: foundry,
      gas: 100_000n,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("reverted");
    const r = await verifyTokenTransfer(client(), hash, expected(), 1);
    expect(r.status).toBe("failed");
  });

  it("never marks an unknown hash as paid", async () => {
    const r = await verifyTokenTransfer(client(), `0x${"ab".repeat(32)}`, expected(), 1);
    expect(r.status).toBe("pending");
  });

  it("rejects the wrong chain", async () => {
    const r = await verifyTokenTransfer(client(), goodTx, { ...expected(), chainId: 100 }, 1);
    expect(r.status).toBe("failed");
  });

  it("applies the confirmation policy", async () => {
    const tx = await transferDemoToken(anvil.rpcUrl, token, payer, payee, 1n);
    const exp = { ...expected(), amount: 1n };
    expect((await verifyTokenTransfer(client(), tx, exp, 3)).status).toBe("pending");
    await mineBlocks(anvil.rpcUrl, 2);
    expect((await verifyTokenTransfer(client(), tx, exp, 3)).status).toBe("verified");
  });

  it("reads balances and cross-checks decimals", async () => {
    const reg = new TokenRegistry();
    const [b] = await readTokenBalances(client(), payee, reg.forChain(31337));
    expect(b!.balance).toBeGreaterThanOrEqual(amount);
    expect(b!.onChainDecimals).toBe(6);
    expect(b!.error).toBeUndefined();
  });
});
