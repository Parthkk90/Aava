import { describe, expect, it } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import * as nip19 from "nostr-tools/nip19";
import { bytesToHex } from "nostr-tools/utils";
import { OBSERVATORY_TESTS, runAll, runTest, isKnownTracker, type ObservatoryEnv } from "./index.ts";

const byId = (id: string) => OBSERVATORY_TESTS.find((t) => t.id === id)!;
const sk = generateSecretKey();
const identity = { secretKey: () => sk, pubkey: getPublicKey(sk), npub: nip19.npubEncode(getPublicKey(sk)) };

describe("observatory", () => {
  it("has 15 uniquely identified tests with methods and limitations", () => {
    expect(OBSERVATORY_TESTS).toHaveLength(15);
    expect(new Set(OBSERVATORY_TESTS.map((t) => t.id)).size).toBe(15);
    for (const t of OBSERVATORY_TESTS) {
      expect(t.method.length).toBeGreaterThan(40);
      expect(t.limitations.length).toBeGreaterThan(0);
    }
  });

  it("reports NOT TESTED (never PASS) when capabilities are missing", async () => {
    const results = await runAll({});
    const byStatus = Object.fromEntries(results.map((r) => [r.id, r.status]));
    for (const id of ["OBS-02", "OBS-03", "OBS-04", "OBS-05", "OBS-06", "OBS-11", "OBS-12", "OBS-13", "OBS-14", "OBS-15"]) expect(byStatus[id]).toBe("NOT TESTED");
    // Self-contained cryptographic tests run anywhere.
    for (const id of ["OBS-01", "OBS-07", "OBS-08", "OBS-09", "OBS-10"]) expect(byStatus[id]).toBe("PASS");
    for (const r of results) {
      expect(r.startedAt).toMatch(/Z$/);
      expect(r.version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it("FAILS key storage when a plaintext key is present", async () => {
    const leaky: ObservatoryEnv = { identity, storageDump: async () => [{ area: "localStorage", key: "oops", value: `{"sk":"${bytesToHex(sk)}"}` }] };
    expect((await runTest(byId("OBS-11"), leaky)).status).toBe("FAIL");
    const nsecLeak: ObservatoryEnv = { identity, storageDump: async () => [{ area: "indexedDB", key: "k", value: nip19.nsecEncode(sk) }] };
    expect((await runTest(byId("OBS-11"), nsecLeak)).status).toBe("FAIL");
    const clean: ObservatoryEnv = { identity, storageDump: async () => [{ area: "indexedDB", key: "vault", value: "ncryptsec1qqqq" }] };
    expect((await runTest(byId("OBS-11"), clean)).status).toBe("PASS");
  });

  it("FAILS tracker detection and inventory on unexpected hosts", async () => {
    expect(isKnownTracker("www.google-analytics.com")).toBe(true);
    expect(isKnownTracker("relay.example.org")).toBe(false);
    const env: ObservatoryEnv = {
      networkEntries: () => [
        { url: "https://app.example/assets/main.js", kind: "script" },
        { url: "https://www.google-analytics.com/collect", kind: "beacon" },
      ],
      allowedOrigins: () => ["https://app.example"],
    };
    expect((await runTest(byId("OBS-03"), env)).status).toBe("FAIL");
    const inv = await runTest(byId("OBS-04"), env);
    expect(inv.status).toBe("FAIL");
    expect(inv.evidence.join("\n")).toContain("UNEXPECTED: https://www.google-analytics.com");
  });

  it("FAILS ICE inspection when relay-only mode leaks host candidates", async () => {
    const leaking: ObservatoryEnv = {
      privacy: { relayOnlyWebRTC: true, turnServers: [] },
      iceProbe: async () => ["candidate:1 1 udp 2122260223 192.168.1.20 54321 typ host generation 0"],
    };
    const r = await runTest(byId("OBS-05"), leaking);
    expect(r.status).toBe("FAIL");
    expect(r.evidence.join(" ")).not.toContain("192.168.1.20"); // evidence is redacted
    const ok: ObservatoryEnv = {
      privacy: { relayOnlyWebRTC: true, turnServers: [{ urls: "turn:turn.example:3478" }] },
      iceProbe: async () => ["candidate:2 1 udp 41885439 203.0.113.9 50000 typ relay raddr 0.0.0.0 rport 0"],
    };
    expect((await runTest(byId("OBS-05"), ok)).status).toBe("PASS");
    const none: ObservatoryEnv = { privacy: { relayOnlyWebRTC: true, turnServers: [] }, iceProbe: async () => [] };
    expect((await runTest(byId("OBS-05"), none)).status).toBe("LIMITED");
  });

  it("FAILS wallet validation on a chain mismatch", async () => {
    const env: ObservatoryEnv = { wallet: async () => ({ connected: true, kind: "injected", account: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", chainId: 1, expectedChainId: 31337 }) };
    expect((await runTest(byId("OBS-06"), env)).status).toBe("FAIL");
  });

  it("turns a thrown error into FAIL with evidence", async () => {
    const env: ObservatoryEnv = { identity, storageDump: async () => { throw new Error("IndexedDB blocked"); } };
    const r = await runTest(byId("OBS-11"), env);
    expect(r.status).toBe("FAIL");
    expect(r.evidence[0]).toContain("IndexedDB blocked");
  });

  it("verifies identity recovery for the current key", async () => {
    expect((await runTest(byId("OBS-13"), { identity })).status).toBe("PASS");
  });
});
