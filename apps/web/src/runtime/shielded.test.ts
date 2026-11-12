import { describe, expect, it } from "vitest";
import { MemoryStore } from "@relaymesh/identity";
import { decryptPhrase, encryptPhrase, loadStoredPhrase, newShieldedPhrase, storePhrase, SHIELDED_PHRASE_KEY } from "./shielded-keys.ts";
import { DENOMINATION_STEP, encryptedStorage, isValidShieldAmount } from "./shielded.ts";

const PW = "correct horse battery staple";
const FAST = 8; // low scrypt cost for tests only

describe("private-payments recovery phrase", () => {
  it("is a fresh 24-word phrase, independent of anything else", () => {
    const a = newShieldedPhrase();
    expect(a.split(" ")).toHaveLength(24);
    expect(newShieldedPhrase()).not.toBe(a);
  });

  it("is stored only as NIP-49 ciphertext and needs the password to decrypt", async () => {
    const store = new MemoryStore();
    const phrase = newShieldedPhrase();
    await storePhrase(store, phrase, PW, FAST);
    const raw = (await store.get(SHIELDED_PHRASE_KEY))!;
    for (const word of phrase.split(" ")) expect(raw).not.toContain(` ${word} `);
    expect(raw).not.toContain(phrase);
    const rec = (await loadStoredPhrase(store))!;
    expect(rec.ncryptsec.startsWith("ncryptsec1")).toBe(true);
    expect(decryptPhrase(rec.ncryptsec, PW)).toBe(phrase);
    expect(() => decryptPhrase(rec.ncryptsec, "wrong password!!")).toThrow(/Wrong password/);
  });

  it("refuses invalid phrases instead of storing them", () => {
    expect(() => encryptPhrase("not a real phrase", PW, FAST)).toThrow(/Invalid/);
  });
});

describe("encrypted Kohaku storage", () => {
  it("round-trips values and keeps them unreadable at rest", async () => {
    const store = new MemoryStore();
    const phrase = newShieldedPhrase();
    const s = await encryptedStorage(store, phrase);
    await s.set("tornado-cash-state-x", JSON.stringify({ commitment: "0xdeadbeef", leafIndex: 7 }));
    expect(await s.get("tornado-cash-state-x")).toBe(JSON.stringify({ commitment: "0xdeadbeef", leafIndex: 7 }));
    expect(await s.get("missing")).toBeNull();
    const dump = JSON.stringify(await Promise.all((await store.keys()).map((k) => store.get(k))));
    expect(dump).not.toContain("deadbeef");
    // A different phrase cannot read it.
    const other = await encryptedStorage(store, newShieldedPhrase());
    await expect(other.get("tornado-cash-state-x")).rejects.toThrow();
  });
});

describe("amounts", () => {
  it("only accepts sums of the Sepolia pool sizes (smallest 0.01 ETH)", () => {
    expect(isValidShieldAmount(DENOMINATION_STEP)).toBe(true);
    expect(isValidShieldAmount(13n * DENOMINATION_STEP)).toBe(true);
    expect(isValidShieldAmount(DENOMINATION_STEP + 1n)).toBe(false);
    expect(isValidShieldAmount(0n)).toBe(false);
  });
});
