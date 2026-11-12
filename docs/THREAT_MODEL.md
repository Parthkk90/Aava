# Threat Model

Aava protects **message content**, **identity keys**, and **payment intent integrity**. It **reduces**, but does not eliminate, metadata exposure to infrastructure operators. Every mitigation listed here names the automated test that checks it.

## Assets

| Asset | Where it lives |
|---|---|
| Nostr identity secret key | Device memory while unlocked; NIP-49 ciphertext at rest; user-held backup file |
| Message plaintext | Sender and recipient devices only |
| Wallet private keys | **Never in Aava.** Held by the user's wallet (EIP-1193) |
| Payment request integrity | EIP-712 signature by the creator's wallet |
| Payment execution state | Local request ledger (request ID → state) |
| Infrastructure choice | Local relay / RPC / TURN configuration |

## Trust boundaries

```
 [user device: app + vault + ledger]  <-- trusted while uncompromised
        |                             |                           |
        | wss (gift-wrapped events)   | json-rpc: direct, via the | turn
        |                             | Anon-RPC mixnet, or       |
        |                             | Helios-verified           |
 [relay operators A, B, ...]   [RPC provider / mixnet nodes]  [TURN operator]   <-- untrusted
        |
 [other users / communities / agents]  <-- untrusted input
```

## Threat matrix

| # | Threat | Surface | Impact | Mitigation | Remaining risk | Test |
|---|---|---|---|---|---|---|
| T1 | Relay reads message contents | Stored events | Loss of confidentiality | NIP-17: kind 14 rumor, NIP-44 sealed (kind 13), gift-wrapped (kind 1059) under a random ephemeral key | Relay sees recipient pubkey (`p` tag), size, timing, sender IP | P-01, P-02 |
| T2 | Relay learns the social graph | Event pubkeys | Metadata leak | Gift wraps are signed by a one-time key; the seal timestamp is randomised by up to 2 days | Recipient pubkey is visible; traffic analysis from the client IP | P-02 (*limited*) |
| T3 | Relay censors or drops events | Publish / subscribe | Loss of availability | Publish to all configured relays; per-relay acks; failover; manually configured relays | All configured relays colluding | S-13, C-01, C-03 |
| T4 | Malicious operator manifest | Imported relay metadata | User routed to an attacker relay | Manifest is a NIP-01 signed event; checks on signature, operator key match, expiry, schema, and URL scheme | Users trusting a malicious but validly signed operator | S-14 |
| T5 | Forged message from a contact | Inbound events | Impersonation | Seal signature verified; seal pubkey must equal rumor pubkey | Compromised contact key | S-04 |
| T6 | Payment recipient or amount altered in transit | Payment request | Funds sent to the attacker | EIP-712 signature over every field; recovered signer must equal `creatorWallet` and be authorised by policy | A compromised creator wallet can still sign a malicious request | S-05, S-06 |
| T7 | Request replayed or reused | Payment request | Double payment | Unique `requestId`, `expiresAt`, local ledger state machine | Ledger is per device; a second device does not know prior state | S-08, S-09 |
| T8 | Cross-chain or wrong-token replay | Payment request | Payment on the wrong network or asset | `chainId` in the EIP-712 domain and message; token allowlist by contract address, never by symbol | Misconfigured allowlist | S-07, S-12 |
| T9 | Fake "paid" status | Wallet return value, RPC | Merchant or user deceived | Receipt verification: status, token, sender, recipient, amount, Transfer log, confirmations. **Verified RPC mode** (Helios light client via Kohaku) checks receipts against the beacon chain | In direct and anonymous modes a **malicious RPC can lie**; verified mode is Sepolia/mainnet only, about 27 h of receipts, and trusts the beacon sync committee | S-11, S-15, S-16 |
| T10 | Silent or unauthorised transfer | Wallet | Loss of funds | App never holds wallet keys; every transfer requires explicit approval in the UI and wallet; agent policy enforced outside the LLM | User approves a malicious request | S-10 |
| T11 | Key exfiltration from storage | localStorage / IndexedDB | Identity theft | Key stored only as NIP-49 ciphertext; plaintext key only in memory; lock zeroes the buffer | Compromised unlocked device; JS memory not reliably zeroed | S-02 |
| T12 | Weak key generation | Keygen | Identity theft | `crypto.getRandomValues` via `@noble/curves` | Platform RNG failure | S-01 |
| T13 | Lost device | Device | Loss of identity | NIP-49 encrypted backup and verified restore | Weak user password; backup file theft plus offline brute force (scrypt slows this) | S-03 |
| T14 | IP exposure via WebRTC | ICE candidates | Location leak | `iceTransportPolicy: "relay"`, candidate inspection | TURN operator sees both IPs | P-07 |
| T15 | Third-party tracking | Frontend network requests | Metadata leak | No analytics; strict CSP `connect-src` limited to configured endpoints; endpoint inventory | Wallet extensions make their own requests | P-03, P-04 |
| T16 | Linking chat and payment identities | Public events | De-anonymisation | Wallet address never published in public events; only shared inside encrypted payment requests | Recipient learns both; on-chain transfers are public | P-06 |
| T17 | Prompt injection makes an agent pay | Agent inbound messages | Loss of funds | Spending policy enforced in code outside the LLM; all payments go through policy and human-approval queue | Overly broad policy configured by the operator | `agent-sdk.test.ts` (caps, allowlist, owner-only NIP-17 approval, forged approval, injected text) |
| T18 | Compromised frontend dependency | Supply chain | Total compromise | Pinned exact versions, lockfile, license inventory, CSP, release hashes | Malicious pinned version; no reproducible builds yet | O-02, O-03 |
| T19 | Original team disappears | Hosted backend / domain | Loss of service | No mandatory backend; static frontend; user-supplied relays and RPC | Users must find alternative relays | C-02, C-04, C-06 |
| T20 | Malicious community member | Community messages | Spam, impersonation of admins | Admin roster signed by the founder; invitations signed; members verified against the roster | No forward secrecy; removed members keep past messages | `communities.test.ts` (forged founder, chainless admin roster, escalation, stale versions) |
| T21 | RPC provider profiles the user | Chain reads | IP linked to the wallet addresses queried | **Anonymous RPC mode** (Anon-RPC worker, Nox mixnet): requests reach the RPC from a mixnet exit; all reads go through one router that fails closed; ESLint forbids other RPC clients in the app; OBS-15 checks for direct requests in the browser | Mixnet entry node sees the IP; the query pattern itself can identify; one direct bootstrap read on first use; the wallet extension uses its own RPC; no WebRTC means no anon mode (Tor Browser) | P-09, P-10, P-11, OBS-15 |
| T22 | Malicious anonymizing-worker code | Anon-RPC specifier update, bundle mirrors | Worker logs, alters, or censors reads | Bundle runs only if keccak256 matches the hash pinned on first use; a changed on-chain hash is refused until the user accepts it; the worker runs in a null-origin sandboxed iframe without access to the page, storage, or keys; a bootstrap RPC on the wrong chain is rejected | The pinned code itself is trusted with every request it carries (trust on first use) | P-10 |
| T23 | Theft of shielded notes | Kohaku recovery phrase, synced state | Loss of shielded testnet funds | Separate 24-word phrase (not derived from the chat key); entropy stored only NIP-49-encrypted under the device password; in memory only while unlocked; backup carries it encrypted with the backup password; Kohaku state AES-GCM-encrypted; keystore scoped to Tornado paths | **Aava holds spending keys for shielded notes** (the one exception to "never holds keys"); a compromised unlocked device exposes them; Kohaku Tornado package is alpha and unaudited | `shielded.test.ts` (unit), S-17 |
| T24 | On-chain link between payer and payee | Public ERC-20 / ETH transfers | Payment graph de-anonymised | Private payments: Tornado deposit from the wallet, withdrawal to the recipient as a paymaster-sponsored ERC-4337 operation; bundler submission routed through the mixnet in anonymous mode | Small anonymity set on Sepolia; timing; fixed denominations; one-time proving-file download from GitHub reveals Tornado use | S-17, S-18 (funded, opt-in), P-13 |
| T25 | Relay lists who receives messages | Gift-wrap `p` tags | Social-graph metadata to any reader | NIP-42: relays like `auth.nostr1.com` (a default) and the reference relay with `protectGiftWraps` serve gift wraps only to the authenticated recipient; Aava authenticates automatically | The relay operator itself still sees recipients and your IP; most public relays do not enforce NIP-42 | P-12, C-07 |

## Explicit non-goals and limitations

- **No forward secrecy or post-compromise security.** NIP-44 uses static-key ECDH. MLS is a future upgrade.
- **No anonymity against a global network observer.** Aava does not route traffic over Tor by itself.
- **Public ERC-20 transfers are not private.** Sender, recipient, and amount are on-chain.
- **A compromised device that is unlocked exposes the identity key.**
