/**
 * Aava signature demonstration (headless, reproducible).
 *
 *   pnpm demo            # self-contained: in-process relays A+B and anvil (needs Foundry)
 *   pnpm demo --docker   # against `docker compose -f infra/docker-compose.yml up`
 *                        #   Relay A = Aava reference relay (ws://localhost:7001)
 *                        #   Relay B = nostr-rs-relay, independent codebase (ws://localhost:7002)
 *
 * Every step prints evidence; the script exits non-zero if any step fails.
 * Uses a local devnet with a valueless test token: never real funds.
 */
import { execSync } from "node:child_process";
import { Relay } from "nostr-tools/relay";
import { finalizeEvent, type NostrEvent } from "nostr-tools/pure";
import type { Filter } from "nostr-tools/filter";
import { foundry } from "viem/chains";
import type { Address, Hash } from "viem";
import { IdentityVault, MemoryStore, createIdentityBackup, restoreIdentityBackup } from "@relaymesh/identity";
import { ConversationStore, Messenger, type StoredMessage } from "@relaymesh/messaging";
import { RelayMesh, probeRelay } from "@relaymesh/relay-mesh";
import { DEMO_TOKEN_ADDRESS, TokenRegistry, formatUnitsExact } from "@relaymesh/chain";
import { ANVIL_ACCOUNTS, deployDemoToken, devClients, mintDemoToken, startAnvil } from "@relaymesh/chain/testing";
import { demoTokenAbi } from "@relaymesh/chain/demo-token";
import { ContactWalletPolicy, RequestLedger, createPaymentRequest, executeApprovedPayment, settlePayment, toWire, typedDataFor, verifyPaymentRequest, type PaymentWallet } from "@relaymesh/payments";
import { startRelay } from "@relaymesh/relay";

const DOCKER = process.argv.includes("--docker");
const c = { g: "\x1b[32m", r: "\x1b[31m", d: "\x1b[2m", b: "\x1b[1m", c: "\x1b[36m", x: "\x1b[0m" };
let stepNo = 0;
let failures = 0;
async function step<T>(title: string, fn: () => Promise<T>): Promise<T> {
  stepNo++;
  process.stdout.write(`\n${c.b}${String(stepNo).padStart(2, "0")}. ${title}${c.x}\n`);
  try {
    const out = await fn();
    process.stdout.write(`    ${c.g}✔ ok${c.x}\n`);
    return out;
  } catch (e) {
    failures++;
    process.stdout.write(`    ${c.r}✘ FAILED: ${(e as Error).message}${c.x}\n`);
    throw e;
  }
}
const ev = (s: string) => process.stdout.write(`    ${c.d}${s}${c.x}\n`);
const assert = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(msg);
};
async function waitFor(cond: () => boolean, ms = 15_000, what = "condition") {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function queryRelay(url: string, filter: Filter): Promise<NostrEvent[]> {
  const relay = new Relay(url, { enablePing: false, enableReconnect: false });
  await relay.connect({ timeout: 5000 });
  const out: NostrEvent[] = [];
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 5000);
    const sub = relay.subscribe([filter], { onevent: (e) => out.push(e), oneose: () => (clearTimeout(t), sub.close(), resolve()) });
  });
  relay.close();
  return out;
}

interface User {
  name: string;
  vault: IdentityVault;
  kv: MemoryStore;
  mesh: RelayMesh;
  store: ConversationStore;
  messenger: Messenger;
  inbox: StoredMessage[];
}

async function openUser(name: string, relays: string[], vault: IdentityVault, kv: MemoryStore): Promise<User> {
  const mesh = new RelayMesh({ relays: relays.map((url) => ({ url })), backoffMs: [200, 500, 1000], auth: async (t) => finalizeEvent(t, vault.secretKey()) });
  const pubkey = vault.publicKey();
  const store = new ConversationStore(kv, ConversationStore.keyFor(pubkey), () => vault.secretKey());
  await store.load();
  const inbox: StoredMessage[] = [];
  const messenger = new Messenger(mesh, store, () => vault.secretKey(), { onMessage: (m) => m.direction === "in" && inbox.push(m) });
  mesh.start();
  messenger.start();
  await waitFor(() => mesh.openRelays().length > 0, 10_000, `${name} to connect`);
  return { name, vault, kv, mesh, store, messenger, inbox };
}

async function main() {
  console.log(`${c.b}Aava signature demo${c.x} ${c.d}(${DOCKER ? "docker stack" : "self-contained"} mode)${c.x}`);
  const cleanup: (() => Promise<unknown>)[] = [];
  let relayA: string, relayB: string, rpcUrl: string;
  let stopRelayA: () => Promise<void>;

  if (DOCKER) {
    relayA = "ws://localhost:7001";
    relayB = "ws://localhost:7002";
    rpcUrl = "http://127.0.0.1:8545";
    stopRelayA = async () => void execSync("docker compose -f infra/docker-compose.yml stop relay-a", { stdio: "ignore" });
  } else {
    const anvil = await startAnvil();
    cleanup.push(() => anvil.stop());
    rpcUrl = anvil.rpcUrl;
    await deployDemoToken(rpcUrl, ANVIL_ACCOUNTS[0]!);
    await mintDemoToken(rpcUrl, DEMO_TOKEN_ADDRESS, ANVIL_ACCOUNTS[1]!, 1_000_000_000n);
    const a = await startRelay({ port: 0, name: "Relay A" });
    const b = await startRelay({ port: 0, name: "Relay B" });
    cleanup.push(() => b.close());
    relayA = a.url;
    relayB = b.url;
    stopRelayA = () => a.close();
  }
  const relays = [relayA, relayB];
  ev(`Relay A: ${relayA}   Relay B: ${relayB}   RPC: ${rpcUrl}`);
  const ALICE_WALLET = ANVIL_ACCOUNTS[2]! as Address;
  const BOB_WALLET = ANVIL_ACCOUNTS[1]! as Address;
  const { walletClient, publicClient } = devClients(rpcUrl);
  const PASSWORD = "alice device password";

  const aliceKv = new MemoryStore();
  const aliceVault = new IdentityVault(aliceKv);
  const bobVault = new IdentityVault(new MemoryStore());

  await step("Alice generates a local identity", async () => {
    const id = await aliceVault.create(PASSWORD, "Alice");
    ev(`npub ${id.npub}`);
    ev(`stored at rest: ${[...aliceKv.data.values()][0]!.slice(0, 90)}…`);
  });
  await step("Bob generates a local identity", async () => {
    const id = await bobVault.create("bob device password", "Bob");
    ev(`npub ${id.npub}`);
  });

  let alice = await openUser("Alice", relays, aliceVault, aliceKv);
  const bob = await openUser("Bob", relays, bobVault, new MemoryStore());
  cleanup.push(async () => {
    alice.messenger.stop();
    bob.messenger.stop();
    await alice.mesh.stop();
    await bob.mesh.stop();
  });
  const A = aliceVault.publicKey();
  const B = bobVault.publicKey();
  const SECRET = `Hi Bob, the invoice for March is coming. (${Date.now()})`;

  await step("Alice sends Bob an end-to-end encrypted private message (NIP-17)", async () => {
    const sent = await alice.messenger.send([B], { type: "text", content: SECRET });
    for (const r of sent.relays) ev(`${r.url}: ${r.ok ? "accepted" : r.message}`);
    await waitFor(() => bob.inbox.some((m) => m.content === SECRET), 15_000, "Bob to receive");
    ev(`Bob decrypted: "${SECRET}"`);
  });

  await step("The relays store only the encrypted event", async () => {
    for (const url of relays) {
      const events = await queryRelay(url, { kinds: [1059], "#p": [B], limit: 100 });
      const leaks = events.filter((e) => JSON.stringify(e).includes(SECRET) || e.pubkey === A);
      ev(`${url}: ${events.length} gift wrap(s) for Bob · kind ${[...new Set(events.map((e) => e.kind))].join(",")} · plaintext/sender leaks: ${leaks.length}`);
      assert(events.length > 0, `no events stored on ${url}`);
      assert(leaks.length === 0, `plaintext or sender key visible on ${url}`);
    }
    const sample = (await queryRelay(relayB, { kinds: [1059], "#p": [B], limit: 1 }))[0]!;
    ev(`stored content sample: ${sample.content.slice(0, 60)}…  signer: ${sample.pubkey.slice(0, 16)}… (one-time key)`);
  });

  let originalWire: ReturnType<typeof toWire>;
  await step("Alice creates an EIP-712 signed payment request (signed by her wallet)", async () => {
    const req = createPaymentRequest({ creatorPubkey: A, creatorWallet: ALICE_WALLET, chainId: 31337, token: DEMO_TOKEN_ADDRESS, recipient: ALICE_WALLET, amount: 25_000_000n, description: "March hosting", ttlSec: 3600 });
    const signature = await walletClient.signTypedData({ account: ALICE_WALLET, ...typedDataFor(req), chain: foundry } as never);
    originalWire = toWire({ request: req, signature });
    ev(`requestId ${req.requestId.slice(0, 18)}…  amount 25 rmUSD → ${req.recipient}`);
    ev(`signature ${signature.slice(0, 26)}…`);
    await alice.messenger.send([B], { type: "payment-request", content: JSON.stringify(originalWire), subject: "March hosting" });
  });

  const bobLedger = new RequestLedger(new MemoryStore());
  const bobPolicy = new ContactWalletPolicy();
  const ctx = (author: string) => ({ expectedChainId: 31337, tokens: new TokenRegistry(), policy: bobPolicy, ledger: bobLedger, messageAuthor: author });

  await step("Bob receives the payment request and verifies it", async () => {
    await waitFor(() => bob.inbox.some((m) => m.type === "payment-request"), 15_000, "request delivery");
    const msg = bob.inbox.find((m) => m.type === "payment-request")!;
    ev(`Bob confirms Alice's wallet ${ALICE_WALLET} out of band and pins it for her contact`);
    bobPolicy.pin(A, ALICE_WALLET);
    const v = await verifyPaymentRequest(msg.content, ctx(msg.from));
    for (const s of v.steps) ev(`${s.ok ? "✓" : "✗"} ${s.check}: ${s.detail}`);
    assert(v.ok, "original request should verify");
    if (v.ok) await bobLedger.register(v.signed, v.digest);
  });

  await step("A test attacker changes the recipient address", async () => {
    const tampered = JSON.parse(JSON.stringify(originalWire)) as { request: { recipient: string } };
    tampered.request.recipient = ANVIL_ACCOUNTS[3]!;
    ev(`recipient ${originalWire.request.recipient} → ${tampered.request.recipient}`);
    // The attacker could be a relay-level forwarder, a compromised group member, or a phishing contact.
    const mallory = new IdentityVault(new MemoryStore());
    await mallory.create("mallory password!!", "Mallory");
    const m = await openUser("Mallory", [relayB], mallory, new MemoryStore());
    await m.messenger.send([B], { type: "payment-request", content: JSON.stringify(tampered) });
    await waitFor(() => bob.inbox.filter((x) => x.type === "payment-request").length >= 2, 15_000, "tampered delivery");
    m.messenger.stop();
    await m.mesh.stop();
  });

  await step("Aava rejects the modified request", async () => {
    const msg = bob.inbox.filter((m) => m.type === "payment-request").at(-1)!;
    const v = await verifyPaymentRequest(msg.content, ctx(msg.from));
    assert(!v.ok, "tampered request must be rejected");
    if (!v.ok) {
      ev(`rejected: ${v.code}`);
      ev(v.reason);
    }
  });

  let txHash: Hash;
  await step("Bob explicitly approves the ORIGINAL payment with a test wallet", async () => {
    const id = originalWire.request.requestId;
    await bobLedger.approve(id, "user");
    const bobWallet: PaymentWallet = {
      account: async () => BOB_WALLET,
      chainId: async () => walletClient.getChainId(),
      transferToken: async (token, to, amount) => walletClient.writeContract({ address: token, abi: demoTokenAbi, functionName: "transfer", args: [to, amount], account: BOB_WALLET, chain: foundry }),
    };
    txHash = await executeApprovedPayment(bobLedger, id, bobWallet);
    ev(`wallet returned tx ${txHash}: NOT yet considered paid`);
  });

  await step("Aava verifies the actual blockchain receipt", async () => {
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    const report = await settlePayment(bobLedger, originalWire.request.requestId, publicClient, 1);
    for (const ch of report.checks) ev(`${ch.ok ? "✓" : "✗"} ${ch.name}: ${ch.detail}`);
    assert(report.status === "verified", `receipt status ${report.status}`);
    const entry = await bobLedger.get(originalWire.request.requestId);
    ev(`ledger state: ${entry?.state}`);
    const bal = await publicClient.readContract({ address: DEMO_TOKEN_ADDRESS, abi: demoTokenAbi, functionName: "balanceOf", args: [ALICE_WALLET] });
    ev(`Alice's wallet balance: ${formatUnitsExact(bal, 6)} rmUSD`);
  });

  await step("Relay A is deliberately shut down", async () => {
    await stopRelayA();
    await waitFor(() => !alice.mesh.openRelays().includes(alice.mesh.states().find((s) => s.url.includes(new URL(relayA).port))!.url), 15_000, "Alice to notice");
    for (const s of alice.mesh.states()) ev(`Alice sees ${s.url}: ${s.status}${s.lastError ? ` (${s.lastError})` : ""}`);
  });

  await step("Aava fails over to Relay B; Alice and Bob keep talking", async () => {
    const m1 = await alice.messenger.send([B], { type: "text", content: "Thanks Bob, payment confirmed on-chain." });
    for (const r of m1.relays) ev(`Alice → ${r.url}: ${r.ok ? "accepted" : r.message}`);
    assert(m1.status === "sent", `status ${m1.status}`);
    await waitFor(() => bob.inbox.some((m) => m.content.startsWith("Thanks Bob")), 15_000, "Bob to receive via B");
    await bob.messenger.send([A], { type: "text", content: "Got it, see you Monday." });
    await waitFor(() => alice.store.all().some((m) => m.content === "Got it, see you Monday."), 15_000, "Alice to receive via B");
    ev("both directions delivered through Relay B only");
  });

  let backup = "";
  await step("Alice exports an encrypted identity backup (NIP-49)", async () => {
    backup = JSON.stringify(createIdentityBackup(aliceVault.secretKey(), "alice backup passphrase", { label: "Alice" }));
    ev(`${backup.slice(0, 110)}…`);
    assert(!backup.includes(Buffer.from(aliceVault.secretKey()).toString("hex")), "backup leaks key");
  });

  await step("Alice's local application data is cleared", async () => {
    alice.messenger.stop();
    await alice.mesh.stop();
    await aliceVault.wipe();
    aliceKv.data.clear();
    ev(`local storage entries remaining: ${aliceKv.data.size}`);
    assert(aliceKv.data.size === 0, "storage not empty");
  });

  await step("Alice restores her identity from the backup on a fresh install", async () => {
    const freshKv = new MemoryStore();
    const fresh = new IdentityVault(freshKv);
    const id = await fresh.importSecret(restoreIdentityBackup(backup, "alice backup passphrase"), "new device password", "Alice");
    assert(id.pubkey === A, "restored a different identity");
    ev(`restored npub ${id.npub} (matches original)`);
    alice = await openUser("Alice (restored)", relays, fresh, freshKv);
    await waitFor(() => alice.store.all().some((m) => m.content === SECRET), 15_000, "history re-sync from Relay B");
    ev(`history re-synced from Relay B: ${alice.store.all().filter((m) => m.type === "text").length} message(s), including "${SECRET.slice(0, 30)}…"`);
    const probe = await probeRelay(relayA, 2000);
    ev(`Relay A reachable: ${probe.reachable ? "yes" : "no"} (restore did not depend on it)`);
  });

  for (const fn of cleanup.reverse()) await fn().catch(() => {});
  console.log(`\n${failures === 0 ? c.g + "✔ All steps passed" : c.r + `✘ ${failures} step(s) failed`}${c.x}`);
  if (DOCKER) console.log(`${c.d}Restart Relay A with: docker compose -f infra/docker-compose.yml start relay-a${c.x}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`${c.r}${(e as Error).stack}${c.x}`);
  process.exit(1);
});
