import { describe, expect, it } from "vitest";
import { getPublicKey } from "nostr-tools/pure";
import {
  IdentityVault,
  MemoryStore,
  VAULT_STORAGE_KEY,
  createIdentityBackup,
  createRotationNotice,
  generateIdentitySecret,
  parsePubkey,
  publicIdentity,
  restoreIdentityBackup,
  verifyIdentityBackup,
  verifyRotationNotice,
} from "./index.ts";

const PW = "correct horse battery staple";
const weak = { logN: 8, allowWeakKdfForTests: true } as const;

describe("key generation", () => {
  it("produces distinct 32-byte keys from the platform CSPRNG", () => {
    const keys = Array.from({ length: 32 }, () => generateIdentitySecret());
    const hex = new Set(keys.map((k) => Buffer.from(k).toString("hex")));
    expect(hex.size).toBe(32);
    for (const k of keys) expect(k.length).toBe(32);
  });

  it("parses npub and hex public keys", () => {
    const sk = generateIdentitySecret();
    const { pubkey, npub } = publicIdentity(sk);
    expect(parsePubkey(npub)).toBe(pubkey);
    expect(parsePubkey(pubkey.toUpperCase())).toBe(pubkey);
    expect(() => parsePubkey("not-a-key")).toThrow();
  });
});

describe("encrypted backup (NIP-49)", () => {
  it("round-trips and verifies", () => {
    const sk = generateIdentitySecret();
    const backup = createIdentityBackup(sk, PW, weak);
    expect(backup.ncryptsec.startsWith("ncryptsec1")).toBe(true);
    expect(JSON.stringify(backup)).not.toContain(Buffer.from(sk).toString("hex"));
    const restored = restoreIdentityBackup(JSON.stringify(backup), PW);
    expect(Buffer.from(restored).equals(Buffer.from(sk))).toBe(true);
    expect(verifyIdentityBackup(backup, PW, getPublicKey(sk))).toBe(true);
  });

  it("rejects a wrong password", () => {
    const backup = createIdentityBackup(generateIdentitySecret(), PW, weak);
    expect(() => restoreIdentityBackup(backup, "wrong password entirely")).toThrow(/Wrong password/);
  });

  it("rejects an envelope whose public key was swapped", () => {
    const backup = createIdentityBackup(generateIdentitySecret(), PW, weak);
    const other = publicIdentity(generateIdentitySecret());
    expect(() => restoreIdentityBackup({ ...backup, pubkey: other.pubkey }, PW)).toThrow(/does not match/);
  });

  it("refuses weak passwords and weak KDF parameters by default", () => {
    expect(() => createIdentityBackup(generateIdentitySecret(), "short", weak)).toThrow();
    expect(() => createIdentityBackup(generateIdentitySecret(), PW, { logN: 8 })).toThrow(/below the minimum/);
  });
});

describe("identity vault", () => {
  it("stores only ciphertext at rest", async () => {
    const store = new MemoryStore();
    const vault = new IdentityVault(store, weak);
    await vault.create(PW);
    const secretHex = Buffer.from(vault.secretKey()).toString("hex");
    const raw = store.data.get(VAULT_STORAGE_KEY)!;
    expect(raw).toContain("ncryptsec1");
    expect(raw).not.toContain(secretHex);
  });

  it("locks, zeroizes, and unlocks", async () => {
    const vault = new IdentityVault(new MemoryStore(), weak);
    const id = await vault.create(PW);
    const keyRef = vault.secretKey();
    vault.lock();
    expect(vault.isUnlocked).toBe(false);
    expect(keyRef.every((b) => b === 0)).toBe(true);
    expect(() => vault.secretKey()).toThrow(/locked/);
    await expect(vault.unlock("wrong password entirely")).rejects.toThrow();
    const again = await vault.unlock(PW);
    expect(again.pubkey).toBe(id.pubkey);
  });

  it("auto-locks after inactivity", async () => {
    const vault = new IdentityVault(new MemoryStore(), { ...weak, autoLockMs: 20 });
    await vault.create(PW);
    await new Promise((r) => setTimeout(r, 60));
    expect(vault.isUnlocked).toBe(false);
  });

  it("recovers an identity on a fresh installation from a backup", async () => {
    const vaultA = new IdentityVault(new MemoryStore(), weak);
    const id = await vaultA.create(PW);
    const backup = JSON.stringify(createIdentityBackup(vaultA.secretKey(), PW, weak));
    await vaultA.wipe();
    expect(await vaultA.exists()).toBe(false);

    const fresh = new IdentityVault(new MemoryStore(), weak);
    const restored = await fresh.importSecret(restoreIdentityBackup(backup, PW), "new local password", "Restored");
    expect(restored.pubkey).toBe(id.pubkey);
  });

  it("rotates keys with a dual-signed notice", async () => {
    const vault = new IdentityVault(new MemoryStore(), weak);
    const before = await vault.create(PW);
    const { oldSecret, newSecret, newIdentity } = await vault.rotate(PW);
    expect(newIdentity.pubkey).not.toBe(before.pubkey);
    expect(vault.publicKey()).toBe(newIdentity.pubkey);
    const notice = createRotationNotice(oldSecret, newSecret);
    expect(verifyRotationNotice(notice)).toEqual({ oldPubkey: before.pubkey, newPubkey: newIdentity.pubkey });
    const list = await vault.listIdentities();
    expect(list.map((i) => i.status)).toEqual(["retired", "active"]);
  });

  it("rejects a tampered clone of an already-verified notice (signature cache bypass)", () => {
    const a = generateIdentitySecret();
    const b = generateIdentitySecret();
    const c = generateIdentitySecret();
    const notice = createRotationNotice(a, b);
    verifyRotationNotice(notice); // primes nostr-tools' verification cache on these objects
    const evil = publicIdentity(c).pubkey;
    const content = notice.byOld.content.replace(publicIdentity(b).pubkey, evil);
    const tampered = { byOld: { ...notice.byOld, content }, byNew: { ...notice.byNew, content, pubkey: evil } };
    expect(() => verifyRotationNotice(tampered)).toThrow(/Invalid rotation signature/);
  });

  it("rejects a rotation notice where one signature is from an unrelated key", () => {
    const a = generateIdentitySecret();
    const b = generateIdentitySecret();
    const c = generateIdentitySecret();
    const good = createRotationNotice(a, b);
    const forged = createRotationNotice(c, b);
    expect(() => verifyRotationNotice({ byOld: forged.byOld, byNew: good.byNew })).toThrow();
  });
});
