import type { Address } from "viem";
import { sameAddress, type TokenRegistry } from "@relaymesh/chain";
import { MAX_REQUEST_LIFETIME_SEC, PAYMENT_REQUEST_VERSION, fromWire, recoverRequestSigner, requestDigest, type SignedPaymentRequest } from "./request.ts";
import type { PaymentPolicy } from "./policy.ts";
import type { RequestLedger } from "./ledger.ts";

export type RejectionCode =
  | "malformed"
  | "unsupported-version"
  | "invalid-signature"
  | "author-mismatch"
  | "wrong-chain"
  | "unsupported-token"
  | "amount-invalid"
  | "expired"
  | "expiry-too-far"
  | "duplicate"
  | "unauthorized-creator"
  | "recipient-not-allowed"
  | "amount-exceeds-limit"
  | "unknown-wallet";

export interface VerifyContext {
  /** Chain the verifier is willing to pay on. */
  expectedChainId: number;
  tokens: TokenRegistry;
  policy: PaymentPolicy;
  ledger: RequestLedger;
  /** Authenticated Nostr author of the message that carried the request (seal signer). */
  messageAuthor?: string;
  now?: number;
}

export interface VerifyStep {
  check: string;
  ok: boolean;
  detail: string;
}

export type VerifyResult =
  | { ok: true; signed: SignedPaymentRequest; signer: Address; digest: string; steps: VerifyStep[] }
  | { ok: false; code: RejectionCode; reason: string; steps: VerifyStep[]; signed?: SignedPaymentRequest };

/**
 * Verifies a payment request end to end. Every check is recorded so the UI
 * and Privacy Observatory can show evidence, not just a verdict.
 * Checks run in order and stop at the first failure.
 */
export async function verifyPaymentRequest(raw: unknown, ctx: VerifyContext): Promise<VerifyResult> {
  const steps: VerifyStep[] = [];
  const now = ctx.now ?? Math.floor(Date.now() / 1000);
  const fail = (code: RejectionCode, reason: string, signed?: SignedPaymentRequest): VerifyResult => {
    steps.push({ check: code, ok: false, detail: reason });
    return signed ? { ok: false, code, reason, steps, signed } : { ok: false, code, reason, steps };
  };

  let signed: SignedPaymentRequest;
  try {
    signed = fromWire(raw);
  } catch (e) {
    return fail("malformed", `Request does not match the schema: ${(e as Error).message.slice(0, 300)}`);
  }
  steps.push({ check: "schema", ok: true, detail: "Well-formed request" });
  const req = signed.request;

  if (req.version !== PAYMENT_REQUEST_VERSION) return fail("unsupported-version", `Version ${req.version} is not supported`, signed);

  let signer: Address;
  try {
    signer = await recoverRequestSigner(signed);
  } catch {
    return fail("invalid-signature", "Signature could not be recovered", signed);
  }
  if (!sameAddress(signer, req.creatorWallet)) {
    return fail("invalid-signature", `Signature was produced by ${signer}, not the declared creator wallet ${req.creatorWallet}. The request was altered or forged.`, signed);
  }
  steps.push({ check: "signature", ok: true, detail: `EIP-712 signature recovers to ${signer}` });

  if (ctx.messageAuthor !== undefined) {
    if (ctx.messageAuthor !== req.creatorPubkey) return fail("author-mismatch", "The chat identity that sent this request is not the declared creator", signed);
    steps.push({ check: "author", ok: true, detail: "Sender's chat identity matches the creator" });
  }

  if (req.chainId !== ctx.expectedChainId) return fail("wrong-chain", `Request is for chain ${req.chainId}; you are on chain ${ctx.expectedChainId}`, signed);
  steps.push({ check: "chain", ok: true, detail: `Chain ${req.chainId}` });

  const token = ctx.tokens.find(req.chainId, req.token);
  if (!token) return fail("unsupported-token", `Token contract ${req.token} is not in your allowlist for chain ${req.chainId}`, signed);
  steps.push({ check: "token", ok: true, detail: `${token.symbol} at ${token.address} (matched by address)` });

  if (req.amount <= 0n) return fail("amount-invalid", "Amount must be positive", signed);
  if (sameAddress(req.recipient, "0x0000000000000000000000000000000000000000")) return fail("amount-invalid", "Recipient is the zero address", signed);

  if (req.expiresAt <= now) return fail("expired", `Request expired at ${new Date(req.expiresAt * 1000).toISOString()}`, signed);
  if (req.expiresAt - now > MAX_REQUEST_LIFETIME_SEC) return fail("expiry-too-far", "Request validity exceeds 30 days", signed);
  steps.push({ check: "expiry", ok: true, detail: `Valid until ${new Date(req.expiresAt * 1000).toISOString()}` });

  const decision = ctx.policy.authorize(req);
  if (!decision.ok) return fail(decision.code, decision.detail, signed);
  steps.push({ check: "policy", ok: true, detail: `${ctx.policy.name}: ${decision.detail}` });

  const digest = requestDigest(req);
  const seen = await ctx.ledger.get(req.requestId);
  if (seen) return fail("duplicate", `Request id ${req.requestId.slice(0, 18)}… was already received (state: ${seen.state})`, signed);
  steps.push({ check: "replay", ok: true, detail: "Request id not seen before" });

  return { ok: true, signed, signer, digest, steps };
}
