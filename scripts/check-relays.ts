/**
 * Tests public Nostr relays for what Aava needs:
 *   1. WebSocket connects
 *   2. NIP-11 info (software, NIP-42 AUTH / payment requirements)
 *   3. Accepts a kind 1059 gift wrap (publishes ONE test wrap to a random throwaway key)
 *   4. Serves that wrap back to an unauthenticated reader (Aava does not implement NIP-42 AUTH yet)
 *
 *   pnpm exec tsx scripts/check-relays.ts [wss://relay1,wss://relay2,...]
 */
import { Relay } from "nostr-tools/relay";
import { generateSecretKey, getPublicKey, type NostrEvent } from "nostr-tools/pure";
import * as nip59 from "nostr-tools/nip59";
import { fetchRelayInfo } from "@relaymesh/relay-mesh";

const DEFAULT = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://relay.snort.social",
  "wss://nostr.mom",
  "wss://offchain.pub",
  "wss://relay.nostr.net",
  "wss://nostr.oxtr.dev",
  "wss://relay.0xchat.com",
  "wss://auth.nostr1.com",
  "wss://relay.nostr.band",
  "wss://inbox.nostr.wine",
];
const urls = process.argv[2] ? process.argv[2].split(",") : DEFAULT;

const withTimeout = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<T>((_, r) => setTimeout(() => r(new Error(`${what} timed out`)), ms))]);

interface Row {
  url: string;
  connect: string;
  software: string;
  auth: string;
  publish: string;
  readBack: string;
}

async function check(url: string): Promise<Row> {
  const row: Row = { url, connect: "â€“", software: "â€“", auth: "â€“", publish: "â€“", readBack: "â€“" };
  try {
    const info = await fetchRelayInfo(url, 6000);
    row.software = `${(info.software ?? "?").split("/").pop()} ${info.version ?? ""}`.trim();
    const lim = (info.limitation ?? {}) as { auth_required?: boolean; payment_required?: boolean };
    const nips = info.supported_nips ?? [];
    row.auth = [lim.auth_required ? "auth required" : nips.includes(42) ? "NIP-42 supported" : "no auth", lim.payment_required ? "PAID" : ""].filter(Boolean).join(", ");
  } catch (e) {
    row.software = `NIP-11 failed: ${String((e as Error)?.message ?? e).slice(0, 30)}`;
  }
  const relay = new Relay(url, { enablePing: false, enableReconnect: false });
  const t0 = performance.now();
  try {
    await relay.connect({ timeout: 8000 });
    row.connect = `ok ${Math.round(performance.now() - t0)} ms`;
  } catch (e) {
    row.connect = `FAIL ${String((e as Error)?.message ?? e).slice(0, 40)}`;
    return row;
  }
  relay.publishTimeout = 8000;
  // One test gift wrap from a throwaway sender to a throwaway recipient: meaningless ciphertext to everyone.
  const recipient = generateSecretKey();
  const wrap: NostrEvent = nip59.wrapEvent({ kind: 14, content: "aava relay compatibility probe", tags: [["p", getPublicKey(recipient)]] }, generateSecretKey(), getPublicKey(recipient));
  try {
    const msg = await relay.publish(wrap);
    row.publish = `accepted${msg ? ` (${msg.slice(0, 30)})` : ""}`;
  } catch (e) {
    row.publish = `REJECTED: ${String((e as Error)?.message ?? e).slice(0, 60)}`;
  }
  if (row.publish.startsWith("accepted")) {
    try {
      const got = await withTimeout(
        new Promise<boolean>((resolve) => {
          let found = false;
          const sub = relay.subscribe([{ kinds: [1059], "#p": [wrap.tags[0]![1]!], limit: 5 }], {
            onevent: (e) => {
              if (e.id === wrap.id) found = true;
            },
            oneose: () => (sub.close(), resolve(found)),
            onclose: (reason) => resolve(found || (reason.includes("auth") ? false : found)),
          });
        }),
        8000,
        "read",
      );
      row.readBack = got ? "yes" : "NO (needs AUTH or not served)";
    } catch (e) {
      row.readBack = `NO: ${(e as Error).message}`;
    }
  }
  relay.close();
  return row;
}

const rows: Row[] = [];
for (const u of urls) rows.push(await check(u.trim()).catch((e) => ({ url: u, connect: `error ${String((e as Error)?.message ?? e)}`, software: "", auth: "", publish: "", readBack: "" })));
console.log("relay | connect | software | auth/payment | publish kind 1059 | unauthenticated read-back");
for (const r of rows) console.log([r.url, r.connect, r.software, r.auth, r.publish, r.readBack].join(" | "));
process.exit(0);
