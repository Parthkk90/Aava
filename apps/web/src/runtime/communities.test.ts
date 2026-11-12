import { describe, expect, it } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from "nostr-tools/pure";
import { ROSTER_KIND, validateRoster, validateRosterChain, type Roster } from "./communities.ts";

const founderSk = generateSecretKey();
const adminSk = generateSecretKey();
const memberSk = generateSecretKey();
const F = getPublicKey(founderSk);
const A = getPublicKey(adminSk);
const M = getPublicKey(memberSk);

function sign(r: Roster, sk: Uint8Array): NostrEvent {
  return finalizeEvent({ kind: ROSTER_KIND, created_at: 1_800_000_000 + r.version, tags: [["d", `relaymesh/community/${r.id}`]], content: JSON.stringify(r) }, sk);
}
const genesis: Roster = { v: 1, id: "c0ffee", name: "Co-op", description: "", founder: F, admins: [F], members: [F], treasuryWallets: [], version: 1, createdAt: 1 };

describe("community rosters (experimental)", () => {
  it("accepts a founder-signed genesis and a valid chain of updates", () => {
    const v2 = { ...genesis, admins: [F, A], members: [F, A], version: 2 };
    const v3 = { ...v2, members: [F, A, M], version: 3 }; // admin invites a member
    const chain = [sign(genesis, founderSk), sign(v2, founderSk), sign(v3, adminSk)];
    expect(validateRosterChain(chain).members).toEqual([F, A, M]);
  });

  it("rejects a forged community that claims someone else as founder", () => {
    const forged = { ...genesis, admins: [F, M], members: [F, M] };
    expect(() => validateRosterChain([sign(forged, memberSk)])).toThrow(/signed by its founder/);
  });

  it("rejects an admin-signed roster delivered without its chain", () => {
    const v2 = { ...genesis, admins: [F, A], members: [F, A, M], version: 2 };
    expect(() => validateRosterChain([sign(v2, adminSk)])).toThrow();
  });

  it("rejects updates from non-admins, stale versions, admin escalation, and treasury changes by admins", () => {
    const g = sign(genesis, founderSk);
    const v2 = { ...genesis, admins: [F, A], members: [F, A, M], version: 2 };
    const e2 = sign(v2, founderSk);
    const known = validateRosterChain([g, e2]);
    expect(() => validateRoster(sign({ ...v2, members: [F, A], version: 3 }, memberSk), known)).toThrow(/not signed by an admin/);
    expect(() => validateRoster(sign({ ...v2, version: 2 }, founderSk), known)).toThrow(/Stale/);
    expect(() => validateRoster(sign({ ...v2, admins: [F, A, M], version: 3 }, adminSk), known)).toThrow(/Only the founder can change admins/);
    expect(() => validateRoster(sign({ ...v2, treasuryWallets: ["0x0000000000000000000000000000000000000001"], version: 3 }, adminSk), known)).toThrow(/treasury/);
  });

  it("rejects tampered roster content and oversized groups", () => {
    const g = sign(genesis, founderSk);
    expect(() => validateRoster({ ...g, content: g.content.replace("Co-op", "Evil") })).toThrow(/signature/);
    const big = { ...genesis, members: [F, ...Array.from({ length: 50 }, () => getPublicKey(generateSecretKey()))] };
    expect(() => validateRoster(sign(big, founderSk))).toThrow(/limited/);
  });
});
