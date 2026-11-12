import type { Address, Hash, PublicClient } from "viem";
import { Relay } from "nostr-tools/relay";
import type { Filter } from "nostr-tools/filter";
import { finalizeEvent, type NostrEvent } from "nostr-tools/pure";
import {
  IdentityVault,
  createIdentityBackup,
  createRotationNotice,
  decodeNsec,
  parsePubkey,
  publicIdentity,
  restoreIdentityBackup,
  verifyIdentityBackup,
  verifyRotationNotice,
  zeroize,
  type IdentityBackupV1,
  type VaultIdentityRecord,
} from "@relaymesh/identity";
import { ConversationStore, Messenger, conversationId, type StoredMessage } from "@relaymesh/messaging";
import { RelayMesh, importRelayConfig, probeRelay, verifyOperatorManifest, type RelayProbe } from "@relaymesh/relay-mesh";
import { DEFAULT_CHAINS, TokenRegistry, verifyTokenTransfer, type ChainConfig, type VerificationReport } from "@relaymesh/chain";
import {
  ContactWalletPolicy,
  RequestLedger,
  createPaymentRequest,
  executeApprovedPayment,
  fromWire,
  settlePayment,
  toWire,
  typedDataFor,
  verifyPaymentRequest,
  type LedgerEntry,
  type VerifyResult,
} from "@relaymesh/payments";
import { runAll, runTest, OBSERVATORY_TESTS, type ObservatoryEnv, type TestResult } from "@relaymesh/observatory";
import { blobCache, kv, dumpAllStorage, wipeAllLocalData } from "./storage.ts";
import * as nip49 from "nostr-tools/nip49";
import { decryptPhrase, encryptPhrase, loadStoredPhrase, newShieldedPhrase, storePhrase } from "./shielded-keys.ts";
import { SHIELDED_CHAIN_ID, ShieldedWallet, type TornadoArtifacts, type TornadoSnapshot } from "./shielded.ts";
import { defaultSettings, isOnion, loadSettings, saveSettings, type RelaySetting, type Settings } from "./settings.ts";
import { WalletController } from "./wallet.ts";
import { gatherIceCandidates } from "./ice.ts";
import { CommunityManager } from "./communities.ts";
import { RpcRouter, type RpcRoutingSettings } from "./rpc.ts";

export type Phase = "loading" | "onboarding" | "locked" | "ready";

/** Stored on payment-request messages (annotation key "payment"). */
export interface PaymentAnnotation {
  role: "creator" | "payer";
  requestId: string;
  verdict?: "verified" | "rejected";
  code?: string;
  reason?: string;
  steps?: { check: string; ok: boolean; detail: string }[];
  /** Creator side: independent on-chain check of the payer's receipt. */
  receipt?: { txHash: string; payer: string; status: VerificationReport["status"]; checks: VerificationReport["checks"]; at: number };
}

export interface ReceiptPayload {
  type: "relaymesh.payment-receipt";
  requestId: string;
  txHash: Hash;
  payer: Address;
  chainId: number;
}

const LEDGER_KEY = (pk: string) => `relaymesh.payment-ledger.v1.${pk}`;
// Tornado proving artifacts (pinned commit of tornado-cli, the same files Kohaku's default loader uses).
const TORNADO_ARTIFACTS_BASE = "https://raw.githubusercontent.com/tornadocash/tornado-cli/378ddf8b8b92a4924037d7b64a94dbfd5a7dd6e8/build/circuits";
const TORNADO_ARTIFACTS_CACHE = "tornado-artifacts.378ddf8b";
export const SHIELDED_SERVICE_ORIGINS = ["https://raw.githubusercontent.com", "https://public.pimlico.io"];
const OBS_KEY = "relaymesh.observatory-results.v1";

export class AppRuntime {
  phase: Phase = "loading";
  settings: Settings = defaultSettings();
  identity: VaultIdentityRecord | undefined;
  readonly vault: IdentityVault;
  mesh: RelayMesh | null = null;
  store: ConversationStore | null = null;
  messenger: Messenger | null = null;
  ledger: RequestLedger | null = null;
  communities: CommunityManager | null = null;
  readonly wallet: WalletController;
  readonly rpc: RpcRouter;
  policy = new ContactWalletPolicy();
  tokens = new TokenRegistry();
  observatory: TestResult[] = [];
  observatoryRunning = false;
  lastError: string | null = null;
  /** Kohaku recovery phrase for private payments, in memory only while unlocked. */
  private shieldedPhrase: string | null = null;
  private shieldedWallet: ShieldedWallet | null = null;
  /** True when this device has a private-payments key record (encrypted). */
  shieldedConfigured = false;
  ledgerEntries: LedgerEntry[] = [];

  private version = 0;
  private readonly listeners = new Set<() => void>();
  private unsubs: (() => void)[] = [];

  constructor() {
    this.vault = new IdentityVault(kv, { autoLockMs: 15 * 60_000 });
    this.wallet = new WalletController((id) => this.rpcUrl(id));
    this.wallet.onChange(() => this.bump());
    this.rpc = new RpcRouter({
      settings: () => this.settings.rpc,
      rpcUrl: (id) => this.rpcUrl(id),
      iframeUrl: () => new URL("anon-rpc-iframe.html", location.href).toString(),
      savePin: (pin) => this.updateSettings((s) => (s.rpc.anon.pin = pin)),
      onChange: () => this.bump(),
    });
    this.vault.onChange(() => {
      if (!this.vault.isUnlocked && this.phase === "ready") this.endSession();
      this.bump();
    });
  }

  // ------------------------------------------------------------ reactivity
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = () => this.version;
  bump() {
    this.version++;
    for (const l of this.listeners) l();
  }

  // ------------------------------------------------------------- lifecycle
  async init() {
    this.settings = await loadSettings(kv);
    this.applySettingsDerived();
    const raw = await kv.get(OBS_KEY);
    if (raw) this.observatory = JSON.parse(raw) as TestResult[];
    if (await this.vault.exists()) {
      this.identity = await this.vault.activeIdentity();
      this.phase = "locked";
    } else {
      this.phase = "onboarding";
    }
    this.bump();
  }

  private applySettingsDerived() {
    this.policy = new ContactWalletPolicy(this.settings.pinnedWallets as Record<string, Address[]>);
    this.tokens = new TokenRegistry(this.settings.tokens);
  }

  async updateSettings(mut: (s: Settings) => void) {
    const next = structuredClone(this.settings);
    mut(next);
    this.settings = next;
    this.applySettingsDerived();
    await saveSettings(kv, next);
    this.bump();
  }

  rpcUrl(chainId: number): string {
    return this.settings.rpcUrls[String(chainId)] ?? DEFAULT_CHAINS.find((c) => c.id === chainId)?.rpcUrls[0] ?? "";
  }

  chain(): ChainConfig {
    const c = DEFAULT_CHAINS.find((x) => x.id === this.settings.chainId);
    return c ?? { id: this.settings.chainId, name: `Chain ${this.settings.chainId}`, rpcUrls: [this.rpcUrl(this.settings.chainId)], nativeSymbol: "ETH", testnet: true, minConfirmations: 1 };
  }

  /**
   * Client for chain reads (balances, receipt verification). Uses the user's configured RPC and
   * routing mode, independent of the wallet's own RPC. Never falls back to a weaker mode.
   */
  readClient(chainId = this.settings.chainId): Promise<PublicClient> {
    return this.rpc.client(chainId);
  }

  /** One line for the UI: how this chain's reads travel right now. */
  routeSummary(chainId = this.settings.chainId): string {
    try {
      const r = this.rpc.route(chainId);
      if (r.kind === "direct") return r.why === "direct mode" ? "Direct (the RPC provider sees your IP address)" : `Direct (${r.why})`;
      if (r.kind === "anon") return "Anonymous: through the Anon-RPC worker (Nox mixnet by default)";
      return `Verified: Helios light client via ${new URL(r.config.consensusRpc).host}`;
    } catch (e) {
      return `Unavailable: ${(e as Error).message}`;
    }
  }

  /** Changes RPC routing and restarts the worker / light clients with the new settings. */
  async updateRpcRouting(mut: (r: RpcRoutingSettings) => void) {
    await this.updateSettings((s) => mut(s.rpc));
    this.rpc.reset();
  }

  // -------------------------------------------------------------- identity
  async createIdentity(password: string, label: string) {
    await this.vault.create(password, label);
    await this.startSession();
  }

  async importNsec(nsec: string, password: string, label: string) {
    await this.vault.importSecret(decodeNsec(nsec), password, label);
    await this.startSession();
  }

  async restoreFromBackup(backupJson: string, backupPassword: string, localPassword: string) {
    const secret = restoreIdentityBackup(backupJson, backupPassword);
    const parsed = JSON.parse(backupJson) as IdentityBackupV1 & { shieldedPhrase?: string };
    await this.vault.importSecret(secret, localPassword, parsed.label ?? "Restored");
    // The private-payments phrase travels in the same backup, encrypted with the backup password.
    if (parsed.shieldedPhrase) {
      const phrase = decryptPhrase(parsed.shieldedPhrase, backupPassword);
      await storePhrase(kv, phrase, localPassword);
      this.shieldedPhrase = phrase;
      this.shieldedConfigured = true;
    }
    await this.startSession();
  }

  async unlock(password: string) {
    await this.vault.unlock(password);
    await this.loadShieldedPhrase(password);
    await this.startSession();
  }

  lock() {
    this.vault.lock();
  }

  /** Creates an encrypted backup and proves it restores before returning it. */
  exportBackup(password: string): string {
    const sk = this.vault.secretKey();
    const backup: IdentityBackupV1 & { shieldedPhrase?: string } = createIdentityBackup(sk, password, { label: this.identity?.label });
    if (!verifyIdentityBackup(backup, password, publicIdentity(sk).pubkey)) throw new Error("Backup verification failed; do not rely on this backup");
    if (this.shieldedPhrase) {
      backup.shieldedPhrase = encryptPhrase(this.shieldedPhrase, password);
      if (decryptPhrase(backup.shieldedPhrase, password) !== this.shieldedPhrase) throw new Error("Private-payments phrase backup failed verification");
    } else if (this.shieldedConfigured) {
      throw new Error("Unlock private payments first so their recovery phrase is included in the backup");
    }
    return JSON.stringify(backup, null, 2);
  }

  // ------------------------------------------------------- private payments
  /** Checks a password against the identity vault without changing state. */
  private async checkVaultPassword(password: string) {
    const active = await this.vault.activeIdentity();
    if (!active) throw new Error("No identity");
    try {
      nip49.decrypt(active.ncryptsec, password.normalize("NFKC"));
    } catch {
      throw new Error("Wrong device password");
    }
  }

  private async loadShieldedPhrase(password: string) {
    const record = await loadStoredPhrase(kv).catch(() => null);
    this.shieldedConfigured = !!record;
    if (!record) return;
    try {
      this.shieldedPhrase = decryptPhrase(record.ncryptsec, password);
    } catch {
      this.shieldedPhrase = null; // configured but locked; unlockShielded() can retry
    }
  }

  get shieldedUnlocked() {
    return !!this.shieldedPhrase;
  }

  /** Creates the separate Kohaku recovery phrase and returns it once for the user to write down. */
  async enableShielded(password: string): Promise<string> {
    await this.checkVaultPassword(password);
    if (await loadStoredPhrase(kv)) throw new Error("Private payments are already set up on this device");
    const phrase = newShieldedPhrase();
    await storePhrase(kv, phrase, password);
    this.shieldedPhrase = phrase;
    this.shieldedConfigured = true;
    this.bump();
    return phrase;
  }

  async unlockShielded(password: string) {
    const record = await loadStoredPhrase(kv);
    if (!record) throw new Error("Private payments are not set up");
    this.shieldedPhrase = decryptPhrase(record.ncryptsec, password);
    this.bump();
  }

  async revealShieldedPhrase(password: string): Promise<string> {
    const record = await loadStoredPhrase(kv);
    if (!record) throw new Error("Private payments are not set up");
    return decryptPhrase(record.ncryptsec, password);
  }

  /** Downloads (once) and caches Tornado's proving artifacts. Kohaku verifies their SHA-256 pins. */
  private async tornadoArtifacts(): Promise<TornadoArtifacts> {
    const cached = await blobCache.get<TornadoArtifacts>(TORNADO_ARTIFACTS_CACHE);
    if (cached) return cached;
    // Direct download: ~34 MB exceeds what the anonymizing worker carries per response.
    const [circuit, key] = await Promise.all([fetch(`${TORNADO_ARTIFACTS_BASE}/tornado.json`), fetch(`${TORNADO_ARTIFACTS_BASE}/tornadoProvingKey.bin`)]);
    if (!circuit.ok || !key.ok) throw new Error("Could not download the Tornado proving artifacts");
    const artifacts = { circuitText: await circuit.text(), provingKey: await key.arrayBuffer() };
    await blobCache.set(TORNADO_ARTIFACTS_CACHE, artifacts);
    return artifacts;
  }

  /** The shielded wallet, created on first use. Requires unlocked private payments. */
  shielded(): ShieldedWallet {
    if (!this.shieldedPhrase) throw new Error(this.shieldedConfigured ? "Unlock private payments first" : "Set up private payments first");
    this.shieldedWallet ??= new ShieldedWallet({
      phrase: this.shieldedPhrase,
      provider: () => this.rpc.eip1193(SHIELDED_CHAIN_ID, { needsHistoricalLogs: true }),
      serviceFetch: () => this.rpc.serviceFetch(),
      store: kv,
      artifacts: () => this.tornadoArtifacts(),
      // Public Sepolia pool state shipped with the app (see apps/web/scripts/tornado-snapshot.ts).
      snapshot: async () => {
        const res = await fetch(new URL("kohaku/tornado-sepolia-state.json", location.href));
        return res.ok ? ((await res.json()) as TornadoSnapshot) : null;
      },
      workerUrl: new URL("kohaku/state-manager.worker.js", location.href).toString(),
      sendTransaction: async (tx) => {
        if ((await this.wallet.chainId()) !== SHIELDED_CHAIN_ID) throw new Error("Switch your wallet to Sepolia first");
        return this.wallet.sendTransaction(tx, [["Action", "Tornado Cash deposit (Kohaku)"]]);
      },
      waitForReceipt: async (hash) => {
        const r = await (await this.readClient(SHIELDED_CHAIN_ID)).waitForTransactionReceipt({ hash, pollingInterval: 4_000, timeout: 600_000 });
        return { status: r.status };
      },
    });
    return this.shieldedWallet;
  }

  async rotateIdentity(password: string) {
    const contacts = this.store?.listContacts() ?? [];
    const { oldSecret, newSecret } = await this.vault.rotate(password);
    const notice = createRotationNotice(oldSecret, newSecret);
    // Notify contacts from the OLD identity so they can verify continuity.
    if (this.mesh && contacts.length) {
      const temp = new Messenger(this.mesh, new ConversationStore({ get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [] }, "tmp", () => oldSecret), () => oldSecret);
      await temp.send(contacts.map((c) => c.pubkey), { type: "key-rotation", content: JSON.stringify(notice) });
    }
    zeroize(oldSecret);
    zeroize(newSecret);
    this.endSession();
    await this.startSession();
  }

  async wipeDevice() {
    this.endSession();
    this.vault.lock();
    this.wallet.disconnect();
    await wipeAllLocalData();
    this.settings = defaultSettings();
    this.rpc.reset();
    this.applySettingsDerived();
    this.identity = undefined;
    this.observatory = [];
    this.phase = "onboarding";
    this.bump();
  }

  // --------------------------------------------------------------- session
  private relayConfigs() {
    const policy = this.settings.privacy.connectionPolicy;
    return this.settings.relays
      .filter((r) => policy !== "onion-only" || isOnion(r.url))
      .map((r) => {
        const cfg: { url: string; read: boolean; write: boolean; enabled: boolean; manifest?: ReturnType<typeof verifyOperatorManifest> } = { url: r.url, read: r.read, write: r.write, enabled: r.enabled };
        if (r.manifest) {
          try {
            cfg.manifest = verifyOperatorManifest(r.manifest, { pinnedKeys: this.settings.pinnedOperators });
          } catch {
            /* invalid manifests are shown as unverified; relay still usable if user added it manually */
          }
        }
        return cfg;
      });
  }

  async startSession() {
    this.identity = await this.vault.activeIdentity();
    const pubkey = this.identity!.pubkey;
    const outboxKey = `relaymesh.outbox.v1.${pubkey}`;
    const savedOutbox = await kv.get(outboxKey);
    this.mesh = new RelayMesh({
      relays: this.relayConfigs(),
      initialOutbox: savedOutbox ? (JSON.parse(savedOutbox) as NostrEvent[]) : [],
      persistOutbox: (events) => void kv.set(outboxKey, JSON.stringify(events.slice(-200))),
      // NIP-42: relays that serve gift wraps only to their recipient ask us to prove our key.
      auth: async (template) => finalizeEvent(template, this.vault.secretKey()),
    });
    this.store = new ConversationStore(kv, ConversationStore.keyFor(pubkey), () => this.vault.secretKey());
    await this.store.load();
    this.ledger = new RequestLedger(kv, LEDGER_KEY(pubkey));
    this.ledgerEntries = await this.ledger.list();
    this.communities = new CommunityManager(this);
    await this.communities.load();
    this.messenger = new Messenger(this.mesh, this.store, () => this.vault.secretKey(), {
      onMessage: (m) => void this.handleIncoming(m),
    });
    this.unsubs = [
      this.mesh.onChange(() => this.bump()),
      this.store.onChange(() => this.bump()),
      this.ledger.onChange(() => {
        void this.ledger?.list().then((l) => {
          this.ledgerEntries = l;
          this.bump();
        });
      }),
    ];
    this.mesh.start();
    this.messenger.start();
    this.vault.touch();
    this.phase = "ready";
    this.bump();
  }

  /** Restarts networking so connection-policy changes take effect. Local data is untouched. */
  async endAndRestart() {
    if (this.phase !== "ready") return;
    this.endSession();
    await this.startSession();
  }

  private endSession() {
    if (!this.vault.isUnlocked) {
      this.shieldedPhrase = null;
      this.shieldedWallet = null;
    }
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.messenger?.stop();
    void this.mesh?.stop();
    this.mesh = null;
    this.messenger = null;
    this.store = null;
    this.ledger = null;
    this.communities = null;
    this.ledgerEntries = [];
    this.phase = this.identity ? "locked" : "onboarding";
    this.bump();
  }

  // ------------------------------------------------------------- messaging
  async sendText(to: string[], text: string) {
    if (!this.messenger) throw new Error("Locked");
    this.vault.touch();
    return this.messenger.send(to, { type: "text", content: text });
  }

  addContact(input: string, name: string) {
    const pubkey = parsePubkey(input);
    if (pubkey === this.identity?.pubkey) throw new Error("That is your own key");
    this.store!.addContact({ pubkey, name: name.trim() || pubkey.slice(0, 8), addedAt: Date.now() });
    return pubkey;
  }

  contactName(pubkey: string): string {
    if (pubkey === this.identity?.pubkey) return "You";
    return this.store?.contact(pubkey)?.name ?? `${pubkey.slice(0, 8)}…`;
  }

  private async handleIncoming(m: StoredMessage) {
    try {
      if (m.subject === "observatory-probe") return;
      if (m.type === "payment-request" && m.direction === "in" && !m.annotations?.payment) await this.verifyIncomingRequest(m);
      if (m.type === "payment-receipt" && m.direction === "in" && !m.annotations?.receiptChecked) await this.checkReceipt(m);
      if (m.type === "key-rotation" && m.direction === "in" && !m.annotations?.rotation) this.checkRotation(m);
      if ((m.type === "community-invite" || m.type === "community-event") && this.communities) await this.communities.handle(m);
    } catch (e) {
      this.lastError = (e as Error).message;
      this.bump();
    }
  }

  private async verifyIncomingRequest(m: StoredMessage) {
    const result: VerifyResult = await verifyPaymentRequest(m.content, {
      expectedChainId: this.settings.chainId,
      tokens: this.tokens,
      policy: this.communities?.policyFor(m) ?? this.policy,
      ledger: this.ledger!,
      messageAuthor: m.from,
    });
    let requestId = "";
    try {
      requestId = fromWire(m.content).request.requestId;
    } catch {
      /* malformed */
    }
    const ann: PaymentAnnotation = { role: "payer", requestId, steps: result.steps };
    if (result.ok) {
      await this.ledger!.register(result.signed, result.digest);
      ann.verdict = "verified";
    } else {
      ann.verdict = "rejected";
      ann.code = result.code;
      ann.reason = result.reason;
      await this.ledger!.recordRejection({ requestId, code: result.code, reason: result.reason, from: m.from });
    }
    this.store!.annotate(m.id, "payment", ann);
  }

  /** Re-verifies a rejected request after the user changed trust settings (e.g. pinned a wallet). */
  async reverify(messageId: string) {
    const m = this.store?.get(messageId);
    const ann = m?.annotations?.payment as PaymentAnnotation | undefined;
    if (!m || !ann || ann.verdict !== "rejected") return;
    if (ann.code === "duplicate") throw new Error("Duplicate requests are never re-verified");
    await this.verifyIncomingRequest(m);
  }

  async pinWallet(pubkey: string, wallet: Address) {
    await this.updateSettings((s) => {
      const list = new Set(s.pinnedWallets[pubkey] ?? []);
      list.add(wallet);
      s.pinnedWallets[pubkey] = [...list];
    });
  }

  private checkRotation(m: StoredMessage) {
    try {
      const { oldPubkey, newPubkey } = verifyRotationNotice(JSON.parse(m.content));
      const ok = oldPubkey === m.from;
      this.store!.annotate(m.id, "rotation", { ok, oldPubkey, newPubkey, detail: ok ? "Signed by both the old and new key" : "Sender is not the old key" });
    } catch (e) {
      this.store!.annotate(m.id, "rotation", { ok: false, detail: (e as Error).message });
    }
  }

  async acceptRotation(messageId: string) {
    const m = this.store!.get(messageId)!;
    const r = m.annotations?.rotation as { ok: boolean; oldPubkey: string; newPubkey: string } | undefined;
    if (!r?.ok) throw new Error("Rotation notice is not valid");
    const old = this.store!.contact(r.oldPubkey);
    this.store!.addContact({ pubkey: r.newPubkey, name: old?.name ?? "Rotated contact", addedAt: Date.now(), note: `Rotated from ${r.oldPubkey.slice(0, 12)}…` });
  }

  // -------------------------------------------------------------- payments
  async createPaymentRequest(input: { to: string; token: Address; amount: bigint; description: string; ttlSec: number; communityId?: `0x${string}`; recipients?: string[] }) {
    if (!this.messenger || !this.identity) throw new Error("Locked");
    const account = await this.wallet.account();
    const walletChain = await this.wallet.chainId();
    if (walletChain !== this.settings.chainId) throw new Error(`Switch your wallet to chain ${this.settings.chainId} first`);
    const token = this.tokens.find(this.settings.chainId, input.token);
    if (!token) throw new Error("Token is not in your allowlist");
    const req = createPaymentRequest({
      creatorPubkey: this.identity.pubkey,
      creatorWallet: account,
      chainId: this.settings.chainId,
      token: token.address,
      recipient: account,
      amount: input.amount,
      description: input.description,
      ttlSec: input.ttlSec,
      ...(input.communityId ? { communityId: input.communityId } : {}),
    });
    const signature = await this.wallet.signPaymentRequest(typedDataFor(req), [
      ["Token", `${token.symbol} ${token.address}`],
      ["Amount (base units)", req.amount.toString()],
      ["Pay to", req.recipient],
      ["Chain", String(req.chainId)],
      ["Expires", new Date(req.expiresAt * 1000).toISOString()],
    ]);
    const content = JSON.stringify(toWire({ request: req, signature }));
    const sent = await this.messenger.send(input.recipients ?? [input.to], { type: "payment-request", content, subject: input.description || "Payment request" });
    this.store!.annotate(sent.id, "payment", { role: "creator", requestId: req.requestId } satisfies PaymentAnnotation);
    return sent;
  }

  /** Explicit user approval → wallet prompt → on-chain verification → receipt to creator. */
  async approveAndPay(messageId: string, onStage?: (s: string) => void) {
    const m = this.store!.get(messageId);
    const ann = m?.annotations?.payment as PaymentAnnotation | undefined;
    if (!m || !ann || ann.verdict !== "verified") throw new Error("Only verified requests can be paid");
    const ledger = this.ledger!;
    let entry = await ledger.get(ann.requestId);
    if (entry?.state === "verified") {
      onStage?.("Recording your approval");
      entry = await ledger.approve(ann.requestId, "user");
    }
    if (entry?.state === "approved") {
      onStage?.("Waiting for your wallet to confirm the transfer");
      await executeApprovedPayment(ledger, ann.requestId, this.wallet);
    }
    onStage?.("Verifying the transaction receipt on-chain");
    const report = await this.waitForSettlement(ann.requestId);
    if (report.status === "verified") {
      const e = (await ledger.get(ann.requestId))!;
      const receipt: ReceiptPayload = { type: "relaymesh.payment-receipt", requestId: ann.requestId, txHash: e.txHash!, payer: e.payer!, chainId: this.settings.chainId };
      onStage?.("Sending receipt to the requester");
      await this.messenger!.send([m.from], { type: "payment-receipt", content: JSON.stringify(receipt), replyTo: m.id });
    }
    return report;
  }

  async waitForSettlement(requestId: string): Promise<VerificationReport> {
    const required = this.chain().minConfirmations;
    const { intervalMs, tries } = this.rpc.settlementPolicy(this.settings.chainId);
    let report: VerificationReport | null = null;
    for (let i = 0; i < tries; i++) {
      report = await settlePayment(this.ledger!, requestId, await this.readClient(), required);
      if (report.status !== "pending") return report;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return report!;
  }

  async declineRequest(messageId: string) {
    const ann = this.store!.get(messageId)?.annotations?.payment as PaymentAnnotation | undefined;
    if (!ann) return;
    await this.ledger!.decline(ann.requestId);
  }

  /** Creator side: independently verifies the payer's claimed transaction on-chain. */
  private async checkReceipt(m: StoredMessage) {
    this.store!.annotate(m.id, "receiptChecked", true);
    let receipt: ReceiptPayload;
    try {
      receipt = JSON.parse(m.content) as ReceiptPayload;
    } catch {
      return;
    }
    const original = this.store!.all().find((x) => x.direction === "out" && (x.annotations?.payment as PaymentAnnotation | undefined)?.requestId === receipt.requestId);
    if (!original) return;
    const { request } = fromWire(original.content);
    const report = await verifyTokenTransfer(
      await this.readClient(request.chainId),
      receipt.txHash,
      { chainId: request.chainId, token: request.token, from: receipt.payer, to: request.recipient, amount: request.amount },
      this.chain().minConfirmations,
    );
    const ann = original.annotations!.payment as PaymentAnnotation;
    this.store!.annotate(original.id, "payment", { ...ann, receipt: { txHash: receipt.txHash, payer: receipt.payer, status: report.status, checks: report.checks, at: Date.now() } });
  }

  // ---------------------------------------------------------------- relays
  async addRelay(url: string, manifest?: unknown) {
    const normalized = url.trim();
    if (this.settings.relays.some((r) => r.url === normalized)) throw new Error("Relay already configured");
    const verified = manifest ? verifyOperatorManifest(manifest, { pinnedKeys: this.settings.pinnedOperators }) : undefined;
    if (verified && verified.manifest.relayUrl !== normalized) throw new Error("Manifest is for a different relay URL");
    await this.updateSettings((s) => {
      const r: RelaySetting = { url: normalized, read: true, write: true, enabled: true };
      if (manifest) r.manifest = manifest;
      s.relays.push(r);
      if (verified) s.pinnedOperators[verified.manifest.operator.id] = verified.manifest.publicKey;
    });
    this.mesh?.addRelay({ url: normalized, ...(verified ? { manifest: verified } : {}) });
  }

  async removeRelay(url: string) {
    await this.updateSettings((s) => (s.relays = s.relays.filter((r) => r.url !== url)));
    this.mesh?.removeRelay(url);
  }

  async setRelayEnabled(url: string, enabled: boolean) {
    await this.updateSettings((s) => {
      const r = s.relays.find((x) => x.url === url);
      if (r) r.enabled = enabled;
    });
    this.mesh?.setEnabled(url, enabled);
  }

  async importRelayBundle(json: string) {
    const imported = importRelayConfig(json, { pinnedKeys: this.settings.pinnedOperators });
    let added = 0;
    for (const r of imported.relays) {
      if (this.settings.relays.some((x) => x.url === r.url)) continue;
      await this.addRelay(r.url, r.manifest?.event);
      added++;
    }
    return { added, rejected: imported.rejectedManifests };
  }

  exportRelayBundle(): string {
    return JSON.stringify(
      {
        format: "relaymesh.relay-config",
        v: 1,
        relays: this.settings.relays.map((r) => ({ url: r.url, read: r.read, write: r.write })),
        manifests: this.settings.relays.filter((r) => r.manifest).map((r) => r.manifest),
      },
      null,
      2,
    );
  }

  probe(url: string): Promise<RelayProbe> {
    return probeRelay(url);
  }

  /** Raw single-relay query: the operator's (or any reader's) view of stored events. */
  async queryRelay(url: string, filter: Filter, timeoutMs = 5_000): Promise<NostrEvent[]> {
    const relay = new Relay(url, { enablePing: false, enableReconnect: false });
    await relay.connect({ timeout: timeoutMs });
    const events: NostrEvent[] = [];
    const query = () =>
      new Promise<string | undefined>((resolve) => {
        const t = setTimeout(() => resolve(undefined), timeoutMs);
        const sub = relay.subscribe([filter], {
          onevent: (e) => events.push(e),
          oneose: () => {
            clearTimeout(t);
            resolve(undefined);
            sub.close();
          },
          onclose: (reason) => {
            clearTimeout(t);
            resolve(reason);
          },
        });
      });
    const closed = await query();
    // NIP-42 relays serve gift wraps only to their recipient: authenticate as ourselves and retry once.
    if (closed?.startsWith("auth-required") && this.vault.isUnlocked) {
      for (let i = 0; i < 20; i++) {
        try {
          await relay.auth(async (t) => finalizeEvent(t, this.vault.secretKey()));
          await query();
          break;
        } catch (e) {
          if (!/no challenge/.test(String(e))) break;
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    }
    relay.close();
    return events;
  }

  // ------------------------------------------------------------- observatory
  observatoryEnv(): ObservatoryEnv {
    const env: ObservatoryEnv = {
      storageDump: dumpAllStorage,
      networkEntries: () => performance.getEntriesByType("resource").map((e) => ({ url: e.name, kind: (e as PerformanceResourceTiming).initiatorType, startTime: e.startTime })),
      allowedOrigins: () => [
        location.origin,
        ...this.settings.relays.map((r) => r.url),
        ...this.settings.relays.map((r) => r.url.replace(/^ws(s?):/, "http$1:")),
        ...Object.values(this.settings.rpcUrls),
        ...this.rpc.knownOrigins(),
        ...(this.shieldedConfigured ? SHIELDED_SERVICE_ORIGINS : []),
      ],
      rpcRouting: () => ({
        mode: this.rpc.mode,
        anonymizedOrigins: this.rpc.anonymizedOrigins(Object.keys(this.settings.rpcUrls).map(Number)),
        since: this.rpc.since,
        detail: this.rpc.describe(),
      }),
      privacy: { relayOnlyWebRTC: this.settings.privacy.relayOnlyWebRTC, turnServers: this.settings.privacy.turnServers },
      wallet: async () => ({
        connected: this.wallet.state.kind !== "none",
        kind: this.wallet.state.kind,
        account: this.wallet.state.account,
        chainId: this.wallet.state.kind !== "none" ? await this.wallet.chainId().catch(() => undefined) : undefined,
        expectedChainId: this.settings.chainId,
      }),
      release: { manifestUrl: new URL("release.json", location.href).toString(), fetch: window.fetch.bind(window) },
      queryRelay: (url, filter, t) => this.queryRelay(url, filter, t),
    };
    if (typeof RTCPeerConnection !== "undefined") env.iceProbe = gatherIceCandidates;
    if (this.vault.isUnlocked && this.identity) {
      env.identity = { secretKey: () => this.vault.secretKey(), pubkey: this.identity.pubkey, npub: this.identity.npub };
    }
    if (this.mesh) env.mesh = this.mesh;
    return env;
  }

  async runObservatory(onlyId?: string) {
    this.observatoryRunning = true;
    this.bump();
    try {
      const env = this.observatoryEnv();
      if (onlyId) {
        const test = OBSERVATORY_TESTS.find((t) => t.id === onlyId);
        if (!test) return;
        const r = await runTest(test, env);
        this.observatory = [...this.observatory.filter((x) => x.id !== onlyId), r].sort((a, b) => a.id.localeCompare(b.id));
      } else {
        this.observatory = [];
        await runAll(env, OBSERVATORY_TESTS, (r) => {
          this.observatory = [...this.observatory, r];
          this.bump();
        });
      }
      await kv.set(OBS_KEY, JSON.stringify(this.observatory));
    } finally {
      this.observatoryRunning = false;
      this.bump();
    }
  }

  // ------------------------------------------------------------- utilities
  conversationWith(pubkey: string) {
    return conversationId([this.identity!.pubkey, pubkey]);
  }
}

export const runtime = new AppRuntime();
