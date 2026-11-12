import { z } from "zod";
import { getAddress, isAddress, type Address, type Hex } from "viem";

/**
 * x402 (HTTP 402 payments), version 1, "exact" scheme on EVM.
 *
 *   1. Client requests a resource → server answers 402 with PaymentRequirements.
 *   2. Client signs an EIP-3009 TransferWithAuthorization for the token (no tx sent).
 *   3. Client retries with header X-PAYMENT: base64(JSON payment payload).
 *   4. Server (acting as facilitator) verifies, submits transferWithAuthorization,
 *      waits for the receipt, and answers 200 with X-PAYMENT-RESPONSE.
 *
 * Network identifiers follow x402 naming where one exists; the local devnet
 * uses "relaymesh-local-31337", which is not a registered x402 network.
 */
export const X402_VERSION = 1;
export const X_PAYMENT = "x-payment";
export const X_PAYMENT_RESPONSE = "x-payment-response";
const MAX_HEADER_BYTES = 8 * 1024;

export const NETWORKS: Record<string, number> = {
  "relaymesh-local-31337": 31337,
  gnosis: 100,
  "gnosis-chiado": 10200,
  sepolia: 11155111,
  base: 8453,
  "base-sepolia": 84532,
};

export function chainIdForNetwork(network: string): number | undefined {
  return NETWORKS[network];
}

const address = z
  .string()
  .refine((a) => isAddress(a, { strict: false }), "invalid address")
  .transform((a) => getAddress(a));
const uintString = z.string().regex(/^\d{1,78}$/);

export const paymentRequirementsSchema = z.object({
  scheme: z.literal("exact"),
  network: z.string().min(1).max(64),
  maxAmountRequired: uintString,
  resource: z.string().url(),
  description: z.string().max(500),
  mimeType: z.string().max(100),
  payTo: address,
  maxTimeoutSeconds: z.number().int().positive().max(3600),
  asset: address,
  extra: z.object({ name: z.string().max(100), version: z.string().max(20) }),
});
export type PaymentRequirements = z.infer<typeof paymentRequirementsSchema>;

export const paymentRequiredSchema = z.object({
  x402Version: z.literal(X402_VERSION),
  accepts: z.array(z.unknown()).min(1).max(16),
  error: z.string().max(500).optional(),
});

export const authorizationSchema = z.object({
  from: address,
  to: address,
  value: uintString,
  validAfter: uintString,
  validBefore: uintString,
  nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});
export type Authorization = z.infer<typeof authorizationSchema>;

export const exactPaymentSchema = z.object({
  x402Version: z.literal(X402_VERSION),
  scheme: z.literal("exact"),
  network: z.string().min(1).max(64),
  payload: z.object({ signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/), authorization: authorizationSchema }),
});
export type ExactPayment = z.infer<typeof exactPaymentSchema>;

export const settlementSchema = z.object({
  success: z.boolean(),
  transaction: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  network: z.string(),
  payer: address.optional(),
  errorReason: z.string().optional(),
});
export type Settlement = z.infer<typeof settlementSchema>;

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export function authorizationTypedData(req: PaymentRequirements, auth: Authorization, chainId: number) {
  return {
    domain: { name: req.extra.name, version: req.extra.version, chainId, verifyingContract: req.asset },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization" as const,
    message: {
      from: auth.from,
      to: auth.to,
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce as Hex,
    },
  };
}

export function encodeHeader(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

export function decodeHeader(value: string): unknown {
  if (value.length > MAX_HEADER_BYTES) throw new Error("x402 header too large");
  return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
}

export function randomNonce(): Hex {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return `0x${Buffer.from(b).toString("hex")}`;
}

export type { Address };
