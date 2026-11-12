import { getAddress, isAddress, type Address } from "viem";

export interface ChainConfig {
  id: number;
  name: string;
  rpcUrls: string[];
  explorerUrl?: string;
  nativeSymbol: string;
  testnet: boolean;
  /** Blocks required (including the inclusion block) before a payment counts as final. */
  minConfirmations: number;
}

export interface TokenConfig {
  chainId: number;
  /** Checksummed contract address. Tokens are identified by address, never by symbol. */
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  /** Where the address was taken from, shown to users so they can check it independently. */
  source: string;
}

/**
 * Explicit chain registry. RPC URLs are user-replaceable defaults; RelayMesh
 * does not operate any RPC endpoint.
 */
export const DEFAULT_CHAINS: ChainConfig[] = [
  {
    id: 31337,
    name: "Local devnet (anvil)",
    rpcUrls: ["http://127.0.0.1:8545"],
    nativeSymbol: "ETH",
    testnet: true,
    minConfirmations: 1,
  },
  {
    id: 10200,
    name: "Gnosis Chiado (testnet)",
    rpcUrls: ["https://rpc.chiadochain.net"],
    explorerUrl: "https://gnosis-chiado.blockscout.com",
    nativeSymbol: "xDAI",
    testnet: true,
    minConfirmations: 3,
  },
  {
    id: 11155111,
    name: "Sepolia (testnet)",
    rpcUrls: ["https://ethereum-sepolia-rpc.publicnode.com"],
    explorerUrl: "https://sepolia.etherscan.io",
    nativeSymbol: "ETH",
    testnet: true,
    minConfirmations: 3,
  },
  {
    id: 100,
    name: "Gnosis Chain",
    rpcUrls: ["https://rpc.gnosischain.com"],
    explorerUrl: "https://gnosisscan.io",
    nativeSymbol: "xDAI",
    testnet: false,
    minConfirmations: 12,
  },
];

/**
 * Deterministic address of the first contract deployed by anvil's default
 * account 0 at nonce 0 (see infra/scripts/deploy-demo-token). Only valid on 31337.
 */
export const DEMO_TOKEN_ADDRESS: Address = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

export const DEFAULT_TOKENS: TokenConfig[] = [
  {
    chainId: 31337,
    address: DEMO_TOKEN_ADDRESS,
    symbol: "rmUSD",
    name: "RelayMesh Demo Dollar (test token, no value)",
    decimals: 6,
    source: "contracts/src/DemoToken.sol deployed by the demo script",
  },
  {
    chainId: 11155111,
    address: "0x7528272FD75b3F7d137A0700B07f5De2294729E3",
    symbol: "rmUSD",
    name: "RelayMesh Demo Dollar (Sepolia test token, no value)",
    decimals: 6,
    source: "deployments/11155111.json, deployed by scripts/deploy-testnet.ts; verify on sepolia.etherscan.io",
  },
  {
    chainId: 100,
    address: "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d",
    symbol: "WXDAI",
    name: "Wrapped XDAI",
    decimals: 18,
    source: "Gnosis Chain canonical WXDAI — verify on gnosisscan.io before use",
  },
];

export function normalizeAddress(a: string): Address {
  if (!isAddress(a, { strict: false })) throw new Error(`Invalid address: ${a}`);
  return getAddress(a);
}

export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export class TokenRegistry {
  private tokens: TokenConfig[];
  constructor(tokens: TokenConfig[] = DEFAULT_TOKENS) {
    this.tokens = tokens.map((t) => ({ ...t, address: normalizeAddress(t.address) }));
  }
  forChain(chainId: number): TokenConfig[] {
    return this.tokens.filter((t) => t.chainId === chainId);
  }
  /** Lookup strictly by (chainId, address). Symbols are never used for trust decisions. */
  find(chainId: number, address: string): TokenConfig | undefined {
    return this.tokens.find((t) => t.chainId === chainId && sameAddress(t.address, address));
  }
  add(t: TokenConfig) {
    if (this.find(t.chainId, t.address)) return;
    this.tokens.push({ ...t, address: normalizeAddress(t.address) });
  }
  remove(chainId: number, address: string) {
    this.tokens = this.tokens.filter((t) => !(t.chainId === chainId && sameAddress(t.address, address)));
  }
  all(): TokenConfig[] {
    return this.tokens.slice();
  }
}

/** Formats a base-unit amount for display without floating point. */
export function formatUnitsExact(amount: bigint, decimals: number): string {
  const neg = amount < 0n;
  const v = neg ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

/** Parses a decimal string into base units; rejects excess precision instead of rounding. */
export function parseUnitsExact(value: string, decimals: number): bigint {
  const s = value.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error("Amount must be a positive decimal number");
  const [whole, frac = ""] = s.split(".");
  if (frac.length > decimals) throw new Error(`Amount has more than ${decimals} decimal places`);
  return BigInt(whole!) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}
