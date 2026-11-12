/**
 * Prepares a devnet for the demo: deploys the demo token at its deterministic
 * address and mints test balances. Idempotent. Refuses to run on any chain
 * other than 31337. These tokens have no value.
 */
import { createPublicClient, http, type Address } from "viem";
import { DEMO_TOKEN_ADDRESS } from "@relaymesh/chain";
import { ANVIL_ACCOUNTS, deployDemoToken, mintDemoToken } from "@relaymesh/chain/testing";
import { demoTokenAbi } from "@relaymesh/chain/demo-token";

const rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const client = createPublicClient({ transport: http(rpcUrl) });
const chainId = await client.getChainId();
if (chainId !== 31337) {
  console.error(`Refusing to run demo setup on chain ${chainId}; only the 31337 devnet is allowed.`);
  process.exit(1);
}

const code = await client.getCode({ address: DEMO_TOKEN_ADDRESS });
if (!code || code === "0x") {
  const addr = await deployDemoToken(rpcUrl, ANVIL_ACCOUNTS[0]!);
  if (addr !== DEMO_TOKEN_ADDRESS) throw new Error(`Token deployed at ${addr}, expected ${DEMO_TOKEN_ADDRESS}. Is this a fresh anvil?`);
  console.log(`[setup] deployed rmUSD at ${addr}`);
} else {
  console.log(`[setup] rmUSD already deployed at ${DEMO_TOKEN_ADDRESS}`);
}

const AGENT = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65" as Address;
const recipients: [string, Address][] = [
  ["Bob (payer, anvil #1)", ANVIL_ACCOUNTS[1]!],
  ["Alice (anvil #2)", ANVIL_ACCOUNTS[2]!],
  ["Demo agent (anvil #4)", AGENT],
];
for (const [label, addr] of recipients) {
  const bal = await client.readContract({ address: DEMO_TOKEN_ADDRESS, abi: demoTokenAbi, functionName: "balanceOf", args: [addr] });
  if (bal < 100_000_000n) {
    await mintDemoToken(rpcUrl, DEMO_TOKEN_ADDRESS, addr, 1_000_000_000n);
    console.log(`[setup] minted 1000 rmUSD to ${label} ${addr}`);
  }
}
console.log("[setup] done");
