#!/usr/bin/env -S npx tsx
import { startRelay } from "./index.ts";

const env = process.env;
const relay = await startRelay({
  port: Number(env.RELAY_PORT ?? 7001),
  host: env.RELAY_HOST ?? "127.0.0.1",
  name: env.RELAY_NAME,
  dataFile: env.RELAY_DATA_FILE,
  operatorPubkey: env.RELAY_OPERATOR_PUBKEY,
  eventsPerMinute: env.RELAY_EVENTS_PER_MINUTE ? Number(env.RELAY_EVENTS_PER_MINUTE) : undefined,
  protectGiftWraps: env.RELAY_PROTECT_GIFT_WRAPS === "1",
  publicUrl: env.RELAY_PUBLIC_URL,
  log: (m) => console.log(`[relay] ${m}`),
});

const shutdown = async () => {
  console.log("[relay] shutting down");
  await relay.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
