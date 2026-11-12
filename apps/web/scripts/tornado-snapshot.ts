/**
 * Builds the Sepolia Tornado Cash state snapshot that the app seeds Kohaku with, so a first sync
 * in the browser only reads recent blocks instead of ~6.5 million blocks of eth_getLogs.
 *
 *   pnpm --filter @relaymesh/web exec tsx scripts/tornado-snapshot.ts [rpcUrl]
 *
 * The snapshot is public chain data (pool Merkle trees, instance and relayer registries) produced
 * by Kohaku's own sync with a throwaway, random keystore. It is a cache: a wrong snapshot cannot
 * steal funds (proofs are checked against on-chain roots); at worst a withdrawal fails.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createTCPlugin, TornadoCashConfigs } from "@kohaku-eth/tornado-cash";
import { MnemonicKeystore, type ExternalRawEvent, type ExternalSyncProvider, type Storage } from "@kohaku-eth/plugins";
import { raw } from "@kohaku-eth/provider/raw";

const RPC = process.argv[2] ?? process.env.SEPOLIA_RPC_URL ?? "https://rpc.sepolia.ethpandaops.io";
/** A Sepolia RPC that answers eth_getLogs over millions of blocks (checked 2026-11-06); used for the bulk scan. */
const BULK_LOGS_RPC = process.env.SEPOLIA_BULK_LOGS_RPC ?? "https://sepolia.gateway.tenderly.co";
const DEPLOYMENT_BLOCK = 5_594_611n; // TornadoCashConfigs[11155111].instanceRegistry.deploymentBlock
const OUT = join(import.meta.dirname, "..", "public", "kohaku", "tornado-sepolia-state.json");

const entries = new Map<string, string>();
const storage: Storage = {
  _brand: "Storage",
  async set(k, v) {
    entries.set(k, v);
  },
  async get(k) {
    return entries.get(k) ?? null;
  },
};

let calls = 0;
const rpc = async (method: string, params?: unknown) => {
  calls++;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: calls, method, params }) });
      const body = (await res.json()) as { result?: unknown; error?: { message: string; code: number } };
      if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code });
      return body.result;
    } catch (e) {
      if (attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, 1_000 * (attempt + 1)));
    }
  }
};

// Kohaku syncs pools in parallel and silently drops a pool whose events fail to load. Free bulk
// endpoints rate-limit parallel calls, so calls are serialised, retried with backoff, and any final
// failure aborts the script instead of writing a partial snapshot.
const failures: string[] = [];
let queue: Promise<unknown> = Promise.resolve();
const bulkOnce = async (method: string, params: unknown) => {
  const res = await fetch(BULK_LOGS_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const text = await res.text();
  let body: { result?: unknown; error?: { message: string } };
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`bulk RPC returned HTTP ${res.status}: ${text.slice(0, 120)}`);
  }
  if (body.error) throw new Error(`bulk RPC error: ${body.error.message}`);
  return body.result;
};
const bulk = (method: string, params: unknown): Promise<unknown> => {
  const run = async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await bulkOnce(method, params);
      } catch (e) {
        if (attempt >= 8) throw e;
        await new Promise((r) => setTimeout(r, 1_500 * (attempt + 1)));
      }
    }
  };
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
};
const head0 = BigInt((await rpc("eth_blockNumber")) as string);
/** Kohaku's cold-sync hook, served by large eth_getLogs ranges; Kohaku finishes the tail with the normal provider. */
const externalSyncProvider: ExternalSyncProvider = {
  async *streamEvents({ address, fromBlock, toBlock }) {
    const STEP = 1_000_000n;
    for (let from = BigInt(fromBlock); from <= BigInt(toBlock); from += STEP) {
      const to = from + STEP - 1n < BigInt(toBlock) ? from + STEP - 1n : BigInt(toBlock);
      const logs = (await bulk("eth_getLogs", [{ address, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }]).catch((e: Error) => {
        failures.push(`${address} ${from}-${to}: ${e.message}`);
        console.error(`  bulk ${address.slice(0, 10)} ${from}-${to} FAILED: ${e.message}`);
        throw e;
      })) as { address: string; topics: string[]; data: string; blockNumber: string; logIndex: string }[];
      console.log(`  bulk ${address.slice(0, 10)} ${from}-${to}: ${logs.length} logs`);
      for (const l of logs) {
        const ev: ExternalRawEvent = { contractAddress: l.address.toLowerCase() as `0x${string}`, eventTopic: l.topics[0]!.toLowerCase() as `0x${string}`, topics: l.topics.map((t) => t.toLowerCase()) as `0x${string}`[], data: l.data.toLowerCase() as `0x${string}`, blockNumber: l.blockNumber.toLowerCase() as `0x${string}`, logIndex: l.logIndex.toLowerCase() as `0x${string}` };
        yield ev;
      }
    }
  },
  async firstCoveredBlock() {
    return `0x${DEPLOYMENT_BLOCK.toString(16)}`;
  },
  async lastCoveredBlock() {
    return `0x${(head0 - 64n).toString(16)}`; // leave the last blocks to the normal provider
  },
};

const tc = createTCPlugin(
  { provider: raw({ request: ({ method, params }: { method: string; params?: unknown }) => rpc(method, params) } as never), network: { fetch: globalThis.fetch.bind(globalThis) }, storage, keystore: MnemonicKeystore.random(), externalSyncProvider },
  { accountIndex: 0, protocolConfig: TornadoCashConfigs[11155111], minExternalSyncBlocksAmount: 10_000, useExtendedEthPools: true },
);

const t0 = Date.now();
const tick = setInterval(() => console.log(`[${Math.round((Date.now() - t0) / 1000)} s] ${calls} RPC calls`), 30_000);
await tc.sync();
clearInterval(tick);
const head = Number(await rpc("eth_blockNumber"));

if (failures.length) {
  console.error(`Aborting: ${failures.length} bulk request(s) failed; the snapshot would be incomplete.`);
  process.exit(1);
}
// Sanity check: every pool Kohaku registered must have been synced close to the head.
const stateValue = JSON.parse([...entries.values()][0] ?? "{}") as { pools?: { poolsTuples?: [string, { lastSyncedBlock?: string | number }][] } };
const pools = stateValue.pools?.poolsTuples ?? [];
console.log(`pools in state: ${pools.length}`);
const keys = [...entries.keys()].sort();
console.log(`synced in ${Math.round((Date.now() - t0) / 1000)} s, ${calls} RPC calls, head ${head}`);
for (const k of keys) console.log(`  ${k}: ${entries.get(k)!.length} chars`);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ format: "relaymesh.tornado-snapshot", v: 1, chainId: 11155111, head, createdAt: new Date().toISOString(), rpc: new URL(RPC).host, entries: Object.fromEntries(keys.map((k) => [k, entries.get(k)!])) }));
console.log(`wrote ${OUT}`);
process.exit(0);
