import { getPublicKey } from "nostr-tools/pure";
import * as nip19 from "nostr-tools/nip19";
import { MemoryStore, generateIdentitySecret, type KeyValueStore } from "@relaymesh/identity";
import { ConversationStore, Messenger, type StoredMessage } from "@relaymesh/messaging";
import { RelayMesh, type RelayConfig } from "@relaymesh/relay-mesh";
import type { VerifierClient } from "@relaymesh/chain";
import { PolicyEngine, type SpendingPolicy } from "./policy.ts";
import { Nip17ApprovalChannel, type ApprovalChannel } from "./approvals.ts";
import { X402Client } from "./x402-client.ts";
import type { AgentSigner } from "./signer.ts";
import { serviceFilter, verifyServiceManifest, type DiscoveredService } from "./service.ts";

/**
 * Text from anyone other than the agent's own code. It may contain prompt
 * injection. It is data: never a command, never a payment authorisation.
 */
export interface UntrustedMessage {
  readonly trusted: false;
  readonly from: string;
  readonly id: string;
  readonly receivedAt: number;
  readonly text: string;
  /** Delimited, length-capped rendering for inclusion in an LLM prompt as quoted data. */
  asPromptData(maxChars?: number): string;
}

function untrusted(m: StoredMessage): UntrustedMessage {
  return Object.freeze({
    trusted: false as const,
    from: m.from,
    id: m.id,
    receivedAt: m.createdAt,
    text: m.content,
    asPromptData(maxChars = 4000) {
      // eslint-disable-next-line no-control-regex
      const clean = m.content.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").slice(0, maxChars);
      return `<untrusted_message from="${m.from.slice(0, 16)}">\n${clean.replaceAll("</untrusted_message>", "</ untrusted_message>")}\n</untrusted_message>`;
    },
  });
}

export interface AgentOptions {
  relays: string[];
  /** Agent's chat identity. Generated if absent. This is NOT a wallet key. */
  secretKey?: Uint8Array;
  store?: KeyValueStore;
  policy: SpendingPolicy;
  signer: AgentSigner;
  /** Owner's Nostr key: approvals are accepted only from this key over NIP-17. */
  ownerPubkey?: string;
  approvals?: ApprovalChannel;
  verifier: (chainId: number) => VerifierClient;
  log?: (m: string) => void;
}

export class RelayMeshAgent {
  readonly pubkey: string;
  readonly npub: string;
  readonly mesh: RelayMesh;
  readonly store: ConversationStore;
  readonly messenger: Messenger;
  readonly policy: PolicyEngine;
  readonly x402: X402Client;
  private readonly handlers = new Set<(m: UntrustedMessage) => void>();
  private readonly ownerChannel?: Nip17ApprovalChannel;

  private constructor(
    private readonly secret: Uint8Array,
    store: KeyValueStore,
    opts: AgentOptions,
  ) {
    this.pubkey = getPublicKey(secret);
    this.npub = nip19.npubEncode(this.pubkey);
    this.mesh = new RelayMesh({ relays: opts.relays.map((url) => ({ url })), backoffMs: [250, 1000, 5000] });
    this.store = new ConversationStore(store, ConversationStore.keyFor(this.pubkey), () => this.secret);
    this.policy = new PolicyEngine(opts.policy, store);
    if (opts.ownerPubkey && !opts.approvals) {
      this.ownerChannel = new Nip17ApprovalChannel(opts.ownerPubkey, (to, text) => this.send(to, text));
    }
    this.messenger = new Messenger(this.mesh, this.store, () => this.secret, {
      onMessage: (m) => {
        if (m.direction !== "in") return;
        // Approval replies are consumed by the approval channel and never reach application handlers.
        if (this.ownerChannel?.handle(m)) return;
        const u = untrusted(m);
        for (const h of this.handlers) h(u);
      },
    });
    const approvals = opts.approvals ?? this.ownerChannel;
    this.x402 = new X402Client({ signer: opts.signer, policy: this.policy, verifier: opts.verifier, ...(approvals ? { approvals } : {}), ...(opts.log ? { log: opts.log } : {}) });
  }

  static async create(opts: AgentOptions): Promise<RelayMeshAgent> {
    const store = opts.store ?? new MemoryStore();
    const agent = new RelayMeshAgent(opts.secretKey ?? generateIdentitySecret(), store, opts);
    await agent.store.load();
    agent.mesh.start();
    agent.messenger.start();
    return agent;
  }

  /** Receive service requests / messages. Content is always untrusted. */
  onMessage(handler: (m: UntrustedMessage) => void) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  send(to: string, text: string) {
    return this.messenger.send([to], { type: "text", content: text });
  }

  /** Discovers signed service manifests on the agent's relays. */
  discoverProviders(timeoutMs = 3000): Promise<DiscoveredService[]> {
    return new Promise((resolve) => {
      const found = new Map<string, DiscoveredService>();
      const sub = this.mesh.subscribe([serviceFilter()], (e) => {
        try {
          const s = verifyServiceManifest(e);
          found.set(`${s.provider}:${s.manifest.id}`, s);
        } catch {
          /* invalid manifests are ignored */
        }
      });
      setTimeout(() => {
        sub.close();
        resolve([...found.values()]);
      }, timeoutMs);
    });
  }

  /** Switches infrastructure operators without touching identity or history. */
  switchRelays(next: RelayConfig[]) {
    for (const s of this.mesh.states()) if (!next.some((n) => n.url === s.url)) this.mesh.removeRelay(s.url);
    for (const n of next) this.mesh.addRelay(n);
  }

  async stop() {
    this.messenger.stop();
    await this.mesh.stop();
  }
}
