/**
 * Private (shielded) payments with Tornado Cash through Kohaku (@kohaku-eth/tornado-cash).
 *
 * Flow:
 *  1. Shield: `prepareShield` returns deposit transactions; the user's own wallet signs and sends
 *     them (fixed pools: 0.1 and 1 Sepolia ETH).
 *  2. Send privately: `prepareUnshield(..., { mode: 'paymaster' })` builds a zero-knowledge
 *     withdrawal to the recipient as a paymaster-sponsored ERC-4337 user operation; the paymaster
 *     takes its fee from the note, so the payer's public account is never involved. The bundler
 *     submission goes through `RpcRouter.serviceFetch`, i.e. through the mixnet in anonymous mode.
 *
 * Kohaku host built here:
 *  - provider: Kohaku's `raw()` provider over the app's RPC router (direct or anonymous; light-client
 *    mode is refused because note sync scans years of eth_getLogs).
 *  - keystore: the separate recovery phrase (shielded-keys.ts), scoped to Tornado's paths.
 *  - storage: IndexedDB, every value AES-GCM encrypted with a key derived from the phrase.
 *  - network: the router's service fetch.
 *
 * Experimental: Kohaku's Tornado package is alpha and "still undergoing audits". Sepolia only.
 */
// Kohaku code is loaded on first use (dynamic import): only people who open private payments download it.
import type { TCInstance, TCNote } from "@kohaku-eth/tornado-cash";
import type { Host, Storage } from "@kohaku-eth/plugins";

const loadKohaku = async () => {
  const [tornado, plugins, provider] = await Promise.all([import("@kohaku-eth/tornado-cash"), import("@kohaku-eth/plugins"), import("@kohaku-eth/provider/raw")]);
  return { ...tornado, MnemonicKeystore: plugins.MnemonicKeystore, scopeKeystore: plugins.scopeKeystore, raw: provider.raw };
};
import { mnemonicToEntropy } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { getAddress, type Address, type Hash, type Hex } from "viem";
import type { KeyValueStore } from "@relaymesh/identity";
import type { Eip1193Like } from "./rpc.ts";

export const SHIELDED_CHAIN_ID = 11155111;
/**
 * Smallest Sepolia ETH pool (an "extended" Tornado pool Kohaku knows, outside the instance
 * registry). Pools: 0.01, 0.03, 0.1, 0.3, 1, 3, 10, 30 ETH; every amount must be a sum of them.
 */
export const DENOMINATION_STEP = 10n ** 16n;
export const SEPOLIA_ETH_POOLS = [10n ** 16n, 3n * 10n ** 16n, 10n ** 17n, 3n * 10n ** 17n, 10n ** 18n];
/** Kohaku's id for native ETH (E_ADDRESS). */
export const ETH_ASSET = { __type: "erc20" as const, contract: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as `0x${string}` };
const STORAGE_PREFIX = "relaymesh.shielded-state.v1.";
const SEEDED_MARKER = "relaymesh.shielded-seeded.v1";

/** Public pool state produced by apps/web/scripts/tornado-snapshot.ts (Kohaku's own storage entries). */
export interface TornadoSnapshot {
  format: "relaymesh.tornado-snapshot";
  v: 1;
  chainId: number;
  head: number;
  createdAt: string;
  entries: Record<string, string>;
}
const TORNADO_PATH_PREFIX = "m/29795'/1'";

export interface TornadoArtifacts {
  circuitText: string;
  provingKey: ArrayBuffer;
}

export interface ShieldedDeps {
  phrase: string;
  /** Chain reads (Kohaku wraps this with `raw()`). */
  provider: () => Promise<Eip1193Like>;
  /** Fetch for the bundler and relayers (anonymized in anonymous RPC mode). */
  serviceFetch: () => Promise<typeof fetch>;
  store: KeyValueStore;
  /** Proving artifacts; Kohaku checks them against pinned SHA-256 hashes whatever the source. */
  artifacts?: () => Promise<TornadoArtifacts>;
  /** URL of Kohaku's state-manager worker (browser builds serve it next to the app). */
  workerUrl?: string;
  /** Sends a deposit transaction from the user's own wallet (its prompt). */
  sendTransaction: (tx: { to: Address; data: Hex; value: bigint }) => Promise<Hash>;
  waitForReceipt: (hash: Hash) => Promise<{ status: "success" | "reverted" }>;
  log?: (msg: string) => void;
  /** Optional public state snapshot to seed an empty store, so the first sync reads only recent blocks. */
  snapshot?: () => Promise<TornadoSnapshot | null>;
}

export interface PrivateSendResult {
  userOperationHash: Hex;
  transactionHash?: Hash;
  success?: boolean;
  /** Paymaster fee bound into the proof (taken from the note), in wei. */
  fee?: bigint;
  /** Note value spent, before the fee. */
  withdrawnValue?: bigint;
}

/** Addresses of the Tornado pools Kohaku's catalog allows deposits into on Sepolia (lowercase). */
export async function sepoliaCatalogPools(): Promise<string[]> {
  const { TornadoInstances } = await loadKohaku();
  const catalog = (TornadoInstances as unknown as Record<string, { address: bigint }[]>)[String(SHIELDED_CHAIN_ID)] ?? [];
  return catalog.map((i) => `0x${i.address.toString(16).padStart(40, "0")}`);
}

export function isValidShieldAmount(amount: bigint): boolean {
  return amount > 0n && amount % DENOMINATION_STEP === 0n;
}

/** Kohaku Storage on top of the app's key-value store, with AES-GCM encryption of every value. */
export async function encryptedStorage(store: KeyValueStore, phrase: string): Promise<Storage> {
  const entropy = mnemonicToEntropy(phrase, wordlist);
  const label = new TextEncoder().encode("aava/shielded-storage/v1");
  const material = new Uint8Array(entropy.length + label.length);
  material.set(entropy);
  material.set(label, entropy.length);
  const digest = await crypto.subtle.digest("SHA-256", material);
  const key = await crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
  const b64 = (u: Uint8Array) => btoa(Array.from(u, (c) => String.fromCharCode(c)).join(""));
  const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  return {
    _brand: "Storage",
    async set(k, value) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(value)));
      await store.set(STORAGE_PREFIX + k, `${b64(iv)}.${b64(ct)}`);
    },
    async get(k) {
      const rec = await store.get(STORAGE_PREFIX + k);
      if (!rec) return null;
      const [iv, ct] = rec.split(".");
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv!) }, key, unb64(ct!));
      return new TextDecoder().decode(pt);
    },
  };
}

export class ShieldedWallet {
  private plugin: Promise<{ tc: TCInstance; host: Host; kohaku: Awaited<ReturnType<typeof loadKohaku>> }> | null = null;
  syncing = false;
  lastSyncMs?: number;

  constructor(private readonly deps: ShieldedDeps) {}

  private log(m: string) {
    this.deps.log?.(m);
  }

  private init() {
    if (this.plugin) return this.plugin;
    this.plugin = (async () => {
      const kohaku = await loadKohaku();
      const { raw, scopeKeystore, MnemonicKeystore, createTCPlugin, TornadoCashConfigs } = kohaku;
      const eip = await this.deps.provider();
      const chain = Number(await eip.request({ method: "eth_chainId" }));
      if (chain !== SHIELDED_CHAIN_ID) throw new Error(`Private payments run on Sepolia (11155111); the RPC is on chain ${chain}`);
      const storage = await encryptedStorage(this.deps.store, this.deps.phrase);
      await this.seedFromSnapshot(storage);
      const host: Host = {
        // Kohaku's raw() provider over the app's RPC router.
        provider: raw({ request: async (args: { method: string; params?: unknown }) => (await this.deps.provider()).request(args) } as never),
        network: { fetch: async (input, init) => (await this.deps.serviceFetch())(input, init) },
        storage,
        // Only Tornado's own derivation paths: the phrase cannot be used for anything else here.
        keystore: scopeKeystore(new MnemonicKeystore(this.deps.phrase), { prefixes: [TORNADO_PATH_PREFIX] }),
      };
      const tc = createTCPlugin(host, {
        accountIndex: 0,
        protocolConfig: TornadoCashConfigs[SHIELDED_CHAIN_ID],
        // Also the 0.01 / 0.03 / 0.3 / 3 / 10 / 30 ETH pools (supported by the Sepolia paymaster).
        useExtendedEthPools: true,
        ...(this.deps.artifacts ? { artifactsLoader: this.deps.artifacts } : {}),
        ...(this.deps.workerUrl ? { stateManagerWorkerUrl: this.deps.workerUrl } : {}),
      });
      return { tc, host, kohaku };
    })();
    this.plugin.catch(() => (this.plugin = null));
    return this.plugin;
  }

  /** Copies a public snapshot into empty storage once. A bad snapshot cannot move funds: proofs use on-chain roots. */
  private async seedFromSnapshot(storage: Storage) {
    if (!this.deps.snapshot || (await this.deps.store.get(SEEDED_MARKER))) return;
    const snap = await this.deps.snapshot().catch(() => null);
    if (!snap || snap.format !== "relaymesh.tornado-snapshot" || snap.chainId !== SHIELDED_CHAIN_ID) return;
    for (const [k, v] of Object.entries(snap.entries)) await storage.set(k, v);
    await this.deps.store.set(SEEDED_MARKER, JSON.stringify({ head: snap.head, createdAt: snap.createdAt }));
    this.log(`seeded from snapshot at block ${snap.head} (${snap.createdAt})`);
  }

  /** Scans pool events into encrypted local storage. The first run reads the pools' whole history. */
  async sync(): Promise<number> {
    const { tc } = await this.init();
    this.syncing = true;
    const t0 = Date.now();
    try {
      await tc.sync();
      this.lastSyncMs = Date.now() - t0;
      return this.lastSyncMs;
    } finally {
      this.syncing = false;
    }
  }

  /** Spendable shielded Sepolia ETH (syncs first). */
  async balance(): Promise<bigint> {
    const { tc } = await this.init();
    const [row] = await tc.balance([ETH_ASSET]);
    return row?.amount ?? 0n;
  }

  async notes(): Promise<TCNote[]> {
    const { tc } = await this.init();
    return tc.notes ? tc.notes([ETH_ASSET]) : [];
  }

  /** Builds the deposit transactions without sending them. */
  async prepareShield(amount: bigint) {
    if (!isValidShieldAmount(amount)) throw new Error("Amount must be a multiple of 0.01 ETH (Sepolia pools: 0.01, 0.03, 0.1, 0.3, 1 ETH and up)");
    const { tc, kohaku } = await this.init();
    if (!tc.prepareShield) throw new Error("This Tornado plugin build cannot shield");
    const op = await tc.prepareShield({ asset: ETH_ASSET, amount }, { strategy: kohaku.DepositStrategy.MinFee });
    const total = op.txns.reduce((s, t) => s + t.value, 0n);
    // Kohaku drops a remainder no pool can hold; refuse rather than deposit a different amount.
    if (total !== amount) throw new Error(`Pools can hold ${total} wei of the requested ${amount}; nothing was sent`);
    return op.txns.map((t) => ({ to: getAddress(t.to), data: t.data as Hex, value: t.value }));
  }

  /** Deposits from the user's wallet, one transaction per note, waiting for each receipt. */
  async shield(amount: bigint, onStage?: (s: string) => void): Promise<Hash[]> {
    const txns = await this.prepareShield(amount);
    const hashes: Hash[] = [];
    for (const [i, tx] of txns.entries()) {
      onStage?.(`Confirm deposit ${i + 1} of ${txns.length} in your wallet`);
      const hash = await this.deps.sendTransaction(tx);
      hashes.push(hash);
      onStage?.(`Waiting for deposit ${i + 1} of ${txns.length} to be mined`);
      const r = await this.deps.waitForReceipt(hash);
      if (r.status !== "success") throw new Error(`Deposit transaction ${hash} reverted`);
    }
    this.log(`shielded ${amount} wei in ${hashes.length} note(s)`);
    return hashes;
  }

  /**
   * Withdraws `amount` from the shielded balance to `recipient` as a paymaster-sponsored user
   * operation. The recipient receives the amount minus the paymaster's fee.
   */
  async sendPrivately(amount: bigint, recipient: Address, onStage?: (s: string) => void, opts: { maxFeeBps?: number } = {}): Promise<PrivateSendResult> {
    // The fee is committed with worst-case gas, so small notes pay a large share (seen live: ~37% of
    // a 0.01 ETH note, ~4% of 0.1 ETH). Default cap 20%; callers may accept more explicitly.
    const maxFeeBps = BigInt(opts.maxFeeBps ?? 2_000);
    if (!isValidShieldAmount(amount)) throw new Error("Amount must be a multiple of 0.01 ETH");
    const { tc, host, kohaku } = await this.init();
    onStage?.("Generating the zero-knowledge proof (this can take a minute)");
    if (!tc.prepareUnshield) throw new Error("This Tornado plugin build cannot unshield");
    // 'required': a withdrawal is only submitted with gas the bundler actually estimated. The
    // conservative fallback can be rejected at admission (seen live: AA26 over verificationGasLimit).
    const op = await tc.prepareUnshield({ asset: ETH_ASSET, amount }, getAddress(recipient), {
      mode: "paymaster",
      gasEstimationPolicy: "required",
      // Kohaku's default ceilings sit below what the Sepolia bundler estimates (seen live: ~205k for the
      // EIP-7702 sender, ~1.54M for paymaster verification, which checks the ZK proof). Explicit
      // ceilings, including execution gas, as Kohaku recommends for an untrusted bundler; the 20% fee
      // guard below still bounds what the note pays.
      maxGasLimits: { verificationGasLimit: 400_000n, paymasterVerificationGasLimit: 2_000_000n, callGasLimit: 1_000_000n },
    });
    const w = op.withdrawals[0];
    this.log(`prepared withdrawal: fee ${w?.fee ?? "?"} wei of ${w?.withdrawnValue ?? amount}; gas ${JSON.stringify(w?.gasEstimation ?? {})}`);
    // Kohaku has no percentage fee cap; refuse sponsorship above maxFeeBps of the note.
    if (w?.fee !== undefined && w.fee * 10_000n > (w.withdrawnValue ?? amount) * maxFeeBps) {
      throw new Error(`The paymaster fee (${w.fee} wei) is more than ${Number(maxFeeBps) / 100}% of the amount; nothing was sent and the note is still yours. Larger notes pay a smaller share.`);
    }
    onStage?.("Submitting to the ERC-4337 bundler");
    const [res] = await kohaku.createTCBroadcaster(host).broadcast(op);
    if (!res?.id) throw new Error("The bundler did not accept the withdrawal (no user operation id); the note is still yours");
    const result: PrivateSendResult = { userOperationHash: res.id as Hex, ...(w?.fee !== undefined ? { fee: w.fee } : {}), ...(w?.withdrawnValue !== undefined ? { withdrawnValue: w.withdrawnValue } : {}) };
    onStage?.("Waiting for the withdrawal to be included");
    const receipt = await this.waitForUserOperation(res.id as Hex);
    if (receipt) Object.assign(result, receipt);
    return result;
  }

  /** Polls the bundler for the user operation's receipt (eth_getUserOperationReceipt). */
  async waitForUserOperation(id: Hex, timeoutMs = 180_000): Promise<{ transactionHash: Hash; success: boolean } | null> {
    const url = (await loadKohaku()).TornadoPaymasterConfigs[SHIELDED_CHAIN_ID].bundlerUrl;
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const f = await this.deps.serviceFetch();
      const res = await f(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getUserOperationReceipt", params: [id] }) });
      const body = (await res.json()) as { result?: { success: boolean; receipt: { transactionHash: Hash } } | null };
      if (body.result) return { transactionHash: body.result.receipt.transactionHash, success: body.result.success };
      await new Promise((r) => setTimeout(r, 5_000));
    }
    return null;
  }
}
