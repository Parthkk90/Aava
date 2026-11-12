import { getAddress, type Address, type Hex } from "viem";
import { sameAddress } from "@relaymesh/chain";
import type { PaymentRequest } from "./request.ts";

/**
 * Decides whether a (creator identity, signing wallet) pair may request
 * payments in a given context. Policies run in code on the verifier's device:
 * they are never delegated to the request author or to an LLM.
 */
export interface PaymentPolicy {
  readonly name: string;
  authorize(req: PaymentRequest): PolicyDecision;
}

export type PolicyDecision =
  | { ok: true; detail: string }
  | { ok: false; code: "unauthorized-creator" | "recipient-not-allowed" | "amount-exceeds-limit" | "unknown-wallet"; detail: string };

/**
 * Community treasury policy: only listed signer wallets may create requests,
 * optionally only to listed recipients, with optional per-token limits.
 */
export class TreasuryPolicy implements PaymentPolicy {
  readonly name = "treasury";
  constructor(
    readonly config: {
      communityId: Hex;
      authorizedSigners: { wallet: Address; pubkey?: string }[];
      allowedRecipients?: Address[];
      /** token address (lowercase) -> max amount in base units */
      maxAmount?: Record<string, bigint>;
    },
  ) {}

  authorize(req: PaymentRequest): PolicyDecision {
    if (req.communityId.toLowerCase() !== this.config.communityId.toLowerCase()) {
      return { ok: false, code: "unauthorized-creator", detail: "Request is for a different community" };
    }
    const signer = this.config.authorizedSigners.find((s) => sameAddress(s.wallet, req.creatorWallet));
    if (!signer) return { ok: false, code: "unauthorized-creator", detail: `${req.creatorWallet} is not an authorised treasury signer` };
    if (signer.pubkey && signer.pubkey !== req.creatorPubkey) {
      return { ok: false, code: "unauthorized-creator", detail: "Signer wallet is bound to a different chat identity" };
    }
    if (this.config.allowedRecipients && !this.config.allowedRecipients.some((r) => sameAddress(r, req.recipient))) {
      return { ok: false, code: "recipient-not-allowed", detail: `${req.recipient} is not an allowed treasury recipient` };
    }
    const max = this.config.maxAmount?.[req.token.toLowerCase()];
    if (max !== undefined && req.amount > max) return { ok: false, code: "amount-exceeds-limit", detail: `Amount exceeds the limit of ${max}` };
    return { ok: true, detail: "Signer is an authorised treasury signer" };
  }
}

/**
 * Direct (1:1) policy: each contact's chat identity is pinned to the wallets
 * the user has accepted for them. An unknown wallet is not silently trusted:
 * the UI must ask the user to confirm it out of band before pinning it.
 */
export class ContactWalletPolicy implements PaymentPolicy {
  readonly name = "contact-wallet";
  private readonly pins = new Map<string, Set<string>>();

  constructor(initial: Record<string, Address[]> = {}) {
    for (const [pubkey, wallets] of Object.entries(initial)) for (const w of wallets) this.pin(pubkey, w);
  }

  pin(pubkey: string, wallet: Address) {
    const set = this.pins.get(pubkey) ?? new Set<string>();
    set.add(getAddress(wallet).toLowerCase());
    this.pins.set(pubkey, set);
  }

  unpin(pubkey: string, wallet: Address) {
    this.pins.get(pubkey)?.delete(wallet.toLowerCase());
  }

  pinned(pubkey: string): string[] {
    return [...(this.pins.get(pubkey) ?? [])];
  }

  export(): Record<string, string[]> {
    return Object.fromEntries([...this.pins.entries()].map(([k, v]) => [k, [...v]]));
  }

  authorize(req: PaymentRequest): PolicyDecision {
    const set = this.pins.get(req.creatorPubkey);
    if (!set || set.size === 0) {
      return { ok: false, code: "unknown-wallet", detail: "No wallet is pinned for this contact. Confirm the wallet address with them out of band." };
    }
    if (!set.has(req.creatorWallet.toLowerCase())) {
      return { ok: false, code: "unauthorized-creator", detail: `${req.creatorWallet} is not a wallet you accepted for this contact` };
    }
    return { ok: true, detail: "Wallet is pinned for this contact" };
  }
}
