# Security

> Aava is a **testnet prototype** and has **not had an independent security review**. Do not use it with funds or communications you cannot afford to lose.

## Reporting a vulnerability

Please report vulnerabilities privately. Open a GitHub security advisory on the repository, or send an encrypted NIP-17 message to the maintainer key in `docs/RELEASE_KEY` once it is published. Include reproduction steps. We aim to acknowledge reports within 72 hours. Please do not open public issues for unpatched vulnerabilities.

## Running the security tests

```bash
pnpm install
pnpm test          # unit and integration tests: real relays, real anvil chain
pnpm test:crops    # CROPS acceptance suite (P-, S-, C-, O- criteria)
pnpm test:e2e      # browser tests (Playwright): UI flow, WebRTC ICE (P-07), storage scan
```

Requirements: Node 22.12+, pnpm 9, and Foundry (`anvil`) on the PATH. No external network access is needed: every test runs against local relays and a local chain. **No automated test ever uses real funds.**

The in-app **Privacy Observatory** runs 14 checks in the user's own browser against their real configuration. See `packages/observatory/src/tests.ts` for exactly what each one does.

## Design rules (enforced in code or tests)

| Rule | Enforcement |
|---|---|
| No custom cryptography | Nostr crypto from `nostr-tools` / `@noble`; EIP-712 and ABI from `viem`; blind RSA from `@cloudflare/privacypass-ts` |
| Identity keys never leave the device | No backend exists; P-05 scans relay storage for keys |
| No plaintext keys at rest | NIP-49 vault; S-02 and OBS-11 scan storage; ESLint forbids `localStorage.setItem` |
| No unsafe HTML | ESLint forbids `dangerouslySetInnerHTML`, `eval`, and `new Function`; React escapes text |
| Strict CSP | Injected at build (`script-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`) |
| Payment requests are not spending authority | Ledger state machine: only `approved` requests can execute (S-10) |
| Never trust a returned hash | Receipt, Transfer log, sender, recipient, amount, token address and confirmations are all checked (S-11, S-12) |
| Tokens identified by address | `TokenRegistry.find(chainId, address)`; symbols are display only |
| Replay protection | Random 32-byte `requestId`, expiry ≤ 30 days, per-device ledger (S-08, S-09) |
| Signed operator metadata | Manifests verified for signature, key, expiry, schema, URL scheme, and pinned key (S-14) |
| Rate limiting on operator services | Reference relay: token bucket per connection, size and subscription caps |
| Pinned dependencies | Exact versions (`save-exact`), lockfile committed, license inventory (O-02) |

## Findings fixed during development

1. **Signature-verification cache bypass.** `nostr-tools`' `verifyEvent` caches a positive result in a symbol property, and object spread copies that symbol. A tampered *clone* of an already-verified event therefore passed verification. Manifest and rotation verification now always verify a freshly built canonical object (`verifyEventStrict`). Regression tests are in `identity.test.ts` and `relay-mesh.test.ts`.
2. **Community admin bootstrap.** Accepting an admin-signed roster without its history would let anyone forge a community "founded" by someone else. Rosters now ship with their full chain from the founder-signed genesis. Tested in `communities.test.ts`.
3. **Stale chain head in confirmation counting.** viem caches `getBlockNumber` for about 4 s, which made fresh receipts report 0 confirmations. The error was conservative (pending, never a false "verified"), but it broke settlement. Verification now always reads a fresh head.
4. **Release manifest computed too early.** `release.json` hashed chunks before Vite finished rewriting them, so OBS-14 correctly reported **FAIL** on a genuine build. Hashes are now computed from the files on disk after the build completes.
5. **Effect cleanup crash in newer Chromium.** `scrollIntoView()` now returns a Promise, which an expression-bodied React effect returned as its "cleanup", crashing the Messages page on navigation. Found by the Playwright suite and fixed; all routes now also have an error element.

## Known limitations

- A compromised **unlocked** device exposes the identity key. JavaScript cannot reliably wipe memory; `zeroize` is best effort.
- Replay protection is per device. A request paid on device A is not known to device B.
- A **malicious RPC** can fabricate receipts in direct and anonymous RPC modes. Use **verified RPC mode** (Helios light client, Sepolia and mainnet; tested by S-16 against an RPC that lies about a receipt), run your own node, or cross-check providers before relying on large payments.
- **Anonymous RPC mode** trusts the hash-pinned Anon-RPC worker with every read it carries. Aava pins the hash on first use and refuses changed code until you accept it (P-10). The harness and Kohaku packages are pre-1.0 and unaudited, and so is Aava.
- **Private payments hold keys.** Aava keeps a separate Kohaku recovery phrase for shielded Tornado notes (NIP-49-encrypted at rest, in memory while unlocked). A compromised unlocked device can spend shielded testnet funds. `@kohaku-eth/tornado-cash` is alpha and still undergoing audits, and `@kohaku-eth/plugins` declares no license (see docs/third-party-licenses.json).
- If a creator's wallet is compromised, the attacker can sign valid requests. The contact-wallet or treasury policy is the last line of defence.
- Key rotation is a signed notice, not revocation.
- Builds are not yet reproducible. Release hashes let you compare what is served against what was published (OBS-14), but they do not prove the release matches the source.

## Recovery threat model

| Scenario | Outcome |
|---|---|
| Lost device, backup file and password available | Full recovery: identity from the backup, message history re-synced from relays (S-03), contacts restored from history |
| Lost device, no backup | Identity is unrecoverable by design. There is no server-side escrow |
| Backup file stolen | Attacker must brute-force the password against scrypt (log_n ≥ 16). Use a long passphrase |
| Device password forgotten, backup available | Erase the device and restore from the backup |
| Key believed compromised | Rotate (notifies contacts), make a new backup, and ask contacts to verify the new key out of band |
