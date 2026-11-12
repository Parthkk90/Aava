# Architecture

## Principle

There is no Aava backend that users depend on. The application is a static frontend plus a set of TypeScript packages. All infrastructure is user-selected and replaceable: Nostr relays, an EVM RPC endpoint, and TURN servers. Every identity and every message lives on the user's device.

```
                         ┌──────────────────────────────── user device ───────────────────────────────┐
                         │  apps/web (React)                                                         │
                         │    ├── Identity Vault ──► @relaymesh/identity  (NIP-49, in-memory key)     │
                         │    ├── Messaging ───────► @relaymesh/messaging (NIP-17 / NIP-59 / NIP-44)  │
                         │    ├── Relay Mesh ──────► @relaymesh/relay-mesh (pool, failover, manifest) │
                         │    ├── Payments ────────► @relaymesh/payments  (EIP-712, policy, ledger)   │
                         │    ├── Wallet ──────────► EIP-1193 provider (user's wallet; holds keys)    │
                         │    ├── Verification ────► @relaymesh/chain     (receipt + Transfer log)    │
                         │    ├── RPC router ──────► runtime/rpc.ts: direct | Anon-RPC | Helios       │
                         │    └── Observatory ─────► @relaymesh/observatory (real checks + evidence)  │
                         └────────────┬─────────────────────────┬────────────────────┬──────────────┘
                                      │ wss                     │ JSON-RPC           │ TURN/UDP,TCP
                  ┌───────────────────┴──────┐        ┌─────────┴────────┐   ┌───────┴────────┐
                  │ Relay A (apps/relay)     │        │ RPC: own node,   │   │ coturn (any    │
                  │ Relay B (nostr-rs-relay) │        │ anvil, or public │   │ operator)      │
                  │ ...any NIP-01 relay      │        └──────────────────┘   └────────────────┘
                  └──────────────────────────┘
```

## Packages

| Package | Responsibility | Key dependencies |
|---|---|---|
| `@relaymesh/identity` | Key generation, NIP-49 vault, encrypted backup envelope, restore, verification, rotation notice | `nostr-tools` |
| `@relaymesh/messaging` | NIP-17 envelope creation and unwrapping, typed payloads (text, payment request, invitation), conversation store | `nostr-tools` |
| `@relaymesh/relay-mesh` | Multi-relay connection manager, health, backoff, failover, signed operator manifests | `nostr-tools`, `zod` |
| `@relaymesh/payments` | EIP-712 payment request schema, signing payloads, verification, treasury policy, replay ledger | `viem`, `zod` |
| `@relaymesh/chain` | Chain and token registry, ERC-20 ABI, receipt verification | `viem` |
| `@relaymesh/observatory` | Observatory test registry, result type (`PASS`/`FAIL`/`NOT TESTED`/`LIMITED`), runner | other packages |
| `@relaymesh/agent-sdk` | Agent identity, policy engine (outside the LLM), approval queue, x402 client | other packages |
| `@relaymesh/blind-tokens` | Experimental RFC 9578 issuance / redemption / double-spend store | `@cloudflare/privacypass-ts` |
| `apps/relay` | Small reference NIP-01 relay (operator software for the demo and tests) | `ws`, `nostr-tools` |
| `apps/web` | React UI. `src/runtime/rpc.ts` is the only place chain reads are made (direct, Anon-RPC, or Helios light client) | React, Vite, Tailwind, `@anon-rpc/browser-harness`, `@kohaku-eth/provider`, `@a16z/helios` |
| `apps/merchant` | Demo x402-style merchant that verifies on-chain payment | Fastify, `@relaymesh/chain` |

Packages export TypeScript source. Vite, Vitest, and tsx compile it. This keeps the dependency graph honest without a separate build step.

## Data flows

**Private message.** The sender builds a kind-14 rumor (unsigned). It is sealed with NIP-44 into a kind-13 event signed by the sender, then gift-wrapped into a kind-1059 event signed by a random key and encrypted to the recipient. The same rumor is also wrapped to the sender so they can sync their own history. The event is published to every healthy relay, and per-relay OK results are recorded.

**Payment request.**
1. The creator's wallet signs EIP-712 `PaymentRequest`.
2. The request is sent as a typed NIP-17 payload.
3. The recipient verifies: signature, signer authorised by community policy, rumor author equals `creatorPubkey`, chain, token allowlist, expiry, and ledger uniqueness.
4. The user approves in the UI, and the wallet asks again.
5. The app records the transaction hash, verifies the receipt, and only then sets `paid`.

**Chain reads.** Every read (balances, receipt verification, diagnostics) asks `RpcRouter` for a client. The router picks the transport from the RPC mode and fails closed; it never falls back to a direct connection.

- **Direct:** viem `http` to the configured URL.
- **Anonymous:** the same JSON-RPC, with viem's `fetchFn` set to the Anon-RPC worker's `fetch`.
  - The worker is a hash-pinned bundle in a null-origin sandboxed iframe.
  - Our CSP has no `'unsafe-inline'`, so the harness loads the same-origin page `anon-rpc-iframe.html`, emitted by a Vite plugin from the installed harness.
  - The specifier's `workerHash()` and `workerResolvers()` results are pinned on first use and replayed to the harness on later boots, so no bootstrap read recurs.
- **Verified:** a Helios light client created through Kohaku's `@kohaku-eth/provider/helios` adapter, used as a viem `custom` transport.
- Loopback RPCs are always direct.
- Helios and the harness are lazy chunks: only users of those modes download them.

**Private payments.** `runtime/shielded.ts` builds a Kohaku host from four parts:

- the RPC router, through Kohaku's `raw()` provider (history scans use `historyRpcUrls`);
- the router's service fetch, for the bundler;
- IndexedDB storage, AES-GCM-encrypted with a key derived from the phrase;
- the separate recovery phrase (`runtime/shielded-keys.ts`, NIP-49 at rest), scoped to Tornado's derivation paths.

Deposits are sent by the user's wallet. Withdrawals are paymaster-sponsored ERC-4337 user operations. Kohaku's state-manager and MSM workers are served verbatim from `/kohaku/`. A public pool snapshot (`public/kohaku/tornado-sepolia-state.json`) seeds the first sync. All Kohaku code is a lazy chunk.

**Relays and NIP-42.** `RelayMesh` answers NIP-42 challenges with the identity key and retries a subscription or publish once on `auth-required`. The reference relay can enforce recipient-only gift-wrap reads.

**Failover.** Each relay has a status (`connecting`, `open`, `failed`, `disabled`). Publishes go to all open relays. If none are open, events are queued locally and flushed on reconnect. Subscriptions are re-established on every relay that reconnects. Identity and message state are local and never depend on a relay.
