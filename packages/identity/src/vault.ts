import * as nip49 from "nostr-tools/nip49";
import { generateIdentitySecret, publicIdentity, zeroize, type PublicIdentity } from "./keys.ts";
import { DEFAULT_LOG_N, MIN_PRODUCTION_LOG_N, validatePasswordStrength } from "./backup.ts";
import type { KeyValueStore } from "./storage.ts";

export const VAULT_STORAGE_KEY = "relaymesh.vault.v1";

export interface VaultIdentityRecord {
  id: string;
  pubkey: string;
  npub: string;
  label: string;
  createdAt: number;
  status: "active" | "retired";
  /** Present when this identity replaced an older one via rotation. */
  rotatedFrom?: string;
  /** NIP-49 ciphertext of the secret key under the local vault password. */
  ncryptsec: string;
}

export interface VaultRecordV1 {
  version: 1;
  logN: number;
  activeId: string;
  identities: VaultIdentityRecord[];
}

export interface VaultOptions {
  logN?: number;
  allowWeakKdfForTests?: boolean;
  /** Auto-lock after this many ms of inactivity (0 disables). */
  autoLockMs?: number;
  now?: () => number;
}

export class VaultLockedError extends Error {
  constructor() {
    super("Identity vault is locked");
  }
}

/**
 * Local identity vault.
 *
 * At rest: only NIP-49 ciphertext + public metadata is written to the store.
 * Unlocked: the active secret key is held in memory and zeroized on lock().
 * A compromised, unlocked device can read the key — this is a documented limitation.
 */
export class IdentityVault {
  private secret: Uint8Array | null = null;
  private record: VaultRecordV1 | null = null;
  private lockTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly logN: number;

  constructor(
    private readonly store: KeyValueStore,
    private readonly opts: VaultOptions = {},
  ) {
    this.logN = opts.logN ?? DEFAULT_LOG_N;
    if (this.logN < MIN_PRODUCTION_LOG_N && !opts.allowWeakKdfForTests) {
      throw new Error(`Vault KDF cost log_n=${this.logN} is below the minimum of ${MIN_PRODUCTION_LOG_N}`);
    }
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    for (const l of this.listeners) l();
  }

  private nowSec() {
    return Math.floor((this.opts.now ?? Date.now)() / 1000);
  }

  async exists(): Promise<boolean> {
    return (await this.store.get(VAULT_STORAGE_KEY)) !== undefined;
  }

  private async load(): Promise<VaultRecordV1> {
    const raw = await this.store.get(VAULT_STORAGE_KEY);
    if (!raw) throw new Error("No identity vault exists on this device");
    const parsed = JSON.parse(raw) as VaultRecordV1;
    if (parsed.version !== 1) throw new Error(`Unsupported vault version ${String(parsed.version)}`);
    return parsed;
  }

  private async save(record: VaultRecordV1) {
    await this.store.set(VAULT_STORAGE_KEY, JSON.stringify(record));
    this.record = record;
  }

  private encryptLocal(secret: Uint8Array, password: string): string {
    return nip49.encrypt(secret, password.normalize("NFKC"), this.logN, 0x02);
  }

  private makeRecord(secret: Uint8Array, password: string, label: string, rotatedFrom?: string): VaultIdentityRecord {
    const pub = publicIdentity(secret);
    const rec: VaultIdentityRecord = {
      id: pub.pubkey.slice(0, 16),
      pubkey: pub.pubkey,
      npub: pub.npub,
      label,
      createdAt: this.nowSec(),
      status: "active",
      ncryptsec: this.encryptLocal(secret, password),
    };
    if (rotatedFrom) rec.rotatedFrom = rotatedFrom;
    return rec;
  }

  /** Creates a vault with a freshly generated identity. */
  async create(password: string, label = "Primary"): Promise<PublicIdentity> {
    return this.initialise(generateIdentitySecret(), password, label);
  }

  /** Creates a vault from an imported key (nsec import or backup restore). Takes ownership of `secret`. */
  async importSecret(secret: Uint8Array, password: string, label = "Imported"): Promise<PublicIdentity> {
    return this.initialise(secret, password, label);
  }

  private async initialise(secret: Uint8Array, password: string, label: string): Promise<PublicIdentity> {
    if (await this.exists()) throw new Error("A vault already exists on this device. Wipe it first.");
    const problems = validatePasswordStrength(password);
    if (problems.length) throw new Error(problems.join(" "));
    const rec = this.makeRecord(secret, password, label);
    await this.save({ version: 1, logN: this.logN, activeId: rec.id, identities: [rec] });
    this.setUnlocked(secret);
    return { pubkey: rec.pubkey, npub: rec.npub };
  }

  async unlock(password: string): Promise<PublicIdentity> {
    const record = await this.load();
    const active = record.identities.find((i) => i.id === record.activeId);
    if (!active) throw new Error("Vault has no active identity");
    let secret: Uint8Array;
    try {
      secret = nip49.decrypt(active.ncryptsec, password.normalize("NFKC"));
    } catch {
      throw new Error("Wrong password");
    }
    if (publicIdentity(secret).pubkey !== active.pubkey) {
      zeroize(secret);
      throw new Error("Vault integrity check failed: key does not match recorded public key");
    }
    this.record = record;
    this.setUnlocked(secret);
    return { pubkey: active.pubkey, npub: active.npub };
  }

  private setUnlocked(secret: Uint8Array) {
    if (this.secret && this.secret !== secret) zeroize(this.secret);
    this.secret = secret;
    this.touch();
    this.emit();
  }

  /** Resets the auto-lock timer; call on user activity. */
  touch() {
    if (this.lockTimer) clearTimeout(this.lockTimer);
    const ms = this.opts.autoLockMs ?? 0;
    if (ms > 0 && this.secret) this.lockTimer = setTimeout(() => this.lock(), ms);
  }

  lock() {
    if (this.lockTimer) clearTimeout(this.lockTimer);
    this.lockTimer = null;
    if (this.secret) zeroize(this.secret);
    this.secret = null;
    this.emit();
  }

  get isUnlocked(): boolean {
    return this.secret !== null;
  }

  /** Public information about the active identity (available while locked). */
  async activeIdentity(): Promise<VaultIdentityRecord | undefined> {
    const record = this.record ?? (await this.exists() ? await this.load() : null);
    return record?.identities.find((i) => i.id === record.activeId);
  }

  async listIdentities(): Promise<Omit<VaultIdentityRecord, "ncryptsec">[]> {
    const record = this.record ?? (await this.load());
    return record.identities.map(({ ncryptsec: _omit, ...pub }) => pub);
  }

  /**
   * Returns the in-memory secret for signing/encryption. Callers must not
   * persist or log it. Throws if locked.
   */
  secretKey(): Uint8Array {
    if (!this.secret) throw new VaultLockedError();
    this.touch();
    return this.secret;
  }

  publicKey(): string {
    return publicIdentity(this.secretKey()).pubkey;
  }

  /**
   * Generates a new identity, marks the current one as retired, and returns
   * both secrets so the caller can produce a signed rotation notice. The old
   * secret is returned only for that purpose and should be zeroized after.
   */
  async rotate(password: string, label = "Rotated"): Promise<{ oldSecret: Uint8Array; newSecret: Uint8Array; newIdentity: PublicIdentity }> {
    const current = this.secretKey();
    const record = await this.load();
    const active = record.identities.find((i) => i.id === record.activeId);
    if (!active) throw new Error("Vault has no active identity");
    // Confirm the password is the vault password before re-encrypting.
    try {
      zeroize(nip49.decrypt(active.ncryptsec, password.normalize("NFKC")));
    } catch {
      throw new Error("Wrong password");
    }
    const oldSecret = current.slice();
    const newSecret = generateIdentitySecret();
    const rec = this.makeRecord(newSecret, password, label, active.pubkey);
    active.status = "retired";
    record.identities.push(rec);
    record.activeId = rec.id;
    await this.save(record);
    this.setUnlocked(newSecret.slice());
    return { oldSecret, newSecret, newIdentity: { pubkey: rec.pubkey, npub: rec.npub } };
  }

  /** Removes all local identity data. Irreversible without a backup. */
  async wipe(): Promise<void> {
    this.lock();
    await this.store.delete(VAULT_STORAGE_KEY);
    this.record = null;
    this.emit();
  }
}
