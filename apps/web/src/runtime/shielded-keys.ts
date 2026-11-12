/**
 * The Kohaku recovery phrase for shielded (Tornado Cash) notes.
 *
 * A separate 24-word BIP-39 phrase, independent of the Nostr identity key: someone who obtains
 * the chat key does not thereby obtain the private notes. At rest, only its 32 bytes of entropy
 * are stored, encrypted with NIP-49 (scrypt + XChaCha20-Poly1305, the same scheme as the identity
 * vault) under the device password. It is decrypted into memory at unlock and dropped at lock.
 *
 * This is the one place Aava holds spending keys. Everything else (deposits, wallet payments)
 * still goes through the user's own wallet.
 */
import * as nip49 from "nostr-tools/nip49";
import { entropyToMnemonic, generateMnemonic, mnemonicToEntropy, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import type { KeyValueStore } from "@relaymesh/identity";

export const SHIELDED_PHRASE_KEY = "relaymesh.shielded-phrase.v1";
const LOG_N = 16;

export interface StoredShieldedPhrase {
  v: 1;
  /** NIP-49 ciphertext of the phrase's 32-byte entropy. */
  ncryptsec: string;
  createdAt: number;
}

export function newShieldedPhrase(): string {
  return generateMnemonic(wordlist, 256);
}

export function encryptPhrase(phrase: string, password: string, logN = LOG_N): string {
  if (!validateMnemonic(phrase, wordlist)) throw new Error("Invalid recovery phrase");
  const entropy = mnemonicToEntropy(phrase, wordlist);
  if (entropy.length !== 32) throw new Error("Expected a 24-word phrase");
  return nip49.encrypt(entropy, password.normalize("NFKC"), logN, 0x02);
}

export function decryptPhrase(ncryptsec: string, password: string): string {
  let entropy: Uint8Array;
  try {
    entropy = nip49.decrypt(ncryptsec, password.normalize("NFKC"));
  } catch {
    throw new Error("Wrong password for the private-payments recovery phrase");
  }
  return entropyToMnemonic(entropy, wordlist);
}

export async function loadStoredPhrase(store: KeyValueStore): Promise<StoredShieldedPhrase | null> {
  const raw = await store.get(SHIELDED_PHRASE_KEY);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as StoredShieldedPhrase;
  if (parsed.v !== 1 || !parsed.ncryptsec?.startsWith("ncryptsec1")) throw new Error("Unrecognised private-payments key record");
  return parsed;
}

/** Encrypts and stores the phrase, then proves it decrypts before returning. */
export async function storePhrase(store: KeyValueStore, phrase: string, password: string, logN = LOG_N): Promise<StoredShieldedPhrase> {
  const record: StoredShieldedPhrase = { v: 1, ncryptsec: encryptPhrase(phrase, password, logN), createdAt: Date.now() };
  if (decryptPhrase(record.ncryptsec, password) !== phrase) throw new Error("Recovery phrase did not survive encryption; nothing was stored");
  await store.set(SHIELDED_PHRASE_KEY, JSON.stringify(record));
  return record;
}
