import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { createPublicClient, createWalletClient, http, parseSignature, verifyTypedData, type Address } from "viem";
import { verifyTokenTransfer } from "@relaymesh/chain";
import { demoTokenAbi } from "@relaymesh/chain/demo-token";
import {
  X402_VERSION,
  X_PAYMENT,
  X_PAYMENT_RESPONSE,
  authorizationTypedData,
  decodeHeader,
  encodeHeader,
  exactPaymentSchema,
  type PaymentRequirements,
  type Settlement,
} from "@relaymesh/agent-sdk/x402";

export interface MerchantOptions {
  port: number;
  host?: string;
  publicUrl: string;
  rpcUrl: string;
  chainId: number;
  network: string;
  token: Address;
  tokenName: string;
  payTo: Address;
  /** Account that submits transferWithAuthorization (the facilitator role). Devnet: an unlocked anvil account. */
  facilitator: Address;
  log?: boolean;
}

interface Product {
  path: string;
  price: bigint;
  description: string;
  body: () => unknown;
}

export const PRODUCTS: Product[] = [
  {
    path: "/api/weather",
    price: 10_000n, // 0.01 rmUSD (6 decimals)
    description: "Sample weather forecast (demo data)",
    body: () => ({ city: "Lisbon", forecast: [{ day: "today", high: 24, low: 16, sky: "clear" }], source: "relaymesh demo merchant" }),
  },
  {
    path: "/api/premium-report",
    price: 30_000n, // 0.03 rmUSD: above the demo agent's auto-approve threshold
    description: "Premium market report (demo data)",
    body: () => ({ title: "Demo premium report", points: ["Fees are low on devnets", "Receipts beat promises"] }),
  },
];

/**
 * Demo x402 merchant. Acts as its own facilitator:
 * verify the EIP-3009 authorisation → submit it on-chain → verify the receipt
 * → only then serve the resource. Never trusts the client's claims.
 */
export async function createMerchant(o: MerchantOptions): Promise<{ app: FastifyInstance; url: string; close(): Promise<void> }> {
  const app = Fastify({ logger: o.log ?? false, bodyLimit: 16 * 1024 });
  await app.register(rateLimit, { max: 60, timeWindow: "1 minute" });
  const publicClient = createPublicClient({ transport: http(o.rpcUrl) });
  const walletClient = createWalletClient({ transport: http(o.rpcUrl) });
  const seenNonces = new Set<string>();

  const requirementFor = (p: Product): PaymentRequirements => ({
    scheme: "exact",
    network: o.network,
    maxAmountRequired: p.price.toString(),
    resource: `${o.publicUrl}${p.path}`,
    description: p.description,
    mimeType: "application/json",
    payTo: o.payTo,
    maxTimeoutSeconds: 120,
    asset: o.token,
    extra: { name: o.tokenName, version: "1" },
  });

  const paymentRequired = (reply: FastifyReply, p: Product, error?: string) =>
    reply.code(402).send({ x402Version: X402_VERSION, accepts: [requirementFor(p)], ...(error ? { error } : {}) });

  app.get("/health", async () => ({ ok: true, chainId: o.chainId, token: o.token, payTo: o.payTo }));

  for (const p of PRODUCTS) {
    app.get(p.path, async (req, reply) => {
      const header = req.headers[X_PAYMENT];
      if (typeof header !== "string") return paymentRequired(reply, p);
      const requirement = requirementFor(p);

      let payment;
      try {
        payment = exactPaymentSchema.parse(decodeHeader(header));
      } catch {
        return paymentRequired(reply, p, "Malformed X-PAYMENT header");
      }
      const a = payment.payload.authorization;
      const now = Math.floor(Date.now() / 1000);
      const problems: string[] = [];
      if (payment.network !== o.network) problems.push("wrong network");
      if (a.to.toLowerCase() !== o.payTo.toLowerCase()) problems.push("wrong recipient");
      if (BigInt(a.value) < p.price) problems.push("insufficient amount");
      if (Number(a.validAfter) > now) problems.push("authorization not yet valid");
      if (Number(a.validBefore) <= now + 5) problems.push("authorization expires too soon");
      if (Number(a.validBefore) > now + requirement.maxTimeoutSeconds + 60) problems.push("authorization validity too long");
      if (seenNonces.has(`${a.from}:${a.nonce}`)) problems.push("nonce already used");
      if (problems.length) return paymentRequired(reply, p, problems.join(", "));

      const sigOk = await verifyTypedData({ address: a.from, ...authorizationTypedData(requirement, a, o.chainId), signature: payment.payload.signature as `0x${string}` });
      if (!sigOk) return paymentRequired(reply, p, "invalid authorization signature");
      const used = await publicClient.readContract({ address: o.token, abi: demoTokenAbi, functionName: "authorizationState", args: [a.from, a.nonce as `0x${string}`] });
      if (used) return paymentRequired(reply, p, "nonce already used on-chain");
      seenNonces.add(`${a.from}:${a.nonce}`);

      const { r, s, v } = parseSignature(payment.payload.signature as `0x${string}`);
      let tx: `0x${string}`;
      try {
        tx = await walletClient.writeContract({
          address: o.token,
          abi: demoTokenAbi,
          functionName: "transferWithAuthorization",
          args: [a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce as `0x${string}`, Number(v ?? 27n), r, s],
          account: o.facilitator,
          chain: null,
        });
        await publicClient.waitForTransactionReceipt({ hash: tx });
      } catch (e) {
        return paymentRequired(reply, p, `settlement failed: ${(e as Error).message.split("\n")[0]}`);
      }
      const report = await verifyTokenTransfer(publicClient, tx, { chainId: o.chainId, token: o.token, from: a.from, to: o.payTo, amount: BigInt(a.value) }, 1);
      const failed = report.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join("; ");
      const settlement: Settlement =
        report.status === "verified"
          ? { success: true, transaction: tx, network: o.network, payer: a.from }
          : { success: false, transaction: tx, network: o.network, errorReason: `receipt verification ${report.status}: ${failed}` };
      reply.header(X_PAYMENT_RESPONSE, encodeHeader(settlement));
      if (!settlement.success) return paymentRequired(reply, p, settlement.errorReason);
      return reply.code(200).send(p.body());
    });
  }

  const address = await app.listen({ port: o.port, host: o.host ?? "127.0.0.1" });
  return { app, url: address, close: () => app.close() };
}
