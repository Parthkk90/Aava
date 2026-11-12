import { getPublicKey, type NostrEvent } from "nostr-tools/pure";
import type { Filter } from "nostr-tools/filter";
import { buildPrivateMessage, inboxFilter, InvalidMessageError, openGiftWrap, type OutgoingMessage, type PrivateMessage } from "./envelope.ts";
import type { ConversationStore, StoredMessage } from "./store.ts";

/** Structural interface satisfied by @relaymesh/relay-mesh's RelayMesh. */
export interface MessageTransport {
  publish(event: NostrEvent): Promise<{ eventId: string; outcomes: { url: string; ok: boolean; message: string }[]; queued: boolean }>;
  subscribe(filters: Filter[], onevent: (e: NostrEvent, relayUrl: string) => void): { close(): void };
}

export interface MessengerEvents {
  onMessage?: (m: StoredMessage) => void;
  onRejected?: (wrapId: string, reason: string, relayUrl: string) => void;
}

/**
 * Sends and receives NIP-17 private messages over any transport,
 * persisting conversation state locally.
 */
export class Messenger {
  private sub: { close(): void } | null = null;
  readonly rejected: { wrapId: string; reason: string; relayUrl: string; at: number }[] = [];

  constructor(
    private readonly transport: MessageTransport,
    private readonly store: ConversationStore,
    private readonly secret: () => Uint8Array,
    private readonly events: MessengerEvents = {},
  ) {}

  get pubkey() {
    return getPublicKey(this.secret());
  }

  start() {
    this.stop();
    const me = this.pubkey;
    const filter = inboxFilter(me, this.store.getLastSync() || undefined);
    this.sub = this.transport.subscribe([filter], (wrap, relayUrl) => this.receive(wrap, relayUrl));
  }

  stop() {
    this.sub?.close();
    this.sub = null;
  }

  /** Processes one inbound gift wrap. Invalid wraps are recorded and dropped. */
  receive(wrap: NostrEvent, relayUrl: string): StoredMessage | null {
    let msg: PrivateMessage;
    try {
      msg = openGiftWrap(wrap, this.secret());
    } catch (e) {
      const reason = e instanceof InvalidMessageError ? e.message : `Unexpected error: ${(e as Error).message}`;
      this.rejected.push({ wrapId: wrap.id, reason, relayUrl, at: Date.now() });
      if (this.rejected.length > 200) this.rejected.shift();
      this.events.onRejected?.(wrap.id, reason, relayUrl);
      return null;
    }
    const me = this.pubkey;
    const stored = this.store.upsert({
      ...msg,
      direction: msg.from === me ? "out" : "in",
      status: msg.from === me ? "sent" : "received",
      relays: [],
      seenOn: [relayUrl],
    });
    this.store.setLastSync(msg.createdAt);
    this.events.onMessage?.(stored);
    return stored;
  }

  async send(recipients: string[], message: OutgoingMessage): Promise<StoredMessage> {
    const sk = this.secret();
    const me = getPublicKey(sk);
    const built = buildPrivateMessage(sk, recipients, message);
    const base: Omit<StoredMessage, "conversation"> = {
      id: built.rumorId,
      from: me,
      to: [...new Set(recipients)],
      createdAt: built.createdAt,
      type: message.type,
      content: message.content,
      tags: [],
      direction: "out",
      status: "sending",
      relays: [],
      seenOn: [],
    };
    if (message.subject) base.subject = message.subject;
    if (message.replyTo) base.replyTo = message.replyTo;
    this.store.upsert(base);

    const results = await Promise.all(built.wraps.map((w) => this.transport.publish(w.event)));
    // A message counts as sent once every recipient's wrap (excluding our self-copy) reached at least one relay.
    const recipientResults = results.filter((_, i) => built.wraps[i]!.recipient !== me || recipients.includes(me));
    const allDelivered = recipientResults.every((r) => r.outcomes.some((o) => o.ok));
    const anyQueued = recipientResults.some((r) => r.queued);
    const relays = mergeOutcomes(results.flatMap((r) => r.outcomes));
    return this.store.upsert({ ...base, status: allDelivered ? "sent" : anyQueued ? "queued" : "failed", relays });
  }
}

function mergeOutcomes(outcomes: { url: string; ok: boolean; message: string }[]) {
  const byUrl = new Map<string, { url: string; ok: boolean; message: string }>();
  for (const o of outcomes) {
    const prev = byUrl.get(o.url);
    if (!prev) byUrl.set(o.url, { ...o });
    else if (!o.ok) byUrl.set(o.url, { ...o });
  }
  return [...byUrl.values()];
}
