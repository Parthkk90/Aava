/**
 * Local infrastructure for browser end-to-end tests: anvil + two relays +
 * a production build of the web app served by `vite preview`.
 * Prints "READY" when everything is up. Devnet only.
 */
import { execSync, spawn } from "node:child_process";
import { DEMO_TOKEN_ADDRESS } from "@relaymesh/chain";
import { ANVIL_ACCOUNTS, deployDemoToken, mintDemoToken, startAnvil } from "@relaymesh/chain/testing";
import { startRelay } from "@relaymesh/relay";

const RPC_PORT = 18545;
const RELAY_PORTS = [17001, 17002];
const WEB_PORT = 4317;

const anvil = await startAnvil({ port: RPC_PORT });
await deployDemoToken(anvil.rpcUrl, ANVIL_ACCOUNTS[0]!);
for (const a of [ANVIL_ACCOUNTS[1]!, ANVIL_ACCOUNTS[2]!]) await mintDemoToken(anvil.rpcUrl, DEMO_TOKEN_ADDRESS, a, 1_000_000_000n);
const relays = await Promise.all(RELAY_PORTS.map((port, i) => startRelay({ port, name: `E2E relay ${"AB"[i]}` })));

execSync("pnpm --filter @relaymesh/web build", {
  stdio: "ignore",
  env: { ...process.env, VITE_DEFAULT_RELAYS: relays.map((r) => r.url).join(","), VITE_LOCAL_RPC_URL: anvil.rpcUrl, VITE_DEFAULT_CHAIN_ID: "31337" },
});
const preview = spawn(`pnpm --filter @relaymesh/web exec vite preview --port ${WEB_PORT} --strictPort --host 127.0.0.1`, { stdio: "ignore", shell: true });

for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`http://127.0.0.1:${WEB_PORT}/`)).ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 200));
}
console.log("READY");

const shutdown = async () => {
  preview.kill();
  for (const r of relays) await r.close();
  await anvil.stop();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.stdin.on("end", shutdown);
process.stdin.resume();
