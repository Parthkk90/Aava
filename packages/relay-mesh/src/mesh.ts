import { Relay } from "nostr-tools/relay";
import type { Filter } from "nostr-tools/filter";
import type { EventTemplate, NostrEvent, VerifiedEvent } from "nostr-tools/pure";
import type { VerifiedManifest } from "./manifest.ts";

export type RelayStatus = "idle" | "connecting" | "open" | "backoff" | "disabled";

export interface RelayConfig {
  url: string;
  read?: boolean;
  write?: boolean;
  enabled?: boolean;
  manifest?: VerifiedManifest;
}

export interface RelayState {
  url: string;
  status: RelayStatus;
  read: boolean;
  write: boolean;
  attempts: number;
  lastError?: string;
  lastConnectedAt?: number;
  lastDisconnectedAt?: number;
  connectLatencyMs?: number;
  lastPublishLatencyMs?: number;
  nextRetryAt?: number;
  eventsReceived: number;
  publishesAccepted: number;
  publishesRejected: number;
  /** True once this connection answered the relay's NIP-42 challenge. */
  authenticated?: boolean;
  manifest?: VerifiedManifest;
}

export interface PublishOutcome {
  url: string;
  ok: boolean;
  message: string;
  latencyMs?: number;
}

export interface PublishResult {
  eventId: string;
  outcomes: PublishOutcome[];
  /** True when no relay accepted the event yet; it stays in the local outbox. */
  queued: boolean;
}

export interface MeshSubscription {
  close(): void;
}

export interface RelayMeshOptions {
  relays: RelayConfig[];
  /** Backoff schedule in ms; the last value repeats. */
  backoffMs?: number[];
  connectTimeoutMs?: number;
  publishTimeoutMs?: number;
  /** Outbox restored from local storage after a restart. */
  initialOutbox?: NostrEvent[];
  persistOutbox?: (events: NostrEvent[]) => void;
  maxOutbox?: number;
  log?: (msg: string) => void;
  /**
   * NIP-42 signer. Relays that serve gift wraps only to their recipient (e.g. relay.damus.io)
   * answer "auth-required"; the mesh then authenticates with this signer and retries once.
   * Authenticating tells the relay which key you are, which a relay you read from already
   * learns from your subscription filter.
   */
  auth?: (template: EventTemplate) => Promise<VerifiedEvent>;
}

interface Internal {
  state: RelayState;
  relay: Relay | null;
  timer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
}

interface OutboxEntry {
  event: NostrEvent;
  ackedBy: Set<string>;
}

interface MeshSub {
  filters: Filter[];
  onevent: (e: NostrEvent, relayUrl: string) => void;
  oneose?: (relayUrl: string) => void;
  seen: Set<string>;
  perRelay: Map<string, { close(): void }>;
}

const DEFAULT_BACKOFF = [500, 1_000, 2_000, 5_000, 10_000, 30_000];

/**
 * Manages connections to many independently operated relays.
 *
 * - Publishes every event to all writable relays and records per-relay OK results.
 * - Keeps events in a local outbox until at least one relay accepts them, and
 *   backfills relays that reconnect later (redundancy healing).
 * - Subscriptions are mirrored on every readable relay and deduplicated by id,
 *   so losing one relay does not lose the conversation.
 * - Identities and message history never depend on relays: they are local.
 */
export class RelayMesh {
  private readonly relays = new Map<string, Internal>();
  private readonly subs = new Map<number, MeshSub>();
  private readonly outbox = new Map<string, OutboxEntry>();
  private readonly listeners = new Set<() => void>();
  private subCounter = 0;
  private started = false;
  private readonly log: (m: string) => void;

  constructor(private readonly opts: RelayMeshOptions) {
    this.log = opts.log ?? (() => {});
    for (const cfg of opts.relays) this.addRelay(cfg, false);
    for (const e of opts.initialOutbox ?? []) this.outbox.set(e.id, { event: e, ackedBy: new Set() });
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    for (const l of this.listeners) l();
  }

  states(): RelayState[] {
    return [...this.relays.values()].map((r) => ({ ...r.state }));
  }

  openRelays(): string[] {
    return [...this.relays.values()].filter((r) => r.state.status === "open").map((r) => r.state.url);
  }

  pendingOutbox(): NostrEvent[] {
    return [...this.outbox.values()].filter((o) => o.ackedBy.size === 0).map((o) => o.event);
  }

  start() {
    this.started = true;
    for (const r of this.relays.values()) if (r.state.status !== "disabled") this.connect(r);
  }

  async stop() {
    this.started = false;
    for (const r of this.relays.values()) this.teardown(r, "idle");
    this.emit();
  }

  addRelay(cfg: RelayConfig, connectNow = true) {
    const url = normalizeRelayUrl(cfg.url);
    if (this.relays.has(url)) return;
    const state: RelayState = {
      url,
      status: cfg.enabled === false ? "disabled" : "idle",
      read: cfg.read ?? true,
      write: cfg.write ?? true,
      attempts: 0,
      eventsReceived: 0,
      publishesAccepted: 0,
      publishesRejected: 0,
    };
    if (cfg.manifest) state.manifest = cfg.manifest;
    const internal: Internal = { state, relay: null, timer: null, stopped: false };
    this.relays.set(url, internal);
    if (connectNow && this.started && state.status !== "disabled") this.connect(internal);
    this.emit();
  }

  removeRelay(url: string) {
    const r = this.relays.get(normalizeRelayUrl(url));
    if (!r) return;
    this.teardown(r, "idle");
    r.stopped = true;
    this.relays.delete(r.state.url);
    for (const s of this.subs.values()) s.perRelay.delete(r.state.url);
    this.emit();
  }

  setEnabled(url: string, enabled: boolean) {
    const r = this.relays.get(normalizeRelayUrl(url));
    if (!r) return;
    if (!enabled) {
      this.teardown(r, "disabled");
    } else if (r.state.status === "disabled") {
      r.state.status = "idle";
      r.state.attempts = 0;
      if (this.started) this.connect(r);
    }
    this.emit();
  }

  /** Forces an immediate reconnection attempt (user "retry" action). */
  retry(url: string) {
    const r = this.relays.get(normalizeRelayUrl(url));
    if (!r || r.state.status === "disabled") return;
    if (r.timer) clearTimeout(r.timer);
    r.timer = null;
    r.state.attempts = 0;
    this.connect(r);
  }

  private teardown(r: Internal, status: RelayStatus) {
    if (r.timer) clearTimeout(r.timer);
    r.timer = null;
    const relay = r.relay;
    r.relay = null;
    if (relay) {
      relay.onclose = null;
      try {
        relay.close();
      } catch {
        /* already closed */
      }
    }
    for (const s of this.subs.values()) s.perRelay.delete(r.state.url);
    r.state.status = status;
    delete r.state.nextRetryAt;
  }

  private async connect(r: Internal) {
    if (r.state.status === "connecting" || r.state.status === "open" || r.state.status === "disabled") return;
    r.state.status = "connecting";
    this.emit();
    const started = performance.now();
    const relay = new Relay(r.state.url, { enablePing: false, enableReconnect: false });
    relay.publishTimeout = this.opts.publishTimeoutMs ?? 6_000;
    // Answer the relay's AUTH challenge as soon as it arrives (NIP-42).
    if (this.opts.auth) relay.onauth = this.opts.auth;
    try {
      await relay.connect({ timeout: this.opts.connectTimeoutMs ?? 5_000 });
    } catch (e) {
      try {
        relay.close();
      } catch {
        /* ignore */
      }
      if (r.state.status !== "connecting" || !this.relays.has(r.state.url)) return;
      this.scheduleRetry(r, errorMessage(e));
      return;
    }
    if (r.state.status !== "connecting" || !this.relays.has(r.state.url)) {
      relay.close();
      return;
    }
    r.relay = relay;
    r.state.status = "open";
    r.state.attempts = 0;
    r.state.connectLatencyMs = Math.round(performance.now() - started);
    r.state.lastConnectedAt = Date.now();
    delete r.state.lastError;
    delete r.state.nextRetryAt;
    this.log(`relay open ${r.state.url} (${r.state.connectLatencyMs} ms)`);
    relay.onclose = () => {
      if (r.relay !== relay) return;
      r.relay = null;
      r.state.authenticated = false;
      r.state.lastDisconnectedAt = Date.now();
      for (const s of this.subs.values()) s.perRelay.delete(r.state.url);
      this.log(`relay closed ${r.state.url}`);
      if (this.started && r.state.status !== "disabled") this.scheduleRetry(r, "connection closed");
      else r.state.status = "idle";
    };
    if (r.state.read) for (const [, s] of this.subs) this.openSubOn(r, s);
    this.emit();
    void this.flushOutboxTo(r);
  }

  private scheduleRetry(r: Internal, error: string) {
    const schedule = this.opts.backoffMs ?? DEFAULT_BACKOFF;
    const delay = schedule[Math.min(r.state.attempts, schedule.length - 1)] ?? 30_000;
    r.state.attempts += 1;
    r.state.status = "backoff";
    r.state.lastError = error;
    r.state.nextRetryAt = Date.now() + delay;
    this.log(`relay ${r.state.url} failed (${error}); retry in ${delay} ms`);
    if (r.timer) clearTimeout(r.timer);
    r.timer = setTimeout(() => {
      r.timer = null;
      if (this.started && r.state.status === "backoff") this.connect(r);
    }, delay);
    this.emit();
  }

  private openSubOn(r: Internal, s: MeshSub, afterAuth = false) {
    if (!r.relay || s.perRelay.has(r.state.url)) return;
    const url = r.state.url;
    const relay = r.relay;
    const sub = relay.subscribe(s.filters, {
      onevent: (e) => {
        r.state.eventsReceived += 1;
        if (s.seen.has(e.id)) return;
        s.seen.add(e.id);
        s.onevent(e, url);
      },
      oneose: () => s.oneose?.(url),
      onclose: (reason) => {
        if (s.perRelay.get(url) !== sub) return;
        s.perRelay.delete(url);
        if (!reason.startsWith("auth-required") || afterAuth || !this.opts.auth) {
          if (reason && reason !== "closed by caller") this.log(`subscription on ${url} closed: ${reason}`);
          return;
        }
        void this.authenticate(r, relay).then((ok) => {
          if (ok && r.relay === relay && [...this.subs.values()].includes(s)) this.openSubOn(r, s, true);
        });
      },
    });
    s.perRelay.set(url, sub);
  }

  /** NIP-42: answers the relay's challenge with the configured signer. Waits briefly for a challenge. */
  private async authenticate(r: Internal, relay: Relay): Promise<boolean> {
    if (!this.opts.auth) return false;
    for (let attempt = 0; ; attempt++) {
      try {
        await relay.auth(this.opts.auth);
        r.state.authenticated = true;
        this.emit();
        return true;
      } catch (e) {
        // The challenge may still be in flight; nostr-tools throws until it has one.
        if (/no challenge/.test(errorMessage(e)) && attempt < 20) {
          await new Promise((res) => setTimeout(res, 100));
          continue;
        }
        this.log(`auth on ${r.state.url} failed: ${errorMessage(e)}`);
        return false;
      }
    }
  }

  /** Subscribes on every readable relay; events are deduplicated by id. */
  subscribe(filters: Filter[], onevent: (e: NostrEvent, relayUrl: string) => void, oneose?: (relayUrl: string) => void): MeshSubscription {
    const id = ++this.subCounter;
    const s: MeshSub = { filters, onevent, seen: new Set(), perRelay: new Map() };
    if (oneose) s.oneose = oneose;
    this.subs.set(id, s);
    for (const r of this.relays.values()) if (r.state.status === "open" && r.state.read) this.openSubOn(r, s);
    return {
      close: () => {
        for (const sub of s.perRelay.values()) sub.close();
        this.subs.delete(id);
      },
    };
  }

  /** Publishes to every writable open relay. Never throws for relay failures. */
  async publish(event: NostrEvent): Promise<PublishResult> {
    const entry = this.outbox.get(event.id) ?? { event, ackedBy: new Set<string>() };
    this.outbox.set(event.id, entry);
    this.trimOutbox();
    const targets = [...this.relays.values()].filter((r) => r.state.status === "open" && r.state.write && r.relay);
    const outcomes = await Promise.all(targets.map((r) => this.publishTo(r, entry)));
    for (const r of this.relays.values()) {
      if (r.state.write && r.state.status !== "open" && r.state.status !== "disabled") {
        outcomes.push({ url: r.state.url, ok: false, message: `not connected (${r.state.status}); queued for backfill` });
      }
    }
    this.persist();
    this.emit();
    return { eventId: event.id, outcomes, queued: entry.ackedBy.size === 0 };
  }

  private async publishTo(r: Internal, entry: OutboxEntry): Promise<PublishOutcome> {
    const url = r.state.url;
    const relay = r.relay;
    if (!relay) return { url, ok: false, message: "not connected" };
    const t0 = performance.now();
    try {
      let message: string;
      try {
        message = await relay.publish(entry.event);
      } catch (e) {
        if (!errorMessage(e).startsWith("auth-required") || !(await this.authenticate(r, relay))) throw e;
        message = await relay.publish(entry.event);
      }
      const latencyMs = Math.round(performance.now() - t0);
      entry.ackedBy.add(url);
      r.state.publishesAccepted += 1;
      r.state.lastPublishLatencyMs = latencyMs;
      return { url, ok: true, message, latencyMs };
    } catch (e) {
      const message = errorMessage(e);
      // A duplicate means the relay already stores the event: treat as accepted.
      if (message.startsWith("duplicate")) {
        entry.ackedBy.add(url);
        return { url, ok: true, message };
      }
      r.state.publishesRejected += 1;
      return { url, ok: false, message };
    }
  }

  private async flushOutboxTo(r: Internal) {
    if (!r.state.write) return;
    const pending = [...this.outbox.values()].filter((o) => !o.ackedBy.has(r.state.url));
    if (pending.length === 0) return;
    this.log(`backfilling ${pending.length} event(s) to ${r.state.url}`);
    for (const entry of pending) {
      if (r.state.status !== "open") break;
      await this.publishTo(r, entry);
    }
    this.persist();
    this.emit();
  }

  private trimOutbox() {
    const max = this.opts.maxOutbox ?? 500;
    while (this.outbox.size > max) {
      const first = this.outbox.keys().next().value;
      if (first === undefined) break;
      this.outbox.delete(first);
    }
  }

  private persist() {
    this.opts.persistOutbox?.([...this.outbox.values()].map((o) => o.event));
  }
}

export function normalizeRelayUrl(url: string): string {
  const u = new URL(url.trim());
  if (u.protocol !== "ws:" && u.protocol !== "wss:") throw new Error("Relay URL must use ws:// or wss://");
  let s = u.toString();
  if (s.endsWith("/") && u.pathname === "/") s = s.slice(0, -1);
  return s;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface RelayProbe {
  url: string;
  reachable: boolean;
  latencyMs?: number;
  error?: string;
  info?: Nip11Info;
  infoError?: string;
}

export interface Nip11Info {
  name?: string;
  description?: string;
  pubkey?: string;
  software?: string;
  version?: string;
  supported_nips?: number[];
  limitation?: Record<string, unknown>;
}

/** Fetches the NIP-11 relay information document. */
export async function fetchRelayInfo(url: string, timeoutMs = 4_000): Promise<Nip11Info> {
  const http = url.replace(/^ws(s?):\/\//, "http$1://");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(http, { headers: { accept: "application/nostr+json" }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as unknown;
    if (!body || typeof body !== "object") throw new Error("NIP-11 document is not an object");
    return body as Nip11Info;
  } finally {
    clearTimeout(t);
  }
}

/** Verifies connectivity: opens a WebSocket, measures latency, fetches NIP-11. */
export async function probeRelay(url: string, timeoutMs = 5_000): Promise<RelayProbe> {
  const normalized = normalizeRelayUrl(url);
  const result: RelayProbe = { url: normalized, reachable: false };
  const t0 = performance.now();
  const relay = new Relay(normalized, { enablePing: false, enableReconnect: false });
  try {
    await relay.connect({ timeout: timeoutMs });
    result.reachable = true;
    result.latencyMs = Math.round(performance.now() - t0);
  } catch (e) {
    result.error = errorMessage(e);
  } finally {
    try {
      relay.close();
    } catch {
      /* ignore */
    }
  }
  try {
    result.info = await fetchRelayInfo(normalized, timeoutMs);
  } catch (e) {
    result.infoError = errorMessage(e);
  }
  return result;
}
