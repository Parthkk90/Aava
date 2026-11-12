/**
 * CROPS · Relays: NIP-42 gift-wrap protection and the public default relays.
 *
 * Deterministic part: a reference relay with `protectGiftWraps` serves kind-1059 events only to
 * the connection authenticated as their recipient; Aava clients authenticate automatically.
 * LIVE_RELAYS=1 (or LIVE_TESTNET=1): two users exchange a NIP-17 message over the public default
 * relays, including auth.nostr1.com, which requires NIP-42 to publish and read gift wraps.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from "nostr-tools/pure";
import { Relay } from "nostr-tools/relay";
import { startRelay, type RunningRelay } from "@relaymesh/relay";
import { makePeer, waitFor, type Peer } from "./harness.ts";
import { PUBLIC_DEFAULT_RELAYS } from "../../apps/web/src/runtime/settings.ts";

const LIVE = process.env.LIVE_RELAYS === "1" || process.env.LIVE_TESTNET === "1";

/** Reads gift wraps for `p` as a raw client, optionally authenticated with `sk`. */
async function readWraps(url: string, p: string, sk?: Uint8Array): Promise<{ events: NostrEvent[]; closed?: string }> {
  const relay = await Relay.connect(url);
  const events: NostrEvent[] = [];
  const once = () =>
    new Promise<string | undefined>((resolve) => {
      const sub = relay.subscribe([{ kinds: [1059], "#p": [p] }], {
        onevent: (e) => events.push(e),
        oneose: () => {
          resolve(undefined);
          sub.close();
        },
        onclose: (reason) => resolve(reason),
      });
    });
  let closed = await once();
  if (closed?.startsWith("auth-required") && sk) {
    // Like RelayMesh: some relays (strfry) send the challenge only with the refusal.
    for (let i = 0; ; i++) {
      try {
        await relay.auth(async (t) => finalizeEvent(t, sk));
        break;
      } catch (e) {
        if (!/no challenge/.test(String(e)) || i >= 20) throw e;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    closed = await once();
  }
  relay.close();
  return { events, closed };
}

describe("CROPS · Relays", () => {
  describe("P-12 a NIP-42 relay serves gift wraps only to their authenticated recipient", () => {
    let relay: RunningRelay;
    let alice: Peer;
    let bob: Peer;
    beforeAll(async () => {
      relay = await startRelay({ port: 0, name: "protected", protectGiftWraps: true });
      alice = await makePeer([relay.url]);
      bob = await makePeer([relay.url]);
    }, 30_000);
    afterAll(async () => {
      await alice?.stop();
      await bob?.stop();
      await relay?.close();
    });

    it("Aava clients authenticate automatically and still exchange messages both ways", async () => {
      await alice.messenger.send([bob.pubkey], { type: "text", content: "hello over an auth relay" });
      await waitFor(() => bob.inbox.some((m) => m.content === "hello over an auth relay"), 10_000, "bob receives");
      await bob.messenger.send([alice.pubkey], { type: "text", content: "and back" });
      await waitFor(() => alice.inbox.some((m) => m.content === "and back"), 10_000, "alice receives");
      expect(bob.mesh.states()[0]!.authenticated).toBe(true);
    });

    it("anyone else gets nothing: unauthenticated readers and other keys are refused", async () => {
      expect(relay.storedEvents().filter((e) => e.kind === 1059).length).toBeGreaterThan(0);
      const anon = await readWraps(relay.url, bob.pubkey);
      expect(anon.events).toEqual([]);
      expect(anon.closed).toMatch(/^auth-required/);
      const eve = await readWraps(relay.url, bob.pubkey, generateSecretKey());
      expect(eve.events).toEqual([]);
      expect(eve.closed).toMatch(/^auth-required/);
      // Sensitivity: the real recipient, authenticated, does get them.
      const own = await readWraps(relay.url, bob.pubkey, bob.sk);
      expect(own.closed).toBeUndefined();
      expect(own.events.length).toBeGreaterThan(0);
    });

    it("a client without a NIP-42 signer can publish but cannot read its messages", async () => {
      const mute = await makePeer([relay.url], undefined, undefined, { auth: false });
      await alice.messenger.send([mute.pubkey], { type: "text", content: "you cannot read this here" });
      await new Promise((r) => setTimeout(r, 1_000));
      expect(mute.inbox).toEqual([]);
      await mute.stop();
    });

    it("live delivery of a new gift wrap also goes only to its recipient", async () => {
      const watcher = await Relay.connect(relay.url);
      const seen: NostrEvent[] = [];
      watcher.subscribe([{ kinds: [4] }], { onevent: (e) => seen.push(e) }); // allowed: not gift wraps
      const sk = generateSecretKey();
      await new Promise((r) => setTimeout(r, 100));
      await watcher.auth(async (t) => finalizeEvent(t, sk));
      watcher.subscribe([{ kinds: [1059], "#p": [getPublicKey(sk)] }], { onevent: (e) => seen.push(e) });
      await alice.messenger.send([bob.pubkey], { type: "text", content: "not for the watcher" });
      await new Promise((r) => setTimeout(r, 800));
      expect(seen).toEqual([]);
      watcher.close();
    });
  });

  describe.skipIf(!LIVE)("C-07 (live) two users talk over the public default relays", () => {
    it("NIP-17 messages flow over independent public relays, including one that requires NIP-42", async () => {
      expect(PUBLIC_DEFAULT_RELAYS.length).toBeGreaterThanOrEqual(3);
      const alice = await makePeer(PUBLIC_DEFAULT_RELAYS);
      const bob = await makePeer(PUBLIC_DEFAULT_RELAYS);
      try {
        const text = `aava live relay check ${Date.now()}`;
        const res = await alice.messenger.send([bob.pubkey], { type: "text", content: text });
        await waitFor(() => bob.inbox.some((m) => m.content === text), 30_000, "bob receives over public relays");
        const ok = res.relays.filter((r) => r.ok);
        console.log(`public relays: ${res.relays.map((r) => `${r.url} ${r.ok ? "ok" : `FAILED (${r.message})`}`).join("; ")}`);
        expect(ok.length, "independent public relays that accepted the gift wrap").toBeGreaterThanOrEqual(3);
        // auth.nostr1.com only serves gift wraps after NIP-42: Bob reads his, an anonymous reader is refused.
        const authRelay = PUBLIC_DEFAULT_RELAYS.find((u) => u.includes("auth.nostr1"));
        expect(authRelay).toBeDefined();
        expect(res.relays.find((r) => r.url.includes("auth.nostr1"))?.ok, "Alice authenticated to publish").toBe(true);
        const own = await readWraps(authRelay!, bob.pubkey, bob.sk);
        expect(own.closed).toBeUndefined();
        expect(own.events.length).toBeGreaterThan(0);
        const anon = await readWraps(authRelay!, bob.pubkey);
        expect(anon.closed).toMatch(/auth-required/);
      } finally {
        await alice.stop();
        await bob.stop();
      }
    }, 120_000);
  });
});
