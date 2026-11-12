# Initial Audit

Date: 2026-11-05. Scope: the local workspace and the candidate upstream repositories named in the build brief.

## 1. Workspace

| Item | Finding |
|---|---|
| `EF/` working directory | Empty, not a git repository. Aava is a greenfield build. |
| Local Aava checkout | None found under the parent folder. |
| Local OpenLavatory checkout | None found. No public location known. **Out of scope until a path or URL is provided.** |
| Local Wraps checkout | None. Inspected from GitHub (public). |

Toolchain present: Node 24, pnpm 9, Docker 29, git, Foundry (anvil, forge 1.8). **Rust is not installed**, so the Tauri 2 desktop shell cannot be built in this environment.

## 2. Wraps (`github.com/hrishabhayush/wraps`)

- **License:** MIT, which is compatible with Aava (MIT).
- **Purpose:** a privacy layer for AI agents paying via x402 on XRPL. Agents buy RFC 9578 blind tokens and spend them through an attested relay/VPN.
- **Packages:**
  - `packages/tokens` wraps Cloudflare `@cloudflare/privacypass-ts` (RFC 9578 token type `0x0002`, blind RSA).
  - `packages/attestation` verifies Google Confidential Space tokens (AMD SEV, debug-off, image digest, nonce, TLS key hash).
  - `packages/spybot` analyses XRPL x402 payments for wallet linkage.
- **Nostr / NIP-17 / NIP-59 / NIP-44:** not implemented.
- **TURN:** not implemented. **WireGuard:** used for its VPN product.
- **Trust assumptions stated upstream:** the issuer runs in Confidential Space. The design trusts Google attestation and AMD SEV (not SEV-SNP). Image builds are not reproducible. Testnet prototype only.

### Reuse decision

| Capability | Decision |
|---|---|
| Blind tokens (RFC 9578) | Depend directly on `@cloudflare/privacypass-ts` / `@cloudflare/blindrsa-ts`, the same reviewed libraries Wraps uses, with a Wraps-compatible token type (`0x0002`). This avoids vendoring an XRPL-specific wrapper. |
| Attestation | **Not reused in the local demo.** Confidential Space cannot be reproduced locally. The blind-token module records the attestation status as `NOT VERIFIED` instead of pretending. |
| x402 / XRPL payment flow | Not reused. Aava targets EVM chains (local anvil, Gnosis/Chiado by configuration). |

## 3. Established implementations selected (instead of writing cryptography)

| Need | Implementation | License |
|---|---|---|
| NIP-01 events, Schnorr signatures | `nostr-tools` (uses `@noble/curves`) | Unlicense / MIT |
| NIP-44 v2 encryption | `nostr-tools/nip44` (`@noble/ciphers`) | Unlicense / MIT |
| NIP-59 gift wrap, NIP-17 DMs | `nostr-tools/nip59`, `nostr-tools/nip17` | Unlicense |
| Encrypted key backup | NIP-49 `ncryptsec` (scrypt + XChaCha20-Poly1305) via `nostr-tools/nip49` | Unlicense |
| EIP-712, receipts, ABI decoding | `viem` | MIT |
| Blind RSA tokens | `@cloudflare/privacypass-ts` | Apache-2.0 |
| Relay software (independent operator) | `nostr-rs-relay` (Docker image) | MIT |

**Note on the KDF.** The brief suggests Argon2id. Aava uses NIP-49, an existing Nostr standard (scrypt, log_n ≥ 16, with XChaCha20-Poly1305), so backups interoperate with other Nostr clients and no new format is invented. scrypt is an "appropriately configured alternative" per the brief.

## 4. Security gaps to address (none exist in code yet)

1. No standard Nostr key-rotation NIP exists. Rotation in Aava is a local operation plus a signed notice delivered over NIP-17. It is not a network-wide revocation.
2. NIP-17 groups are not a scalable group-encryption protocol, and they have no forward secrecy. Communities are therefore marked experimental.
3. Browsers cannot force WebSocket/fetch traffic through Tor. Only the Tor Browser or an OS-level proxy can do that.
4. WalletConnect needs a project ID from a hosted service, so it is documented as missing configuration. Injected EIP-1193 wallets work without it.
