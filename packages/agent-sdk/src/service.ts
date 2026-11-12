import { z } from "zod";
import { finalizeEvent, type NostrEvent } from "nostr-tools/pure";
import { verifyEventStrict } from "@relaymesh/relay-mesh";

/**
 * Signed service manifests let providers announce paid services on any relay.
 * Discovery is decentralised: agents query whichever relays they use. A valid
 * signature proves who published the offer, not that the service is honest.
 */
export const SERVICE_KIND = 30078;
export const SERVICE_TAG = "relaymesh-service";

export const serviceManifestSchema = z
  .object({
    v: z.literal(1),
    id: z.string().regex(/^[a-z0-9-]{1,48}$/),
    name: z.string().min(1).max(80),
    description: z.string().max(500),
    endpoint: z.string().url(),
    protocol: z.literal("x402"),
    network: z.string().max(64),
    asset: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    price: z.string().regex(/^\d{1,78}$/),
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type ServiceManifest = z.infer<typeof serviceManifestSchema>;

export function signServiceManifest(m: ServiceManifest, secret: Uint8Array): NostrEvent {
  serviceManifestSchema.parse(m);
  return finalizeEvent(
    {
      kind: SERVICE_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["d", `relaymesh/service/${m.id}`],
        ["t", SERVICE_TAG],
        ["expiration", String(m.expiresAt)],
      ],
      content: JSON.stringify(m),
    },
    secret,
  );
}

export interface DiscoveredService {
  manifest: ServiceManifest;
  provider: string;
  event: NostrEvent;
}

export function verifyServiceManifest(e: NostrEvent, now = Math.floor(Date.now() / 1000)): DiscoveredService {
  if (e.kind !== SERVICE_KIND || !e.tags.some((t) => t[0] === "t" && t[1] === SERVICE_TAG)) throw new Error("Not a service manifest");
  if (!verifyEventStrict(e)) throw new Error("Invalid service manifest signature");
  const manifest = serviceManifestSchema.parse(JSON.parse(e.content));
  if (manifest.expiresAt <= now) throw new Error("Service manifest expired");
  return { manifest, provider: e.pubkey, event: e };
}

export const serviceFilter = () => ({ kinds: [SERVICE_KIND], "#t": [SERVICE_TAG], limit: 100 });
