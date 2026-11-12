import type { StoredMessage } from "@relaymesh/messaging";

export interface ApprovalRequest {
  id: string;
  summary: string;
  details: Record<string, string>;
}

/** How a human approves agent payments. */
export interface ApprovalChannel {
  request(req: ApprovalRequest, timeoutMs: number): Promise<boolean>;
}

/** Programmatic channel (CLI prompt, UI, tests). */
export class CallbackApprovalChannel implements ApprovalChannel {
  constructor(private readonly decide: (req: ApprovalRequest) => Promise<boolean>) {}
  async request(req: ApprovalRequest, timeoutMs: number) {
    return Promise.race([this.decide(req), new Promise<boolean>((r) => setTimeout(() => r(false), timeoutMs))]);
  }
}

/**
 * Approval over NIP-17 from the agent's owner.
 *
 * The agent sends its owner an encrypted request. Only a reply whose
 * authenticated author (seal signer) is the owner's key AND whose content is
 * exactly "approve <id>" counts. Everything else, including messages that
 * merely contain those words, quote them, or come from anyone else, is
 * ignored. Silence means deny.
 */
export class Nip17ApprovalChannel implements ApprovalChannel {
  private readonly waiting = new Map<string, (ok: boolean) => void>();

  constructor(
    private readonly ownerPubkey: string,
    private readonly send: (to: string, text: string) => Promise<unknown>,
  ) {}

  /** Feed every inbound message here. Returns true if it was an approval decision. */
  handle(m: StoredMessage): boolean {
    if (m.direction !== "in" || m.from !== this.ownerPubkey || m.type !== "text") return false;
    const match = /^(approve|deny) ([0-9a-f]{16})$/.exec(m.content.trim());
    if (!match) return false;
    const resolve = this.waiting.get(match[2]!);
    if (!resolve) return false;
    this.waiting.delete(match[2]!);
    resolve(match[1] === "approve");
    return true;
  }

  async request(req: ApprovalRequest, timeoutMs: number): Promise<boolean> {
    const lines = [`Agent payment approval ${req.id}`, req.summary, ...Object.entries(req.details).map(([k, v]) => `${k}: ${v}`), "", `Reply exactly "approve ${req.id}" or "deny ${req.id}".`];
    const decision = new Promise<boolean>((resolve) => {
      this.waiting.set(req.id, resolve);
      setTimeout(() => {
        if (this.waiting.delete(req.id)) resolve(false);
      }, timeoutMs);
    });
    await this.send(this.ownerPubkey, lines.join("\n"));
    return decision;
  }
}
