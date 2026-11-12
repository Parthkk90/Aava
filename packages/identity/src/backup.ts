import * as nip49 from "nostr-tools/nip49";
import { publicIdentity, zeroize } from "./keys.ts";

/**
 * Encrypted identity backup.
 *
 * The cryptographic payload is a standard NIP-49 `ncryptsec`
 * (scrypt KDF + XChaCha20-Poly1305, implemented by nostr-tools / noble).
 * The JSON envelope adds only versioning and metadata; it does not add crypto.
 * Any NIP-49 capable Nostr client can import the `ncryptsec` field directly.
 */
export interface IdentityBackupV1 {
  format: "relaymesh.identity-backup";
  version: 1;
  kdf: "nip49-scrypt";
  logN: number;
  createdAt: number;
  npub: string;
  pubkey: string;
  label?: string;
  ncryptsec: string;
}

export const MIN_PASSWORD_LENGTH = 12;
/** NIP-49 recommends log_n >= 16 (64 MiB, ~0.1 s on desktop). */
export const DEFAULT_LOG_N = 16;
export const MIN_PRODUCTION_LOG_N = 16;

export interface BackupOptions {
  label?: string;
  logN?: number;
  /** Only tests may lower the KDF cost below the production minimum. */
  allowWeakKdfForTests?: boolean;
  now?: () => number;
}

export function validatePasswordStrength(password: string): string[] {
  const problems: string[] = [];
  if (password.length < MIN_PASSWORD_LENGTH) problems.push(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
  if (/^(.)\1+$/.test(password)) problems.push("Password must not be a single repeated character.");
  return problems;
}

export function createIdentityBackup(secretKey: Uint8Array, password: string, opts: BackupOptions = {}): IdentityBackupV1 {
  const problems = validatePasswordStrength(password);
  if (problems.length) throw new Error(problems.join(" "));
  const logN = opts.logN ?? DEFAULT_LOG_N;
  if (logN < MIN_PRODUCTION_LOG_N && !opts.allowWeakKdfForTests) {
    throw new Error(`KDF cost log_n=${logN} is below the minimum of ${MIN_PRODUCTION_LOG_N}`);
  }
  const pub = publicIdentity(secretKey);
  // ksb 0x02: "client does not track whether this key has been handled insecurely".
  const ncryptsec = nip49.encrypt(secretKey, password.normalize("NFKC"), logN, 0x02);
  const backup: IdentityBackupV1 = {
    format: "relaymesh.identity-backup",
    version: 1,
    kdf: "nip49-scrypt",
    logN,
    createdAt: Math.floor((opts.now ?? Date.now)() / 1000),
    npub: pub.npub,
    pubkey: pub.pubkey,
    ncryptsec,
  };
  if (opts.label) backup.label = opts.label;
  return backup;
}

export function parseIdentityBackup(raw: string | unknown): IdentityBackupV1 {
  const obj = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  if (!obj || typeof obj !== "object") throw new Error("Backup is not a JSON object");
  const b = obj as Record<string, unknown>;
  if (b.format !== "relaymesh.identity-backup") throw new Error("Unknown backup format");
  if (b.version !== 1) throw new Error(`Unsupported backup version ${String(b.version)}`);
  if (b.kdf !== "nip49-scrypt") throw new Error("Unsupported KDF");
  if (typeof b.ncryptsec !== "string" || !b.ncryptsec.startsWith("ncryptsec1")) throw new Error("Missing ncryptsec");
  if (typeof b.pubkey !== "string" || !/^[0-9a-f]{64}$/.test(b.pubkey)) throw new Error("Invalid pubkey");
  if (typeof b.npub !== "string") throw new Error("Invalid npub");
  if (typeof b.logN !== "number" || typeof b.createdAt !== "number") throw new Error("Invalid metadata");
  return b as unknown as IdentityBackupV1;
}

/**
 * Decrypts a backup and checks that the recovered key matches the public key
 * recorded in the envelope. Throws on a wrong password or tampered envelope.
 */
export function restoreIdentityBackup(raw: string | IdentityBackupV1, password: string): Uint8Array {
  const backup = parseIdentityBackup(raw);
  let secret: Uint8Array;
  try {
    secret = nip49.decrypt(backup.ncryptsec, password.normalize("NFKC"));
  } catch {
    throw new Error("Wrong password or corrupted backup");
  }
  if (publicIdentity(secret).pubkey !== backup.pubkey) {
    zeroize(secret);
    throw new Error("Backup envelope public key does not match the encrypted key");
  }
  return secret;
}

/**
 * Recovery verification: proves a freshly created backup can be restored with
 * the given password before the user relies on it.
 */
export function verifyIdentityBackup(raw: string | IdentityBackupV1, password: string, expectedPubkey: string): boolean {
  try {
    const secret = restoreIdentityBackup(raw, password);
    const ok = publicIdentity(secret).pubkey === expectedPubkey;
    zeroize(secret);
    return ok;
  } catch {
    return false;
  }
}
