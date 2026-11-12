import { afterEach, describe, expect, it } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from "nostr-tools/pure";
import { startRelay, type RunningRelay } from "@relaymesh/relay";
import {
  ManifestError,
  RelayMesh,
  importRelayConfig,
  probeRelay,
  signOperatorManifest,
  verifyOperatorManifest,
  type ManifestInput,
} from "./index.ts";

const operator = generateSecretKey();
const baseInput: ManifestInput = {
  operator: { id: "relay-a.example", name: "Relay A Collective" },
  relayUrl: "wss://relay-a.example",
  protocols: ["nostr"],
  capabilities: ["nip-01", "nip-17", "nip-59"],
  software: { name: "relaymesh-reference-relay", version: "0.1.0" },
};

function errCode(fn: () => unknown): string {
  try {
    fn();
    return "no-error";
  } catch (e) {
    return e instanceof ManifestError ? e.code : `other:${(e as Error).message}`;
  }
}

describe("operator manifests", () => {
  const now = 1_800_000_000;

  it("accepts a valid signed manifest", () => {
    const ev = signOperatorManifest(baseInput, operator, now);
    const v = verifyOperatorManifest(ev, { now });
    expect(v.manifest.publicKey).toBe(getPublicKey(operator));
    expect(v.manifest.relayUrl).toBe("wss://relay-a.example");
  });

  it("rejects tampered content (signature no longer matches)", () => {
    const ev = signOperatorManifest(baseInput, operator, now);
    const tampered = { ...ev, content: ev.content.replace("relay-a.example", "evil.example") };
    expect(errCode(() => verifyOperatorManifest(tampered, { now }))).toBe("bad-signature");
  });

  it("rejects a manifest re-signed by a different key than it declares", () => {
    const ev = signOperatorManifest(baseInput, operator, now);
    const attacker = generateSecretKey();
    const resigned = finalizeEvent({ kind: ev.kind, created_at: ev.created_at, tags: ev.tags, content: ev.content }, attacker);
    expect(errCode(() => verifyOperatorManifest(resigned, { now }))).toBe("key-mismatch");
  });

  it("rejects expired and future-dated manifests", () => {
    const ev = signOperatorManifest({ ...baseInput, validForSec: 60 }, operator, now);
    expect(errCode(() => verifyOperatorManifest(ev, { now: now + 61 }))).toBe("expired");
    expect(errCode(() => verifyOperatorManifest(ev, { now: now - 3600 }))).toBe("not-yet-valid");
  });

  it("rejects insecure URLs, unknown capabilities, and over-long validity", () => {
    expect(() => signOperatorManifest({ ...baseInput, relayUrl: "ws://public.example.com" }, operator, now)).toThrow();
    expect(() => signOperatorManifest({ ...baseInput, capabilities: ["teleport" as never] }, operator, now)).toThrow();
    const long = signOperatorManifest({ ...baseInput, validForSec: 400 * 24 * 3600 }, operator, now);
    expect(errCode(() => verifyOperatorManifest(long, { now }))).toBe("validity-too-long");
  });

  it("enforces pinned operator keys (TOFU)", () => {
    const ev = signOperatorManifest(baseInput, generateSecretKey(), now);
    expect(errCode(() => verifyOperatorManifest(ev, { now, pinnedKeys: { "relay-a.example": getPublicKey(operator) } }))).toBe("pinned-key-mismatch");
  });

  it("rejects malformed input", () => {
    expect(errCode(() => verifyOperatorManifest("not json", { now }))).toBe("malformed");
    expect(errCode(() => verifyOperatorManifest({ kind: 1, tags: [], content: "{}" }, { now }))).toBe("wrong-kind");
  });

  it("imports a config bundle, trusting only valid manifests", () => {
    const good = signOperatorManifest(baseInput, operator, now);
    const bad = { ...good, content: good.content.replace("Collective", "Kollective") };
    const imported = importRelayConfig(
      { format: "relaymesh.relay-config", v: 1, relays: [{ url: "wss://relay-a.example" }, { url: "ws://localhost:7002" }], manifests: [good, bad] },
      { now },
    );
    expect(imported.relays[0]!.manifest).toBeDefined();
    expect(imported.relays[1]!.manifest).toBeUndefined();
    expect(imported.rejectedManifests).toHaveLength(1);
  });
});

describe("relay mesh with real relays", () => {
  const running: RunningRelay[] = [];
  const meshes: RelayMesh[] = [];
  afterEach(async () => {
    for (const m of meshes.splice(0)) await m.stop();
    for (const r of running.splice(0)) await r.close();
  });

  function note(sk: Uint8Array, content: string): NostrEvent {
    return finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content }, sk);
  }

  async function waitFor(cond: () => boolean, ms = 8_000) {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error("timeout waiting for condition");
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it("probes a relay (connectivity + NIP-11)", async () => {
    const relay = await startRelay({ port: 0, name: "Probe relay" });
    running.push(relay);
    const probe = await probeRelay(relay.url);
    expect(probe.reachable).toBe(true);
    expect(probe.info?.name).toBe("Probe relay");
    expect(probe.info?.supported_nips).toContain(17);
    const dead = await probeRelay("ws://127.0.0.1:1", 1_000);
    expect(dead.reachable).toBe(false);
  });

  it("publishes to all relays, fails over, and backfills a recovered relay", async () => {
    const a = await startRelay({ port: 0, name: "A" });
    const b = await startRelay({ port: 0, name: "B" });
    running.push(a, b);
    const mesh = new RelayMesh({ relays: [{ url: a.url }, { url: b.url }], backoffMs: [100, 200] });
    meshes.push(mesh);
    mesh.start();
    await waitFor(() => mesh.openRelays().length === 2);

    const sk = generateSecretKey();
    const received: string[] = [];
    mesh.subscribe([{ kinds: [1], authors: [getPublicKey(sk)] }], (e) => received.push(e.content));

    const r1 = await mesh.publish(note(sk, "one"));
    expect(r1.outcomes.filter((o) => o.ok).map((o) => o.url).sort()).toEqual([a.url, b.url].sort());
    await waitFor(() => received.includes("one"));
    expect(received.filter((c) => c === "one")).toHaveLength(1); // deduplicated across relays

    // Relay A goes down.
    const portA = a.port;
    await a.close();
    running.splice(running.indexOf(a), 1);
    await waitFor(() => mesh.states().find((s) => s.url === a.url)!.status !== "open");

    const r2 = await mesh.publish(note(sk, "two"));
    expect(r2.queued).toBe(false);
    expect(r2.outcomes.find((o) => o.url === b.url)?.ok).toBe(true);
    expect(r2.outcomes.find((o) => o.url === a.url)?.ok).toBe(false);
    await waitFor(() => received.includes("two"));

    // Relay A comes back on the same port: mesh reconnects and backfills "two".
    const a2 = await startRelay({ port: portA, name: "A" });
    running.push(a2);
    await waitFor(() => mesh.states().find((s) => s.url === a.url)!.status === "open");
    await waitFor(() => a2.storedEvents().some((e) => e.content === "two"));
  });

  it("queues events when every relay is down and flushes on recovery", async () => {
    const a = await startRelay({ port: 0 });
    const port = a.port;
    await a.close();
    const mesh = new RelayMesh({ relays: [{ url: `ws://127.0.0.1:${port}` }], backoffMs: [100] });
    meshes.push(mesh);
    mesh.start();
    const sk = generateSecretKey();
    const res = await mesh.publish(note(sk, "offline"));
    expect(res.queued).toBe(true);
    expect(mesh.pendingOutbox()).toHaveLength(1);
    const back = await startRelay({ port });
    running.push(back);
    await waitFor(() => back.storedEvents().some((e) => e.content === "offline"));
    await waitFor(() => mesh.pendingOutbox().length === 0);
  });

  it("rejects events with invalid signatures at the relay", async () => {
    const relay = await startRelay({ port: 0 });
    running.push(relay);
    const mesh = new RelayMesh({ relays: [{ url: relay.url }] });
    meshes.push(mesh);
    mesh.start();
    await waitFor(() => mesh.openRelays().length === 1);
    const ev = note(generateSecretKey(), "genuine");
    const forged = { ...ev, content: "forged" };
    const res = await mesh.publish(forged);
    expect(res.outcomes[0]!.ok).toBe(false);
    expect(res.outcomes[0]!.message).toMatch(/invalid/);
    expect(relay.storedEvents()).toHaveLength(0);
  });
});
