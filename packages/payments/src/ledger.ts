import type { Address, Hash, Hex } from "viem";
import type { VerificationReport } from "@relaymesh/chain";
import { toWire, type SignedPaymentRequest, type WireSignedPaymentRequest } from "./request.ts";

export type LedgerState = "verified" | "approved" | "submitted" | "paid" | "failed" | "declined";

export interface LedgerEntry {
  requestId: Hex;
  digest: string;
  wire: WireSignedPaymentRequest;
  state: LedgerState;
  receivedAt: number;
  updatedAt: number;
  /** Who approved: "user" or "policy:<name>" for constrained agent policies. */
  approval?: { at: number; by: string };
  txHash?: Hash;
  payer?: Address;
  verification?: { status: VerificationReport["status"]; checks: VerificationReport["checks"]; confirmations?: number; at: number };
  history: { state: LedgerState; at: number; note: string }[];
}

export interface RejectionRecord {
  requestId?: string;
  code: string;
  reason: string;
  at: number;
  from?: string;
}

export interface LedgerStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

const TRANSITIONS: Record<LedgerState, LedgerState[]> = {
  verified: ["approved", "declined"],
  approved: ["submitted", "declined"],
  submitted: ["paid", "failed", "submitted"],
  paid: [],
  failed: [],
  declined: [],
};

export class LedgerTransitionError extends Error {}

/**
 * Local execution state for payment requests. Provides replay protection:
 * each requestId can be registered once, and states only move forward.
 * Scope: per device. A second device does not see this ledger.
 */
export class RequestLedger {
  private entries = new Map<string, LedgerEntry>();
  private rejections: RejectionRecord[] = [];
  private loaded = false;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly store: LedgerStore,
    private readonly key = "relaymesh.payment-ledger.v1",
    private readonly clock: () => number = Date.now,
  ) {}

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private async ensureLoaded() {
    if (this.loaded) return;
    const raw = await this.store.get(this.key);
    if (raw) {
      const data = JSON.parse(raw) as { entries: LedgerEntry[]; rejections: RejectionRecord[] };
      this.entries = new Map(data.entries.map((e) => [e.requestId.toLowerCase(), e]));
      this.rejections = data.rejections ?? [];
    }
    this.loaded = true;
  }

  private async persist() {
    await this.store.set(this.key, JSON.stringify({ entries: [...this.entries.values()], rejections: this.rejections.slice(-200) }));
    for (const l of this.listeners) l();
  }

  async get(requestId: string): Promise<LedgerEntry | undefined> {
    await this.ensureLoaded();
    return this.entries.get(requestId.toLowerCase());
  }

  async list(): Promise<LedgerEntry[]> {
    await this.ensureLoaded();
    return [...this.entries.values()].sort((a, b) => b.receivedAt - a.receivedAt);
  }

  async listRejections(): Promise<RejectionRecord[]> {
    await this.ensureLoaded();
    return this.rejections.slice().reverse();
  }

  /** Registers a verified request. Throws if the id was already registered (replay). */
  async register(signed: SignedPaymentRequest, digest: string): Promise<LedgerEntry> {
    await this.ensureLoaded();
    const id = signed.request.requestId.toLowerCase();
    if (this.entries.has(id)) throw new LedgerTransitionError(`Duplicate request id ${id}`);
    const at = this.clock();
    const entry: LedgerEntry = {
      requestId: signed.request.requestId,
      digest,
      wire: toWire(signed),
      state: "verified",
      receivedAt: at,
      updatedAt: at,
      history: [{ state: "verified", at, note: "Signature and policy verified" }],
    };
    this.entries.set(id, entry);
    await this.persist();
    return entry;
  }

  async recordRejection(r: Omit<RejectionRecord, "at">) {
    await this.ensureLoaded();
    this.rejections.push({ ...r, at: this.clock() });
    await this.persist();
  }

  private async transition(requestId: string, to: LedgerState, note: string, mutate?: (e: LedgerEntry) => void): Promise<LedgerEntry> {
    await this.ensureLoaded();
    const e = this.entries.get(requestId.toLowerCase());
    if (!e) throw new LedgerTransitionError("Unknown request");
    if (!TRANSITIONS[e.state].includes(to)) throw new LedgerTransitionError(`Cannot move request from ${e.state} to ${to}`);
    mutate?.(e);
    e.state = to;
    e.updatedAt = this.clock();
    e.history.push({ state: to, at: e.updatedAt, note });
    await this.persist();
    return e;
  }

  /** Records an explicit approval. Refuses expired requests. */
  async approve(requestId: string, by: string): Promise<LedgerEntry> {
    const e = await this.get(requestId);
    if (e && e.wire.request.expiresAt <= Math.floor(this.clock() / 1000)) throw new LedgerTransitionError("Request has expired");
    return this.transition(requestId, "approved", `Approved by ${by}`, (x) => (x.approval = { at: this.clock(), by }));
  }

  async decline(requestId: string, note = "Declined by user"): Promise<LedgerEntry> {
    return this.transition(requestId, "declined", note);
  }

  async markSubmitted(requestId: string, txHash: Hash, payer: Address): Promise<LedgerEntry> {
    return this.transition(requestId, "submitted", `Transaction ${txHash} submitted by wallet`, (x) => {
      x.txHash = txHash;
      x.payer = payer;
    });
  }

  /** Applies an on-chain verification report. Only a "verified" report can mark a request paid. */
  async applyVerification(requestId: string, report: VerificationReport): Promise<LedgerEntry> {
    const e = await this.get(requestId);
    if (!e) throw new LedgerTransitionError("Unknown request");
    if (e.txHash?.toLowerCase() !== report.txHash.toLowerCase()) throw new LedgerTransitionError("Verification is for a different transaction");
    const to: LedgerState = report.status === "verified" ? "paid" : report.status === "failed" ? "failed" : "submitted";
    const note = report.status === "verified" ? "Receipt verified on-chain" : report.status === "failed" ? "On-chain verification failed" : "Awaiting confirmations";
    return this.transition(requestId, to, note, (x) => {
      x.verification = { status: report.status, checks: report.checks, at: report.verifiedAt };
      if (report.confirmations !== undefined) x.verification.confirmations = report.confirmations;
    });
  }
}
