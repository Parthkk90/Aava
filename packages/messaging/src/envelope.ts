import * as nip59 from "nostr-tools/nip59";
import { getEventHash, getPublicKey, type NostrEvent } from "nostr-tools/pure";

/**
 * NIP-17 private messages.
 *
 *   rumor (kind 14, unsigned)  --NIP-44-->  seal (kind 13, signed by sender)
 *   seal  --NIP-44 with random key-->  gift wrap (kind 1059, signed by one-time key, p-tag = recipient)
 *
 * Built with nostr-tools nip59 primitives so RelayMesh can attach typed
 * payload tags. One wrap is produced for each recipient plus one for the
 * sender (so the sender can sync history across devices).
 */
export const CHAT_KIND = 14;
export const GIFT_WRAP_KIND = 1059;
export const SEAL_KIND = 13;
export const MAX_CONTENT_BYTES = 64 * 1024;

export type PayloadType = "text" | "payment-request" | "payment-receipt" | "community-invite" | "community-event" | "key-rotation";
const PAYLOAD_TYPES: readonly PayloadType[] = ["text", "payment-request", "payment-receipt", "community-invite", "community-event", "key-rotation"];

export interface OutgoingMessage {
  type: PayloadType;
  /** Human-readable text, or JSON for structured payloads. */
  content: string;
  subject?: string;
  replyTo?: string;
  /** Extra tags, e.g. ["h", communityId]. Never put secrets here: the rumor is visible to all recipients. */
  extraTags?: string[][];
}

export interface PrivateMessage {
  /** Rumor id: stable identifier shared by all recipients' copies. */
  id: string;
  from: string;
  /** All p-tagged recipients (not including the sender unless self-addressed). */
  to: string[];
  createdAt: number;
  type: PayloadType;
  content: string;
  subject?: string;
  replyTo?: string;
  tags: string[][];
}

export interface BuiltMessage {
  rumorId: string;
  wraps: { recipient: string; event: NostrEvent }[];
  createdAt: number;
}

export function buildPrivateMessage(
  senderSecret: Uint8Array,
  recipients: string[],
  msg: OutgoingMessage,
  createdAt = Math.floor(Date.now() / 1000),
): BuiltMessage {
  if (recipients.length === 0) throw new Error("At least one recipient is required");
  if (new TextEncoder().encode(msg.content).length > MAX_CONTENT_BYTES) throw new Error("Message is too large");
  const uniqueRecipients = [...new Set(recipients)];
  const tags: string[][] = uniqueRecipients.map((p) => ["p", p]);
  if (msg.type !== "text") tags.push(["relaymesh", msg.type]);
  if (msg.subject) tags.push(["subject", msg.subject]);
  if (msg.replyTo) tags.push(["e", msg.replyTo, "", "reply"]);
  for (const t of msg.extraTags ?? []) tags.push(t);

  const rumor = nip59.createRumor({ kind: CHAT_KIND, content: msg.content, tags, created_at: createdAt }, senderSecret);
  const self = getPublicKey(senderSecret);
  const targets = [...new Set([...uniqueRecipients, self])];
  const wraps = targets.map((recipient) => ({
    recipient,
    event: nip59.createWrap(nip59.createSeal(rumor, senderSecret, recipient), recipient),
  }));
  return { rumorId: rumor.id, wraps, createdAt };
}

export class InvalidMessageError extends Error {}

/**
 * Opens a gift wrap addressed to us.
 * nostr-tools verifies the seal signature and that seal.pubkey === rumor.pubkey.
 * We additionally verify the rumor id, kind, and payload type.
 */
export function openGiftWrap(wrap: NostrEvent, recipientSecret: Uint8Array): PrivateMessage {
  if (wrap.kind !== GIFT_WRAP_KIND) throw new InvalidMessageError("Not a gift wrap");
  let rumor: ReturnType<typeof nip59.unwrapEvent>;
  try {
    rumor = nip59.unwrapEvent(wrap, recipientSecret);
  } catch (e) {
    throw new InvalidMessageError(`Cannot open gift wrap: ${(e as Error).message}`);
  }
  if (rumor.kind !== CHAT_KIND) throw new InvalidMessageError(`Unsupported rumor kind ${rumor.kind}`);
  const expectedId = getEventHash({ ...rumor });
  if (rumor.id !== expectedId) throw new InvalidMessageError("Rumor id does not match its contents");
  if (typeof rumor.content !== "string" || !Array.isArray(rumor.tags)) throw new InvalidMessageError("Malformed rumor");
  const typeTag = rumor.tags.find((t) => t[0] === "relaymesh")?.[1];
  const type: PayloadType = typeTag === undefined ? "text" : (PAYLOAD_TYPES as readonly string[]).includes(typeTag) ? (typeTag as PayloadType) : "text";
  const message: PrivateMessage = {
    id: rumor.id,
    from: rumor.pubkey,
    to: rumor.tags.filter((t) => t[0] === "p" && typeof t[1] === "string").map((t) => t[1] as string),
    createdAt: rumor.created_at,
    type,
    content: rumor.content,
    tags: rumor.tags,
  };
  const subject = rumor.tags.find((t) => t[0] === "subject")?.[1];
  if (subject) message.subject = subject;
  const replyTo = rumor.tags.find((t) => t[0] === "e")?.[1];
  if (replyTo) message.replyTo = replyTo;
  return message;
}

/** Stable conversation id: the sorted set of participants (NIP-17 semantics). */
export function conversationId(participants: string[]): string {
  return [...new Set(participants)].sort().join(":");
}

export function conversationOf(message: PrivateMessage): string {
  return conversationId([message.from, ...message.to]);
}

/**
 * Filter for our inbox. Gift wraps carry a randomised created_at up to two
 * days in the past (NIP-59), so `since` must include that margin.
 */
export function inboxFilter(pubkey: string, sinceSec?: number) {
  const filter: { kinds: number[]; "#p": string[]; since?: number } = { kinds: [GIFT_WRAP_KIND], "#p": [pubkey] };
  if (sinceSec !== undefined) filter.since = Math.max(0, sinceSec - 3 * 24 * 3600);
  return filter;
}
