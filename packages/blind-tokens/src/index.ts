/**
 * EXPERIMENTAL: RFC 9578 (Privacy Pass) publicly verifiable blind-RSA tokens,
 * token type 0x0002: the same construction and library
 * (@cloudflare/privacypass-ts) used by Wraps.
 *
 * Stages and who observes what:
 *
 *   ┌─────────────┬─────────────────────────────────────────────┬──────────────────────────────────────────────┐
 *   │ Stage       │ Observer learns                             │ Observer does NOT learn                      │
 *   ├─────────────┼─────────────────────────────────────────────┼──────────────────────────────────────────────┤
 *   │ Top-up      │ Chain: payer wallet, amount, issuer, time   │ which tokens will be minted                  │
 *   │ Issuance    │ Issuer: top-up tx, number of blinded msgs   │ the tokens' nonces (blinded)                 │
 *   │ Redemption  │ Merchant: a valid token for its challenge,  │ which top-up/wallet paid for it              │
 *   │             │ the request itself, client IP               │                                              │
 *   │ Double spend│ Merchant: token nonce (stored)              │ anything linking nonce to issuance           │
 *   └─────────────┴─────────────────────────────────────────────┴──────────────────────────────────────────────┘
 *
 * Trust assumptions: the issuer is assumed to use one key for everyone (a
 * per-user key would deanonymise). Wraps addresses this with TEE attestation
 * (Google Confidential Space); that cannot be reproduced locally, so local
 * attestation status is always "not-verified". Timing correlation between a
 * top-up and an immediate redemption remains possible.
 *
 * This module must be explicitly enabled: every constructor requires
 * `{ experimental: true }`.
 */
import { publicVerif, TOKEN_TYPES, TokenChallenge, Token } from "@cloudflare/privacypass-ts";
import type { Address, Hash } from "viem";
import { verifyTokenTransfer, type VerifierClient } from "@relaymesh/chain";

const { BlindRSAMode, Client, Issuer, Origin, getPublicKeyBytes, TokenRequest, TokenResponse } = publicVerif;
const MODE = BlindRSAMode.PSS;

export interface ExperimentalFlag {
  experimental: true;
}
function requireFlag(o: Partial<ExperimentalFlag>) {
  if (o.experimental !== true) throw new Error("Blind tokens are experimental and must be explicitly enabled ({ experimental: true })");
}

export interface AttestationResult {
  status: "verified" | "not-verified";
  detail: string;
}

/** Local runs cannot verify issuer TEE attestation; never report otherwise. */
export function localAttestation(): AttestationResult {
  return {
    status: "not-verified",
    detail: "No TEE attestation is available in local mode. The issuer is trusted to use a single key for all users and not to log linkable metadata.",
  };
}

export interface KeyValueLike {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
async function sha256(b: Uint8Array) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(b)));
}

/* ------------------------------------------------------------------ issuer */

export interface IssuerOptions extends ExperimentalFlag {
  name: string;
  /** Price per token in token base units. */
  denomination: bigint;
  chainId: number;
  token: Address;
  treasury: Address;
  verifier: VerifierClient;
  requiredConfirmations?: number;
  /** Records which top-up transactions were already used (replay protection). */
  store: KeyValueLike;
  modulusLength?: 2048 | 4096;
}

/**
 * Issues blind tokens only against a verified on-chain top-up. Each top-up
 * transaction can be redeemed for exactly amount / denomination tokens, once.
 */
export class BlindTokenIssuer {
  private constructor(
    private readonly issuer: InstanceType<typeof Issuer>,
    private readonly o: IssuerOptions,
  ) {}

  static async create(o: IssuerOptions) {
    requireFlag(o);
    const keys = await Issuer.generateKey(MODE, { modulusLength: o.modulusLength ?? 2048, publicExponent: Uint8Array.from([1, 0, 1]) });
    return new BlindTokenIssuer(new Issuer(MODE, o.name, keys.privateKey, keys.publicKey), o);
  }

  get name() {
    return this.o.name;
  }
  get publicKey(): CryptoKey {
    return this.issuer.publicKey;
  }
  publicKeyBytes() {
    return getPublicKeyBytes(this.issuer.publicKey);
  }

  async issue(topUp: { txHash: Hash; payer: Address }, requests: Uint8Array[]): Promise<Uint8Array[]> {
    const usedKey = `blind-issuer.used.${topUp.txHash.toLowerCase()}`;
    if (await this.o.store.get(usedKey)) throw new Error("Top-up transaction already used for issuance");
    const amount = this.o.denomination * BigInt(requests.length);
    const report = await verifyTokenTransfer(
      this.o.verifier,
      topUp.txHash,
      { chainId: this.o.chainId, token: this.o.token, from: topUp.payer, to: this.o.treasury, amount },
      this.o.requiredConfirmations ?? 1,
    );
    if (report.status !== "verified") throw new Error(`Top-up not verified (${report.status}): ${report.checks.filter((c) => !c.ok).map((c) => c.detail).join("; ")}`);
    // Mark before signing so a concurrent retry cannot double-issue.
    await this.o.store.set(usedKey, String(Date.now()));
    const out: Uint8Array[] = [];
    for (const raw of requests) {
      const req = TokenRequest.deserialize(TOKEN_TYPES.BLIND_RSA, raw);
      out.push((await this.issuer.issue(req)).serialize());
    }
    return out;
  }
}

/* --------------------------------------------------------------- merchant */

export interface RedeemerOptions extends ExperimentalFlag {
  issuerName: string;
  issuerPublicKey: CryptoKey;
  originInfo: string[];
  spent: KeyValueLike;
}

/**
 * Merchant side. Publishes a challenge with an EMPTY redemption context so
 * tokens can be obtained in advance (decoupling issuance time from use),
 * verifies signature and challenge binding, and rejects double spends.
 */
export class BlindTokenRedeemer {
  private readonly origin: InstanceType<typeof Origin>;
  readonly challenge: InstanceType<typeof TokenChallenge>;

  constructor(private readonly o: RedeemerOptions) {
    requireFlag(o);
    this.origin = new Origin(MODE, o.originInfo);
    this.challenge = this.origin.createTokenChallenge(o.issuerName, new Uint8Array(0));
  }

  challengeBytes(): Uint8Array {
    return this.challenge.serialize();
  }

  async redeem(tokenBytes: Uint8Array): Promise<{ ok: true; nonce: string } | { ok: false; reason: string }> {
    let token: Token;
    try {
      token = Token.deserialize(TOKEN_TYPES.BLIND_RSA, tokenBytes);
    } catch {
      return { ok: false, reason: "malformed token" };
    }
    const expectedDigest = await sha256(this.challenge.serialize());
    if (hex(token.authInput.challengeDigest) !== hex(expectedDigest)) return { ok: false, reason: "token was issued for a different challenge" };
    if (!(await this.origin.verify(token, this.o.issuerPublicKey))) return { ok: false, reason: "invalid token signature" };
    const nonce = hex(token.authInput.nonce);
    const key = `blind-redeemer.spent.${nonce}`;
    if (await this.o.spent.get(key)) return { ok: false, reason: "token already spent" };
    await this.o.spent.set(key, String(Date.now()));
    return { ok: true, nonce };
  }
}

/* ----------------------------------------------------------------- client */

/** Client side: blinds requests, unblinds responses, holds finished tokens. */
export class BlindTokenWallet {
  private readonly tokens: Uint8Array[] = [];
  constructor(flag: ExperimentalFlag) {
    requireFlag(flag);
  }

  /** Prepares n blinded requests for a merchant challenge. Returns serialized requests and a finalizer. */
  async prepare(challengeBytes: Uint8Array, issuerPublicKey: Uint8Array, n: number) {
    const challenge = TokenChallenge.deserialize(challengeBytes);
    const clients: InstanceType<typeof Client>[] = [];
    const requests: Uint8Array[] = [];
    for (let i = 0; i < n; i++) {
      const c = new Client(MODE);
      requests.push((await c.createTokenRequest(challenge, issuerPublicKey)).serialize());
      clients.push(c);
    }
    return {
      requests,
      finalize: async (responses: Uint8Array[]) => {
        if (responses.length !== clients.length) throw new Error("Response count mismatch");
        for (let i = 0; i < clients.length; i++) {
          const token = await clients[i]!.finalize(TokenResponse.deserialize(responses[i]!));
          this.tokens.push(token.serialize());
        }
        return this.tokens.length;
      },
    };
  }

  take(): Uint8Array | undefined {
    return this.tokens.shift();
  }

  get balance() {
    return this.tokens.length;
  }
}
