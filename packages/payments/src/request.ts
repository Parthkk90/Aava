import { z } from "zod";
import { hashTypedData, isAddress, getAddress, recoverTypedDataAddress, keccak256, toHex, type Address, type Hex } from "viem";

/**
 * Authenticated payment requests (EIP-712).
 *
 * A payment request is a statement "creator asks for `amount` of `token` to be
 * paid to `recipient` on `chainId`", signed by the creator's wallet. It is NOT
 * an authorisation to spend: the payer must still explicitly approve the
 * transfer in their own wallet.
 *
 * EIP-712 does not provide replay protection on its own. RelayMesh adds a
 * random 32-byte requestId, an expiry, and a local execution ledger.
 */
export const PAYMENT_REQUEST_VERSION = 1;
export const MAX_DESCRIPTION_LENGTH = 280;
/** Requests may not be valid for longer than 30 days. */
export const MAX_REQUEST_LIFETIME_SEC = 30 * 24 * 3600;
export const ZERO_COMMUNITY: Hex = `0x${"00".repeat(32)}`;

export const PAYMENT_REQUEST_TYPES = {
  PaymentRequest: [
    { name: "version", type: "uint16" },
    { name: "requestId", type: "bytes32" },
    { name: "communityId", type: "bytes32" },
    { name: "creatorPubkey", type: "bytes32" },
    { name: "creatorWallet", type: "address" },
    { name: "chainId", type: "uint256" },
    { name: "token", type: "address" },
    { name: "recipient", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "expiresAt", type: "uint64" },
    { name: "description", type: "string" },
  ],
} as const;

export function paymentRequestDomain(chainId: number) {
  return { name: "RelayMesh Payment Request", version: "1", chainId } as const;
}

export interface PaymentRequest {
  version: number;
  requestId: Hex;
  communityId: Hex;
  /** Nostr public key (hex) of the creator — binds the request to a chat identity. */
  creatorPubkey: string;
  creatorWallet: Address;
  chainId: number;
  token: Address;
  recipient: Address;
  amount: bigint;
  expiresAt: number;
  description: string;
}

export interface SignedPaymentRequest {
  request: PaymentRequest;
  signature: Hex;
}

const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const address = z.string().refine((a) => isAddress(a, { strict: false }), "invalid address").transform((a) => getAddress(a));

/** Wire format: bigint as decimal string. Strict: unknown fields are rejected. */
export const wireRequestSchema = z
  .object({
    version: z.number().int(),
    requestId: hex32,
    communityId: hex32,
    creatorPubkey: z.string().regex(/^[0-9a-f]{64}$/),
    creatorWallet: address,
    chainId: z.number().int().positive(),
    token: address,
    recipient: address,
    amount: z.string().regex(/^[0-9]{1,78}$/),
    expiresAt: z.number().int().positive(),
    description: z.string().max(MAX_DESCRIPTION_LENGTH),
  })
  .strict();

export const wireSignedSchema = z
  .object({
    type: z.literal("relaymesh.payment-request"),
    request: wireRequestSchema,
    signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
  })
  .strict();

export type WireSignedPaymentRequest = z.input<typeof wireSignedSchema>;

export function newRequestId(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

/** Community identifiers are hashed into bytes32 so the EIP-712 type is fixed-size. */
export function communityIdFromString(id: string): Hex {
  return id ? keccak256(new TextEncoder().encode(`relaymesh.community:${id}`)) : ZERO_COMMUNITY;
}

export interface NewRequestInput {
  communityId?: Hex;
  creatorPubkey: string;
  creatorWallet: Address;
  chainId: number;
  token: Address;
  recipient: Address;
  amount: bigint;
  /** Lifetime in seconds from now. */
  ttlSec?: number;
  description?: string;
  now?: number;
}

export function createPaymentRequest(input: NewRequestInput): PaymentRequest {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const ttl = input.ttlSec ?? 24 * 3600;
  if (ttl <= 0 || ttl > MAX_REQUEST_LIFETIME_SEC) throw new Error("Request lifetime must be between 1 second and 30 days");
  if (input.amount <= 0n) throw new Error("Amount must be positive");
  const description = (input.description ?? "").slice(0, MAX_DESCRIPTION_LENGTH);
  return {
    version: PAYMENT_REQUEST_VERSION,
    requestId: newRequestId(),
    communityId: input.communityId ?? ZERO_COMMUNITY,
    creatorPubkey: input.creatorPubkey.toLowerCase(),
    creatorWallet: getAddress(input.creatorWallet),
    chainId: input.chainId,
    token: getAddress(input.token),
    recipient: getAddress(input.recipient),
    amount: input.amount,
    expiresAt: now + ttl,
    description,
  };
}

/** The exact EIP-712 payload a wallet signs (eth_signTypedData_v4). */
export function typedDataFor(req: PaymentRequest) {
  return {
    domain: paymentRequestDomain(req.chainId),
    types: PAYMENT_REQUEST_TYPES,
    primaryType: "PaymentRequest" as const,
    message: {
      version: req.version,
      requestId: req.requestId,
      communityId: req.communityId,
      creatorPubkey: `0x${req.creatorPubkey}` as Hex,
      creatorWallet: req.creatorWallet,
      chainId: BigInt(req.chainId),
      token: req.token,
      recipient: req.recipient,
      amount: req.amount,
      expiresAt: BigInt(req.expiresAt),
      description: req.description,
    },
  };
}

export function requestDigest(req: PaymentRequest): Hex {
  return hashTypedData(typedDataFor(req));
}

export async function recoverRequestSigner(signed: SignedPaymentRequest): Promise<Address> {
  return recoverTypedDataAddress({ ...typedDataFor(signed.request), signature: signed.signature });
}

export function toWire(signed: SignedPaymentRequest): WireSignedPaymentRequest {
  return {
    type: "relaymesh.payment-request",
    request: { ...signed.request, amount: signed.request.amount.toString() },
    signature: signed.signature,
  };
}

export function fromWire(raw: unknown): SignedPaymentRequest {
  const obj = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  const parsed = wireSignedSchema.parse(obj);
  return {
    request: { ...parsed.request, requestId: parsed.request.requestId as Hex, communityId: parsed.request.communityId as Hex, amount: BigInt(parsed.request.amount) },
    signature: parsed.signature as Hex,
  };
}
