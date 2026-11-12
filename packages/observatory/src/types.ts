import type { NostrEvent } from "nostr-tools/pure";
import type { Filter } from "nostr-tools/filter";

export type TestStatus = "PASS" | "FAIL" | "NOT TESTED" | "LIMITED";

export interface TestOutcome {
  status: TestStatus;
  evidence: string[];
  /** Run-specific limitations, added to the test's static limitations. */
  limitations?: string[];
}

export interface ObservatoryTest {
  id: string;
  title: string;
  category: "privacy" | "security" | "availability" | "integrity";
  /** Bump when the test logic changes so stored results can be compared. */
  version: string;
  /** What is tested and how, in plain language. */
  method: string;
  /** What a PASS does NOT prove. */
  limitations: string[];
  run(env: ObservatoryEnv): Promise<TestOutcome>;
}

export interface TestResult {
  id: string;
  title: string;
  category: ObservatoryTest["category"];
  version: string;
  status: TestStatus;
  method: string;
  evidence: string[];
  limitations: string[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export interface MeshLike {
  states(): { url: string; status: string; write: boolean; read: boolean }[];
  openRelays(): string[];
  publish(e: NostrEvent): Promise<{ eventId: string; outcomes: { url: string; ok: boolean; message: string }[]; queued: boolean }>;
  setEnabled(url: string, enabled: boolean): void;
}

export interface StorageItem {
  area: string;
  key: string;
  value: string;
}

export interface NetworkEntry {
  url: string;
  kind: string;
  /** performance.now() timestamp of the request, when known. */
  startTime?: number;
}

/** How chain reads are routed (see apps/web/src/runtime/rpc.ts). */
export interface RpcRoutingInfo {
  mode: "direct" | "anon" | "light-client";
  /** RPC origins whose traffic must only travel through the anonymizing worker in this mode. */
  anonymizedOrigins: string[];
  /** performance.now() when the current mode took effect; earlier requests are ignored. */
  since: number;
  /** Human-readable state of the anonymizing worker or light client. */
  detail: string[];
}

/**
 * Capabilities the Observatory can use. Every field is optional: a test whose
 * capability is missing reports NOT TESTED instead of guessing.
 */
export interface ObservatoryEnv {
  identity?: { secretKey(): Uint8Array; pubkey: string; npub: string };
  mesh?: MeshLike;
  /** Raw query against a single relay (operator's view). */
  queryRelay?: (url: string, filter: Filter, timeoutMs?: number) => Promise<NostrEvent[]>;
  storageDump?: () => Promise<StorageItem[]>;
  networkEntries?: () => NetworkEntry[];
  /** Origins the user configured (relays, RPC, TURN, own origin). */
  allowedOrigins?: () => string[];
  iceProbe?: (config: RTCConfiguration, timeoutMs: number) => Promise<string[]>;
  privacy?: { relayOnlyWebRTC: boolean; turnServers: RTCIceServer[] };
  wallet?: () => Promise<{ connected: boolean; kind: string; account?: string; chainId?: number; expectedChainId: number }>;
  release?: { manifestUrl: string; fetch: typeof fetch };
  rpcRouting?: () => RpcRoutingInfo;
  now?: () => number;
}
