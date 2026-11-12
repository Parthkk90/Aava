# Implementation Plan and Status

Status key: ✅ done and tested · 🧪 experimental (behind a flag or clearly labelled) · ⏳ not started or blocked.

| Phase | Scope | Status | Evidence |
|---|---|---|---|
| 1 | Repository audit, architecture, threat model | ✅ | `docs/INITIAL_AUDIT.md`, `ARCHITECTURE.md`, `THREAT_MODEL.md` |
| 2 | Frontend foundation and design system | ✅ | `apps/web` (React 19, Vite 8, Tailwind 4, hand-written component kit, strict CSP) |
| 3 | Local identity and encrypted recovery | ✅ | `packages/identity` (NIP-49 vault, backup, verify, rotate, auto-lock); S-02, S-03, OBS-11, OBS-13 |
| 4 | Nostr messaging | ✅ | `packages/messaging` (NIP-17/59/44, typed payloads, encrypted history); P-01, P-02, S-04 |
| 5 | Independent relays and failover | ✅ | `packages/relay-mesh` (failover, outbox, backfill, signed manifests); `apps/relay`; S-13, S-14, C-01..C-04 |
| 6 | Wallet integration | ✅ | EIP-1193 injected wallets, local devnet test wallet, chain switching, balances, token verification |
| 7 | Signed payment requests | ✅ | `packages/payments` (EIP-712, policies, ledger); S-05..S-10, S-12 |
| 8 | On-chain verification | ✅ | `packages/chain/verify.ts`; S-11, S-12, C-05 |
| 9 | Privacy routing and WebRTC | ✅ / ⚠️ | Onion-only policy, RPC selection, TURN config, relay-only ICE (P-07). No calling feature yet: the policy is enforced in the single peer-connection factory |
| 9b | RPC routing: Anon-RPC and Helios via Kohaku | ✅ experimental | One RPC router, fail-closed, worker hash pinning, OBS-15; P-09–P-11, S-15 (CI), S-16 and browser checks (live Sepolia, opt-in) |
| 10 | Privacy Observatory | ✅ | `packages/observatory` (14 tests, PASS/FAIL/LIMITED/NOT TESTED with evidence) |
| 11 | AI agent SDK and merchant demo | ✅ | `packages/agent-sdk` (policy outside the LLM, NIP-17 owner approval, x402 "exact" + EIP-3009); `apps/merchant` |
| 12 | Blind-token integration | 🧪 | `packages/blind-tokens` (RFC 9578 via `@cloudflare/privacypass-ts`, the same library Wraps uses); attestation not verified locally |
| 13 | Security testing, Docker demo, deployment docs | ✅ / ⏳ | CROPS suite, Playwright, `infra/docker-compose.yml`, `pnpm demo`. Open items: O-01 (public remote), O-03 (signed release) |
| — | Communities | 🧪 | Founder-signed roster chain over NIP-17; no forward secrecy; ≤ 50 members |
| — | Tauri desktop shell | ⏳ | Blocked: no Rust toolchain in the build environment. The web app runs unchanged inside Tauri; native secure storage would plug into the `KeyValueStore` interface |
| — | WalletConnect | ⏳ | Needs a hosted project ID; injected EIP-1193 wallets work without it |

## Next upgrades (ordered by impact)

1. **Publish** the repository and a signed release (closes O-01, O-03). Tooling: `scripts/sign-release.ts`.
2. **Self-copy decorrelation:** publish the sender's history copy after a random delay, or to a different relay subset.
3. **NIP-42 AUTH** on relays so gift wraps are served only to their recipient.
4. **MLS** for communities (forward secrecy, efficient groups).
5. **Tauri shell** with OS keychain storage for the vault ciphertext and key-unlock.
6. **Reproducible builds** so release hashes prove the release matches the source.
7. **RPC cross-checking:** partly addressed by verified RPC mode (Helios light client, Sepolia/mainnet). Still open for chains Helios does not support (Gnosis).
8. **Kohaku shielded payments:** Tornado Cash is done (experimental, Sepolia): separate encrypted phrase, deposit from the wallet, paymaster withdrawal. Still open:
   - sweeping the paymaster's unused-gas refund from the note's delegator back into the shielded balance;
   - a fee preview in the UI before sending (`estimateUnshield`);
   - linking a private payment to an Aava payment request, with verification on the recipient's side;
   - Privacy Pools (association sets) as a compliance-friendlier pool;
   - Railgun, once Kohaku's package is out of maintenance;
   - an upstream license for `@kohaku-eth/plugins`.
9. **Anonymous + verified reads together:** Helios's own requests cannot yet be routed through the Anon-RPC worker.
