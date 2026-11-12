import { getAddress } from "viem";
import { DEMO_TOKEN_ADDRESS } from "@relaymesh/chain";
import { createMerchant } from "./index.ts";

const env = process.env;
const port = Number(env.MERCHANT_PORT ?? 7080);
const merchant = await createMerchant({
  port,
  host: env.MERCHANT_HOST ?? "127.0.0.1",
  publicUrl: env.MERCHANT_PUBLIC_URL ?? `http://127.0.0.1:${port}`,
  rpcUrl: env.RPC_URL ?? "http://127.0.0.1:8545",
  chainId: Number(env.CHAIN_ID ?? 31337),
  network: env.X402_NETWORK ?? "relaymesh-local-31337",
  token: getAddress(env.TOKEN_ADDRESS ?? DEMO_TOKEN_ADDRESS),
  tokenName: env.TOKEN_NAME ?? "RelayMesh Demo Dollar",
  // anvil account #5 receives, #6 submits (facilitator). Devnet only.
  payTo: getAddress(env.PAY_TO ?? "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc"),
  facilitator: getAddress(env.FACILITATOR ?? "0x976EA74026E726554dB657fA54763abd0C3a0aa9"),
  log: true,
});
console.log(`[merchant] listening on ${merchant.url}`);
const stop = async () => {
  await merchant.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
