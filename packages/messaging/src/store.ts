import * as nip44 from "nostr-tools/nip44";
import { getPublicKey } from "nostr-tools/pure";
import type { KeyValueStore } from "@relaymesh/identity";
import { conversationOf, type PrivateMessage } from "./envelope.ts";

export type DeliveryStatus = "sending" | "sent" | "queued" | "failed" | "received";

export interface RelayDelivery {
  url: string;
  ok: boolean;
  message: string;
}

export interface StoredMessage extends PrivateMessage {
  conversation: string;
  direction: "in" | "out";
  status: DeliveryStatus;
  relays: RelayDelivery[];
  /** Relays this message was observed on (inbound). */
  seenOn: string[];
  /** Local, app-defined metadata (e.g. payment verification results). Encrypted at rest with the history. */
  annotations?: Record<string, unknown>;
}

export interface Contact {
  pubkey: string;
  name: string;
  addedAt: number;
  note?: string;
}

interface StoreSnapshot {
  v: 1;
  messages: StoredMessage[];
  contacts: Contact[];
  lastSync: number;
}

/**
 * Local conversation history and contacts.
 *
 * Persisted encrypted to the user's own key with NIP-44 (the same self-
 * encryption pattern NIP-51 uses for private lists). At-rest history is
 * therefore unreadable without the identity key. Plaintext exists in memory
 * while the vault is unlocked.
 */
export class ConversationStore {
  private messages = new Map<string, StoredMessage>();
  private contacts = new Map<string, Contact>();
  private lastSync = 0;
  private readonly listeners = new Set<() => void>();
  private saveChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly kv: KeyValueStore,
    private readonly storageKey: string,
    private readonly secret: () => Uint8Array,
  ) {}

  static keyFor(pubkey: string) {
    return `relaymesh.history.v1.${pubkey}`;
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    for (const l of this.listeners) l();
  }

  private conversationKey() {
    const sk = this.secret();
    return nip44.getConversationKey(sk, getPublicKey(sk));
  }

  async load(): Promise<void> {
    const raw = await this.kv.get(this.storageKey);
    if (!raw) return;
    const snapshot = JSON.parse(decryptHistoryBlob(raw, this.conversationKey())) as StoreSnapshot;
    if (snapshot.v !== 1) throw new Error("Unsupported history version");
    this.messages = new Map(snapshot.messages.map((m) => [m.id, m]));
    this.contacts = new Map(snapshot.contacts.map((c) => [c.pubkey, c]));
    this.lastSync = snapshot.lastSync;
    this.emit();
  }

  private save(): Promise<void> {
    const snapshot: StoreSnapshot = {
      v: 1,
      messages: [...this.messages.values()],
      contacts: [...this.contacts.values()],
      lastSync: this.lastSync,
    };
    // NIP-44 v2 has a 64 KiB plaintext limit; chunk the snapshot into multiple ciphertexts if needed.
    const json = JSON.stringify(snapshot);
    const ck = this.conversationKey();
    const value = json.length <= 60_000 ? nip44.encrypt(json, ck) : JSON.stringify(chunk(json, 60_000).map((c) => nip44.encrypt(c, ck)));
    this.saveChain = this.saveChain.then(() => this.kv.set(this.storageKey, value));
    return this.saveChain;
  }

  upsert(m: Omit<StoredMessage, "conversation"> & { conversation?: string }): StoredMessage {
    const existing = this.messages.get(m.id);
    const merged: StoredMessage = existing
      ? {
          ...existing,
          status: m.direction === "out" ? m.status : existing.status,
          relays: m.relays.length ? m.relays : existing.relays,
          seenOn: [...new Set([...existing.seenOn, ...m.seenOn])],
        }
      : { ...m, conversation: m.conversation ?? conversationOf(m) };
    this.messages.set(m.id, merged);
    void this.save();
    this.emit();
    return merged;
  }

  get(id: string) {
    return this.messages.get(id);
  }

  annotate(id: string, key: string, value: unknown) {
    const m = this.messages.get(id);
    if (!m) return;
    m.annotations = { ...(m.annotations ?? {}), [key]: value };
    this.messages.set(id, { ...m });
    void this.save();
    this.emit();
  }

  all(): StoredMessage[] {
    return [...this.messages.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  conversation(id: string): StoredMessage[] {
    return this.all().filter((m) => m.conversation === id);
  }

  conversations(): { id: string; participants: string[]; last: StoredMessage }[] {
    const byConv = new Map<string, StoredMessage>();
    for (const m of this.all()) byConv.set(m.conversation, m);
    return [...byConv.entries()]
      .map(([id, last]) => ({ id, participants: id.split(":"), last }))
      .sort((a, b) => b.last.createdAt - a.last.createdAt);
  }

  addContact(c: Contact) {
    this.contacts.set(c.pubkey, c);
    void this.save();
    this.emit();
  }
  removeContact(pubkey: string) {
    this.contacts.delete(pubkey);
    void this.save();
    this.emit();
  }
  listContacts(): Contact[] {
    return [...this.contacts.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  contact(pubkey: string) {
    return this.contacts.get(pubkey);
  }

  getLastSync() {
    return this.lastSync;
  }
  setLastSync(sec: number) {
    if (sec > this.lastSync) {
      this.lastSync = sec;
      void this.save();
    }
  }

  async flush() {
    await this.saveChain;
  }
}

function chunk(s: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}

/** Decrypts either a single NIP-44 payload or a JSON array of chunks. */
export function decryptHistoryBlob(raw: string, conversationKey: Uint8Array): string {
  if (raw.startsWith("[")) return (JSON.parse(raw) as string[]).map((c) => nip44.decrypt(c, conversationKey)).join("");
  return nip44.decrypt(raw, conversationKey);
}
