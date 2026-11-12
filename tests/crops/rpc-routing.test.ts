/**
 * CROPS · RPC routing (Anon-RPC anonymous reads, Helios light-client verified reads).
 *
 * Deterministic tests run against a real anvil chain with a stand-in for the anonymizing worker
 * (it forwards to anvil, as a mixnet exit would) and spies on every direct connection. They prove
 * the routing rules: reads only go through the selected mode, nothing falls back to a direct
 * connection, and the worker code hash is pinned.
 *
 * LIVE_TESTNET=1 additionally runs a real Helios light client on Sepolia against a local RPC proxy
 * that lies about a receipt (S-16).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createPublicClient, decodeFunctionResult, encodeFunctionResult, http, numberToHex, pad, parseAbi, toFunctionSelector, type Address, type Hex } from "viem";
import { DEMO_TOKEN_ADDRESS, TokenRegistry, readTokenBalances, verifyTokenTransfer } from "@relaymesh/chain";
import { ANVIL_ACCOUNTS, deployDemoToken, mintDemoToken, startAnvil, transferDemoToken, type Anvil } from "@relaymesh/chain/testing";
import { OBSERVATORY_TESTS, runTest } from "@relaymesh/observatory";
import {
  RpcRouter,
  RpcUnavailableError,
  defaultRpcRouting,
  type AnonWorkerInit,
  type AnonWorkerLike,
  type Eip1193Like,
  type RpcRoutingSettings,
  type SpecifierPin,
} from "../../apps/web/src/runtime/rpc.ts";

const ABI = parseAbi(["function workerHash() view returns (bytes32)", "function workerResolvers() view returns (string[])"]);
const SEL_HASH = toFunctionSelector("workerHash()");
const SEL_RESOLVERS = toFunctionSelector("workerResolvers()");
const HASH_A = pad("0xa1", { size: 32 });
const HASH_B = pad("0xb2", { size: 32 });
const RESOLVERS = ["https://bundles.example.test/keccak/a1", "kps:203.0.113.1:15005:uEiTest/keccak/a1"];
const BOOTSTRAP = "https://bootstrap.example.test/";
const ANON_DEST = "https://sepolia-rpc.example.test/";
const LIVE = process.env.LIVE_TESTNET === "1";

/** A JSON-RPC endpoint that only knows the specifier contract (stands in for the bootstrap RPC). */
function specifierEndpoint(state: { hash: Hex; chainId: number }, seen: string[]): typeof fetch {
  return async (input, init) => {
    seen.push(String(input));
    const answer = (req: { id: number; method: string; params?: [{ data: Hex }] }) => {
      let result: unknown = null;
      if (req.method === "eth_chainId") result = numberToHex(state.chainId);
      else if (req.method === "eth_call" && req.params?.[0].data === SEL_HASH) result = encodeFunctionResult({ abi: ABI, functionName: "workerHash", result: state.hash });
      else if (req.method === "eth_call" && req.params?.[0].data === SEL_RESOLVERS) result = encodeFunctionResult({ abi: ABI, functionName: "workerResolvers", result: RESOLVERS });
      return { jsonrpc: "2.0", id: req.id, result };
    };
    const body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)), { headers: { "content-type": "application/json" } });
  };
}

/** Stand-in for the Anon-RPC worker: forwards each request to `exit` (as a mixnet exit would). */
function fakeWorker(exit: string, log: { urls: string[]; closed: number }, ready: Promise<void> = Promise.resolve()): AnonWorkerLike {
  return {
    ready,
    fetch: async (input, init) => {
      log.urls.push(String(input));
      return fetch(exit, init);
    },
    close: () => void log.closed++,
  };
}

interface Harness {
  router: RpcRouter;
  settings: RpcRoutingSettings;
  direct: string[];
  worker: { urls: string[]; closed: number };
  inits: AnonWorkerInit[];
  saved: SpecifierPin[];
  spec: { hash: Hex; chainId: number };
  clock: { t: number };
}

function harness(opts: { rpcUrls: Record<number, string>; exit?: string; ready?: () => Promise<void>; createLightClient?: (id: number) => Promise<Eip1193Like>; mode?: RpcRoutingSettings["mode"] }): Harness {
  const settings = defaultRpcRouting();
  settings.mode = opts.mode ?? "anon";
  settings.anon.bootstrapRpcUrl = BOOTSTRAP;
  const h = { settings, direct: [] as string[], worker: { urls: [] as string[], closed: 0 }, inits: [] as AnonWorkerInit[], saved: [] as SpecifierPin[], spec: { hash: HASH_A, chainId: 11155111 }, clock: { t: 1_000_000 } };
  const bootstrap = specifierEndpoint(h.spec, []);
  const router = new RpcRouter({
    settings: () => settings,
    rpcUrl: (id) => opts.rpcUrls[id] ?? "",
    iframeUrl: () => "https://app.example.test/anon-rpc-iframe.html",
    savePin: async (pin) => {
      h.saved.push(pin);
      settings.anon.pin = pin;
    },
    createAnonWorker: (init) => {
      h.inits.push(init);
      return fakeWorker(opts.exit ?? "http://127.0.0.1:1/", h.worker, opts.ready ? opts.ready() : Promise.resolve());
    },
    ...(opts.createLightClient ? { createLightClient: (id: number) => opts.createLightClient!(id) } : {}),
    // Every direct connection is recorded. Only the bootstrap endpoint answers; anything else is a test failure.
    fetch: async (input, init) => {
      h.direct.push(String(input));
      if (String(input) === BOOTSTRAP) return bootstrap(input, init);
      if (String(input).startsWith("http://127.0.0.1")) return fetch(input, init);
      throw new Error(`unexpected direct connection to ${String(input)}`);
    },
    anonBootTimeoutMs: 2_000,
    now: () => h.clock.t,
  });
  return { router, ...h };
}

/** Calls the harness's bootstrap provider exactly as @anon-rpc/harness-core does. */
async function harnessReadsHash(init: AnonWorkerInit): Promise<Hex> {
  const ret = (await init.rpcProvider.request({ method: "eth_call", params: [{ to: init.address, data: SEL_HASH }, "latest"] })) as Hex;
  return decodeFunctionResult({ abi: ABI, functionName: "workerHash", data: ret });
}

describe("CROPS · RPC routing", () => {
  let anvil: Anvil;
  let tx: Hex;
  const [deployer, payer, payee] = ANVIL_ACCOUNTS as [Address, Address, Address];
  const expected = () => ({ chainId: 31337, token: DEMO_TOKEN_ADDRESS, from: payer, to: payee, amount: 42n });

  beforeAll(async () => {
    anvil = await startAnvil();
    await deployDemoToken(anvil.rpcUrl, deployer);
    await mintDemoToken(anvil.rpcUrl, DEMO_TOKEN_ADDRESS, payer, 100n);
    tx = await transferDemoToken(anvil.rpcUrl, DEMO_TOKEN_ADDRESS, payer, payee, 42n);
  }, 60_000);
  afterAll(async () => {
    await anvil?.stop();
  });

  describe("P-09 anonymous RPC mode never contacts the RPC provider directly", () => {
    it("reads and verifies payments only through the hash-pinned worker", async () => {
      // The devnet is presented under a non-loopback https name so it is routed anonymously.
      const h = harness({ rpcUrls: { 31337: ANON_DEST }, exit: anvil.rpcUrl });
      const client = await h.router.client(31337);
      expect((await verifyTokenTransfer(client, tx, expected(), 1)).status).toBe("verified");
      const [bal] = await readTokenBalances(client, payee, new TokenRegistry().forChain(31337));
      expect(bal!.balance).toBe(42n);

      expect(h.worker.urls.length).toBeGreaterThan(3);
      expect(new Set(h.worker.urls)).toEqual(new Set([ANON_DEST]));
      // The only direct connection is the one-time specifier read on the bootstrap RPC.
      expect(h.direct.every((u) => u === BOOTSTRAP)).toBe(true);
      expect(h.direct).not.toContain(ANON_DEST);
      // The harness is given the same-origin bootstrap page and the pinned hash, not a live provider.
      expect(h.inits[0]!.iframeUrl).toMatch(/anon-rpc-iframe\.html$/);
      expect(h.saved).toHaveLength(1);
      expect(h.saved[0]!.hash).toBe(HASH_A);
      expect(await harnessReadsHash(h.inits[0]!)).toBe(HASH_A);
      await expect(h.inits[0]!.rpcProvider.request({ method: "eth_getBalance", params: [payer, "latest"] })).rejects.toThrow();
    });

    it("a later session boots from the pin with no direct connection at all", async () => {
      const first = harness({ rpcUrls: { 31337: ANON_DEST }, exit: anvil.rpcUrl });
      await first.router.client(31337);
      const second = harness({ rpcUrls: { 31337: ANON_DEST }, exit: anvil.rpcUrl });
      second.settings.anon.pin = first.saved[0]!;
      expect(await (await second.router.client(31337)).getChainId()).toBe(31337);
      expect(second.direct).toEqual([]);
      expect(second.saved).toEqual([]);
    });

    it("testing a new endpoint in anonymous mode also goes through the worker", async () => {
      const h = harness({ rpcUrls: { 31337: ANON_DEST }, exit: anvil.rpcUrl });
      expect(await h.router.probe("https://another-rpc.example.test/")).toBe(31337);
      expect(h.worker.urls).toEqual(["https://another-rpc.example.test/"]);
      expect(h.direct.filter((u) => u !== BOOTSTRAP)).toEqual([]);
    });

    it("the loopback devnet stays direct (no third party), and non-https endpoints are refused", async () => {
      const h = harness({ rpcUrls: { 31337: anvil.rpcUrl, 10200: "http://rpc.example.test/" } });
      expect((await verifyTokenTransfer(await h.router.client(31337), tx, expected(), 1)).status).toBe("verified");
      expect(h.inits).toHaveLength(0);
      expect(() => h.router.route(10200)).toThrow(RpcUnavailableError);
      await expect(h.router.client(10200)).rejects.toThrow(/https/);
      expect(h.direct.some((u) => u.includes("rpc.example.test"))).toBe(false);
    });
  });

  describe("P-10 anonymous RPC fails closed", () => {
    it("a worker that fails to boot blocks reads instead of falling back to a direct connection", async () => {
      const h = harness({ rpcUrls: { 31337: ANON_DEST }, exit: anvil.rpcUrl, ready: () => Promise.reject(new Error("mixnet unreachable")) });
      await expect(h.router.client(31337)).rejects.toThrow(/mixnet unreachable/);
      expect(h.router.anonState.state).toBe("failed");
      // Within the retry window: fails fast, no new worker, no direct connection.
      await expect(h.router.client(31337)).rejects.toThrow(RpcUnavailableError);
      expect(h.inits).toHaveLength(1);
      h.clock.t += 60_000;
      await expect(h.router.client(31337)).rejects.toThrow(/mixnet unreachable/);
      expect(h.inits).toHaveLength(2);
      expect(h.direct).not.toContain(ANON_DEST);
      expect(h.worker.urls).toEqual([]);
    });

    it("a worker that never becomes ready times out and is closed", async () => {
      const h = harness({ rpcUrls: { 31337: ANON_DEST }, ready: () => new Promise<void>(() => {}) });
      await expect(h.router.client(31337)).rejects.toThrow(/did not become ready/);
      expect(h.worker.closed).toBe(1);
      expect(h.direct).not.toContain(ANON_DEST);
    }, 10_000);

    it("new worker code published on-chain is refused until the user accepts it", async () => {
      const h = harness({ rpcUrls: { 31337: ANON_DEST }, exit: anvil.rpcUrl });
      await h.router.client(31337);
      h.spec.hash = HASH_B; // the specifier owner publishes different code
      const check = await h.router.checkForWorkerUpdate();
      expect(check.changed).toBe(true);
      expect(check.pin.hash).toBe(HASH_B);
      expect(h.saved).toHaveLength(1); // not saved
      h.router.reset();
      await h.router.client(31337);
      expect(await harnessReadsHash(h.inits.at(-1)!)).toBe(HASH_A); // still the pinned code
      await h.router.acceptPin(check.pin);
      await h.router.client(31337);
      expect(await harnessReadsHash(h.inits.at(-1)!)).toBe(HASH_B);
    });

    it("a bootstrap RPC on the wrong chain cannot supply the worker hash", async () => {
      const h = harness({ rpcUrls: { 31337: ANON_DEST }, exit: anvil.rpcUrl });
      h.spec.chainId = 1;
      await expect(h.router.client(31337)).rejects.toThrow(/chain 1/);
      expect(h.inits).toHaveLength(0);
      expect(h.saved).toHaveLength(0);
    });
  });

  it("P-11 Observatory OBS-15 detects a direct request to an anonymized RPC origin", async () => {
    const obs = OBSERVATORY_TESTS.find((t) => t.id === "OBS-15")!;
    const info = { mode: "anon" as const, anonymizedOrigins: [ANON_DEST], since: 100, detail: [] };
    const clean = await runTest(obs, { rpcRouting: () => info, networkEntries: () => [{ url: `${BOOTSTRAP}`, kind: "fetch", startTime: 150 }, { url: `${ANON_DEST}`, kind: "fetch", startTime: 50 }] });
    expect(clean.status).toBe("PASS"); // the earlier request predates anonymous mode
    const leak = await runTest(obs, { rpcRouting: () => info, networkEntries: () => [{ url: `${ANON_DEST}`, kind: "fetch", startTime: 150 }] });
    expect(leak.status).toBe("FAIL");
    expect((await runTest(obs, { rpcRouting: () => ({ ...info, mode: "direct" }), networkEntries: () => [] })).status).toBe("LIMITED");
  });

  it("P-13 SDK traffic follows the routing mode: bundler calls go through the worker, history scans refuse the light client", async () => {
    // Anonymous mode: the service fetch Kohaku uses for the ERC-4337 bundler is the worker's fetch.
    const h = harness({ rpcUrls: { 31337: ANON_DEST }, exit: anvil.rpcUrl });
    const f = await h.router.serviceFetch();
    await f("https://bundler.example.test/rpc", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
    expect(h.worker.urls).toContain("https://bundler.example.test/rpc");
    expect(h.direct.some((u) => u.includes("bundler.example.test"))).toBe(false);
    // The raw EIP-1193 provider handed to Kohaku is routed the same way.
    const eip = await h.router.eip1193(31337);
    expect(Number(await eip.request({ method: "eth_chainId" }))).toBe(31337);
    expect(h.worker.urls.filter((u) => u === ANON_DEST).length).toBeGreaterThan(0);
    // History scans use the configured history endpoint, still through the worker, never directly.
    h.settings.historyRpcUrls = { "31337": "https://history.example.test/" };
    const hist = await h.router.eip1193(31337, { needsHistoricalLogs: true });
    expect(Number(await hist.request({ method: "eth_chainId" }))).toBe(31337);
    expect(h.worker.urls).toContain("https://history.example.test/");
    expect(h.direct.some((u) => u.includes("history.example.test"))).toBe(false);
    expect(h.router.anonymizedOrigins([31337])).toContain("https://history.example.test");
    // Light-client mode cannot serve years of eth_getLogs: refused, never silently direct.
    const lc = harness({ mode: "light-client", rpcUrls: { 31337: "https://untrusted-rpc.example.test/" }, createLightClient: () => Promise.reject(new Error("must not boot")) });
    lc.settings.lightClients["31337"] = { network: "sepolia", consensusRpc: "https://beacon.example.test", executionRpc: "https://exec.example.test" };
    await expect(lc.router.eip1193(31337, { needsHistoricalLogs: true })).rejects.toThrow(/light client cannot serve/);
    expect(lc.direct).toEqual([]);
  });

  describe("S-15 light-client mode reads only from the light client", () => {
    it("serves reads from the light client and never from the configured RPC", async () => {
      const booted: number[] = [];
      const h = harness({
        mode: "light-client",
        rpcUrls: { 31337: "https://untrusted-rpc.example.test/" },
        createLightClient: async (id) => {
          booted.push(id);
          const t = http(anvil.rpcUrl)({});
          return { request: (a) => t.request(a as never) };
        },
      });
      h.settings.lightClients["31337"] = { network: "sepolia", consensusRpc: "https://beacon.example.test", executionRpc: anvil.rpcUrl };
      expect((await verifyTokenTransfer(await h.router.client(31337), tx, expected(), 1)).status).toBe("verified");
      expect(booted).toEqual([31337]);
      expect(h.direct).toEqual([]);
    });

    it("no light client for the chain, or a failed sync, means no read", async () => {
      const h = harness({ mode: "light-client", rpcUrls: { 100: "https://rpc.gnosis.example.test/", 31337: "https://untrusted-rpc.example.test/" }, createLightClient: () => Promise.reject(new Error("could not fetch bootstrap")) });
      await expect(h.router.client(100)).rejects.toThrow(/no configuration for chain 100/);
      h.settings.lightClients["31337"] = { network: "sepolia", consensusRpc: "https://beacon.example.test", executionRpc: "https://exec.example.test" };
      await expect(h.router.client(31337)).rejects.toThrow(/could not fetch bootstrap/);
      expect(h.direct).toEqual([]);
    });
  });

  describe.skipIf(!LIVE)("S-16 (live Sepolia) a Helios light client rejects a receipt the RPC lied about", () => {
    const UPSTREAM = "https://rpc.sepolia.ethpandaops.io";
    const CONSENSUS = process.env.SEPOLIA_CONSENSUS_RPC ?? "https://lodestar-sepolia.chainsafe.io";
    let proxy: Server;
    let proxyUrl: string;
    let target: { tx: Hex; token: Address; from: Address; to: Address; amount: bigint };
    let tamper = false;

    const rpc = async (method: string, params: unknown[]) => {
      const r = (await (await fetch(UPSTREAM, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()) as { result: unknown };
      return r.result;
    };

    beforeAll(async () => {
      // A real, recent ERC-20 transfer (3 topics) a few blocks behind the head, so the light client has it.
      const head = Number(await rpc("eth_blockNumber", []));
      const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
      const logs = (await rpc("eth_getLogs", [{ fromBlock: numberToHex(head - 40), toBlock: numberToHex(head - 8), topics: [TRANSFER] }])) as { address: Address; topics: Hex[]; data: Hex; transactionHash: Hex }[];
      // Skip system pseudo-logs (e.g. native-ETH transfer logs from 0xff…fe), which have no contract code.
      let log: (typeof logs)[number] | undefined;
      for (const l of logs.filter((x) => x.topics.length === 3 && x.data.length === 66 && BigInt(x.data) > 0n)) {
        if (((await rpc("eth_getCode", [l.address, "latest"])) as string).length > 2) {
          log = l;
          break;
        }
      }
      if (!log) throw new Error("no recent ERC-20 Transfer from a contract on Sepolia");
      target = { tx: log.transactionHash, token: log.address, from: `0x${log.topics[1]!.slice(26)}`, to: `0x${log.topics[2]!.slice(26)}`, amount: BigInt(log.data) };

      // A forwarding RPC that, when told to, inflates the amount in that transfer's receipt.
      const lie = (receipt: { transactionHash?: string; logs?: { data: string; topics: string[] }[] } | null) => {
        if (!receipt || receipt.transactionHash?.toLowerCase() !== target.tx.toLowerCase()) return;
        for (const l of receipt.logs ?? []) if (l.topics[0] === TRANSFER) l.data = numberToHex(BigInt(l.data) + 1n, { size: 32 });
      };
      proxy = createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", async () => {
          const upstream = await fetch(UPSTREAM, { method: "POST", headers: { "content-type": "application/json" }, body });
          const json = (await upstream.json()) as { id: number; result: unknown } | { id: number; result: unknown }[];
          const reqs = JSON.parse(body) as { method: string } | { method: string }[];
          const pairs = Array.isArray(json) ? json.map((j, i) => [j, (reqs as { method: string }[])[i]!] as const) : [[json, reqs as { method: string }] as const];
          if (tamper) {
            for (const [j, r] of pairs) {
              if (r.method === "eth_getTransactionReceipt") lie(j.result as never);
              if (r.method === "eth_getBlockReceipts") for (const rc of (j.result as never[]) ?? []) lie(rc);
            }
          }
          res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" }).end(JSON.stringify(json));
        });
      });
      await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
      proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/`;
    }, 60_000);
    afterAll(() => proxy?.close());

    it("a client that trusts the RPC accepts the lie; the light client does not", async () => {
      const lied = { chainId: 11155111, token: target.token, from: target.from, to: target.to, amount: target.amount + 1n };
      tamper = true;
      const trusting = createPublicClient({ transport: http(proxyUrl) });
      const trustingReport = await verifyTokenTransfer(trusting, target.tx, lied, 1);
      expect(trustingReport.status, JSON.stringify({ target: { ...target, amount: String(target.amount) }, checks: trustingReport.checks })).toBe("verified"); // sensitivity check

      const settings = defaultRpcRouting();
      settings.mode = "light-client";
      settings.lightClients["11155111"] = { network: "sepolia", consensusRpc: CONSENSUS, executionRpc: proxyUrl };
      const router = new RpcRouter({ settings: () => settings, rpcUrl: () => "https://ethereum-sepolia-rpc.publicnode.com", iframeUrl: () => "", savePin: async () => {} });
      const verified = await router.client(11155111);
      expect((await verifyTokenTransfer(verified, target.tx, lied, 1)).status).not.toBe("verified");

      tamper = false;
      const honest = { ...lied, amount: target.amount };
      expect((await verifyTokenTransfer(verified, target.tx, honest, 1)).status).toBe("verified");
    }, 420_000);
  });
});
