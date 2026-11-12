import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { createPublicClient, createWalletClient, getAddress, http, type Address, type Hash } from "viem";
import { foundry } from "viem/chains";
import { demoTokenAbi, demoTokenBytecode } from "./demo-token.ts";

/**
 * Local blockchain harness for tests and the demo. Uses anvil's unlocked
 * development accounts via eth_sendTransaction, so no private key ever
 * appears in RelayMesh code. NEVER point this at a real network.
 */
export const ANVIL_ACCOUNTS: Address[] = [
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
];

export interface Anvil {
  rpcUrl: string;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export async function startAnvil(opts: { port?: number; blockTime?: number; forkUrl?: string } = {}): Promise<Anvil> {
  const port = opts.port ?? (await freePort());
  // A fork keeps the forked chain's id (e.g. Sepolia 11155111); a fresh devnet is 31337.
  const args = ["--port", String(port), "--host", "127.0.0.1", "--silent", ...(opts.forkUrl ? ["--fork-url", opts.forkUrl] : ["--chain-id", "31337"])];
  if (opts.blockTime) args.push("--block-time", String(opts.blockTime));
  const proc: ChildProcess = spawn("anvil", args, { stdio: "ignore" });
  const rpcUrl = `http://127.0.0.1:${port}`;
  const client = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
  const deadline = Date.now() + (opts.forkUrl ? 60_000 : 15_000);
  let spawnError: Error | null = null;
  proc.once("error", (e) => (spawnError = e));
  for (;;) {
    if (spawnError) throw new Error(`Could not start anvil (is Foundry installed?): ${(spawnError as Error).message}`);
    try {
      await client.getBlockNumber();
      break;
    } catch {
      if (Date.now() > deadline) {
        proc.kill();
        throw new Error("anvil did not become ready within 15s");
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return {
    rpcUrl,
    stop: () =>
      new Promise<void>((resolve) => {
        if (proc.exitCode !== null) return resolve();
        proc.once("exit", () => resolve());
        proc.kill();
      }),
  };
}

export function devClients(rpcUrl: string) {
  const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ chain: foundry, transport: http(rpcUrl) });
  return { publicClient, walletClient };
}

export async function deployDemoToken(rpcUrl: string, deployer: Address = ANVIL_ACCOUNTS[0]!, name = "RelayMesh Demo Dollar", symbol = "rmUSD"): Promise<Address> {
  const { publicClient, walletClient } = devClients(rpcUrl);
  const hash = await walletClient.deployContract({ abi: demoTokenAbi, bytecode: demoTokenBytecode, account: deployer, args: [name, symbol], chain: foundry });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error("Deployment failed");
  return getAddress(receipt.contractAddress);
}

export async function mintDemoToken(rpcUrl: string, token: Address, to: Address, amount: bigint, minter: Address = ANVIL_ACCOUNTS[0]!): Promise<Hash> {
  const { publicClient, walletClient } = devClients(rpcUrl);
  const hash = await walletClient.writeContract({ address: token, abi: demoTokenAbi, functionName: "mint", args: [to, amount], account: minter, chain: foundry });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

export async function transferDemoToken(rpcUrl: string, token: Address, from: Address, to: Address, amount: bigint): Promise<Hash> {
  const { publicClient, walletClient } = devClients(rpcUrl);
  const hash = await walletClient.writeContract({ address: token, abi: demoTokenAbi, functionName: "transfer", args: [to, amount], account: from, chain: foundry });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

export async function mineBlocks(rpcUrl: string, n: number) {
  const { publicClient } = devClients(rpcUrl);
  await publicClient.request({ method: "anvil_mine" as never, params: [`0x${n.toString(16)}`] as never });
}
