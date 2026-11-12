import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { WebSocketServer, type WebSocket } from "ws";
import { verifyEvent, type NostrEvent } from "nostr-tools/pure";
import { matchFilters, type Filter } from "nostr-tools/filter";

/**
 * Aava reference relay: a small NIP-01 relay intended for demos, tests,
 * and as readable operator software. It is deliberately simple. Production
 * operators can run any NIP-01 relay (nostr-rs-relay, strfry, ...) instead.
 *
 * Implements: NIP-01 (EVENT/REQ/CLOSE/EOSE/OK/CLOSED/NOTICE), NIP-11 info,
 * signature verification on every event, replaceable / addressable events,
 * ephemeral events, per-connection rate limiting and size limits, and optional
 * NIP-42 protection of gift wraps (kind 1059 served only to their recipient).
 */
export interface RelayOptions {
  port: number;
  host?: string;
  name?: string;
  description?: string;
  /** Optional JSONL file for persistence. */
  dataFile?: string;
  maxEventBytes?: number;
  maxSubscriptions?: number;
  /** Events accepted per connection per minute. */
  eventsPerMinute?: number;
  operatorPubkey?: string;
  /**
   * NIP-42: serve gift wraps (kind 1059) only to connections authenticated as their `p`
   * recipient. Other readers get CLOSED "auth-required". Hides who receives messages from
   * anyone who merely connects. Off by default for compatibility.
   */
  protectGiftWraps?: boolean;
  /** Public wss:// URL when behind a proxy; NIP-42 auth events must name it. Defaults to matching the port. */
  publicUrl?: string;
  log?: (msg: string) => void;
}

export interface RunningRelay {
  url: string;
  port: number;
  /** Snapshot of stored events (operator's view of the data). */
  storedEvents(): NostrEvent[];
  close(): Promise<void>;
}

interface Conn {
  ws: WebSocket;
  challenge: string;
  /** Pubkeys this connection proved control of (NIP-42). */
  authed: Set<string>;
  subs: Map<string, Filter[]>;
  tokens: number;
  lastRefill: number;
}

const SOFTWARE = "relaymesh-reference-relay";
const VERSION = "0.1.0";

function isReplaceable(kind: number) {
  return kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000);
}
function isAddressable(kind: number) {
  return kind >= 30000 && kind < 40000;
}
function isEphemeral(kind: number) {
  return kind >= 20000 && kind < 30000;
}
function dTag(e: NostrEvent) {
  return e.tags.find((t) => t[0] === "d")?.[1] ?? "";
}

function looksLikeEvent(e: unknown): e is NostrEvent {
  if (!e || typeof e !== "object") return false;
  const o = e as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.pubkey === "string" &&
    typeof o.sig === "string" &&
    typeof o.kind === "number" &&
    Number.isInteger(o.kind) &&
    typeof o.created_at === "number" &&
    typeof o.content === "string" &&
    Array.isArray(o.tags) &&
    o.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === "string"))
  );
}

export function startRelay(opts: RelayOptions): Promise<RunningRelay> {
  const log = opts.log ?? (() => {});
  const maxEventBytes = opts.maxEventBytes ?? 128 * 1024;
  const maxSubs = opts.maxSubscriptions ?? 32;
  const perMinute = opts.eventsPerMinute ?? 120;
  const events: NostrEvent[] = [];
  const ids = new Set<string>();
  const conns = new Set<Conn>();

  if (opts.dataFile && existsSync(opts.dataFile)) {
    for (const line of readFileSync(opts.dataFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as NostrEvent;
        if (looksLikeEvent(e) && verifyEvent(e)) store(e, false);
      } catch {
        /* skip corrupt line */
      }
    }
    log(`loaded ${events.length} events from ${opts.dataFile}`);
  }

  function store(e: NostrEvent, persist = true): boolean {
    if (ids.has(e.id)) return false;
    if (isReplaceable(e.kind) || isAddressable(e.kind)) {
      const idx = events.findIndex(
        (x) => x.kind === e.kind && x.pubkey === e.pubkey && (!isAddressable(e.kind) || dTag(x) === dTag(e)),
      );
      if (idx >= 0) {
        const existing = events[idx]!;
        if (existing.created_at >= e.created_at) return false;
        ids.delete(existing.id);
        events.splice(idx, 1);
      }
    }
    events.push(e);
    ids.add(e.id);
    if (persist && opts.dataFile) appendFileSync(opts.dataFile, JSON.stringify(e) + "\n");
    return true;
  }

  const info = {
    name: opts.name ?? "Aava reference relay",
    description: opts.description ?? "NIP-01 relay for Aava demos. Stores only signed events; NIP-17 messages arrive gift-wrapped.",
    pubkey: opts.operatorPubkey,
    supported_nips: opts.protectGiftWraps ? [1, 11, 17, 40, 42, 59] : [1, 11, 17, 40, 59],
    software: SOFTWARE,
    version: VERSION,
    limitation: { max_message_length: maxEventBytes, max_subscriptions: maxSubs, auth_required: false, payment_required: false, ...(opts.protectGiftWraps ? { restricted_reads: "kind 1059 to its authenticated recipient" } : {}) },
  };

  const server: Server = createServer((req, res) => {
    if (req.headers.accept?.includes("application/nostr+json")) {
      res.writeHead(200, {
        "content-type": "application/nostr+json",
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "accept",
      });
      res.end(JSON.stringify(info));
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "accept" });
      res.end();
      return;
    }
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify({ ok: true, events: events.length, connections: conns.size }));
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`${info.name}\nConnect with a Nostr client over WebSocket.\n`);
  });

  const wss = new WebSocketServer({ server, maxPayload: maxEventBytes * 2 });

  function send(ws: WebSocket, msg: unknown[]) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  const GIFT_WRAP = 1059;
  /** May this connection receive `e`? Gift wraps only go to their authenticated recipient. */
  function visibleTo(c: Conn, e: NostrEvent): boolean {
    if (!opts.protectGiftWraps || e.kind !== GIFT_WRAP) return true;
    return e.tags.some((t) => t[0] === "p" && c.authed.has(t[1]!));
  }
  /** A filter that could return gift wraps must name only recipients this connection authenticated as. */
  function filterAllowed(c: Conn, f: Filter): boolean {
    if (!opts.protectGiftWraps) return true;
    if (f.kinds && !f.kinds.includes(GIFT_WRAP)) return true;
    const ps = f["#p"];
    return !!ps && ps.length > 0 && ps.every((p) => c.authed.has(p));
  }
  function verifyAuth(c: Conn, e: NostrEvent): string | null {
    if (e.kind !== 22242) return "invalid: not an auth event";
    if (!verifyEvent(e)) return "invalid: bad signature";
    if (e.tags.find((t) => t[0] === "challenge")?.[1] !== c.challenge) return "invalid: wrong challenge";
    if (Math.abs(e.created_at - Date.now() / 1000) > 600) return "invalid: auth event too old";
    const relayTag = e.tags.find((t) => t[0] === "relay")?.[1];
    try {
      if (!relayTag) return "invalid: wrong relay";
      const named = new URL(relayTag);
      const ok = opts.publicUrl ? named.host === new URL(opts.publicUrl).host : named.port === String(boundPort);
      if (!ok) return "invalid: wrong relay";
    } catch {
      return "invalid: wrong relay";
    }
    return null;
  }
  let boundPort = opts.port;

  function allow(c: Conn): boolean {
    const now = Date.now();
    const elapsed = (now - c.lastRefill) / 60_000;
    c.tokens = Math.min(perMinute, c.tokens + elapsed * perMinute);
    c.lastRefill = now;
    if (c.tokens < 1) return false;
    c.tokens -= 1;
    return true;
  }

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage) => {
    const c: Conn = { ws, challenge: randomBytes(16).toString("hex"), authed: new Set(), subs: new Map(), tokens: perMinute, lastRefill: Date.now() };
    conns.add(c);
    if (opts.protectGiftWraps) send(ws, ["AUTH", c.challenge]);
    ws.on("close", () => conns.delete(c));
    ws.on("message", (data) => {
      const text = data.toString();
      let msg: unknown;
      try {
        msg = JSON.parse(text);
      } catch {
        return send(ws, ["NOTICE", "invalid: malformed JSON"]);
      }
      if (!Array.isArray(msg) || typeof msg[0] !== "string") return send(ws, ["NOTICE", "invalid: expected array"]);
      const [type, ...rest] = msg as [string, ...unknown[]];

      if (type === "EVENT") {
        const e = rest[0];
        if (!looksLikeEvent(e)) return send(ws, ["NOTICE", "invalid: malformed event"]);
        if (text.length > maxEventBytes) return send(ws, ["OK", e.id, false, "invalid: event too large"]);
        if (!allow(c)) return send(ws, ["OK", e.id, false, "rate-limited: slow down"]);
        if (!verifyEvent(e)) return send(ws, ["OK", e.id, false, "invalid: bad signature or id"]);
        const expiration = Number(e.tags.find((t) => t[0] === "expiration")?.[1]);
        if (Number.isFinite(expiration) && expiration < Date.now() / 1000) return send(ws, ["OK", e.id, false, "invalid: event expired"]);
        if (ids.has(e.id)) return send(ws, ["OK", e.id, true, "duplicate: already have this event"]);
        if (!isEphemeral(e.kind)) store(e);
        send(ws, ["OK", e.id, true, ""]);
        for (const other of conns) {
          if (!visibleTo(other, e)) continue;
          for (const [subId, filters] of other.subs) {
            if (matchFilters(filters, e)) send(other.ws, ["EVENT", subId, e]);
          }
        }
        return;
      }

      if (type === "AUTH") {
        const e = rest[0];
        if (!looksLikeEvent(e)) return send(ws, ["NOTICE", "invalid: malformed auth event"]);
        const problem = verifyAuth(c, e);
        if (problem) return send(ws, ["OK", e.id, false, problem]);
        c.authed.add(e.pubkey);
        return send(ws, ["OK", e.id, true, ""]);
      }

      if (type === "REQ") {
        const subId = rest[0];
        if (typeof subId !== "string" || subId.length === 0 || subId.length > 64) return send(ws, ["NOTICE", "invalid: subscription id"]);
        const filters = rest.slice(1) as Filter[];
        if (!filters.every((f) => f && typeof f === "object")) return send(ws, ["CLOSED", subId, "invalid: filters"]);
        if (!c.subs.has(subId) && c.subs.size >= maxSubs) return send(ws, ["CLOSED", subId, "rate-limited: too many subscriptions"]);
        if (!filters.every((f) => filterAllowed(c, f))) return send(ws, ["CLOSED", subId, "auth-required: gift wraps are served only to their authenticated recipient"]);
        c.subs.set(subId, filters);
        const now = Date.now() / 1000;
        for (const f of filters) {
          const limit = Math.min(f.limit ?? 500, 500);
          const matched = events
            .filter((e) => matchFilters([f], e) && visibleTo(c, e))
            .filter((e) => {
              const exp = Number(e.tags.find((t) => t[0] === "expiration")?.[1]);
              return !(Number.isFinite(exp) && exp < now);
            })
            .sort((a, b) => b.created_at - a.created_at)
            .slice(0, limit);
          for (const e of matched) send(ws, ["EVENT", subId, e]);
        }
        send(ws, ["EOSE", subId]);
        return;
      }

      if (type === "CLOSE") {
        if (typeof rest[0] === "string") c.subs.delete(rest[0]);
        return;
      }

      send(ws, ["NOTICE", `unsupported: ${type}`]);
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host ?? "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port;
      boundPort = port;
      const host = opts.host && opts.host !== "0.0.0.0" ? opts.host : "127.0.0.1";
      log(`${info.name} listening on ws://${host}:${port}`);
      resolve({
        url: `ws://${host}:${port}`,
        port,
        storedEvents: () => events.slice(),
        close: () =>
          new Promise<void>((done) => {
            for (const c of conns) c.ws.terminate();
            wss.close(() => server.close(() => done()));
          }),
      });
    });
  });
}
