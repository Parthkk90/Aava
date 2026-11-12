import { DEFAULT_CHAINS, DEFAULT_TOKENS, type TokenConfig } from "@relaymesh/chain";
import type { KeyValueStore } from "@relaymesh/identity";
import { defaultRpcRouting, type RpcRoutingSettings } from "./rpc.ts";

export interface RelaySetting {
  url: string;
  read: boolean;
  write: boolean;
  enabled: boolean;
  /** Signed operator manifest event (verified on load), if one was imported. */
  manifest?: unknown;
}

export interface TurnServer {
  urls: string;
  username?: string;
  credential?: string;
}

export type ConnectionPolicy = "standard" | "onion-only";

export interface Settings {
  v: 1;
  relays: RelaySetting[];
  chainId: number;
  rpcUrls: Record<string, string>;
  /** How chain reads travel: direct, through Anon-RPC, or through a verifying light client. */
  rpc: RpcRoutingSettings;
  tokens: TokenConfig[];
  privacy: {
    connectionPolicy: ConnectionPolicy;
    relayOnlyWebRTC: boolean;
    turnServers: TurnServer[];
    /** User statement only; Aava cannot verify OS-level proxying from a web page. */
    declaredProxy: "none" | "tor-browser" | "system-socks";
  };
  /** Contact pubkey -> wallets the user accepted for that contact. */
  pinnedWallets: Record<string, string[]>;
  /** Operator id -> pinned manifest key (TOFU). */
  pinnedOperators: Record<string, string>;
  autoLockMinutes: number;
}

/**
 * Default relays: independently operated public relays that accept NIP-17 gift wraps (checked
 * 2026-11-06: publish and read back of kind 1059). auth.nostr1.com accepts and serves gift wraps
 * only after NIP-42 auth (served to the recipient only), which RelayMesh performs. relay.damus.io
 * and relay.nostr.net also demand auth for gift wraps but their AUTH is misconfigured ("needs
 * serviceUrl"), so they cannot deliver them. Users can replace every entry; builds can override with
 * VITE_DEFAULT_RELAYS (the local demo and tests point it at their own relays).
 */
export const PUBLIC_DEFAULT_RELAYS = ["wss://nos.lol", "wss://relay.primal.net", "wss://offchain.pub", "wss://nostr.mom", "wss://auth.nostr1.com"];

function envRelays(): string[] {
  const raw = (import.meta.env.VITE_DEFAULT_RELAYS as string | undefined)?.trim();
  const list = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
  return list.length ? list : PUBLIC_DEFAULT_RELAYS;
}

export function defaultSettings(): Settings {
  // Sepolia testnet by default; the local devnet (31337) is selected by the demo and test builds.
  const chainId = Number(import.meta.env.VITE_DEFAULT_CHAIN_ID || 11155111);
  const rpcUrls: Record<string, string> = {};
  for (const c of DEFAULT_CHAINS) rpcUrls[String(c.id)] = c.rpcUrls[0]!;
  if (import.meta.env.VITE_LOCAL_RPC_URL) rpcUrls["31337"] = import.meta.env.VITE_LOCAL_RPC_URL as string;
  return {
    v: 1,
    relays: envRelays().map((url) => ({ url, read: true, write: true, enabled: true })),
    chainId,
    rpcUrls,
    rpc: defaultRpcRouting(),
    tokens: DEFAULT_TOKENS,
    privacy: { connectionPolicy: "standard", relayOnlyWebRTC: true, turnServers: [], declaredProxy: "none" },
    pinnedWallets: {},
    pinnedOperators: {},
    autoLockMinutes: 15,
  };
}

const KEY = "relaymesh.settings.v1";

export async function loadSettings(store: KeyValueStore): Promise<Settings> {
  const raw = await store.get(KEY);
  if (!raw) return defaultSettings();
  try {
    const parsed = JSON.parse(raw) as Settings;
    if (parsed.v !== 1) return defaultSettings();
    const d = defaultSettings();
    const rpc: RpcRoutingSettings = {
      ...d.rpc,
      ...parsed.rpc,
      anon: { ...d.rpc.anon, ...parsed.rpc?.anon },
      lightClients: { ...d.rpc.lightClients, ...parsed.rpc?.lightClients },
      historyRpcUrls: { ...d.rpc.historyRpcUrls, ...parsed.rpc?.historyRpcUrls },
    };
    return { ...d, ...parsed, privacy: { ...d.privacy, ...parsed.privacy }, rpc };
  } catch {
    return defaultSettings();
  }
}

export async function saveSettings(store: KeyValueStore, s: Settings) {
  await store.set(KEY, JSON.stringify(s));
}

export function isOnion(url: string) {
  try {
    return new URL(url).hostname.endsWith(".onion");
  } catch {
    return false;
  }
}
