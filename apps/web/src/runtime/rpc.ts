/**
 * The single seam for every chain read the app makes (balances, receipt
 * verification, diagnostics). Three modes:
 *
 *  - direct:       plain HTTPS JSON-RPC to the configured endpoint. The provider sees your IP.
 *  - anon:         the same JSON-RPC, carried by an Anon-RPC worker (github.com/ethereum/anon-rpc):
 *                  hash-pinned client code in a null-origin sandboxed iframe that routes each request
 *                  through an anonymizing network (default: the Nox mixnet, specifier on Sepolia).
 *  - light-client: reads served by a Helios light client through Kohaku's provider adapter
 *                  (@kohaku-eth/provider/helios), which verifies state and receipts against the
 *                  beacon chain instead of trusting the RPC.
 *
 * Rules enforced here (and tested in tests/crops/rpc-routing.test.ts):
 *  - Fail closed: if the selected mode cannot serve a request, it throws. It never silently falls
 *    back to a direct connection.
 *  - Loopback endpoints (the local devnet) are always direct: no third party is involved.
 *  - The anonymizing worker's code hash is pinned on first use. A different on-chain hash is refused
 *    until the user accepts it explicitly.
 *
 * No `import.meta.env` or DOM access at module scope, so Node tests can import this file.
 */
import { createPublicClient, custom, decodeFunctionResult, http, parseAbi, toFunctionSelector, type Address, type Hex, type PublicClient } from "viem";

export type RpcMode = "direct" | "anon" | "light-client";

export interface Eip1193Like {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
}

/** Specifier contract state accepted by the user (trust on first use). */
export interface SpecifierPin {
  /** keccak256 of the anon-client bundle, as published by `workerHash()`. */
  hash: Hex;
  resolvers: string[];
  /** Exact eth_call return data, replayed to the harness so later boots need no bootstrap read. */
  hashRet: Hex;
  resolversRet: Hex;
  pinnedAt: number;
}

export interface AnonRpcSettings {
  /** IWorkerSpecifier contract identifying the anon-client by hash. */
  specifier: Address;
  /** Chain the specifier contract lives on. */
  specifierChainId: number;
  /**
   * Direct (not anonymized) RPC used only to read the specifier on first use or when checking for
   * an update. Keep it different from the endpoints you query anonymously, so one provider cannot
   * link the direct read to the anonymized traffic that follows.
   */
  bootstrapRpcUrl: string;
  /** Opaque, network-defined worker config. `{}` uses the bundle's defaults. */
  workerConfig?: Record<string, unknown>;
  pin?: SpecifierPin;
}

export interface LightClientSettings {
  network: "mainnet" | "sepolia";
  /** Beacon API serving the light-client endpoints (/eth/v1/beacon/light_client/*). */
  consensusRpc: string;
  /** Execution RPC that serves eth_getProof for recent history. Its answers are verified, not trusted. */
  executionRpc: string;
}

export interface RpcRoutingSettings {
  mode: RpcMode;
  anon: AnonRpcSettings;
  /** Chain id → light-client endpoints. Chains without an entry cannot be read in light-client mode. */
  lightClients: Record<string, LightClientSettings>;
  /**
   * Chain id → RPC used for long history scans (Kohaku's Tornado sync reads years of eth_getLogs).
   * Many free endpoints prune old logs (publicnode Sepolia keeps only days). Routed like every other
   * read: direct, or through the anonymizing worker in anonymous mode.
   */
  historyRpcUrls?: Record<string, string>;
}

/** Nox mixnet Anon-RPC network, specifier deployed on Sepolia (ethereum.github.io/anon-rpc/adopters). */
export const NOX_SEPOLIA_SPECIFIER: Address = "0x35133267A8F7EC35046a83DCA0f4Ca8A6e1b7A9A";
export const SEPOLIA_ID = 11155111;

export function defaultRpcRouting(): RpcRoutingSettings {
  return {
    mode: "direct",
    anon: {
      specifier: NOX_SEPOLIA_SPECIFIER,
      specifierChainId: SEPOLIA_ID,
      // A different operator from the default Sepolia read endpoint (publicnode).
      bootstrapRpcUrl: "https://rpc.sepolia.ethpandaops.io",
      workerConfig: {},
    },
    // Served full Sepolia log history over multi-million-block ranges when checked (2026-11-06).
    historyRpcUrls: { [String(SEPOLIA_ID)]: (import.meta.env?.VITE_SEPOLIA_HISTORY_RPC_URL as string | undefined) || "https://sepolia.gateway.tenderly.co" },
    lightClients: {
      [String(SEPOLIA_ID)]: {
        network: "sepolia",
        consensusRpc: "https://lodestar-sepolia.chainsafe.io",
        executionRpc: "https://rpc.sepolia.ethpandaops.io",
      },
    },
  };
}

export class RpcUnavailableError extends Error {
  override name = "RpcUnavailableError";
}
export class WorkerHashChangedError extends Error {
  override name = "WorkerHashChangedError";
  constructor(
    readonly pinned: Hex,
    readonly onChain: SpecifierPin,
  ) {
    super(`The anonymizing worker's code changed on-chain (pinned ${short(pinned)}, now ${short(onChain.hash)}). Review and accept the new hash on the Privacy page before it is used.`);
  }
}

export type BootState =
  | { state: "idle" }
  | { state: "booting"; since: number }
  | { state: "ready"; at: number; ms: number }
  | { state: "failed"; at: number; error: string };

export type Route = { kind: "direct"; url: string; why: string } | { kind: "anon"; url: string } | { kind: "light-client"; config: LightClientSettings };

export interface AnonWorkerLike {
  ready: Promise<void>;
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  close(): void;
}

export interface AnonWorkerInit {
  address: string;
  config?: Record<string, unknown>;
  iframeUrl: string;
  rpcProvider: Eip1193Like;
}

export interface RpcRouterDeps {
  settings(): RpcRoutingSettings;
  rpcUrl(chainId: number): string;
  /** Same-origin URL of the harness bootstrap page (strict CSP forbids the inline srcdoc default). */
  iframeUrl(): string;
  savePin(pin: SpecifierPin): Promise<void>;
  onChange?(): void;
  /** Overridable for tests. Defaults to @anon-rpc/browser-harness (browser only). */
  createAnonWorker?(init: AnonWorkerInit): AnonWorkerLike;
  /** Overridable for tests. Defaults to Kohaku's Helios adapter. */
  createLightClient?(chainId: number, config: LightClientSettings): Promise<Eip1193Like>;
  /** Fetch used for direct connections (bootstrap read, direct mode). */
  fetch?: typeof fetch;
  anonBootTimeoutMs?: number;
  lightClientBootTimeoutMs?: number;
  /** After a failed boot, further reads fail fast for this long instead of rebooting. */
  retryAfterMs?: number;
  now?(): number;
  /** Monotonic clock comparable with Resource Timing (performance.now in browsers). */
  monotonic?(): number;
}

const SPECIFIER_ABI = parseAbi(["function workerHash() view returns (bytes32)", "function workerResolvers() view returns (string[])"]);
const SEL_HASH = toFunctionSelector("workerHash()");
const SEL_RESOLVERS = toFunctionSelector("workerResolvers()");
const ZERO_HASH = `0x${"0".repeat(64)}`;

export function isLoopbackUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "[::1]" || h === "anvil";
  } catch {
    return false;
  }
}

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

function short(h: string) {
  return `${h.slice(0, 10)}…${h.slice(-6)}`;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new RpcUnavailableError(`${what} did not become ready within ${Math.round(ms / 1000)} s`));
    }, ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** A JSON-RPC requester over HTTP, using the given fetch (plain, or the anonymizing worker's). */
function httpRequester(url: string, fetchFn: typeof fetch | undefined, timeout: number): Eip1193Like {
  const transport = http(url, { fetchFn, timeout, retryCount: 1 })({});
  return { request: (args) => transport.request(args as never) };
}

/**
 * Answers the harness's two specifier reads from the pinned return data, so the harness verifies
 * the bundle against the hash the user accepted (no time-of-check/time-of-use gap) and later boots
 * make no direct network request at all.
 */
export function pinnedSpecifierProvider(specifier: Address, pin: SpecifierPin): Eip1193Like {
  return {
    async request({ method, params }) {
      const call = Array.isArray(params) ? (params[0] as { to?: string; data?: string } | undefined) : undefined;
      if (method === "eth_call" && call?.to?.toLowerCase() === specifier.toLowerCase()) {
        if (call.data?.toLowerCase() === SEL_HASH) return pin.hashRet;
        if (call.data?.toLowerCase() === SEL_RESOLVERS) return pin.resolversRet;
      }
      throw new RpcUnavailableError(`Pinned specifier provider does not serve ${method}`);
    },
  };
}

/** Reads the specifier contract directly through the bootstrap RPC and checks it is on the expected chain. */
export async function readSpecifier(bootstrap: Eip1193Like, anon: AnonRpcSettings, now = Date.now()): Promise<SpecifierPin> {
  const chain = Number(await bootstrap.request({ method: "eth_chainId" }));
  if (chain !== anon.specifierChainId) throw new RpcUnavailableError(`Bootstrap RPC is on chain ${chain}; the specifier lives on chain ${anon.specifierChainId}`);
  const call = (data: Hex) => bootstrap.request({ method: "eth_call", params: [{ to: anon.specifier, data }, "latest"] }) as Promise<Hex>;
  const hashRet = await call(SEL_HASH);
  const resolversRet = await call(SEL_RESOLVERS);
  if (!hashRet || hashRet === "0x") throw new RpcUnavailableError(`No specifier contract at ${anon.specifier} on chain ${chain}`);
  const hash = decodeFunctionResult({ abi: SPECIFIER_ABI, functionName: "workerHash", data: hashRet });
  const resolvers = decodeFunctionResult({ abi: SPECIFIER_ABI, functionName: "workerResolvers", data: resolversRet });
  if (hash === ZERO_HASH) throw new RpcUnavailableError("The specifier publishes no worker (zero hash)");
  return { hash, resolvers: [...resolvers], hashRet, resolversRet, pinnedAt: now };
}

async function defaultCreateAnonWorker(init: AnonWorkerInit): Promise<AnonWorkerLike> {
  const { AnonRpcWorker } = await import("@anon-rpc/browser-harness");
  return new AnonRpcWorker({
    address: init.address,
    config: init.config as never,
    iframeUrl: init.iframeUrl,
    preExisting: { rpcProvider: init.rpcProvider },
  });
}

async function defaultCreateLightClient(chainId: number, cfg: LightClientSettings): Promise<Eip1193Like> {
  // Lazy: Helios ships ~4 MB of WebAssembly that only light-client users should download.
  const { helios } = await import("@kohaku-eth/provider/helios");
  let lastError: unknown;
  // waitSynced() can return while the head still trails ("out of sync: N seconds behind"). Usually
  // the next update loop fixes it; with some beacon endpoints the client stays stuck, and a fresh
  // boot recovers. Ready means a fresh head is actually served.
  for (let boot = 0; boot < 2; boot++) {
    // dbType "config" keeps Helios's checkpoint cache out of localStorage.
    const provider = await helios({ executionRpc: cfg.executionRpc, consensusRpc: cfg.consensusRpc, network: cfg.network, dbType: "config" }, "ethereum");
    const reported = Number(await provider.getChainId());
    if (reported !== chainId) throw new RpcUnavailableError(`Light client reports chain ${reported}, expected ${chainId}`);
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        await provider.getBlockNumber();
        return { request: (args) => provider.request(args as never) };
      } catch (e) {
        lastError = e;
        if (!/out of sync/i.test(String((e as Error).message))) throw e;
        await new Promise((r) => setTimeout(r, 3_000));
      }
    }
    await provider._internal.shutdown().catch(() => {});
  }
  throw new RpcUnavailableError(`Light client did not reach the chain head (${(lastError as Error).message}). The consensus endpoint ${cfg.consensusRpc} may be serving stale updates; try another, ideally your own beacon node.`);
}

export class RpcRouter {
  anonState: BootState = { state: "idle" };
  readonly lightState = new Map<number, BootState>();
  /** Monotonic timestamp when the current routing took effect (for the Observatory). */
  since: number;

  private anonWorker: Promise<AnonWorkerLike> | null = null;
  private readonly light = new Map<number, Promise<Eip1193Like>>();
  private readonly clients = new Map<string, PublicClient>();
  private readonly deps: Required<Pick<RpcRouterDeps, "anonBootTimeoutMs" | "lightClientBootTimeoutMs" | "retryAfterMs" | "now" | "monotonic">> & RpcRouterDeps;

  constructor(deps: RpcRouterDeps) {
    this.deps = {
      anonBootTimeoutMs: 180_000,
      lightClientBootTimeoutMs: 300_000,
      retryAfterMs: 15_000,
      now: () => Date.now(),
      monotonic: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
      ...deps,
    };
    this.since = this.deps.monotonic();
  }

  get mode(): RpcMode {
    return this.deps.settings().mode;
  }

  /** Decides how a chain's reads travel. Throws when the selected mode cannot serve the chain. */
  route(chainId: number): Route {
    const url = this.deps.rpcUrl(chainId);
    if (!url) throw new RpcUnavailableError(`No RPC endpoint configured for chain ${chainId}`);
    if (isLoopbackUrl(url)) return { kind: "direct", url, why: "loopback devnet: no third party involved" };
    const s = this.deps.settings();
    if (s.mode === "direct") return { kind: "direct", url, why: "direct mode" };
    if (s.mode === "anon") {
      if (!url.startsWith("https://")) throw new RpcUnavailableError(`Anonymous RPC needs an https:// endpoint for chain ${chainId} (end-to-end TLS through the mixnet); got ${url}`);
      return { kind: "anon", url };
    }
    const config = s.lightClients[String(chainId)];
    if (!config) throw new RpcUnavailableError(`Light-client mode has no configuration for chain ${chainId}. Helios supports Ethereum mainnet and Sepolia; switch RPC mode to read this chain.`);
    return { kind: "light-client", config };
  }

  /** viem client for chain reads. Never falls back to another mode. */
  async client(chainId: number): Promise<PublicClient> {
    const route = this.route(chainId);
    const key = route.kind === "light-client" ? `lc:${chainId}` : `${route.kind}:${chainId}:${route.url}`;
    const cached = this.clients.get(key);
    if (cached) return cached;
    const transport = custom(await this.requester(chainId, route), { retryCount: 0 });
    const client = createPublicClient({ transport }) as PublicClient;
    this.clients.set(key, client);
    return client;
  }

  /**
   * Raw EIP-1193 requester for SDKs that bring their own provider wrapper (Kohaku plugins wrap it
   * with `raw()` from @kohaku-eth/provider). `needsHistoricalLogs` refuses light-client mode,
   * because Helios serves eth_getLogs only for the last 8,191 blocks.
   */
  async eip1193(chainId: number, opts: { needsHistoricalLogs?: boolean } = {}): Promise<Eip1193Like> {
    const route = this.route(chainId);
    if (route.kind === "light-client" && opts.needsHistoricalLogs) {
      throw new RpcUnavailableError("This feature scans years of chain history, which the light client cannot serve. Switch RPC routing to Direct or Anonymous to use it.");
    }
    const history = opts.needsHistoricalLogs ? this.deps.settings().historyRpcUrls?.[String(chainId)] : undefined;
    if (history && route.kind !== "light-client" && !(route.kind === "direct" && route.why.startsWith("loopback"))) {
      if (route.kind === "anon" && !history.startsWith("https://")) throw new RpcUnavailableError(`Anonymous RPC needs an https:// history endpoint; got ${history}`);
      return this.requester(chainId, route.kind === "anon" ? { kind: "anon", url: history } : { kind: "direct", url: history, why: "history endpoint" });
    }
    return this.requester(chainId, route);
  }

  /**
   * HTTP fetch for third-party services an SDK talks to (bundlers, relayers). In anonymous mode it
   * goes through the anonymizing worker, so the service does not see your IP; otherwise direct.
   */
  async serviceFetch(): Promise<typeof fetch> {
    if (this.mode !== "anon") return this.deps.fetch ?? globalThis.fetch.bind(globalThis);
    const worker = await this.anon();
    return worker.fetch as typeof fetch;
  }

  /** Chain id reported by `url` over the current mode's transport (used before saving a new endpoint). */
  async probe(url: string): Promise<number> {
    const loop = isLoopbackUrl(url);
    if (this.mode === "anon" && !loop) {
      const worker = await this.anon();
      return Number(await httpRequester(url, worker.fetch as typeof fetch, 60_000).request({ method: "eth_chainId" }));
    }
    return Number(await httpRequester(url, this.deps.fetch, 20_000).request({ method: "eth_chainId" }));
  }

  /** Suggested receipt polling for settlement: anonymized and light-client reads are slower. */
  settlementPolicy(chainId: number): { intervalMs: number; tries: number } {
    let kind: Route["kind"] = "direct";
    try {
      kind = this.route(chainId).kind;
    } catch {
      /* the read itself will report the error */
    }
    return kind === "direct" ? { intervalMs: 2_000, tries: 60 } : { intervalMs: 6_000, tries: 100 };
  }

  /**
   * Reads the specifier directly through the bootstrap RPC. Unchanged hash: resolvers are refreshed.
   * Changed hash: nothing is saved and the caller must ask the user (acceptPin).
   */
  async checkForWorkerUpdate(): Promise<{ changed: boolean; pin: SpecifierPin }> {
    const s = this.deps.settings().anon;
    const pin = await readSpecifier(httpRequester(s.bootstrapRpcUrl, this.deps.fetch, 20_000), s, this.deps.now());
    if (s.pin && s.pin.hash.toLowerCase() !== pin.hash.toLowerCase()) return { changed: true, pin };
    await this.deps.savePin(pin);
    return { changed: false, pin };
  }

  async acceptPin(pin: SpecifierPin) {
    await this.deps.savePin(pin);
    this.reset();
  }

  /** Closes the worker and light clients; the next read boots them again with current settings. */
  reset() {
    void this.anonWorker?.then((w) => w.close()).catch(() => {});
    this.anonWorker = null;
    this.anonState = { state: "idle" };
    this.light.clear();
    this.lightState.clear();
    this.clients.clear();
    this.since = this.deps.monotonic();
    this.deps.onChange?.();
  }

  /** Starts the selected mode's machinery for a chain now (e.g. from a "Connect" button). */
  async warmUp(chainId: number): Promise<Route> {
    const route = this.route(chainId);
    await this.requester(chainId, route);
    return route;
  }

  /** Endpoints this module may contact, for the Observatory's network inventory. */
  knownOrigins(): string[] {
    const s = this.deps.settings();
    const urls = [s.anon.bootstrapRpcUrl, ...(s.anon.pin?.resolvers.filter((r) => /^https?:/.test(r)) ?? []), ...Object.values(s.historyRpcUrls ?? {})];
    for (const lc of Object.values(s.lightClients)) urls.push(lc.consensusRpc, lc.executionRpc);
    return [...new Set(urls.map(originOf).filter((o): o is string => !!o))];
  }

  /** RPC origins that, in anon mode, must never be contacted directly. */
  anonymizedOrigins(chainIds: number[]): string[] {
    if (this.mode !== "anon") return [];
    const out = new Set<string>();
    for (const id of chainIds) {
      const url = this.deps.rpcUrl(id);
      const o = url && !isLoopbackUrl(url) ? originOf(url) : null;
      if (o) out.add(o);
    }
    for (const url of Object.values(this.deps.settings().historyRpcUrls ?? {})) {
      const o = originOf(url);
      if (o) out.add(o);
    }
    return [...out];
  }

  describe(): string[] {
    const s = this.deps.settings();
    const fmt = (b: BootState) => (b.state === "ready" ? `ready (booted in ${Math.round(b.ms / 1000)} s)` : b.state === "failed" ? `failed: ${b.error}` : b.state);
    if (s.mode === "anon") return [`Anon-RPC specifier ${s.anon.specifier} (chain ${s.anon.specifierChainId}); worker ${fmt(this.anonState)}`, s.anon.pin ? `Pinned worker hash ${s.anon.pin.hash}` : "Worker hash not pinned yet"];
    if (s.mode === "light-client") return [...this.lightState.entries()].map(([id, b]) => `Light client for chain ${id}: ${fmt(b)}`);
    return [];
  }

  // ------------------------------------------------------------------ internals

  private async requester(chainId: number, route: Route): Promise<Eip1193Like> {
    if (route.kind === "direct") return httpRequester(route.url, this.deps.fetch, 20_000);
    if (route.kind === "anon") {
      const worker = await this.anon();
      // Each hop through the mixnet is slow; the worker enforces its own per-call deadline too.
      return httpRequester(route.url, worker.fetch as typeof fetch, 90_000);
    }
    return this.lightClient(chainId, route.config);
  }

  private failFastIfRecentlyFailed(state: BootState) {
    if (state.state === "failed" && this.deps.now() - state.at < this.deps.retryAfterMs) throw new RpcUnavailableError(state.error);
  }

  private anon(): Promise<AnonWorkerLike> {
    if (this.anonWorker) return this.anonWorker;
    this.failFastIfRecentlyFailed(this.anonState);
    const started = this.deps.now();
    this.anonState = { state: "booting", since: started };
    this.deps.onChange?.();
    const boot = this.bootAnon().then(
      (w) => {
        this.anonState = { state: "ready", at: this.deps.now(), ms: this.deps.now() - started };
        this.deps.onChange?.();
        return w;
      },
      (e: unknown) => {
        this.anonWorker = null;
        this.anonState = { state: "failed", at: this.deps.now(), error: (e as Error).message };
        this.deps.onChange?.();
        throw e instanceof RpcUnavailableError || e instanceof WorkerHashChangedError ? e : new RpcUnavailableError(`Anonymous RPC unavailable: ${(e as Error).message}`);
      },
    );
    this.anonWorker = boot;
    return boot;
  }

  private async bootAnon(): Promise<AnonWorkerLike> {
    const s = this.deps.settings().anon;
    let pin = s.pin;
    if (!pin) {
      // First use: one direct read of the specifier, then pinned forever (until the user accepts a change).
      pin = await readSpecifier(httpRequester(s.bootstrapRpcUrl, this.deps.fetch, 20_000), s, this.deps.now());
      await this.deps.savePin(pin);
    } else {
      const decoded = decodeFunctionResult({ abi: SPECIFIER_ABI, functionName: "workerHash", data: pin.hashRet });
      if (decoded.toLowerCase() !== pin.hash.toLowerCase()) throw new RpcUnavailableError("Stored worker pin is inconsistent; check for a worker update on the Privacy page");
    }
    const create = this.deps.createAnonWorker ?? null;
    const init: AnonWorkerInit = { address: s.specifier, config: s.workerConfig, iframeUrl: this.deps.iframeUrl(), rpcProvider: pinnedSpecifierProvider(s.specifier, pin) };
    const worker = create ? create(init) : await defaultCreateAnonWorker(init);
    await withTimeout(worker.ready, this.deps.anonBootTimeoutMs, "The anonymizing worker", () => worker.close());
    return worker;
  }

  private lightClient(chainId: number, cfg: LightClientSettings): Promise<Eip1193Like> {
    const existing = this.light.get(chainId);
    if (existing) return existing;
    this.failFastIfRecentlyFailed(this.lightState.get(chainId) ?? { state: "idle" });
    const started = this.deps.now();
    this.lightState.set(chainId, { state: "booting", since: started });
    this.deps.onChange?.();
    const create = this.deps.createLightClient ?? defaultCreateLightClient;
    const boot = withTimeout(create(chainId, cfg), this.deps.lightClientBootTimeoutMs, `The light client for chain ${chainId}`).then(
      (p) => {
        this.lightState.set(chainId, { state: "ready", at: this.deps.now(), ms: this.deps.now() - started });
        this.deps.onChange?.();
        return p;
      },
      (e: unknown) => {
        this.light.delete(chainId);
        this.lightState.set(chainId, { state: "failed", at: this.deps.now(), error: (e as Error).message });
        this.deps.onChange?.();
        throw e instanceof RpcUnavailableError ? e : new RpcUnavailableError(`Light client unavailable: ${(e as Error).message}`);
      },
    );
    this.light.set(chainId, boot);
    return boot;
  }
}
