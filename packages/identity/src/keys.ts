import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import * as nip19 from "nostr-tools/nip19";

export interface PublicIdentity {
  /** 32-byte x-only secp256k1 public key, lowercase hex. */
  pubkey: string;
  /** NIP-19 bech32 encoding of the public key. */
  npub: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Generates a new Nostr secret key.
 *
 * Randomness comes from `@noble/curves` which uses `crypto.getRandomValues`
 * (WebCrypto CSPRNG). RelayMesh never implements its own RNG or curve math.
 */
export function generateIdentitySecret(): Uint8Array {
  if (typeof globalThis.crypto?.getRandomValues !== "function") {
    throw new Error("No secure random source (crypto.getRandomValues) is available; refusing to generate keys.");
  }
  return generateSecretKey();
}

export function publicIdentity(secretKey: Uint8Array): PublicIdentity {
  const pubkey = getPublicKey(secretKey);
  return { pubkey, npub: nip19.npubEncode(pubkey) };
}

export function isHexPubkey(value: string): boolean {
  return HEX64.test(value);
}

/** Accepts npub or 64-char hex; returns lowercase hex or throws. */
export function parsePubkey(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith("npub1")) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== "npub") throw new Error("Not an npub");
    return decoded.data;
  }
  const lower = trimmed.toLowerCase();
  if (!isHexPubkey(lower)) throw new Error("Public key must be an npub or 64 hex characters");
  return lower;
}

export function npubOf(pubkey: string): string {
  return nip19.npubEncode(pubkey);
}

/** Decodes an `nsec` for import. Caller must zeroize the result when done. */
export function decodeNsec(nsec: string): Uint8Array {
  const decoded = nip19.decode(nsec.trim());
  if (decoded.type !== "nsec") throw new Error("Not an nsec");
  return decoded.data;
}

/**
 * Best-effort overwrite of key material. JavaScript engines may keep copies
 * (GC, JIT), so this reduces but does not eliminate exposure on a compromised device.
 */
export function zeroize(buf: Uint8Array): void {
  buf.fill(0);
}
