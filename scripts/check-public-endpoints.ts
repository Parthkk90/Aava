/**
 * Checks that publicly shared demo endpoints (e.g. a dev tunnel) work the way a
 * visitor's browser will use them: relays over WSS, NIP-11, and the devnet RPC.
 *
 *   pnpm exec tsx scripts/check-public-endpoints.ts <relayUrl,relayUrl> <rpcUrl>
 */
import { createPublicClient, http } from "viem";
import { probeRelay } from "@relaymesh/relay-mesh";

const [relaysArg, rpcUrl] = process.argv.slice(2);
if (!relaysArg || !rpcUrl) {
  console.error("usage: check-public-endpoints.ts <relayUrl,relayUrl> <rpcUrl>");
  process.exit(2);
}
let ok = true;
for (const url of relaysArg.split(",")) {
  const r = await probeRelay(url.trim(), 8000);
  ok &&= r.reachable;
  console.log(`${r.reachable ? "✔" : "✘"} relay ${url}  ${r.reachable ? `${r.latencyMs} ms` : r.error}  NIP-11: ${r.info?.name ?? r.infoError}`);
}
try {
  const id = await createPublicClient({ transport: http(rpcUrl) }).getChainId();
  ok &&= id === 31337;
  console.log(`${id === 31337 ? "✔" : "✘"} rpc ${rpcUrl}  chain ${id}`);
} catch (e) {
  ok = false;
  console.log(`✘ rpc ${rpcUrl}  ${(e as Error).message.split("\n")[0]}`);
}
process.exit(ok ? 0 : 1);
