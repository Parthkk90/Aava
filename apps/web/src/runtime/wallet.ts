import { createPublicClient, createWalletClient, custom, erc20Abi, getAddress, http, type Address, type EIP1193Provider, type Hash, type WalletClient } from "viem";
import { defineChain } from "viem";
import { DEFAULT_CHAINS } from "@relaymesh/chain";
import type { PaymentWallet, typedDataFor } from "@relaymesh/payments";
import type { Hex } from "viem";

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

export type WalletKind = "none" | "injected" | "dev-node";

export interface WalletState {
  kind: WalletKind;
  account?: Address;
  chainId?: number;
  error?: string;
  devAccounts?: Address[];
}

/** A pending confirmation shown by the app for the local test wallet (which has no UI of its own). */
export interface PendingPrompt {
  id: number;
  title: string;
  lines: [string, string][];
  resolve: (ok: boolean) => void;
}

export function chainFor(id: number, rpcUrl: string) {
  const known = DEFAULT_CHAINS.find((c) => c.id === id);
  return defineChain({
    id,
    name: known?.name ?? `Chain ${id}`,
    nativeCurrency: { name: known?.nativeSymbol ?? "ETH", symbol: known?.nativeSymbol ?? "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

function isLoopback(url: string) {
  try {
    const h = new URL(url).hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "[::1]" || h === "anvil";
  } catch {
    return false;
  }
}

/**
 * Public demo builds (e.g. served through a dev tunnel) can opt in to the test
 * wallet on a non-loopback devnet RPC. The RPC must still report chain 31337.
 */
const REMOTE_DEVNET_WALLET = import.meta.env.VITE_ALLOW_REMOTE_DEVNET_WALLET === "1";

async function assertDevnetRpc(rpc: string) {
  if (!isLoopback(rpc) && !REMOTE_DEVNET_WALLET) throw new Error("The local test wallet only works with a loopback devnet RPC");
  const id = await createPublicClient({ transport: http(rpc) }).getChainId();
  if (id !== 31337) throw new Error(`RPC reports chain ${id}; the local test wallet is limited to the 31337 devnet`);
}

/**
 * Non-custodial wallet connection. Aava never sees private keys or seed
 * phrases: injected wallets sign in their own UI, and the local test wallet
 * relies on the dev node's unlocked accounts (test networks only).
 */
export class WalletController implements PaymentWallet {
  state: WalletState = { kind: "none" };
  prompt: PendingPrompt | null = null;
  private client: WalletClient | null = null;
  private devRpc: string | null = null;
  private promptCounter = 0;
  private readonly listeners = new Set<() => void>();
  private detach: (() => void) | null = null;

  constructor(private readonly rpcFor: (chainId: number) => string) {}

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private set(s: Partial<WalletState>) {
    this.state = { ...this.state, ...s };
    for (const l of this.listeners) l();
  }

  get hasInjected() {
    return typeof window !== "undefined" && !!window.ethereum;
  }

  async connectInjected() {
    const provider = window.ethereum;
    if (!provider) throw new Error("No browser wallet (EIP-1193) found. Install a wallet extension or use the local test wallet on the devnet.");
    const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
    if (!accounts[0]) throw new Error("Wallet returned no accounts");
    const chainHex = (await provider.request({ method: "eth_chainId" })) as string;
    this.client = createWalletClient({ transport: custom(provider) });
    const onAccounts = (a: unknown) => {
      const list = a as string[];
      if (!list[0]) this.disconnect();
      else this.set({ account: getAddress(list[0]) });
    };
    const onChain = (c: unknown) => this.set({ chainId: Number(c as string) });
    provider.on?.("accountsChanged", onAccounts as never);
    provider.on?.("chainChanged", onChain as never);
    this.detach = () => {
      provider.removeListener?.("accountsChanged", onAccounts as never);
      provider.removeListener?.("chainChanged", onChain as never);
    };
    this.set({ kind: "injected", account: getAddress(accounts[0]), chainId: Number(chainHex), error: undefined });
  }

  /** Lists the dev node's unlocked accounts. Only allowed for an RPC that reports chain 31337. */
  async listDevAccounts(): Promise<Address[]> {
    const rpc = this.rpcFor(31337);
    await assertDevnetRpc(rpc);
    const wc = createWalletClient({ transport: http(rpc) });
    const accounts = await wc.getAddresses();
    const list = accounts.map((a) => getAddress(a));
    this.set({ devAccounts: list });
    return list;
  }

  async connectDevNode(account: Address) {
    const rpc = this.rpcFor(31337);
    await assertDevnetRpc(rpc);
    this.devRpc = rpc;
    this.client = createWalletClient({ chain: chainFor(31337, rpc), transport: http(rpc) });
    this.set({ kind: "dev-node", account: getAddress(account), chainId: 31337, error: undefined });
  }

  disconnect() {
    this.detach?.();
    this.detach = null;
    this.client = null;
    this.devRpc = null;
    this.set({ kind: "none", account: undefined, chainId: undefined });
  }

  async switchChain(chainId: number) {
    if (this.state.kind === "dev-node") {
      if (chainId !== 31337) throw new Error("The local test wallet only supports the 31337 devnet");
      return;
    }
    const provider = window.ethereum;
    if (!provider) throw new Error("No wallet connected");
    try {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: `0x${chainId.toString(16)}` }] });
    } catch (e) {
      const code = (e as { code?: number }).code;
      if (code !== 4902) throw e;
      const known = DEFAULT_CHAINS.find((c) => c.id === chainId);
      if (!known) throw new Error(`Chain ${chainId} is not configured`, { cause: e });
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [{ chainId: `0x${chainId.toString(16)}`, chainName: known.name, nativeCurrency: { name: known.nativeSymbol, symbol: known.nativeSymbol, decimals: 18 }, rpcUrls: [this.rpcFor(chainId)], blockExplorerUrls: known.explorerUrl ? [known.explorerUrl] : undefined }],
      });
    }
  }

  /** Shows the app's own confirmation (used for the local test wallet, which has no UI). */
  private confirm(title: string, lines: [string, string][]): Promise<boolean> {
    return new Promise((resolve) => {
      this.prompt = {
        id: ++this.promptCounter,
        title,
        lines,
        resolve: (ok) => {
          this.prompt = null;
          for (const l of this.listeners) l();
          resolve(ok);
        },
      };
      for (const l of this.listeners) l();
    });
  }

  private requireClient(): { client: WalletClient; account: Address } {
    if (!this.client || !this.state.account) throw new Error("No wallet connected");
    return { client: this.client, account: this.state.account };
  }

  // ---- PaymentWallet
  async account(): Promise<Address> {
    return this.requireClient().account;
  }

  async chainId(): Promise<number> {
    const { client } = this.requireClient();
    const id = await client.getChainId();
    this.set({ chainId: id });
    return id;
  }

  /** EIP-712 signature over a payment request. Injected wallets show their own prompt. */
  async signPaymentRequest(data: ReturnType<typeof typedDataFor>, summary: [string, string][]): Promise<Hex> {
    const { client, account } = this.requireClient();
    if (this.state.kind === "dev-node" && !(await this.confirm("Sign payment request (local test wallet)", summary))) throw new Error("Signature rejected by user");
    return client.signTypedData({ ...data, account });
  }

  /** A raw transaction prepared by an SDK (e.g. a Tornado deposit). The wallet shows its own prompt. */
  async sendTransaction(tx: { to: Address; data: Hex; value: bigint }, summary: [string, string][]): Promise<Hash> {
    const { client, account } = this.requireClient();
    if (this.state.kind === "dev-node" && !(await this.confirm("Send transaction (local test wallet)", [...summary, ["To", tx.to], ["Value (wei)", tx.value.toString()]]))) {
      throw new Error("Transaction rejected by user");
    }
    const chainId = await client.getChainId();
    return client.sendTransaction({ account, to: tx.to, data: tx.data, value: tx.value, chain: chainFor(chainId, this.devRpc ?? this.rpcFor(chainId)) });
  }

  async transferToken(token: Address, to: Address, amount: bigint): Promise<Hash> {
    const { client, account } = this.requireClient();
    if (this.state.kind === "dev-node") {
      const ok = await this.confirm("Send token transfer (local test wallet)", [
        ["Token contract", token],
        ["Recipient", to],
        ["Amount (base units)", amount.toString()],
        ["From", account],
      ]);
      if (!ok) throw new Error("Transfer rejected by user");
    }
    const chainId = await client.getChainId();
    return client.writeContract({
      address: token,
      abi: erc20Abi,
      functionName: "transfer",
      args: [to, amount],
      account,
      chain: chainFor(chainId, this.devRpc ?? this.rpcFor(chainId)),
    });
  }
}
