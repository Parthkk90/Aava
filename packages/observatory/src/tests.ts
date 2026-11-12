import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import * as nip19 from "nostr-tools/nip19";
import { bytesToHex } from "nostr-tools/utils";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import { buildPrivateMessage, openGiftWrap } from "@relaymesh/messaging";
import { createIdentityBackup, restoreIdentityBackup, publicIdentity, zeroize } from "@relaymesh/identity";
import { TokenRegistry } from "@relaymesh/chain";
import { ContactWalletPolicy, RequestLedger, createPaymentRequest, toWire, typedDataFor, verifyPaymentRequest } from "@relaymesh/payments";
import type { ObservatoryEnv, ObservatoryTest, TestOutcome } from "./types.ts";
import { isKnownTracker } from "./trackers.ts";

const notTested = (why: string): TestOutcome => ({ status: "NOT TESTED", evidence: [why] });

function randomMarker() {
  return `rm-probe-${bytesToHex(generateSecretKey()).slice(0, 24)}`;
}

/* ---------------------------------------------------------------- privacy */

const encryption: ObservatoryTest = {
  id: "OBS-01",
  title: "Message encryption (NIP-17 / NIP-59)",
  category: "privacy",
  version: "1.0.0",
  method:
    "Builds a real NIP-17 message containing a random marker to a throwaway recipient, then checks every gift wrap: kind 1059, signed by a one-time key, marker absent from the serialized event, sender key absent from the recipient's wrap, and the recipient can decrypt it while a third key cannot.",
  limitations: ["Proves content encryption only. Relays still see recipient public key, timing, size, and your IP address.", "NIP-44 provides no forward secrecy."],
  async run(env) {
    const sender = env.identity?.secretKey() ?? generateSecretKey();
    const senderPub = getPublicKey(sender);
    const recipient = generateSecretKey();
    const recipientPub = getPublicKey(recipient);
    const marker = randomMarker();
    const built = buildPrivateMessage(sender, [recipientPub], { type: "text", content: marker });
    const evidence: string[] = [];
    let fail = false;
    for (const w of built.wraps) {
      const json = JSON.stringify(w.event);
      const ok = w.event.kind === 1059 && !json.includes(marker) && w.event.pubkey !== senderPub;
      evidence.push(`wrap ${w.event.id.slice(0, 12)}… kind=${w.event.kind} signer=${w.event.pubkey.slice(0, 12)}… plaintext-present=${json.includes(marker)}`);
      if (!ok) fail = true;
    }
    const toRecipient = built.wraps.find((w) => w.recipient === recipientPub)!.event;
    if (JSON.stringify(toRecipient).includes(senderPub)) {
      fail = true;
      evidence.push("Recipient wrap contains the sender public key");
    }
    const opened = openGiftWrap(toRecipient, recipient);
    evidence.push(`recipient decrypts: ${opened.content === marker}; authenticated author matches sender: ${opened.from === senderPub}`);
    if (opened.content !== marker || opened.from !== senderPub) fail = true;
    let thirdParty = false;
    try {
      openGiftWrap(toRecipient, generateSecretKey());
      thirdParty = true;
    } catch {
      /* expected */
    }
    evidence.push(`third party can decrypt: ${thirdParty}`);
    if (thirdParty) fail = true;
    return { status: fail ? "FAIL" : "PASS", evidence };
  },
};

const relayExposure: ObservatoryTest = {
  id: "OBS-02",
  title: "Relay plaintext exposure",
  category: "privacy",
  version: "1.0.0",
  method:
    "Publishes a gift-wrapped note-to-self containing a random marker to every connected relay, then queries each relay directly (as the operator or any reader could) and searches everything it returns for the marker and for your public key in signer fields.",
  limitations: [
    "Only inspects what the relay returns over the protocol, not its disk or logs.",
    "The note-to-self wrap is p-tagged to you: relays learn that you received a message at that time.",
  ],
  async run(env) {
    if (!env.identity || !env.mesh || !env.queryRelay) return notTested("Requires an unlocked identity and at least one connected relay.");
    const open = env.mesh.openRelays();
    if (open.length === 0) return notTested("No relay is connected.");
    const marker = randomMarker();
    const sk = env.identity.secretKey();
    const built = buildPrivateMessage(sk, [env.identity.pubkey], { type: "text", content: marker, subject: "observatory-probe" });
    const wrap = built.wraps[0]!.event;
    const pub = await env.mesh.publish(wrap);
    const evidence = pub.outcomes.map((o) => `publish → ${o.url}: ${o.ok ? "accepted" : `rejected (${o.message})`}`);
    let fail = false;
    let inspected = 0;
    for (const url of open) {
      const events = await env.queryRelay(url, { kinds: [1059], "#p": [env.identity.pubkey], limit: 100 }, 5_000);
      const stored = events.find((e) => e.id === wrap.id);
      const leaks = events.filter((e) => JSON.stringify(e).includes(marker) || e.pubkey === env.identity!.pubkey);
      inspected += events.length;
      evidence.push(`${url}: returned ${events.length} wrap(s); probe stored=${!!stored}; plaintext or sender-key leaks=${leaks.length}`);
      if (leaks.length) fail = true;
    }
    if (fail) return { status: "FAIL", evidence };
    if (inspected === 0) return { status: "LIMITED", evidence: [...evidence, "Relays returned no events; nothing could be inspected."] };
    return { status: "PASS", evidence };
  },
};

const trackers: ObservatoryTest = {
  id: "OBS-03",
  title: "Third-party tracker detection",
  category: "privacy",
  version: "1.0.0",
  method: "Reads the browser's Resource Timing entries for this page and matches every contacted hostname against a list of known analytics and tracking domains.",
  limitations: ["Cannot see requests made by browser extensions (including wallet extensions) or by the OS.", "Resource Timing may omit some cross-origin requests."],
  async run(env) {
    if (!env.networkEntries) return notTested("Resource Timing is not available in this environment.");
    const entries = env.networkEntries();
    const hosts = [...new Set(entries.map((e) => safeHost(e.url)).filter(Boolean))] as string[];
    const hits = hosts.filter(isKnownTracker);
    return {
      status: hits.length ? "FAIL" : "PASS",
      evidence: [`${entries.length} request(s) to ${hosts.length} host(s): ${hosts.join(", ") || "none"}`, hits.length ? `Trackers: ${hits.join(", ")}` : "No known tracker domains contacted"],
    };
  },
};

const inventory: ObservatoryTest = {
  id: "OBS-04",
  title: "Network endpoint inventory",
  category: "privacy",
  version: "1.0.0",
  method:
    "Lists every origin this page has contacted (Resource Timing) plus every relay WebSocket, and compares them with the endpoints you configured (relays, RPC, TURN, and this app's own origin). Any origin you did not configure fails the test.",
  limitations: ["Only covers this page's requests. Wallet extensions, the OS, and other tabs are not visible.", "Does not show what each endpoint learns; see the Privacy page for that."],
  async run(env) {
    if (!env.networkEntries || !env.allowedOrigins) return notTested("Network inventory is not available in this environment.");
    const allowed = new Set(env.allowedOrigins().map(originOf).filter(Boolean));
    const contacted = new Set<string>();
    for (const e of env.networkEntries()) {
      const o = originOf(e.url);
      if (o) contacted.add(o);
    }
    for (const s of env.mesh?.states() ?? []) if (s.status === "open") contacted.add(originOf(s.url)!);
    const unexpected = [...contacted].filter((o) => !allowed.has(o));
    const evidence = [...contacted].sort().map((o) => `${allowed.has(o) ? "configured" : "UNEXPECTED"}: ${o}`);
    if (evidence.length === 0) evidence.push("No network requests recorded yet.");
    return { status: unexpected.length ? "FAIL" : "PASS", evidence };
  },
};

const ice: ObservatoryTest = {
  id: "OBS-05",
  title: "WebRTC ICE candidate inspection",
  category: "privacy",
  version: "1.0.0",
  method:
    "Creates a real RTCPeerConnection with your configured TURN servers and transport policy, gathers ICE candidates for a few seconds, and classifies each one (host, srflx, prflx, relay). In relay-only mode any non-relay candidate is a failure, because it would reveal your local or public IP address to a peer.",
  limitations: ["Tests this browser and network only.", "The TURN operator still sees your IP address and your peer's.", "Relay-only mode fails to connect if no TURN server is reachable."],
  async run(env) {
    if (!env.iceProbe || !env.privacy) return notTested("WebRTC is not available in this environment.");
    const { relayOnlyWebRTC, turnServers } = env.privacy;
    const config: RTCConfiguration = { iceServers: turnServers, iceTransportPolicy: relayOnlyWebRTC ? "relay" : "all" };
    const candidates = await env.iceProbe(config, 4_000);
    const types = candidates.map((c) => / typ ([a-z]+)/.exec(c)?.[1] ?? "unknown");
    const counts = types.reduce<Record<string, number>>((m, t) => ({ ...m, [t]: (m[t] ?? 0) + 1 }), {});
    const evidence = [`policy=${config.iceTransportPolicy}; TURN servers=${turnServers.length}`, `candidates: ${JSON.stringify(counts)}`];
    for (const c of candidates.slice(0, 8)) evidence.push(redactCandidate(c));
    const exposing = types.filter((t) => t === "host" || t === "srflx" || t === "prflx");
    if (relayOnlyWebRTC) {
      if (exposing.length) return { status: "FAIL", evidence: [...evidence, "Non-relay candidates were gathered despite relay-only mode."] };
      if (candidates.length === 0) return { status: "LIMITED", evidence: [...evidence, "No candidates gathered: no IP was exposed, but no TURN server was reachable so calls would not connect."] };
      return { status: "PASS", evidence: [...evidence, "Only relay candidates: peers would see the TURN server address, not yours."] };
    }
    return {
      status: "LIMITED",
      evidence: [...evidence, exposing.length ? "Relay-only mode is OFF: peers can learn your IP address from these candidates." : "Relay-only mode is OFF."],
    };
  },
};

/* --------------------------------------------------------------- security */

const wallet: ObservatoryTest = {
  id: "OBS-06",
  title: "Wallet connection validation",
  category: "security",
  version: "1.0.0",
  method: "Reads the connected wallet's account and chain through EIP-1193 (no signing request) and checks that the address is well formed and the chain matches the network you selected. Aava never asks for a seed phrase or private key.",
  limitations: ["Cannot verify the wallet software itself is genuine or uncompromised."],
  async run(env) {
    if (!env.wallet) return notTested("Wallet integration not available.");
    const w = await env.wallet();
    if (!w.connected) return notTested("No wallet connected.");
    const evidence = [`wallet type: ${w.kind}`, `account: ${w.account}`, `wallet chain: ${w.chainId}; selected chain: ${w.expectedChainId}`];
    const addrOk = !!w.account && /^0x[0-9a-fA-F]{40}$/.test(w.account);
    if (!addrOk) return { status: "FAIL", evidence: [...evidence, "Account address is malformed"] };
    if (w.chainId !== w.expectedChainId) return { status: "FAIL", evidence: [...evidence, "Wallet is on a different chain than the one selected; payments will be refused until you switch."] };
    return { status: "PASS", evidence };
  },
};

/** Shared fixture for payment tests: an ephemeral, in-memory test signer (never a user key). */
async function paymentFixture(env: ObservatoryEnv) {
  const signer = privateKeyToAccount(generatePrivateKey());
  const creatorPubkey = env.identity?.pubkey ?? getPublicKey(generateSecretKey());
  const token = "0x00000000000000000000000000000000000Fa11e" as Address;
  const tokens = new TokenRegistry([{ chainId: 31337, address: token, symbol: "TEST", name: "Observatory test token", decimals: 6, source: "observatory fixture" }]);
  const store = new Map<string, string>();
  const ledger = new RequestLedger({ get: async (k) => store.get(k), set: async (k, v) => void store.set(k, v) });
  const policy = new ContactWalletPolicy({ [creatorPubkey]: [signer.address] });
  const makeWith = async (account: ReturnType<typeof privateKeyToAccount>, over: Partial<Parameters<typeof createPaymentRequest>[0]> = {}) => {
    const req = createPaymentRequest({ creatorPubkey, creatorWallet: account.address, chainId: 31337, token, recipient: "0x1111111111111111111111111111111111111111", amount: 1_000_000n, ...over });
    return toWire({ request: req, signature: await account.signTypedData(typedDataFor(req)) });
  };
  const make = (over: Partial<Parameters<typeof createPaymentRequest>[0]> = {}) => makeWith(signer, over);
  const ctx = { expectedChainId: 31337, tokens, policy, ledger, messageAuthor: creatorPubkey };
  return { make, makeWith, ctx };
}

const paymentSignature: ObservatoryTest = {
  id: "OBS-07",
  title: "Payment signature validation",
  category: "security",
  version: "1.0.0",
  method: "Signs a payment request with an ephemeral in-memory test key, runs it through the same verifier the app uses for incoming requests, and requires every check (schema, EIP-712 signature, author, chain, token, expiry, policy, replay) to pass.",
  limitations: ["Uses a test signer, not your wallet. Wallet signing is exercised in the payment flow itself."],
  async run(env) {
    const { make, ctx } = await paymentFixture(env);
    const r = await verifyPaymentRequest(await make(), ctx);
    return { status: r.ok ? "PASS" : "FAIL", evidence: r.steps.map((s) => `${s.ok ? "✓" : "✗"} ${s.check}: ${s.detail}`) };
  },
};

const tamper: ObservatoryTest = {
  id: "OBS-08",
  title: "Payment recipient tampering",
  category: "security",
  version: "1.0.0",
  method: "Signs a valid request, then changes the recipient address in transit (as a malicious relay or attacker would) and also tries re-signing the altered request with an attacker wallet. Both must be rejected.",
  limitations: ["If the creator's own wallet is compromised, the attacker can sign a valid request; the policy then decides."],
  async run(env) {
    const { make, makeWith, ctx } = await paymentFixture(env);
    const attackerAddress = "0x2222222222222222222222222222222222222222" as Address;
    // 1. Recipient edited in transit; signature left as is.
    const altered = JSON.parse(JSON.stringify(await make())) as { request: Record<string, unknown> };
    altered.request.recipient = attackerAddress;
    const r1 = await verifyPaymentRequest(altered, ctx);
    // 2. Attacker re-signs the altered request with their own wallet.
    const attacker = privateKeyToAccount(generatePrivateKey());
    const r2 = await verifyPaymentRequest(await makeWith(attacker, { recipient: attackerAddress }), ctx);
    const evidence = [
      `altered recipient → ${r1.ok ? "ACCEPTED" : `rejected (${r1.code}: ${r1.reason})`}`,
      `attacker re-signed → ${r2.ok ? "ACCEPTED" : `rejected (${r2.code}: ${r2.reason})`}`,
    ];
    return { status: !r1.ok && !r2.ok ? "PASS" : "FAIL", evidence };
  },
};

const expired: ObservatoryTest = {
  id: "OBS-09",
  title: "Expired request rejection",
  category: "security",
  version: "1.0.0",
  method: "Signs a request that expired one minute ago and verifies that it is rejected with code 'expired'.",
  limitations: ["Relies on this device's clock being roughly correct."],
  async run(env) {
    const { make, ctx } = await paymentFixture(env);
    const r = await verifyPaymentRequest(await make({ ttlSec: 60, now: Math.floor(Date.now() / 1000) - 120 }), ctx);
    return { status: !r.ok && r.code === "expired" ? "PASS" : "FAIL", evidence: [r.ok ? "Expired request was ACCEPTED" : `rejected (${r.code}): ${r.reason}`] };
  },
};

const duplicate: ObservatoryTest = {
  id: "OBS-10",
  title: "Duplicate request rejection",
  category: "security",
  version: "1.0.0",
  method: "Verifies and registers a request in a scratch ledger, then submits the identical request again and requires rejection with code 'duplicate'.",
  limitations: ["Replay protection is per device: a second device has its own ledger."],
  async run(env) {
    const { make, ctx } = await paymentFixture(env);
    const wire = await make();
    const first = await verifyPaymentRequest(wire, ctx);
    if (!first.ok) return { status: "FAIL", evidence: [`first submission unexpectedly rejected: ${first.reason}`] };
    await ctx.ledger.register(first.signed, first.digest);
    const second = await verifyPaymentRequest(wire, ctx);
    return { status: !second.ok && second.code === "duplicate" ? "PASS" : "FAIL", evidence: ["first submission accepted", second.ok ? "replay ACCEPTED" : `replay rejected (${second.code})`] };
  },
};

const keyStorage: ObservatoryTest = {
  id: "OBS-11",
  title: "Local key storage",
  category: "security",
  version: "1.0.0",
  method: "Dumps every value in localStorage, sessionStorage and the app's IndexedDB stores and searches them for your secret key in hex and nsec form. Encrypted NIP-49 ciphertext (ncryptsec) is expected and reported.",
  limitations: ["Does not prove the device is uncompromised: malware or a malicious extension can read keys from memory while the vault is unlocked.", "Cannot inspect browser caches or swap."],
  async run(env) {
    if (!env.identity || !env.storageDump) return notTested("Requires an unlocked identity and storage access.");
    const sk = env.identity.secretKey();
    const hex = bytesToHex(sk);
    const nsec = nip19.nsecEncode(sk);
    const items = await env.storageDump();
    const leaks = items.filter((i) => i.value.toLowerCase().includes(hex) || i.value.includes(nsec) || i.key.includes(hex));
    const encrypted = items.filter((i) => i.value.includes("ncryptsec1"));
    const evidence = [`scanned ${items.length} stored value(s) across ${new Set(items.map((i) => i.area)).size} storage area(s)`, `values containing NIP-49 ciphertext: ${encrypted.length}`];
    if (leaks.length) evidence.push(...leaks.map((l) => `PLAINTEXT KEY FOUND in ${l.area}:${l.key}`));
    else evidence.push("secret key not found in hex or nsec form");
    return { status: leaks.length ? "FAIL" : "PASS", evidence };
  },
};

/* ----------------------------------------------------------- availability */

const failover: ObservatoryTest = {
  id: "OBS-12",
  title: "Relay failover",
  category: "availability",
  version: "1.0.0",
  method: "Temporarily disables one connected relay, publishes a gift-wrapped note-to-self, and checks that another independent relay accepted it. The disabled relay is then re-enabled and receives the event through backfill.",
  limitations: ["Simulates loss of a relay from this client's side; it does not test what happens when a relay silently drops events."],
  async run(env) {
    if (!env.identity || !env.mesh) return notTested("Requires an unlocked identity and the relay mesh.");
    const open = env.mesh.openRelays();
    if (open.length < 2) return notTested(`Needs at least two connected relays (have ${open.length}). Add another independent relay.`);
    const victim = open[0]!;
    env.mesh.setEnabled(victim, false);
    try {
      const built = buildPrivateMessage(env.identity.secretKey(), [env.identity.pubkey], { type: "text", content: randomMarker(), subject: "observatory-probe" });
      const res = await env.mesh.publish(built.wraps[0]!.event);
      const accepted = res.outcomes.filter((o) => o.ok).map((o) => o.url);
      const evidence = [`disabled ${victim}`, `accepted by: ${accepted.join(", ") || "none"}`];
      return { status: accepted.length > 0 && !accepted.includes(victim) ? "PASS" : "FAIL", evidence };
    } finally {
      env.mesh.setEnabled(victim, true);
    }
  },
};

const recovery: ObservatoryTest = {
  id: "OBS-13",
  title: "Identity recovery",
  category: "availability",
  version: "1.0.0",
  method: "Creates a real NIP-49 encrypted backup (scrypt log_n=16, XChaCha20-Poly1305) of your current identity under a random one-time password, restores it, and checks the restored key produces the same public key. A wrong password must fail.",
  limitations: ["Tests the backup format and code path, not a backup file you saved earlier. Restore your saved file on another device to be certain.", "Fresh-installation recovery is covered by the automated CROPS suite (S-03)."],
  async run(env) {
    if (!env.identity) return notTested("Requires an unlocked identity.");
    const password = `probe-${bytesToHex(generateSecretKey())}`;
    const backup = createIdentityBackup(env.identity.secretKey(), password);
    const restored = restoreIdentityBackup(JSON.stringify(backup), password);
    const same = publicIdentity(restored).pubkey === env.identity.pubkey;
    zeroize(restored);
    let wrongRejected = false;
    try {
      restoreIdentityBackup(backup, "definitely the wrong password");
    } catch {
      wrongRejected = true;
    }
    return {
      status: same && wrongRejected ? "PASS" : "FAIL",
      evidence: [`backup format: ${backup.format} v${backup.version}, kdf ${backup.kdf} log_n=${backup.logN}`, `restored public key matches: ${same}`, `wrong password rejected: ${wrongRejected}`],
    };
  },
};

/* ------------------------------------------------------------- integrity */

const release: ObservatoryTest = {
  id: "OBS-14",
  title: "Frontend release verification",
  category: "integrity",
  version: "1.0.0",
  method: "Fetches the build's release manifest, re-downloads every listed asset, computes its SHA-256 locally, and compares. Compare the manifest's root hash with the one published in the signed release notes.",
  limitations: [
    "The manifest is served by the same origin as the app: a malicious host could serve a matching manifest. This is at most LIMITED until you compare the root hash against an independently published, signed release.",
  ],
  async run(env) {
    if (!env.release) return notTested("No release manifest configured.");
    let manifest: { version: string; rootHash: string; files: { path: string; sha256: string }[] };
    try {
      const res = await env.release.fetch(env.release.manifestUrl, { cache: "no-store" });
      if (!res.ok) return notTested(`No release manifest at ${env.release.manifestUrl} (HTTP ${res.status}). Development builds are not release-verified.`);
      manifest = (await res.json()) as typeof manifest;
    } catch (e) {
      return notTested(`Release manifest unavailable: ${(e as Error).message}`);
    }
    const base = new URL(env.release.manifestUrl, globalThis.location?.href ?? "http://localhost/");
    const mismatches: string[] = [];
    for (const f of manifest.files) {
      const res = await env.release.fetch(new URL(f.path, base).toString(), { cache: "no-store" });
      const digest = bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", await res.arrayBuffer())));
      if (digest !== f.sha256) mismatches.push(f.path);
    }
    const evidence = [`release ${manifest.version}; ${manifest.files.length} file(s); root hash ${manifest.rootHash}`];
    if (mismatches.length) return { status: "FAIL", evidence: [...evidence, `hash mismatch: ${mismatches.join(", ")}`] };
    return { status: "LIMITED", evidence: [...evidence, "All served files match the manifest."] };
  },
};

const rpcRouting: ObservatoryTest = {
  id: "OBS-15",
  title: "Anonymous RPC routing",
  category: "privacy",
  version: "1.0.0",
  method:
    "When anonymous RPC (Anon-RPC) mode is on, lists every request this page made since the mode took effect (Resource Timing) and fails if any went directly to an RPC origin that must only be reached through the anonymizing worker. In direct or light-client mode it reports LIMITED, because the RPC provider then sees your IP address.",
  limitations: [
    "The anonymizing worker's own traffic (WebRTC/KPS to the mixnet entry node) is not visible to Resource Timing; the entry node sees your IP address but not the destination.",
    "Your wallet extension reads and broadcasts through its own RPC, which Aava cannot route.",
    "A PASS does not prove the mixnet is honest: the hash-pinned worker sees every request and could censor or alter responses.",
  ],
  async run(env) {
    if (!env.rpcRouting) return notTested("RPC routing information is not available in this environment.");
    const info = env.rpcRouting();
    if (info.mode !== "anon") {
      return {
        status: "LIMITED",
        evidence: [`RPC mode: ${info.mode}. The RPC provider${info.mode === "light-client" ? " (light-client execution and consensus endpoints)" : ""} sees your IP address and which addresses you query.`, ...info.detail],
      };
    }
    if (!env.networkEntries) return notTested("Resource Timing is not available in this environment.");
    const guarded = new Set(info.anonymizedOrigins.map(originOf).filter(Boolean));
    const direct = env
      .networkEntries()
      .filter((e) => (e.startTime ?? Number.POSITIVE_INFINITY) >= info.since)
      .map((e) => originOf(e.url))
      .filter((o): o is string => !!o && guarded.has(o));
    const evidence = [`Anonymized RPC origins: ${[...guarded].join(", ") || "none"}`, ...info.detail];
    if (direct.length) return { status: "FAIL", evidence: [...evidence, `Direct request(s) to: ${[...new Set(direct)].join(", ")}`] };
    return { status: "PASS", evidence: [...evidence, "No direct request to an anonymized RPC origin since the mode took effect."] };
  },
};

export const OBSERVATORY_TESTS: ObservatoryTest[] = [
  encryption,
  relayExposure,
  trackers,
  inventory,
  ice,
  wallet,
  paymentSignature,
  tamper,
  expired,
  duplicate,
  keyStorage,
  failover,
  recovery,
  release,
  rpcRouting,
];

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/** Keeps candidate type and protocol; masks IP addresses in evidence shown on screen. */
function redactCandidate(c: string): string {
  return c.replace(/\b(\d{1,3})\.\d{1,3}\.\d{1,3}\.(\d{1,3})\b/g, "$1.x.x.$2").replace(/([0-9a-f]{1,4}:){3,}[0-9a-f:]+/gi, "<ipv6>");
}
