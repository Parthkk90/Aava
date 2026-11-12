# Privacy

This document lists what Aava protects, what it does not, and which party can observe what. Every protection listed here has an automated test (IDs in brackets). Anything without a test is listed as a limitation.

## What is protected

| Property | How | Test |
|---|---|---|
| Message content is hidden from relays | NIP-17: rumor (kind 14) → NIP-44 seal (kind 13) → NIP-44 gift wrap (kind 1059) | P-01, OBS-01, OBS-02 |
| Sender identity is hidden from relays | Gift wraps are signed by a fresh one-time key; the sender's key appears only inside the encrypted seal | P-02, P-06 |
| Sender cannot be impersonated | Seal signature verified; seal author must equal rumor author; rumor id recomputed | S-04 |
| Wallet address is not published | Wallet addresses appear only inside encrypted payment requests and receipts | P-06 |
| Keys are not stored in plaintext | NIP-49 ciphertext at rest; history encrypted to self with NIP-44 | S-02, OBS-11 |
| No third-party tracking | No analytics, fonts, or CDNs; strict CSP; tracker detection in the Observatory | P-03, OBS-03, OBS-04 |
| WebRTC does not reveal your IP to peers in relay-only mode | `iceTransportPolicy: "relay"`, candidate inspection | P-07, OBS-05 |

## Metadata that remains visible

**Relay operators** can observe:

- **Your IP address** and when you connect, unless you use Tor (Tor Browser, or an onion-only relay policy) or a VPN.
- **The recipient** of every gift wrap. The `p` tag must be readable so relays can deliver the event.
- **Timing and size.** NIP-59 randomises the visible `created_at` by up to two days, but the moment an event arrives at the relay is still observable. Sizes are padded by NIP-44 only to coarse buckets.
- **The self-copy.** When you send a message, a copy is also wrapped to your own key so your other devices can sync history. A relay that sees a wrap to Bob and a wrap to you arrive at the same moment can infer that you wrote to Bob. *Mitigation not yet implemented: delayed or separate-relay publishing of the self-copy.*
- **Reading patterns.** Relays see which public key you subscribe to, which reveals your identity to any relay you read from.

**Default relays.** Aava now ships with five independently operated public relays (`nos.lol`, `relay.primal.net`, `offchain.pub`, `nostr.mom`, `auth.nostr1.com`), checked on 2026-11-06 to accept and return NIP-17 gift wraps (test C-07). You can replace every one. `auth.nostr1.com` uses **NIP-42**: it accepts and serves gift wraps only to a client that proves it holds the recipient's key, so nobody else can even list who received messages there. Aava answers NIP-42 challenges automatically (P-12). Authenticating tells that relay your public key, which any relay you read from already learns from your subscription. `relay.damus.io` and `relay.nostr.net` also demand NIP-42 for gift wraps, but their authentication was misconfigured when tested, so they cannot deliver them and are not defaults. The reference relay (`apps/relay`) supports the same protection with `RELAY_PROTECT_GIFT_WRAPS=1`.

**RPC providers** see every address, balance, and transaction you query. In the default *direct* mode they also see your IP address, and a malicious RPC can lie about receipts. The two experimental routing modes below change this.

## RPC routing (Privacy → RPC routing)

All chain reads the app makes (balances, receipt verification, diagnostics) go through one module, `apps/web/src/runtime/rpc.ts`, and an ESLint rule forbids creating RPC clients anywhere else in the app. In every mode:

- **Fail closed.** If the selected mode cannot answer, the read fails. It never silently falls back to a direct connection.
- **Loopback is direct.** A local devnet RPC (127.0.0.1, localhost) is always contacted directly, because no third party is involved.
- **Your wallet is not routed.** Your wallet extension sends transactions, and makes its own reads, through its own RPC.

| Mode | RPC provider sees | Your IP is seen by | Receipts and balances | Test |
|---|---|---|---|---|
| Direct (default) | Your IP, every query | RPC provider | Trusted from the RPC | C-05 |
| **Anonymous** ([Anon-RPC](https://ethereum.github.io/anon-rpc/), Nox mixnet) | Every query, arriving from a mixnet exit | Mixnet entry node only | Trusted from the RPC | P-09, P-10, P-11, OBS-15 |
| **Verified** ([Helios](https://github.com/a16z/helios) light client via [Kohaku](https://github.com/ethereum/kohaku) `@kohaku-eth/provider/helios`) | Your IP, every query (execution and beacon endpoints) | Both endpoints | Checked against the beacon chain; a lying RPC is detected | S-15, S-16 |

**Anonymous mode, in detail.** Each JSON-RPC request is handed to an Anon-RPC worker: client code identified on-chain by its keccak256 hash, run in a Web Worker inside a null-origin sandboxed iframe with no access to the page, its storage, or any keys. The default network is the Nox mixnet (specifier `0x35133267…7A9A` on Sepolia). The worker runs TLS with the RPC provider itself and sends it as Sphinx packets through the mixnet. Who sees what:

- **The mixnet entry node** sees your IP address and encrypted packets. It does not see the destination or the request.
- **The exit node** sees the provider's host name and the timing and size of TLS records. It does not see the request content (end-to-end TLS) or who sent it.
- **The worker code** sees every request it carries and could censor or alter responses. You trust whoever controls the specifier's hash.
  - Aava pins the hash on first use and refuses different code until you accept it on the Privacy page.
  - The Nox specifier's owner is an externally owned account, so the code can change.
- **The bootstrap RPC** (default `rpc.sepolia.ethpandaops.io`, deliberately a different operator from the default read RPC) receives one direct, non-anonymized read of the specifier, on first use and when you check for a worker update. It learns your IP and that you are setting up Anon-RPC. Later sessions boot from the pinned values and contact no bootstrap RPC.
- **The bundle sources** (GitHub, jsDelivr, unpkg, or KPS peers) see your IP when the worker code is downloaded. The code is verified against the pinned hash before it runs.

**Limits of anonymous mode:**

- It needs WebRTC, so it does not work in Tor Browser (which disables WebRTC). Use direct mode there: Tor already hides your IP.
- It is slower: about 15 s to boot in our tests, then seconds per read.
- The endpoint must be an `https://` URL with a host name (end-to-end TLS).
- On a testnet mixnet the anonymity set is small.
- It hides who is asking, not what is asked. The RPC provider still sees which addresses you query, and that pattern can identify you.

**Verified mode, in detail.** The Helios light client follows the beacon chain's sync committee through a beacon API (default `lodestar-sepolia.chainsafe.io`). It checks every balance, contract code, `eth_call` result and receipt from the execution RPC (default `rpc.sepolia.ethpandaops.io`) with Merkle proofs. The execution RPC is therefore not trusted, but both endpoints see your IP. Its limits:

- Only Ethereum mainnet and Sepolia are supported; Gnosis chains cannot be read in this mode.
- Receipts can be verified for roughly the last 27 hours (8,191 blocks).
- `eth_getTransaction` is not available. The informational "transaction sender" check is skipped, and the Transfer log still decides the outcome.
- The first sync takes 30–60 s and downloads about 4 MB of WebAssembly.
- With the public Lodestar endpoint, Helios sometimes stays several minutes behind the head. Aava then reboots it once and otherwise reports the failure. A beacon node you run yourself avoids this.
- The beacon checkpoint cache is kept in memory, not in browser storage.

Anonymous and verified reads cannot currently be combined in the browser: Helios makes its own network requests, which cannot be routed through the anonymizing worker.

**TURN operators** see the IP addresses of both peers, connection timing, and traffic volume. Media and data are DTLS-encrypted end to end.

**Blockchain observers (everyone)**: ERC-20 transfers are public **on-chain**. The sender, recipient, amount, token, and time of every payment are permanently visible. Aava never describes these payments as anonymous. Linking your chat identity to your wallet is up to you and the people you send requests to.

**Message recipients** learn your chat identity and, for payment requests, your wallet address.

## Private payments (Tornado Cash via Kohaku, experimental, Sepolia only)

Private payments use Kohaku's Tornado Cash plugin (`@kohaku-eth/tornado-cash`). You **shield** Sepolia ETH from your wallet (fixed pool sizes: 0.01, 0.03, 0.1, 0.3, 1, 3, 10 and 30 ETH, including the extended pools Kohaku knows outside the instance registry), then **send privately**: a zero-knowledge withdrawal to the recipient, submitted as a paymaster-sponsored ERC-4337 user operation, so neither your wallet nor your deposit appears in it.

| Party | Sees | Does not see |
|---|---|---|
| Everyone (on-chain) | Your deposit (from your wallet, a fixed amount); a pool withdrawal arriving at the recipient | Which deposit funded which withdrawal; that your wallet paid the recipient |
| ERC-4337 bundler (`public.pimlico.io`) and paymaster | The withdrawal operation; your IP unless RPC routing is anonymous (the submission then travels through the mixnet) | Your wallet or deposit |
| GitHub (once) | Your IP and that you downloaded Tornado's proving files (~34 MB, too large for the mixnet) | Anything about your notes |
| Your RPC | Pool reads (the sync), unless routing is anonymous | Which notes are yours (notes are derived locally) |

**What Aava holds.** This is the one feature where Aava holds spending keys: a separate 24-word Kohaku recovery phrase, created when you set up private payments, independent of your chat key. At rest only its entropy is stored, NIP-49-encrypted under your device password; it is decrypted into memory at unlock and included (encrypted with the backup password) in your backup file. Kohaku's synced state is stored AES-GCM-encrypted with a key derived from that phrase. The keystore given to Kohaku is scoped to Tornado's derivation paths.

**Fees.** The paymaster's fee is bound into the proof using worst-case gas prices, so small notes pay a large share. In the live test, the fee on a 0.01 ETH note was 0.00373 ETH (37%). About 0.00234 ETH of that came back as an unused-gas refund, which lands on the note's recoverable delegator address: Aava does not sweep it yet. Aava refuses withdrawals whose fee exceeds 20% of the amount unless told otherwise, so in practice use 0.1 ETH notes or larger (a fee of about 4%).

**Limits.** Kohaku's Tornado package is alpha and still undergoing audits; this is testnet-only. The anonymity set on Sepolia is small, so timing links a withdrawal to a recent deposit: wait between them. The paymaster's fee is taken from the note, so the recipient receives slightly less than the denomination. Tornado Cash has been sanctioned in some jurisdictions in the past; check the rules that apply to you. The first sync is seeded from a snapshot of public pool state shipped with the app (`apps/web/public/kohaku/tornado-sepolia-state.json`, built by `apps/web/scripts/tornado-snapshot.ts`); a wrong snapshot cannot move funds, because withdrawals are proven against on-chain roots, but it could make a withdrawal fail.

## Cryptographic limitations

- **No forward secrecy and no post-compromise security.** NIP-44 derives a static conversation key from long-term keys. Anyone who later obtains your secret key can decrypt every past message they have captured. A ratcheting protocol (for example MLS) is a future upgrade and will be a separate protocol.
- **Groups (communities) are experimental.** They use per-member NIP-17 wraps with a signed roster. Removed members keep what they received.
- **Deniability is partial.** Rumors are unsigned, but seals are signed by the sender and decrypted by the recipient.

## Network-level privacy

- A web page **cannot** force its own traffic through Tor. Aava does not claim that it does. Anonymous RPC mode (above) anonymizes chain reads only, not relay connections.
- *Onion-only relay policy* is enforced: clearnet relays are not contacted. It only works in Tor Browser or behind an OS-level Tor proxy.
- The "How is this browser connected?" setting is a user statement and is never treated as a passed test.
- Wallet extensions make their own network requests that Aava cannot see or control.

## Blind-token payments (experimental, off)

The RFC 9578 blind-token module, compatible with Wraps, hides the link between *buying* tokens and *spending* them from the issuer. It does not hide the request content from the merchant, or the top-up transaction from the chain. Its trust assumptions (issuer attestation in a TEE) cannot be reproduced locally, so attestation is reported as **not verified** in local runs.
