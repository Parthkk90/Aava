import { finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from "nostr-tools/pure";
import { startRelay, type RunningRelay } from "@relaymesh/relay";
import { RelayMesh } from "@relaymesh/relay-mesh";
import { ConversationStore, Messenger, type StoredMessage } from "@relaymesh/messaging";
import { MemoryStore } from "@relaymesh/identity";

export async function waitFor(cond: () => boolean | Promise<boolean>, ms = 10_000, label = "condition") {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

export interface Peer {
  sk: Uint8Array;
  pubkey: string;
  kv: MemoryStore;
  mesh: RelayMesh;
  store: ConversationStore;
  messenger: Messenger;
  inbox: StoredMessage[];
  stop(): Promise<void>;
}

/** A headless RelayMesh client: the same packages the web app uses. */
export async function makePeer(relayUrls: string[], sk = generateSecretKey(), kv = new MemoryStore(), opts: { auth?: boolean } = {}): Promise<Peer> {
  const pubkey = getPublicKey(sk);
  const mesh = new RelayMesh({
    relays: relayUrls.map((url) => ({ url })),
    backoffMs: [100, 200, 400],
    // NIP-42, as the app does; relays that do not ask are unaffected.
    ...(opts.auth === false ? {} : { auth: async (t) => finalizeEvent(t, sk) }),
  });
  const store = new ConversationStore(kv, ConversationStore.keyFor(pubkey), () => sk);
  await store.load();
  const inbox: StoredMessage[] = [];
  const messenger = new Messenger(mesh, store, () => sk, { onMessage: (m) => inbox.push(m) });
  mesh.start();
  messenger.start();
  await waitFor(() => mesh.openRelays().length === relayUrls.length, 10_000, "relays to connect");
  return {
    sk,
    pubkey,
    kv,
    mesh,
    store,
    messenger,
    inbox,
    stop: async () => {
      messenger.stop();
      await mesh.stop();
    },
  };
}

export async function twoRelays(): Promise<[RunningRelay, RunningRelay]> {
  return [await startRelay({ port: 0, name: "Relay A" }), await startRelay({ port: 0, name: "Relay B" })];
}

export function allStored(relays: RunningRelay[]): NostrEvent[] {
  return relays.flatMap((r) => r.storedEvents());
}

/** Well-known anvil development private keys (public test keys, never real funds). */
export const ANVIL_PRIVATE_KEYS = [
  "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
];
