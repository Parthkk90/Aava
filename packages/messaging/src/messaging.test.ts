import { describe, expect, it } from "vitest";
import * as nip59 from "nostr-tools/nip59";
import { generateSecretKey, getEventHash, getPublicKey } from "nostr-tools/pure";
import { MemoryStore } from "@relaymesh/identity";
import { ConversationStore, GIFT_WRAP_KIND, SEAL_KIND, buildPrivateMessage, conversationId, openGiftWrap } from "./index.ts";

const alice = generateSecretKey();
const bob = generateSecretKey();
const carol = generateSecretKey();
const A = getPublicKey(alice);
const B = getPublicKey(bob);

describe("NIP-17 envelope", () => {
  it("delivers to the recipient and the sender's own copy only", () => {
    const secret = "meet at the usual place 7pm";
    const built = buildPrivateMessage(alice, [B], { type: "text", content: secret });
    expect(built.wraps.map((w) => w.recipient).sort()).toEqual([A, B].sort());
    const toBob = built.wraps.find((w) => w.recipient === B)!.event;
    const msg = openGiftWrap(toBob, bob);
    expect(msg).toMatchObject({ from: A, to: [B], content: secret, type: "text", id: built.rumorId });
    const toSelf = built.wraps.find((w) => w.recipient === A)!.event;
    expect(openGiftWrap(toSelf, alice).id).toBe(built.rumorId);
    expect(() => openGiftWrap(toBob, carol)).toThrow();
  });

  it("hides sender identity and plaintext from the relay-visible event", () => {
    const secret = "the treasury multisig moves tonight";
    const built = buildPrivateMessage(alice, [B], { type: "text", content: secret });
    for (const { event, recipient } of built.wraps) {
      expect(event.kind).toBe(GIFT_WRAP_KIND);
      expect(event.pubkey).not.toBe(A);
      expect(event.tags).toEqual([["p", recipient]]);
      expect(JSON.stringify(event)).not.toContain(secret);
    }
    // The wrap delivered to Bob must not reveal Alice. (Alice's own history copy is
    // necessarily p-tagged to Alice — a documented timing-correlation limitation.)
    const toBob = built.wraps.find((w) => w.recipient === B)!.event;
    expect(JSON.stringify(toBob)).not.toContain(A);
    // Each wrap uses a fresh one-time key.
    const signers = new Set(built.wraps.map((w) => w.event.pubkey));
    expect(signers.size).toBe(built.wraps.length);
  });

  it("carries typed payloads", () => {
    const built = buildPrivateMessage(alice, [B], { type: "payment-request", content: '{"x":1}', subject: "Invoice" });
    const msg = openGiftWrap(built.wraps.find((w) => w.recipient === B)!.event, bob);
    expect(msg.type).toBe("payment-request");
    expect(msg.subject).toBe("Invoice");
  });

  it("rejects a seal whose signer differs from the claimed author (impersonation)", () => {
    const mallory = generateSecretKey();
    const rumor = { kind: 14, content: "send funds to 0xbad", tags: [["p", B]], created_at: 1_700_000_000, pubkey: A } as ReturnType<typeof nip59.createRumor>;
    rumor.id = getEventHash(rumor);
    const forged = nip59.createWrap(nip59.createSeal(rumor, mallory, B), B);
    expect(() => openGiftWrap(forged, bob)).toThrow(/does not match seal pubkey|Cannot open/);
  });

  it("rejects a rumor whose content was altered after its id was computed", () => {
    const rumor = nip59.createRumor({ kind: 14, content: "pay 1 token", tags: [["p", B]] }, alice);
    const altered = { ...rumor, content: "pay 1000 tokens" };
    const wrap = nip59.createWrap(nip59.createSeal(altered, alice, B), B);
    expect(() => openGiftWrap(wrap, bob)).toThrow(/Rumor id/);
  });

  it("rejects non-gift-wrap events", () => {
    const built = buildPrivateMessage(alice, [B], { type: "text", content: "hi" });
    expect(() => openGiftWrap({ ...built.wraps[0]!.event, kind: SEAL_KIND }, bob)).toThrow(/Not a gift wrap/);
  });
});

describe("conversation store", () => {
  it("persists history encrypted to the owner's key", async () => {
    const kv = new MemoryStore();
    const store = new ConversationStore(kv, "h", () => alice);
    store.addContact({ pubkey: B, name: "Bob", addedAt: 1 });
    store.upsert({
      id: "m1",
      from: A,
      to: [B],
      createdAt: 1,
      type: "text",
      content: "very private plaintext",
      tags: [],
      direction: "out",
      status: "sent",
      relays: [],
      seenOn: [],
    });
    await store.flush();
    const raw = kv.data.get("h")!;
    expect(raw).not.toContain("very private plaintext");
    expect(raw).not.toContain("Bob");

    const reopened = new ConversationStore(kv, "h", () => alice);
    await reopened.load();
    expect(reopened.all()[0]!.content).toBe("very private plaintext");
    expect(reopened.conversation(conversationId([A, B]))).toHaveLength(1);

    const wrongKey = new ConversationStore(kv, "h", () => carol);
    await expect(wrongKey.load()).rejects.toThrow();
  });
});
