import { finalizeEvent, verifyEvent, type NostrEvent } from "nostr-tools/pure";
import { publicIdentity } from "./keys.ts";

/**
 * Key rotation notice.
 *
 * There is no ratified Nostr NIP for key migration. RelayMesh therefore uses a
 * conservative, local construction built only from NIP-01 signatures: the old
 * key signs a statement naming the new key, and the new key signs a statement
 * naming the old key. Contacts receive the notice over NIP-17 and decide
 * whether to accept it. This is NOT network-wide revocation: anyone holding a
 * stolen old key can still sign as the old identity.
 */
export const ROTATION_KIND = 30078; // NIP-78 application-specific data
const D_TAG = "relaymesh/key-rotation/v1";

export interface RotationNotice {
  byOld: NostrEvent;
  byNew: NostrEvent;
}

/**
 * Verifies a canonical copy of the event. nostr-tools caches verification
 * results in a symbol property that object spread copies, so verifying the
 * original object could accept a tampered clone of a previously verified event.
 */
export function verifyEventStrict(e: NostrEvent): boolean {
  try {
    return verifyEvent({ id: e.id, pubkey: e.pubkey, created_at: e.created_at, kind: e.kind, tags: e.tags, content: e.content, sig: e.sig });
  } catch {
    return false;
  }
}

function statement(oldPubkey: string, newPubkey: string, createdAt: number) {
  return JSON.stringify({ type: "relaymesh.key-rotation", v: 1, oldPubkey, newPubkey, createdAt });
}

export function createRotationNotice(oldSecret: Uint8Array, newSecret: Uint8Array, createdAt = Math.floor(Date.now() / 1000)): RotationNotice {
  const oldPubkey = publicIdentity(oldSecret).pubkey;
  const newPubkey = publicIdentity(newSecret).pubkey;
  const content = statement(oldPubkey, newPubkey, createdAt);
  // finalizeEvent mutates its argument, so each signature gets a fresh template.
  const template = () => ({ kind: ROTATION_KIND, created_at: createdAt, tags: [["d", D_TAG]], content });
  return { byOld: finalizeEvent(template(), oldSecret), byNew: finalizeEvent(template(), newSecret) };
}

export function verifyRotationNotice(notice: RotationNotice): { oldPubkey: string; newPubkey: string } {
  const { byOld, byNew } = notice;
  if (!verifyEventStrict(byOld) || !verifyEventStrict(byNew)) throw new Error("Invalid rotation signature");
  if (byOld.content !== byNew.content) throw new Error("Rotation statements differ");
  const parsed = JSON.parse(byOld.content) as { type?: string; v?: number; oldPubkey?: string; newPubkey?: string };
  if (parsed.type !== "relaymesh.key-rotation" || parsed.v !== 1) throw new Error("Unknown rotation statement");
  if (parsed.oldPubkey !== byOld.pubkey || parsed.newPubkey !== byNew.pubkey) throw new Error("Rotation signers do not match statement");
  if (parsed.oldPubkey === parsed.newPubkey) throw new Error("Rotation to the same key");
  return { oldPubkey: parsed.oldPubkey, newPubkey: parsed.newPubkey };
}
