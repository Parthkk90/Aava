/**
 * CROPS · Private payments (Tornado Cash through Kohaku) on Sepolia.
 *
 * LIVE_TESTNET=1: builds the app's ShieldedWallet over the app's RPC router, syncs the Sepolia
 * Tornado pools and prepares a 0.1 ETH deposit (no funds needed).
 * TORNADO_FUNDED_PRIVATE_KEY=0x… (a throwaway Sepolia key holding a little over 0.01 ETH) additionally
 * runs a full round trip: deposit 0.01 ETH (the smallest pool), then send it privately to a fresh
 * address via the paymaster.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { MemoryStore } from "@relaymesh/identity";
import { ANVIL_ACCOUNTS, startAnvil } from "@relaymesh/chain/testing";
import { RpcRouter, defaultRpcRouting } from "../../apps/web/src/runtime/rpc.ts";
import { newShieldedPhrase } from "../../apps/web/src/runtime/shielded-keys.ts";
import { DENOMINATION_STEP, ShieldedWallet, sepoliaCatalogPools, type TornadoSnapshot } from "../../apps/web/src/runtime/shielded.ts";

const SNAPSHOT = join(import.meta.dirname, "..", "..", "apps", "web", "public", "kohaku", "tornado-sepolia-state.json");
/** The snapshot the app ships (public pool state), as the browser loads it. */
const snapshot = async () => (existsSync(SNAPSHOT) ? (JSON.parse(readFileSync(SNAPSHOT, "utf8")) as TornadoSnapshot) : null);

const LIVE = process.env.LIVE_TESTNET === "1";
const FUNDED = process.env.TORNADO_FUNDED_PRIVATE_KEY as Hex | undefined;
const RPC = process.env.SEPOLIA_RPC_URL ?? "https://rpc.sepolia.ethpandaops.io";

function makeWallet(phrase: string, store = new MemoryStore(), send?: (tx: { to: `0x${string}`; data: Hex; value: bigint }) => Promise<Hex>, rpc = RPC) {
  const settings = defaultRpcRouting(); // direct mode
  const router = new RpcRouter({ settings: () => settings, rpcUrl: () => rpc, iframeUrl: () => "", savePin: async () => {} });
  const reader = createPublicClient({ chain: sepolia, transport: http(rpc) });
  const wallet = new ShieldedWallet({
    phrase,
    provider: () => router.eip1193(11155111, { needsHistoricalLogs: true }),
    serviceFetch: () => router.serviceFetch(),
    store,
    sendTransaction: send ?? (async () => Promise.reject(new Error("no wallet in this test"))),
    waitForReceipt: async (hash) => ({ status: (await reader.waitForTransactionReceipt({ hash, timeout: 300_000 })).status }),
    log: (m) => console.log(`[shielded] ${m}`),
    snapshot,
  });
  return { wallet, store };
}

describe.skipIf(!LIVE)("CROPS · Private payments (live Sepolia, Kohaku Tornado)", () => {
  it("S-17 syncs the Sepolia pools through the app's router and prepares a deposit into a catalog pool", async () => {
    const { wallet, store } = makeWallet(newShieldedPhrase());
    expect(existsSync(SNAPSHOT), "the app ships a Sepolia pool snapshot").toBe(true);
    const ms = await wallet.sync();
    console.log(`[shielded] first sync (seeded from the shipped snapshot) took ${Math.round(ms / 1000)} s`);
    expect(ms).toBeLessThan(10 * 60_000);
    expect(await wallet.balance()).toBe(0n); // a brand-new phrase owns no notes
    const txns = await wallet.prepareShield(DENOMINATION_STEP);
    expect(txns).toHaveLength(1);
    expect(txns[0]!.value).toBe(DENOMINATION_STEP);
    const pools = await sepoliaCatalogPools();
    expect(pools.length).toBeGreaterThan(0);
    expect(pools, `deposit target ${txns[0]!.to} is a catalog Tornado pool`).toContain(txns[0]!.to.toLowerCase());
    // Synced state is stored encrypted.
    const dump = JSON.stringify(await Promise.all((await store.keys()).map((k) => store.get(k))));
    expect(dump.length).toBeGreaterThan(100);
    expect(dump).not.toMatch(/"commitment"|"leafIndex"|tornado-cash-state/);
  }, 3_600_000);

  it("S-18a (Sepolia fork) a deposit sent from the wallet becomes this phrase's shielded balance; another phrase sees nothing", async () => {
    const fork = await startAnvil({ forkUrl: RPC });
    try {
      const payer = ANVIL_ACCOUNTS[0]!; // anvil's unlocked, funded account on the fork
      const walletClient = createWalletClient({ account: payer, chain: sepolia, transport: http(fork.rpcUrl) });
      const phrase = newShieldedPhrase();
      const { wallet } = makeWallet(phrase, new MemoryStore(), (tx) => walletClient.sendTransaction(tx), fork.rpcUrl);
      const deposits = await wallet.shield(DENOMINATION_STEP, (s) => console.log(`[shielded/fork] ${s}`));
      expect(deposits).toHaveLength(1);
      await wallet.sync();
      expect(await wallet.balance()).toBe(DENOMINATION_STEP);
      const notes = await wallet.notes();
      expect(notes).toHaveLength(1);
      expect(notes[0]!.amount).toBe(DENOMINATION_STEP);
      // The note belongs to the phrase, not to the device: a different phrase on the same chain owns nothing.
      const { wallet: stranger } = makeWallet(newShieldedPhrase(), new MemoryStore(), undefined, fork.rpcUrl);
      await stranger.sync();
      expect(await stranger.balance()).toBe(0n);
      // The same phrase restored elsewhere (fresh storage) finds the note again.
      const { wallet: restored } = makeWallet(phrase, new MemoryStore(), undefined, fork.rpcUrl);
      await restored.sync();
      expect(await restored.balance()).toBe(DENOMINATION_STEP);
    } finally {
      await fork.stop();
    }
  }, 900_000);

  it.skipIf(!FUNDED)("S-18 full round trip: deposit 0.01 ETH from a wallet, then pay a fresh address privately", async () => {
    const payer = privateKeyToAccount(FUNDED!);
    const walletClient = createWalletClient({ account: payer, chain: sepolia, transport: http(RPC) });
    const reader = createPublicClient({ chain: sepolia, transport: http(RPC) });
    // The phrase is saved (git-ignored) BEFORE any deposit, so a failed withdrawal can be retried
    // later with the same note instead of stranding the funds.
    const phraseFile = join(import.meta.dirname, "..", "..", ".shielded-test-phrase");
    if (!existsSync(phraseFile)) writeFileSync(phraseFile, newShieldedPhrase(), { mode: 0o600 });
    const phrase = readFileSync(phraseFile, "utf8").trim();
    const { wallet } = makeWallet(phrase, new MemoryStore(), (tx) => walletClient.sendTransaction(tx));
    await wallet.sync();
    if ((await wallet.balance()) < DENOMINATION_STEP) {
      const deposits = await wallet.shield(DENOMINATION_STEP, (s) => console.log(`[shielded] ${s}`));
      expect(deposits).toHaveLength(1);
      console.log(`[shielded] deposit ${deposits[0]}`);
    } else {
      console.log("[shielded] reusing the shielded note from a previous run");
    }
    expect(await wallet.balance()).toBeGreaterThanOrEqual(DENOMINATION_STEP);
    const before = await wallet.balance();

    const recipient = privateKeyToAccount(generatePrivateKey()).address;
    // A 0.01 ETH note pays ~37% in worst-case-priced sponsorship; accept up to 50% for this test.
    const res = await wallet.sendPrivately(DENOMINATION_STEP, recipient, (s) => console.log(`[shielded] ${s}`), { maxFeeBps: 5_000 });
    console.log(`[shielded] recipient ${recipient}, user operation ${res.userOperationHash}, tx ${res.transactionHash}, fee ${res.fee}`);
    expect(res.success).toBe(true);
    const received = await reader.getBalance({ address: recipient });
    expect(received).toBeGreaterThan(0n);
    expect(received).toBeLessThanOrEqual(DENOMINATION_STEP); // minus the paymaster fee
    // The withdrawal transaction does not come from the payer.
    const tx = await reader.getTransaction({ hash: res.transactionHash! });
    expect(tx.from.toLowerCase()).not.toBe(payer.address.toLowerCase());
    await wallet.sync();
    expect(await wallet.balance()).toBe(before - DENOMINATION_STEP);
  }, 3_600_000);
});
