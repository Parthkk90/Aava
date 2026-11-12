import type { Address } from "viem";
import type { KeyValueStore } from "@relaymesh/identity";

/**
 * Spending policy for an autonomous agent.
 *
 * Enforced in ordinary code, outside any language model. The LLM (if any)
 * can only *ask* for a payment; it cannot change limits, allowlists, or
 * approvals, and nothing in a message from an external party is ever
 * interpreted as authorisation.
 */
export interface SpendingPolicy {
  /** Origins (scheme://host:port) the agent may pay. Anything else is denied. */
  allowedOrigins: string[];
  /** Assets the agent may spend, by chain and contract address. */
  allowedAssets: { chainId: number; address: Address }[];
  /** Hard cap per payment, base units, per asset (lowercase address key). */
  maxPerPayment: Record<string, bigint>;
  /** Hard cap per rolling 24 h, base units, per asset. */
  maxPerDay: Record<string, bigint>;
  /** Above this amount a human must approve, per asset. Set to 0n to always require approval. */
  approvalThreshold: Record<string, bigint>;
}

export type PolicyDecision =
  | { decision: "allow"; reasons: string[] }
  | { decision: "needs-approval"; reasons: string[] }
  | { decision: "deny"; reasons: string[] };

export interface SpendRecord {
  at: number;
  asset: string;
  amount: string;
  origin: string;
  payTo: string;
  tx?: string;
  approvedBy: string;
}

export interface PaymentIntent {
  origin: string;
  chainId: number;
  asset: Address;
  payTo: Address;
  amount: bigint;
}

export class PolicyEngine {
  private records: SpendRecord[] = [];
  private loaded = false;

  constructor(
    readonly policy: SpendingPolicy,
    private readonly store?: KeyValueStore,
    private readonly key = "relaymesh.agent.spend-log.v1",
    private readonly clock: () => number = Date.now,
  ) {
    Object.freeze(policy);
  }

  private async load() {
    if (this.loaded || !this.store) return;
    const raw = await this.store.get(this.key);
    if (raw) this.records = JSON.parse(raw) as SpendRecord[];
    this.loaded = true;
  }

  async spentToday(asset: string): Promise<bigint> {
    await this.load();
    const since = this.clock() - 24 * 3600 * 1000;
    return this.records.filter((r) => r.asset === asset.toLowerCase() && r.at >= since).reduce((s, r) => s + BigInt(r.amount), 0n);
  }

  async evaluate(intent: PaymentIntent): Promise<PolicyDecision> {
    const asset = intent.asset.toLowerCase();
    const reasons: string[] = [];
    if (!this.policy.allowedOrigins.includes(intent.origin)) return { decision: "deny", reasons: [`Origin ${intent.origin} is not on the allowlist`] };
    if (!this.policy.allowedAssets.some((a) => a.chainId === intent.chainId && a.address.toLowerCase() === asset)) {
      return { decision: "deny", reasons: [`Asset ${intent.asset} on chain ${intent.chainId} is not allowed`] };
    }
    if (intent.amount <= 0n) return { decision: "deny", reasons: ["Amount must be positive"] };
    const perPayment = this.policy.maxPerPayment[asset];
    if (perPayment === undefined || intent.amount > perPayment) return { decision: "deny", reasons: [`Amount ${intent.amount} exceeds the per-payment cap ${perPayment ?? 0n}`] };
    const daily = this.policy.maxPerDay[asset] ?? 0n;
    const spent = await this.spentToday(asset);
    if (spent + intent.amount > daily) return { decision: "deny", reasons: [`Daily cap ${daily} would be exceeded (already spent ${spent})`] };
    reasons.push(`within caps (per payment ≤ ${perPayment}, today ${spent + intent.amount}/${daily})`);
    const threshold = this.policy.approvalThreshold[asset] ?? 0n;
    if (intent.amount > threshold) return { decision: "needs-approval", reasons: [...reasons, `amount above approval threshold ${threshold}`] };
    return { decision: "allow", reasons: [...reasons, `amount at or below auto-approve threshold ${threshold}`] };
  }

  async record(r: Omit<SpendRecord, "at">) {
    await this.load();
    this.records.push({ ...r, asset: r.asset.toLowerCase(), at: this.clock() });
    await this.store?.set(this.key, JSON.stringify(this.records.slice(-1000)));
  }

  async history(): Promise<SpendRecord[]> {
    await this.load();
    return this.records.slice();
  }
}
