/**
 * Deploys the RelayMesh demo token (contracts/src/DemoToken.sol) to a PUBLIC TESTNET.
 *
 *   1. Put your deployer key in .env (git-ignored), never in code or chat:
 *        DEPLOYER_PRIVATE_KEY=0x...
 *        RPC_URL=https://rpc.chiadochain.net        # optional; this is the default
 *        MINT_TO=0xabc...,0xdef...                  # optional; defaults to the deployer
 *        MINT_AMOUNT=1000                           # optional; whole rmUSD per address
 *   2. Fund the deployer with testnet xDAI from a Chiado faucet.
 *   3. pnpm deploy:testnet
 *
 * Writes deployments/<chainId>.json. Refuses mainnets and unknown chains.
 * The key is read from the environment and never printed.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, formatEther, getAddress, http, isAddress, type Address, type Hex } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { demoTokenAbi, demoTokenBytecode } from "@relaymesh/chain/demo-token";

const ROOT = join(import.meta.dirname, "..");
if (existsSync(join(ROOT, ".env"))) process.loadEnvFile(join(ROOT, ".env"));

const TESTNETS: Record<number, { name: string; symbol: string; explorer: string; faucet: string }> = {
  10200: { name: "Gnosis Chiado", symbol: "xDAI", explorer: "https://gnosis-chiado.blockscout.com", faucet: "https://faucet.chiadochain.net" },
  11155111: { name: "Sepolia", symbol: "ETH", explorer: "https://sepolia.etherscan.io", faucet: "https://sepoliafaucet.com" },
};
// Only for testing this script against a local anvil node.
if (process.env.ALLOW_DEVNET === "1") TESTNETS[31337] = { name: "Local devnet", symbol: "ETH", explorer: "", faucet: "" };

function fail(msg: string): never {
  console.error(`✘ ${msg}`);
  process.exit(1);
}

const rpcUrl = process.env.RPC_URL ?? "https://rpc.chiadochain.net";

/** Deployer from DEPLOYER_PRIVATE_KEY, or DEPLOYER_MNEMONIC (BIP-44 m/44'/60'/0'/0/<index>). */
function loadDeployer() {
  const mnemonic = process.env.DEPLOYER_MNEMONIC?.trim();
  if (mnemonic) return mnemonicToAccount(mnemonic.replace(/\s+/g, " "), { addressIndex: Number(process.env.DEPLOYER_ACCOUNT_INDEX ?? 0) });
  const rawKey = process.env.DEPLOYER_PRIVATE_KEY?.trim();
  if (!rawKey) fail("Set DEPLOYER_PRIVATE_KEY or DEPLOYER_MNEMONIC in .env (git-ignored).");
  const key = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) fail("DEPLOYER_PRIVATE_KEY must be 32 bytes of hex.");
  return privateKeyToAccount(key);
}
const account = loadDeployer();
const expected = process.env.EXPECTED_DEPLOYER?.trim();
if (expected && expected.toLowerCase() !== account.address.toLowerCase()) fail(`Key derives ${account.address}, but EXPECTED_DEPLOYER is ${expected}. Refusing to continue.`);
if (process.argv.includes("--check")) {
  const bal = await createPublicClient({ transport: http(rpcUrl) }).getBalance({ address: account.address });
  console.log(`Deployer ${account.address} balance ${formatEther(bal)} (chain via ${rpcUrl})`);
  process.exit(0);
}

const probe = createPublicClient({ transport: http(rpcUrl) });
const chainId = await probe.getChainId();
const net = TESTNETS[chainId];
if (!net) fail(`RPC ${rpcUrl} is chain ${chainId}, which is not an allowed testnet. Refusing to deploy.`);

const chain = defineChain({ id: chainId, name: net.name, nativeCurrency: { name: net.symbol, symbol: net.symbol, decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const walletClient = createWalletClient({ chain, account, transport: http(rpcUrl) });

const gas = await publicClient.getBalance({ address: account.address });
console.log(`Network:  ${net.name} (${chainId}) via ${rpcUrl}`);
console.log(`Deployer: ${account.address}  balance ${formatEther(gas)} ${net.symbol}`);
if (gas === 0n) fail(`Deployer has no ${net.symbol} for gas. Fund it from ${net.faucet}`);

const mintTo = (process.env.MINT_TO ?? account.address)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((a) => (isAddress(a, { strict: false }) ? getAddress(a) : fail(`MINT_TO contains an invalid address: ${a}`)));
const mintAmount = BigInt(process.env.MINT_AMOUNT ?? "1000") * 1_000_000n; // 6 decimals

console.log("Deploying RelayMesh Demo Dollar (rmUSD)…");
const deployTx = await walletClient.deployContract({ abi: demoTokenAbi, bytecode: demoTokenBytecode, args: ["RelayMesh Demo Dollar", "rmUSD"] });
console.log(`  tx ${deployTx}`);
const receipt = await publicClient.waitForTransactionReceipt({ hash: deployTx, timeout: 180_000 });
if (receipt.status !== "success" || !receipt.contractAddress) fail(`Deployment failed (status ${receipt.status})`);
const address = getAddress(receipt.contractAddress) as Address;
const code = await publicClient.getCode({ address });
if (!code || code === "0x") fail("No contract code at the deployed address");
const [name, symbol, decimals] = await Promise.all([
  publicClient.readContract({ address, abi: demoTokenAbi, functionName: "name" }),
  publicClient.readContract({ address, abi: demoTokenAbi, functionName: "symbol" }),
  publicClient.readContract({ address, abi: demoTokenAbi, functionName: "decimals" }),
]);
console.log(`✔ Deployed ${name} (${symbol}, ${decimals} decimals) at ${address} in block ${receipt.blockNumber}`);

const mints: { to: Address; amount: string; tx: Hex }[] = [];
for (const to of mintTo) {
  const tx = await walletClient.writeContract({ address, abi: demoTokenAbi, functionName: "mint", args: [to, mintAmount] });
  const r = await publicClient.waitForTransactionReceipt({ hash: tx, timeout: 180_000 });
  if (r.status !== "success") fail(`Mint to ${to} failed`);
  mints.push({ to, amount: mintAmount.toString(), tx });
  console.log(`✔ Minted ${mintAmount / 1_000_000n} rmUSD to ${to}`);
}

const sourceSha256 = createHash("sha256").update(readFileSync(join(ROOT, "contracts", "src", "DemoToken.sol"))).digest("hex");
const record = {
  chainId,
  network: net.name,
  contract: "DemoToken",
  address,
  name,
  symbol,
  decimals,
  deployer: account.address,
  deployTx,
  blockNumber: Number(receipt.blockNumber),
  sourceSha256,
  compiler: "solc 0.8.28, optimizer 200 runs, no metadata hash",
  mints,
  deployedAt: new Date().toISOString(),
  explorer: net.explorer ? `${net.explorer}/address/${address}` : null,
};
mkdirSync(join(ROOT, "deployments"), { recursive: true });
const out = join(ROOT, "deployments", `${chainId}.json`);
writeFileSync(out, JSON.stringify(record, null, 2) + "\n");
console.log(`✔ Wrote ${out}`);
if (record.explorer) console.log(`  Explorer: ${record.explorer}`);
