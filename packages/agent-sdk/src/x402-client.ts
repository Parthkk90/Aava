import { getAddress, type Address } from "viem";
import { verifyTokenTransfer, type VerificationReport, type VerifierClient } from "@relaymesh/chain";
import {
  X402_VERSION,
  X_PAYMENT,
  X_PAYMENT_RESPONSE,
  authorizationTypedData,
  chainIdForNetwork,
  decodeHeader,
  encodeHeader,
  paymentRequiredSchema,
  paymentRequirementsSchema,
  randomNonce,
  settlementSchema,
  type Authorization,
  type PaymentRequirements,
  type Settlement,
} from "./x402.ts";
import type { PolicyDecision, PolicyEngine } from "./policy.ts";
import type { ApprovalChannel } from "./approvals.ts";
import type { AgentSigner } from "./signer.ts";

export class PaymentDeniedError extends Error {
  constructor(
    readonly reasons: string[],
    message = `Payment denied: ${reasons.join("; ")}`,
  ) {
    super(message);
  }
}

export interface X402ClientOptions {
  signer: AgentSigner;
  policy: PolicyEngine;
  approvals?: ApprovalChannel;
  /** RPC client per chain for independent receipt verification. */
  verifier: (chainId: number) => VerifierClient;
  fetch?: typeof fetch;
  approvalTimeoutMs?: number;
  requiredConfirmations?: number;
  log?: (msg: string) => void;
}

export interface PaidFetchResult {
  response: Response;
  paid: boolean;
  requirement?: PaymentRequirements;
  decision?: PolicyDecision;
  settlement?: Settlement;
  /** Our own on-chain verification of the merchant's claimed settlement. */
  verification?: VerificationReport;
}

/**
 * Fetch wrapper that can pay x402 "exact" requirements, but only within the
 * spending policy and with human approval where required. The merchant's
 * claim of settlement is independently verified on-chain.
 */
export class X402Client {
  private readonly f: typeof fetch;
  private readonly log: (m: string) => void;

  constructor(private readonly opts: X402ClientOptions) {
    this.f = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.log = opts.log ?? (() => {});
  }

  async fetch(url: string, init: RequestInit = {}): Promise<PaidFetchResult> {
    const first = await this.f(url, init);
    if (first.status !== 402) return { response: first, paid: false };

    const body = paymentRequiredSchema.parse(await first.json());
    const origin = new URL(url).origin;
    const candidates: { req: PaymentRequirements; chainId: number }[] = [];
    for (const raw of body.accepts) {
      const parsed = paymentRequirementsSchema.safeParse(raw);
      if (!parsed.success) continue;
      const chainId = chainIdForNetwork(parsed.data.network);
      if (chainId === undefined) continue;
      // A server may only charge for its own resources (prevents redirecting payment to another origin's offer).
      if (new URL(parsed.data.resource).origin !== origin) continue;
      candidates.push({ req: parsed.data, chainId });
    }
    if (candidates.length === 0) throw new PaymentDeniedError(["No acceptable x402 payment option (unknown network, malformed, or foreign resource)"]);

    let chosen: { req: PaymentRequirements; chainId: number; decision: PolicyDecision } | null = null;
    const denials: string[] = [];
    for (const c of candidates) {
      const decision = await this.opts.policy.evaluate({ origin, chainId: c.chainId, asset: c.req.asset, payTo: c.req.payTo, amount: BigInt(c.req.maxAmountRequired) });
      if (decision.decision !== "deny") {
        chosen = { ...c, decision };
        break;
      }
      denials.push(...decision.reasons);
    }
    if (!chosen) throw new PaymentDeniedError(denials);
    const { req, chainId, decision } = chosen;
    this.log(`402 from ${origin}: ${req.maxAmountRequired} of ${req.asset} → ${req.payTo} (${decision.decision})`);

    let approvedBy = "policy:auto";
    if (decision.decision === "needs-approval") {
      if (!this.opts.approvals) throw new PaymentDeniedError(["Human approval required but no approval channel is configured"]);
      const id = randomNonce().slice(2, 18);
      const ok = await this.opts.approvals.request(
        {
          id,
          summary: `Pay ${req.maxAmountRequired} base units for ${req.resource}`,
          details: { Merchant: origin, "Pay to": req.payTo, Token: req.asset, Chain: String(chainId), Description: req.description },
        },
        this.opts.approvalTimeoutMs ?? 120_000,
      );
      if (!ok) throw new PaymentDeniedError(["Human approver declined or did not answer in time"]);
      approvedBy = "human";
    }

    const from = getAddress(await this.opts.signer.address());
    const now = Math.floor(Date.now() / 1000);
    const auth: Authorization = {
      from,
      to: req.payTo,
      value: req.maxAmountRequired,
      validAfter: String(now - 60),
      validBefore: String(now + req.maxTimeoutSeconds),
      nonce: randomNonce(),
    };
    const signature = await this.opts.signer.signTypedData(authorizationTypedData(req, auth, chainId));
    // Record before sending: once the server holds the authorisation it can settle it.
    await this.opts.policy.record({ asset: req.asset, amount: req.maxAmountRequired, origin, payTo: req.payTo, approvedBy });

    const headers = new Headers(init.headers);
    headers.set(X_PAYMENT, encodeHeader({ x402Version: X402_VERSION, scheme: "exact", network: req.network, payload: { signature, authorization: auth } }));
    const second = await this.f(url, { ...init, headers });

    const result: PaidFetchResult = { response: second, paid: true, requirement: req, decision };
    const settlementHeader = second.headers.get(X_PAYMENT_RESPONSE);
    if (settlementHeader) {
      const parsed = settlementSchema.safeParse(decodeHeader(settlementHeader));
      if (parsed.success) result.settlement = parsed.data;
    }
    if (result.settlement?.success && result.settlement.transaction) {
      result.verification = await verifyTokenTransfer(
        this.opts.verifier(chainId),
        result.settlement.transaction as `0x${string}`,
        { chainId, token: req.asset, from, to: req.payTo as Address, amount: BigInt(req.maxAmountRequired) },
        this.opts.requiredConfirmations ?? 1,
      );
      this.log(`settlement ${result.settlement.transaction}: on-chain verification ${result.verification.status}`);
    }
    return result;
  }
}
