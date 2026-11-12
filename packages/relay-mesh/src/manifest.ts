import { z } from "zod";
import { finalizeEvent, getPublicKey, verifyEvent, type NostrEvent } from "nostr-tools/pure";

/**
 * Relay operator manifest.
 *
 * Signed metadata in which an operator declares a relay URL, its software,
 * capabilities, verification key, and expiry. Transported as a NIP-01 signed
 * event (kind 30078, NIP-78 app data, d-tag below), so the signature is a
 * standard BIP-340 Schnorr signature verified by nostr-tools — no new crypto.
 *
 * A valid signature proves who published the manifest, NOT that the operator
 * is honest. Trust decisions remain with the user.
 */
export const MANIFEST_KIND = 30078;
export const MANIFEST_D_TAG = "relaymesh/operator-manifest/v1";
export const MAX_MANIFEST_VALIDITY_SEC = 366 * 24 * 3600;
export const CLOCK_SKEW_SEC = 300;

export const KNOWN_CAPABILITIES = [
  "nip-01",
  "nip-11",
  "nip-17",
  "nip-42",
  "nip-59",
  "store-gift-wraps",
  "tor-onion",
  "rate-limited",
  "paid-access",
] as const;

const hex64 = z.string().regex(/^[0-9a-f]{64}$/, "must be 64 lowercase hex chars");

function isLocalHost(host: string) {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
}

export const relayUrlSchema = z
  .string()
  .max(512)
  .refine((u) => {
    try {
      const url = new URL(u);
      if (url.username || url.password) return false;
      if (url.protocol === "wss:") return true;
      // Plain ws:// is only acceptable for loopback, docker-internal demo hosts, or Tor onion services.
      return url.protocol === "ws:" && (isLocalHost(url.hostname) || url.hostname.endsWith(".onion") || !url.hostname.includes("."));
    } catch {
      return false;
    }
  }, "relay URL must be wss:// (ws:// only for localhost, internal demo hosts, or .onion)");

export const operatorManifestSchema = z
  .object({
    v: z.literal(1),
    operator: z.object({
      id: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/, "operator id must be a lowercase slug"),
      name: z.string().min(1).max(100),
      contact: z.string().max(200).optional(),
    }),
    relayUrl: relayUrlSchema,
    protocols: z.array(z.string().max(32)).min(1).max(32),
    capabilities: z.array(z.enum(KNOWN_CAPABILITIES)).max(32),
    software: z.object({ name: z.string().min(1).max(64), version: z.string().min(1).max(32) }),
    publicKey: hex64,
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
  })
  .strict();

export type OperatorManifest = z.infer<typeof operatorManifestSchema>;

export interface VerifiedManifest {
  manifest: OperatorManifest;
  event: NostrEvent;
}

export type ManifestInput = Omit<OperatorManifest, "v" | "publicKey" | "issuedAt" | "expiresAt"> & {
  validForSec?: number;
};

export function signOperatorManifest(input: ManifestInput, operatorSecret: Uint8Array, now = Math.floor(Date.now() / 1000)): NostrEvent {
  const { validForSec = 90 * 24 * 3600, ...rest } = input;
  const manifest: OperatorManifest = operatorManifestSchema.parse({
    v: 1,
    ...rest,
    publicKey: getPublicKey(operatorSecret),
    issuedAt: now,
    expiresAt: now + validForSec,
  });
  return finalizeEvent(
    {
      kind: MANIFEST_KIND,
      created_at: now,
      tags: [
        ["d", MANIFEST_D_TAG],
        ["r", manifest.relayUrl],
        ["expiration", String(manifest.expiresAt)],
      ],
      content: JSON.stringify(manifest),
    },
    operatorSecret,
  );
}

export interface ManifestVerifyOptions {
  now?: number;
  /** Operator id -> pinned public key (trust on first use). */
  pinnedKeys?: Record<string, string>;
}

export class ManifestError extends Error {
  constructor(
    readonly code:
      | "malformed"
      | "bad-signature"
      | "wrong-kind"
      | "schema"
      | "key-mismatch"
      | "expired"
      | "not-yet-valid"
      | "validity-too-long"
      | "pinned-key-mismatch"
      | "url-tag-mismatch",
    message: string,
  ) {
    super(message);
  }
}

/** Validates a signed manifest. Throws ManifestError with a specific code on any failure. */
export function verifyOperatorManifest(raw: unknown, opts: ManifestVerifyOptions = {}): VerifiedManifest {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const event = (typeof raw === "string" ? safeJson(raw) : raw) as NostrEvent;
  if (!event || typeof event !== "object" || typeof event.content !== "string" || !Array.isArray(event.tags)) {
    throw new ManifestError("malformed", "Manifest is not a Nostr event");
  }
  if (event.kind !== MANIFEST_KIND || !event.tags.some((t) => t[0] === "d" && t[1] === MANIFEST_D_TAG)) {
    throw new ManifestError("wrong-kind", "Event is not a RelayMesh operator manifest");
  }
  if (!verifyEventStrict(event)) throw new ManifestError("bad-signature", "Manifest signature is invalid");
  const parsed = operatorManifestSchema.safeParse(safeJson(event.content));
  if (!parsed.success) throw new ManifestError("schema", `Manifest schema invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const m = parsed.data;
  if (m.publicKey !== event.pubkey) throw new ManifestError("key-mismatch", "Manifest publicKey does not match the signing key");
  const rTag = event.tags.find((t) => t[0] === "r")?.[1];
  if (rTag !== undefined && rTag !== m.relayUrl) throw new ManifestError("url-tag-mismatch", "Relay URL tag does not match manifest body");
  if (m.expiresAt <= now) throw new ManifestError("expired", "Manifest has expired");
  if (m.issuedAt > now + CLOCK_SKEW_SEC) throw new ManifestError("not-yet-valid", "Manifest is issued in the future");
  if (m.expiresAt - m.issuedAt > MAX_MANIFEST_VALIDITY_SEC) throw new ManifestError("validity-too-long", "Manifest validity exceeds one year");
  const pinned = opts.pinnedKeys?.[m.operator.id];
  if (pinned && pinned !== m.publicKey) {
    throw new ManifestError("pinned-key-mismatch", `Operator "${m.operator.id}" is pinned to a different key`);
  }
  return { manifest: m, event };
}

/**
 * nostr-tools' verifyEvent caches a positive result in a symbol property on the
 * event object; object spread copies that symbol, so a tampered copy of a
 * verified event would pass. Always verify a freshly constructed canonical copy.
 */
export function verifyEventStrict(e: NostrEvent): boolean {
  try {
    return verifyEvent({ id: e.id, pubkey: e.pubkey, created_at: e.created_at, kind: e.kind, tags: e.tags, content: e.content, sig: e.sig });
  } catch {
    return false;
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** Portable relay configuration bundle users can share or import manually. */
export const relayConfigBundleSchema = z.object({
  format: z.literal("relaymesh.relay-config"),
  v: z.literal(1),
  relays: z
    .array(z.object({ url: relayUrlSchema, read: z.boolean().default(true), write: z.boolean().default(true) }))
    .min(1)
    .max(64),
  manifests: z.array(z.unknown()).max(64).default([]),
});
export type RelayConfigBundle = z.infer<typeof relayConfigBundleSchema>;

export interface ImportedRelayConfig {
  relays: { url: string; read: boolean; write: boolean; manifest?: VerifiedManifest }[];
  rejectedManifests: { index: number; error: string }[];
}

/** Imports a bundle. Relays are accepted without a manifest; invalid manifests are reported, never trusted. */
export function importRelayConfig(raw: unknown, opts: ManifestVerifyOptions = {}): ImportedRelayConfig {
  const bundle = relayConfigBundleSchema.parse(typeof raw === "string" ? safeJson(raw) : raw);
  const verified = new Map<string, VerifiedManifest>();
  const rejectedManifests: ImportedRelayConfig["rejectedManifests"] = [];
  bundle.manifests.forEach((m, index) => {
    try {
      const v = verifyOperatorManifest(m, opts);
      verified.set(v.manifest.relayUrl, v);
    } catch (e) {
      rejectedManifests.push({ index, error: (e as Error).message });
    }
  });
  return {
    relays: bundle.relays.map((r) => {
      const manifest = verified.get(r.url);
      return manifest ? { ...r, manifest } : { ...r };
    }),
    rejectedManifests,
  };
}
