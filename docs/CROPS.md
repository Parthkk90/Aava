# CROPS Acceptance Status

Each criterion is an automated test that **fails when its condition is not met**. Nothing is marked PASS on trust. Run them yourself:

```bash
pnpm test:crops     # tests/crops/*.test.ts: Node, real relays, real anvil chain
pnpm test:e2e       # tests/e2e/app.spec.ts: Chromium (P-07, browser storage, UI flow)
```

Status below is from the most recent local run (Windows 11, Node 24, Foundry 1.8). **CI reruns everything on each push.**

## Privacy

| ID | Criterion | How it is tested | Status |
|---|---|---|---|
| P-01 | Relay-stored message contents are not plaintext | Two real relays; every stored event is searched for the plaintext | ✅ PASS |
| P-02 | NIP-17 / NIP-59 construction | Decrypts each stored wrap layer by layer: kind 1059 → 13 (signed by sender) → 14 (unsigned); one-time wrap keys | ✅ PASS |
| P-03 | No third-party analytics | Builds the app; scans every emitted asset for tracker domains and external script or style tags; checks the CSP is present | ✅ PASS |
| P-04 | Network connections inventoried | Observatory OBS-04 lists every relay socket and fails on an unexpected origin | ✅ PASS |
| P-05 | Relay operators never receive wallet keys | After a full payment flow, relay storage is searched for wallet and identity private keys | ✅ PASS |
| P-06 | Chat and payment identities not published together | Relay storage is searched for wallet addresses; the sender key never appears as a signer | ✅ PASS |
| P-07 | WebRTC relay-only mode exposes no direct IP | Chromium gathers ICE candidates with `iceTransportPolicy: "relay"` (no host/srflx allowed), plus a sensitivity check that the default policy does produce host candidates | ✅ PASS (Chromium) |
| P-08 | Privacy limitations documented | Checks that PRIVACY.md covers forward secrecy, IP, recipient, timing, TURN, on-chain, Tor, self-copy | ✅ PASS |
| P-09 | Anonymous RPC mode never contacts the RPC provider directly | Real anvil chain behind a stand-in Anon-RPC worker. Spies on every direct connection: payment verification and balances go only through the worker; testing a new endpoint goes through the worker; the only direct request is the one-time specifier read on the bootstrap RPC; a pinned session makes none. **Live (opt-in):** Chromium on the production build boots the real Nox mixnet worker on Sepolia, reads the chain, and records zero requests to the Sepolia RPC origin | ✅ PASS (CI) · ✅ PASS live |
| P-10 | Anonymous RPC fails closed and pins the worker code | A worker that fails or never boots blocks reads (no direct fallback, fail-fast retry window, worker closed on timeout). New code published on-chain is refused until accepted. A bootstrap RPC on the wrong chain cannot supply the hash. Non-https endpoints are refused | ✅ PASS |
| P-11 | Direct RPC requests in anonymous mode are detected in the browser | Observatory OBS-15 PASS with clean traffic, FAIL on a direct request after the mode took effect, LIMITED outside anonymous mode | ✅ PASS |
| P-12 | A NIP-42 relay serves gift wraps only to their authenticated recipient | Reference relay with `protectGiftWraps`. Aava clients authenticate automatically and chat both ways. Unauthenticated readers and other keys get `auth-required` and nothing. A client without a signer cannot read. Live deliveries go only to the recipient | ✅ PASS |
| P-13 | SDK traffic follows the routing mode | Kohaku's bundler and relayer calls go through the anonymizing worker in anonymous mode. Tornado history scans use the history endpoint, also through the worker. Light-client mode refuses history scans instead of going direct | ✅ PASS |

## Security

| ID | Criterion | How it is tested | Status |
|---|---|---|---|
| S-01 | Secure randomness | 500 distinct keys; generation refuses without `crypto.getRandomValues`; no `Math.random` in source | ✅ PASS |
| S-02 | No plaintext keys in browser storage | Vault storage scan (Node) and Observatory OBS-11 in Chromium; ESLint bans `localStorage.setItem` | ✅ PASS |
| S-03 | Recovery on a fresh installation | Backup, then a new vault on empty storage; history re-synced from the relay | ✅ PASS |
| S-04 | Invalid signed messages rejected | Forged seal, rumor altered after hashing, and corrupted wrap (refused by the relay) | ✅ PASS |
| S-05 | Altered recipients rejected | Recipient edited in transit → `invalid-signature` | ✅ PASS |
| S-06 | Altered amounts rejected | Amount edited → `invalid-signature` | ✅ PASS |
| S-07 | Wrong chain ids rejected | Chain edited → `invalid-signature`; signed for another chain → `wrong-chain` | ✅ PASS |
| S-08 | Expired requests rejected | Expired one minute ago → `expired` | ✅ PASS |
| S-09 | Duplicate requests rejected | Same request twice → `duplicate` | ✅ PASS |
| S-10 | Unauthorized transactions cannot execute | Unapproved, unknown, and attacker-re-signed requests never reach the wallet | ✅ PASS |
| S-11 | Fake success rejected | Wallet returns the hash of a different (decoy) transfer → `failed`; unknown hash never `verified` | ✅ PASS |
| S-12 | Wrong token contracts rejected | Unlisted token in the request; payment made with a look-alike token (same name and symbol) | ✅ PASS |
| S-13 | Relay failover | Relay A shut down; both directions continue via Relay B | ✅ PASS |
| S-14 | Invalid operator manifests rejected | Tampered URL, forged signature, expired, impostor key for a pinned operator, wrong kind, garbage | ✅ PASS |
| S-15 | Verified (light-client) mode reads only from the light client | Payment verification is served by the light client and never by the configured RPC; a chain without a light client, or a failed sync, means no read | ✅ PASS |
| S-16 | A light client rejects a receipt the RPC lied about | **Live Sepolia (opt-in, `LIVE_TESTNET=1`):** a local RPC proxy inflates the amount in a real recent ERC-20 Transfer receipt. A client that trusts the RPC reports `verified` (sensitivity check); Helios (through Kohaku's adapter) does not; the honest receipt verifies. Browser: Helios syncs under the production CSP | ✅ PASS live (see note) |
| S-17 | Private payments (Kohaku Tornado Cash) work on Sepolia | **Live (opt-in):** the app's `ShieldedWallet` syncs the Sepolia pools through the app's router from the shipped snapshot (about 14 s), prepares a 0.1 ETH deposit into a Kohaku catalog pool, and stores state only encrypted. **Browser, production CSP:** Kohaku's worker loads and syncs in direct mode (24 s) and in anonymous mode through the Nox mixnet (33 s), with zero direct requests to the history or read RPC. The recovery phrase survives backup, wipe, restore and a new device password, and never appears in plaintext in IndexedDB (CI) | ✅ PASS (live and CI) |
| S-18 | A private payment works end to end on Sepolia | **Live, funded (2026-11-06):** a 0.01 ETH Tornado deposit from the test wallet ([`0xc08bf927…`](https://sepolia.etherscan.io/tx/0xc08bf9272df63cc973de028aa60fe7d3e5cd02683ec8d2000aed7bd463020e46)). The private withdrawal to a fresh address went out as a paymaster-sponsored ERC-4337 operation ([`0xebb547d3…`](https://sepolia.etherscan.io/tx/0xebb547d38ee0d20be369d4af2ed4fe3534473ae5e4d36d3e7c34b368c7d1e870)), submitted by the bundler (`0x4337…1979`), never by the payer. The recipient received 0.00627 ETH; the proof-bound fee was 0.00373 ETH, of which 0.00234 came back as an unused-gas refund to the phrase's recoverable delegator. **Sepolia fork:** a deposit becomes that phrase's note only; a restored phrase finds it again | ✅ PASS live |

## Censorship resistance

| ID | Criterion | How it is tested | Status |
|---|---|---|---|
| C-01 | Independent relays | Peers sharing only one of two relays still communicate; the Docker demo uses two different relay codebases | ✅ PASS |
| C-02 | No mandatory registry | Manifest-less config bundle imports; no remote relay-list fetch in the app runtime | ✅ PASS |
| C-03 | Manually configured infrastructure | Full flow with only test-supplied URLs | ✅ PASS |
| C-04 | Backend loss doesn't destroy identities | All relays killed; vault unlocks and history is readable from local storage; new messages queue | ✅ PASS |
| C-05 | Changeable RPC providers | Same receipt verified through two endpoints; a node without the transaction never verifies it | ✅ PASS |
| C-06 | Self-hostable frontend | Built `index.html` uses only relative asset paths; hash routing; nginx config provided | ✅ PASS |
| C-07 | Users talk over independent public relays by default | **Live (opt-in):** two users exchange a NIP-17 message over the five default public relays. All five accept it, including `auth.nostr1.com`, which requires NIP-42 to publish and to read. An anonymous reader is refused there | ✅ PASS live |

## Open source

| ID | Criterion | How it is tested | Status |
|---|---|---|---|
| O-01 | All source public | MIT LICENSE, every package licensed MIT, **and a public `origin` remote** | ❌ FAIL: repository not yet pushed to a public remote |
| O-02 | Dependency license records | Every runtime dependency has an entry in `docs/third-party-licenses.json` | ✅ PASS |
| O-03 | Releases are signed | `release/SHA256SUMS` + NIP-94 signature by the key in `docs/RELEASE_KEY` | ❌ FAIL: no signed release yet (`scripts/sign-release.ts` is ready; it needs the maintainer key) |
| O-04 | Build instructions | README documents install, dev, build, Docker, test | ✅ PASS |
| O-05 | Security test instructions public | SECURITY.md documents `pnpm test:crops` and reporting | ✅ PASS |

**Totals (latest run, 2026-11-06):** 41 of 43 criteria pass, plus P-07 in Chromium. O-01 and O-03 need maintainer action. Live opt-in runs (`LIVE_TESTNET=1`) covered P-09, S-16, S-17, S-18 (including a real funded private payment on Sepolia) and C-07 against Sepolia, the Nox mixnet and public relays. O-02 passes, but `@kohaku-eth/plugins` is recorded as **UNDECLARED**: no license is published upstream.

**RPC routing notes.**

- **Live tests are opt-in.** P-09 live and S-16 depend on public Sepolia infrastructure (Nox mixnet nodes, `lodestar-sepolia.chainsafe.io`, `rpc.sepolia.ethpandaops.io`), so CI runs only the deterministic parts.
- **Lodestar with Helios is intermittent.** In our runs, Helios 0.12 sometimes stayed 4–7 minutes behind the head with the Lodestar endpoint. The app reboots it once and otherwise reports a clear error. Against the Nimbus beacon API (`SEPOLIA_CONSENSUS_RPC=http://unstable.sepolia.beacon-api.nimbus.team`) S-16 passed every time, but browsers cannot use that endpoint from an HTTPS page because it is HTTP only.
- **C-06 test change.** The test now also accepts inline `data:` references, such as the empty favicon added to `index.html`. They load nothing from a server, which is what the test checks.

## Beyond the acceptance list

- **Signature demo** (`pnpm demo`, `pnpm demo --docker`): passes all 15 steps, including failover from the reference relay to `nostr-rs-relay`.
- **Agent SDK:** spending caps, origin allowlist, NIP-17 owner approval, forged-approval and prompt-injection resistance, merchant replay and tamper rejection.
- **Communities (experimental):** roster-chain validation against forged founders, privilege escalation, and stale updates.
