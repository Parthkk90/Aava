# Aava

**Private messages and verifiable payments, on infrastructure you choose.**

Aava is an open-source client and toolkit for people, communities, and AI agents:

- **Encrypted direct messages:** Nostr **NIP-17 / NIP-59 / NIP-44**, with **NIP-42** login for relays that only hand messages to their recipient.
- **A relay mesh:** messages go to several independently operated public relays by default, with failover and backfill.
- **Signed payment requests:** **EIP-712** requests, bound to the sender's chat identity and rejected if anything is altered.
- **Verified payments:** you approve each payment in your own wallet, and Aava checks it against the **actual on-chain receipt**.
- **RPC routing (experimental):** chain reads can go **direct**, **anonymously** through [Anon-RPC](https://ethereum.github.io/anon-rpc/) and the Nox mixnet, or **verified** by a [Helios](https://github.com/a16z/helios) light client through [Kohaku](https://github.com/ethereum/kohaku).
- **Private payments (experimental, Sepolia):** Tornado Cash through Kohaku's SDK. You shield ETH, then pay without an on-chain link to your wallet.
- **A Privacy Observatory:** 15 real tests that run in your browser and report evidence and limitations, not a score.
- **An agent SDK:** x402 payments under a spending policy that is enforced outside the model.

It keeps working if the original team, servers, or domain disappear: there is no Aava backend.

> ⚠️ **Testnet prototype. Not independently audited.** Do not use with funds or communications you cannot afford to lose. The Kohaku and Anon-RPC packages it builds on are alpha releases. See [docs/SECURITY.md](docs/SECURITY.md).

> **Naming:** Aava was developed as *RelayMesh*. Internal identifiers keep that name so existing data and signatures stay valid: the `@relaymesh/*` packages, storage keys, the backup format, the EIP-712 domain `RelayMesh Payment Request`, and the deployed test token `RelayMesh Demo Dollar` (rmUSD).

## What's new

| Area | Change | Details |
|---|---|---|
| Relays | Public default relays replace the local / devtunnel ones: `nos.lol`, `relay.primal.net`, `offchain.pub`, `nostr.mom`, `auth.nostr1.com` | [PRIVACY.md](docs/PRIVACY.md) |
| Relays | NIP-42 login. Aava proves its key to relays that serve gift wraps only to the recipient. The reference relay can enforce this (`RELAY_PROTECT_GIFT_WRAPS=1`) | P-12, C-07 |
| Chain reads | One RPC router (`apps/web/src/runtime/rpc.ts`) with three modes. It **fails closed**: it never falls back to a direct connection | P-09 – P-11, P-13 |
| Chain reads | **Anonymous mode:** Anon-RPC worker (hash-pinned, sandboxed), Nox mixnet on Sepolia | [PRIVACY.md](docs/PRIVACY.md#rpc-routing-privacy--rpc-routing) |
| Chain reads | **Verified mode:** Helios light client via `@kohaku-eth/provider/helios`. Catches an RPC that lies about receipts | S-15, S-16 |
| Payments | **Private payments page:** Kohaku Tornado Cash (pools 0.01 – 30 ETH on Sepolia), paymaster-sponsored withdrawals, a separate encrypted recovery phrase. **Proven live on Sepolia:** deposit [`0xc08bf927…`](https://sepolia.etherscan.io/tx/0xc08bf9272df63cc973de028aa60fe7d3e5cd02683ec8d2000aed7bd463020e46), private withdrawal [`0xebb547d3…`](https://sepolia.etherscan.io/tx/0xebb547d38ee0d20be369d4af2ed4fe3534473ae5e4d36d3e7c34b368c7d1e870) | S-17, S-18 |
| Defaults | The app opens on the **Sepolia** testnet. The local devnet is selected by the demo and test builds | |
| Observatory | OBS-15 *Anonymous RPC routing*: flags any direct request to an RPC that should be anonymized | |

## Tech stack: what is used where

| Technology | Version | Used for | Where |
|---|---|---|---|
| **TypeScript** | 6.0 | All code: packages export TS source, with no separate build step | everywhere |
| **Node.js / pnpm** | ≥ 22.12 / 9 | Runtime and monorepo workspaces | root `package.json`, `pnpm-workspace.yaml` |
| **React** + **React Router** | 19 / 7 | Web UI with hash routing, so it self-hosts without rewrites | [apps/web/src](apps/web/src) |
| **Vite** + **Tailwind CSS** | 8 / 4 | Build, CSP injection, release hash manifest, serving third-party worker files verbatim | [apps/web/vite.config.ts](apps/web/vite.config.ts) |
| **nostr-tools** | 2.25 | NIP-01 events, NIP-17/59 gift wraps, NIP-44 encryption, NIP-49 key vault, NIP-42 login | [packages/identity](packages/identity), [packages/messaging](packages/messaging), [packages/relay-mesh](packages/relay-mesh) |
| **viem** | 2.57 | EIP-712 signing and verification, ERC-20 calls, receipt checks, wallet connection (EIP-1193) | [packages/payments](packages/payments), [packages/chain](packages/chain), [apps/web/src/runtime/wallet.ts](apps/web/src/runtime/wallet.ts) |
| **Kohaku `@kohaku-eth/provider`** | 0.1.0-alpha.14 | `helios()` adapter for Verified mode; `raw()` provider handed to the Tornado plugin | [apps/web/src/runtime/rpc.ts](apps/web/src/runtime/rpc.ts), [shielded.ts](apps/web/src/runtime/shielded.ts) |
| **Kohaku `@kohaku-eth/tornado-cash`** + **`@kohaku-eth/plugins`** | 0.1.0-alpha.35 / 0.0.1-alpha.20 | Private payments: shield, sync, zero-knowledge withdrawal, ERC-4337 paymaster broadcast; host keystore and storage interfaces | [apps/web/src/runtime/shielded.ts](apps/web/src/runtime/shielded.ts), [apps/web/scripts/tornado-snapshot.ts](apps/web/scripts/tornado-snapshot.ts) |
| **Anon-RPC `@anon-rpc/browser-harness`** | 0.4.0 | Anonymous mode: hash-pinned worker in a null-origin sandboxed iframe, Nox mixnet (specifier `0x3513…7A9A` on Sepolia) | [apps/web/src/runtime/rpc.ts](apps/web/src/runtime/rpc.ts) |
| **Helios `@a16z/helios`** | 0.12.0 | Light client (WebAssembly) behind Verified mode, loaded lazily | via Kohaku's adapter in `rpc.ts` |
| **@scure/bip39** | 2.4 | The 24-word private-payments recovery phrase | [apps/web/src/runtime/shielded-keys.ts](apps/web/src/runtime/shielded-keys.ts) |
| **idb-keyval** (IndexedDB) | 6.3 | All local storage: vault ciphertext, encrypted history, ledger, encrypted Kohaku state, cached proving files | [apps/web/src/runtime/storage.ts](apps/web/src/runtime/storage.ts) |
| **WebCrypto** (AES-GCM, SHA-256) | built-in | Encrypting Kohaku's synced state at rest; release hashes | `shielded.ts`, `vite.config.ts` |
| **zod** | 4 | Validating manifests, payment requests and config bundles | [packages/relay-mesh](packages/relay-mesh), [packages/payments](packages/payments) |
| **ws** | — | Reference Nostr relay server | [apps/relay](apps/relay) |
| **Fastify** | — | Demo x402 merchant | [apps/merchant](apps/merchant) |
| **@cloudflare/privacypass-ts** | 0.9 | Experimental RFC 9578 blind tokens (off) | [packages/blind-tokens](packages/blind-tokens) |
| **Foundry** (`anvil`, `forge`, `cast`) | 1.x | Local devnet, Sepolia forks in tests, demo token contract | [contracts](contracts), [packages/chain/src/testing.ts](packages/chain/src/testing.ts) |
| **Vitest** | 5.1 | Unit, integration and CROPS acceptance tests | [vitest.config.ts](vitest.config.ts), [tests/crops](tests/crops) |
| **Playwright** (Chromium) | 1.64 | Browser end-to-end tests against the production build | [tests/e2e](tests/e2e) |
| **ESLint** + typescript-eslint | 10 / 8 | Lint, plus security rules: no `eval`, no `localStorage.setItem`, no RPC client outside the router | [eslint.config.js](eslint.config.js) |
| **Docker**, **nginx**, **nostr-rs-relay**, **coturn** | — | Demo stack, static hosting with security headers, an independent second relay, optional TURN | [infra](infra) |

**External services (all replaceable in settings):**

| Service | Default | Used for | When |
|---|---|---|---|
| Nostr relays | 5 public relays (see above) | Messages, payment requests, receipts | Always |
| Sepolia read RPC | `ethereum-sepolia-rpc.publicnode.com` | Balances, receipts | Direct and anonymous modes |
| History RPC | `sepolia.gateway.tenderly.co` | Tornado pool history (publicnode keeps only days of logs) | Private payments |
| Anon-RPC bootstrap | `rpc.sepolia.ethpandaops.io` | One direct read of the worker's on-chain hash, on first use only | Anonymous mode |
| Nox mixnet | specifier on Sepolia | Carries anonymized RPC and bundler traffic | Anonymous mode |
| Beacon light-client API + execution RPC | `lodestar-sepolia.chainsafe.io` + `rpc.sepolia.ethpandaops.io` | Helios sync and proofs | Verified mode |
| ERC-4337 bundler / paymaster | `public.pimlico.io` (Kohaku default) | Private withdrawals | Private payments |
| GitHub raw | tornado-cli build at a pinned commit | Proving files (~34 MB, SHA-256-pinned by Kohaku, downloaded once) | Private payments |

## Quick start

Requirements: Node ≥ 22.12, pnpm 9, [Foundry](https://getfoundry.sh) (`anvil`) for tests and the demo, and Docker for the full stack.

```bash
pnpm install
pnpm test          # unit, integration and CROPS tests against real relays and a real local chain
pnpm demo          # the scripted signature demo, self-contained (in-process relays + anvil)
pnpm dev           # app at http://localhost:5173: Sepolia and the public default relays
pnpm build         # static production build in apps/web/dist (+ release.json hash manifest)
```

To develop against the **local** stack instead (relays on :7001/:7002, anvil on :8545), create `apps/web/.env.local`:

```bash
VITE_DEFAULT_RELAYS=ws://127.0.0.1:7001,ws://127.0.0.1:7002
VITE_DEFAULT_CHAIN_ID=31337
```

### Full demo stack (Docker)

```bash
docker compose -f infra/docker-compose.yml up -d --build
pnpm demo --docker          # Alice & Bob scripted demo against the stack
# open http://localhost:8190 in two browser profiles (Alice and Bob)
docker compose -f infra/docker-compose.yml down -v
```

| Service | Address | What it is |
|---|---|---|
| `relay-a` | ws://localhost:7001 | Aava reference relay ([apps/relay](apps/relay)) |
| `relay-b` | ws://localhost:7002 | **nostr-rs-relay**, an independent Rust implementation (unmodified upstream image) |
| `anvil` | http://localhost:8545 | Local devnet (chain 31337). Demo token `rmUSD` at `0x5FbD…0aa3`, which has no value |
| `merchant` | http://localhost:7080 | Demo x402 merchant ([apps/merchant](apps/merchant)) |
| `web` | http://localhost:8190 | Static frontend behind nginx with security headers. Built for **Sepolia and the public relays**; the comments in `docker-compose.yml` show the local-only build |
| `turn` | localhost:3478 | coturn, optional (`--profile webrtc`) |

On a local-only build, use **Wallet → Local test wallet** to connect an anvil account. Bob is `#1` (funded) and Alice is `#2`. That wallet exists only for the devnet: the node holds the keys and Aava asks you to confirm every action.

### The signature demo

`pnpm demo` (or `pnpm demo --docker`) runs these steps and prints the evidence for each:

1. Alice and Bob generate local identities.
2. Alice sends Bob an encrypted message, and the relays are queried to show they store only gift wraps.
3. Alice's wallet signs an EIP-712 payment request, and Bob verifies all eight checks.
4. An attacker changes the recipient address, and Aava rejects the request (`invalid-signature`).
5. Bob approves the original request. His wallet pays, and Aava verifies the receipt and Transfer log.
6. Relay A is shut down. Aava fails over, and Alice and Bob keep talking through Relay B.
7. Alice exports an encrypted backup, her local data is wiped, and she restores on a fresh install. Her history re-syncs from Relay B.

### Public testnet (Sepolia)

The demo token ([contracts/src/DemoToken.sol](contracts/src/DemoToken.sol): ERC-20 plus EIP-3009, no value) is deployed on **Sepolia**:

| | |
|---|---|
| Address | [`0x7528272FD75b3F7d137A0700B07f5De2294729E3`](https://sepolia.etherscan.io/address/0x7528272FD75b3F7d137A0700B07f5De2294729E3) |
| Deploy transaction | [`0xa94d875a…5c61767d`](https://sepolia.etherscan.io/tx/0xa94d875a98867f5613ad88238bed945bbc287ff695fc7fd262c09feb5c61767d) (block 12071261) |
| Record | [deployments/11155111.json](deployments/11155111.json) (includes the source SHA-256) |

Connect a browser wallet (MetaMask) on Sepolia under **Wallet**. To deploy your own copy, put a throwaway key in `.env` (see [.env.example](.env.example)) and run `pnpm deploy:testnet`; the script refuses to run on mainnets.

## Using the privacy features

**Privacy → RPC routing**

| Mode | What it does | Cost |
|---|---|---|
| Direct (default) | Plain HTTPS to the configured RPC | The provider sees your IP |
| Anonymous | Every chain read, plus Kohaku's bundler and history traffic, goes through the Anon-RPC worker over the Nox mixnet. The worker's code hash is pinned on first use and a changed hash is refused until you accept it | About 15 s to boot, seconds per read. Needs WebRTC (not Tor Browser) |
| Verified | Helios checks balances, code and receipts against the beacon chain | 30–60 s first sync, about 4 MB of WebAssembly. Sepolia and mainnet only; receipts from roughly the last 27 h |

The local devnet (loopback) is always direct. Anonymous and Verified cannot be combined yet.

**Private payments** (sidebar → *Private payments*, Sepolia):

1. **Set up:** enter your device password. Aava creates a separate 24-word recovery phrase, stored encrypted and included in your backup file.
2. **Shield:** pick an amount (0.01, 0.03, 0.1, 0.3 or 1 ETH). Your wallet sends the deposit.
3. **Send privately:** pick an amount and a recipient address. Aava proves the withdrawal locally and submits it as a paymaster-sponsored ERC-4337 operation. The paymaster's fee comes out of the note: about 37% on a 0.01 ETH note, about 4% on 0.1 ETH. Aava refuses fees above 20%.

This is the one feature where Aava holds spending keys. Before using it, read the limits in [docs/PRIVACY.md](docs/PRIVACY.md#private-payments-tornado-cash-via-kohaku-experimental-sepolia-only): a small anonymity set on Sepolia, timing correlation, Tornado Cash's sanctions history, and alpha, unaudited code.

## Repository layout

| Path | Purpose |
|---|---|
| [packages/identity](packages/identity) | Key generation, NIP-49 vault, encrypted backups, rotation notices |
| [packages/messaging](packages/messaging) | NIP-17 envelopes, typed payloads, encrypted local history |
| [packages/relay-mesh](packages/relay-mesh) | Multi-relay manager, failover and backfill, NIP-42 login, signed operator manifests |
| [packages/payments](packages/payments) | EIP-712 requests, policies, replay ledger, explicit execution |
| [packages/chain](packages/chain) | Chain and token registry, receipt verification, devnet and fork helpers |
| [packages/observatory](packages/observatory) | The 15 Privacy Observatory tests |
| [packages/agent-sdk](packages/agent-sdk) | Agent identity, spending policy, approvals, x402 client, service discovery |
| [packages/blind-tokens](packages/blind-tokens) | Experimental RFC 9578 blind tokens (off by default) |
| [apps/web](apps/web) | React app |
| [apps/web/src/runtime/rpc.ts](apps/web/src/runtime/rpc.ts) | The single RPC router: Direct / Anonymous (Anon-RPC) / Verified (Helios via Kohaku) |
| [apps/web/src/runtime/shielded.ts](apps/web/src/runtime/shielded.ts), [shielded-keys.ts](apps/web/src/runtime/shielded-keys.ts) | Private payments (Kohaku Tornado Cash) and the encrypted recovery phrase |
| [apps/web/scripts/tornado-snapshot.ts](apps/web/scripts/tornado-snapshot.ts) | Builds the public Sepolia pool snapshot shipped in `apps/web/public/kohaku/` |
| [apps/relay](apps/relay) | Reference NIP-01 relay with optional NIP-42 gift-wrap protection |
| [apps/merchant](apps/merchant) | Demo x402 merchant |
| [contracts](contracts) | Demo ERC-20 with EIP-3009 |
| [tests/crops](tests/crops) | CROPS acceptance suite (including `rpc-routing`, `relays`, `shielded`) |
| [tests/e2e](tests/e2e) | Browser tests (Playwright), including live Sepolia specs |
| [infra](infra) | Dockerfile, compose stack, nginx config |

## Testing

```bash
pnpm typecheck && pnpm lint
pnpm test          # all unit, integration and CROPS tests (no internet needed)
pnpm test:crops    # CROPS acceptance criteria only
pnpm test:e2e      # Playwright: payment flow, Observatory, WebRTC (P-07), backup/restore, private-payments phrase restore
```

Live checks against Sepolia, the Nox mixnet and public relays are opt-in:

```bash
LIVE_TESTNET=1 pnpm test:crops                                 # S-16 Helios vs a lying RPC, S-17/S-18 Tornado (fork), C-07 public relays
LIVE_TESTNET=1 pnpm test:e2e tests/e2e/rpc-routing.spec.ts     # Anonymous and Verified modes in Chromium
LIVE_TESTNET=1 pnpm test:e2e tests/e2e/shielded.spec.ts        # Private payments in Chromium (direct and through the mixnet)
TORNADO_FUNDED_PRIVATE_KEY=0x… LIVE_TESTNET=1 pnpm test:crops  # + a real deposit and private withdrawal (a little over 0.01 Sepolia ETH)
```

The current pass/fail status of every criterion, including what still fails, is in [docs/CROPS.md](docs/CROPS.md).

## CROPS

**Lead property: C (censorship resistance).** Aava has no backend: if we disappear, the app, your identity and your messages keep working.

- **C:** We run nothing you strictly need.
  - **Relays:** messages go to five independent public relays by default. If one disappears or refuses you, messages continue over the others and are backfilled later, and you can add any NIP-01 relay by URL (no registry).
  - **RPC:** switch providers in Privacy → RPC providers.
  - **Domain:** if it goes, serve `apps/web/dist` from anywhere (relative assets, hash routing) and restore your identity from your own backup file.
- **O:** MIT licensed. The whole system builds and runs from this repo alone (`pnpm install && pnpm demo`, or the Docker stack), including both reference relays, the devnet chain and the merchant. Dependencies are pinned, and their licenses are listed in [docs/third-party-licenses.json](docs/third-party-licenses.json). One exception: `@kohaku-eth/plugins` publishes no license, recorded there as UNDECLARED.
- **P:**
  - **Relays** learn the recipient's public key, message size, arrival time and your IP address, but not the content or the sender (NIP-17 gift wraps signed by one-time keys). NIP-42 relays such as `auth.nostr1.com` show messages only to their recipient.
  - **RPC providers** learn which addresses you look up, and your IP unless RPC routing is *Anonymous*.
  - **On-chain:** ERC-20 payments are public. *Private payments* break the link between payer and recipient, at the cost of Aava holding a separate, encrypted recovery phrase.
  - **No tracking:** no analytics, trackers, CDNs or web fonts.
- **S:**
  - **Keys:** generated in your browser, stored only as NIP-49 ciphertext (scrypt + XChaCha20-Poly1305), and held unlocked only in memory.
  - **Payments:** requests are EIP-712 signed and bound to the sender's chat identity. Nothing is paid without your wallet's approval and a verified on-chain receipt. *Verified* routing checks receipts against the beacon chain instead of trusting the RPC.
  - **Not covered:** there is no forward secrecy, and nothing here has been audited.

Every claim above is checked by an automated acceptance test that fails when its condition is not met.

## Self-hosting

- **Frontend:** `pnpm build`, then serve `apps/web/dist` from any static host. Hash routing means no rewrites are needed. Use [infra/web/nginx.conf](infra/web/nginx.conf) for the headers a `<meta>` CSP cannot set. It also lets the app frame its single Anon-RPC page (`anon-rpc-iframe.html`, `frame-ancestors 'self'`). Serve `kohaku/*` (Kohaku's worker scripts and the pool snapshot) as ordinary static files.
- **Relays:** the defaults are public; replace them under Relay Mesh, or set `VITE_DEFAULT_RELAYS` at build time. To run your own, use `apps/relay` (`RELAY_PROTECT_GIFT_WRAPS=1` for NIP-42 recipient-only reads, `RELAY_PUBLIC_URL` behind a proxy) or any NIP-01 relay. Optionally sign an operator manifest with `signOperatorManifest` from `@relaymesh/relay-mesh` so users can verify your metadata.
- **RPC:** run your own node, or choose providers under Privacy → RPC providers. The app checks `eth_chainId` before saving. A beacon node of your own makes Verified mode more reliable than the public Lodestar endpoint.
- **Private payments:** refresh the shipped pool snapshot before a release with `pnpm --filter @relaymesh/web exec tsx scripts/tornado-snapshot.ts`. It aborts rather than write a partial snapshot.

## Documentation

[Initial audit](docs/INITIAL_AUDIT.md) · [Architecture](docs/ARCHITECTURE.md) · [Threat model](docs/THREAT_MODEL.md) · [Security](docs/SECURITY.md) · [Privacy](docs/PRIVACY.md) · [CROPS status](docs/CROPS.md) · [Implementation plan](docs/IMPLEMENTATION_PLAN.md)

## License

MIT. Third-party runtime dependencies and their licenses are listed in [docs/third-party-licenses.json](docs/third-party-licenses.json) (`pnpm license-inventory`).
