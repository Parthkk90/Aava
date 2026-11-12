import { finalizeEvent, generateSecretKey, verifyEvent, type NostrEvent } from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";
import type { Address } from "viem";
import type { StoredMessage } from "@relaymesh/messaging";
import { TreasuryPolicy, communityIdFromString, type PaymentPolicy } from "@relaymesh/payments";
import type { AppRuntime } from "./runtime.ts";

/**
 * EXPERIMENTAL small-group communities.
 *
 * Construction: a founder-signed roster (NIP-01 event, kind 30078) is the
 * source of truth for membership and roles. Rosters, invitations, and group
 * messages travel ONLY inside NIP-17 gift wraps to each member, so relays
 * never see a membership list. Group messages are NIP-17 messages addressed
 * to every member with an ["h", communityId] tag.
 *
 * Known limitations (documented, not hidden):
 *  - No forward secrecy; removed members keep messages they already received.
 *  - Cost grows linearly with members (one gift wrap per member per message); capped at 50.
 *  - Moderation is enforced by honest clients, not cryptographically.
 *  - This is not MLS. A reviewed group protocol is a future upgrade.
 */
export const ROSTER_KIND = 30078;
export const MAX_MEMBERS = 50;

export interface Roster {
  v: 1;
  id: string;
  name: string;
  description: string;
  founder: string;
  admins: string[];
  members: string[];
  treasuryWallets: Address[];
  version: number;
  createdAt: number;
}

export interface Community {
  roster: Roster;
  rosterEvent: NostrEvent;
  /** Every accepted roster event from the founder-signed genesis onward. */
  history: NostrEvent[];
  hidden: string[];
}

/** Validates a full roster chain starting at the founder-signed genesis. */
export function validateRosterChain(chain: NostrEvent[]): Roster {
  if (chain.length === 0) throw new Error("Empty roster chain");
  let roster: Roster | undefined;
  for (const ev of chain) roster = validateRoster(ev, roster);
  return roster!;
}

const dTag = (id: string) => `relaymesh/community/${id}`;

function verifyStrict(e: NostrEvent) {
  try {
    return verifyEvent({ id: e.id, pubkey: e.pubkey, created_at: e.created_at, kind: e.kind, tags: e.tags, content: e.content, sig: e.sig });
  } catch {
    return false;
  }
}

/** Validates a roster event against the previously known roster (if any). Returns the parsed roster or throws. */
export function validateRoster(event: NostrEvent, known?: Roster): Roster {
  if (event.kind !== ROSTER_KIND || !verifyStrict(event)) throw new Error("Invalid roster signature");
  const r = JSON.parse(event.content) as Roster;
  if (r.v !== 1 || !event.tags.some((t) => t[0] === "d" && t[1] === dTag(r.id))) throw new Error("Roster format not recognised");
  if (!r.members.includes(r.founder) || !r.admins.includes(r.founder)) throw new Error("Founder must be an admin and member");
  if (r.members.length > MAX_MEMBERS) throw new Error(`Experimental communities are limited to ${MAX_MEMBERS} members`);
  if (!r.admins.every((a) => r.members.includes(a))) throw new Error("Every admin must be a member");
  if (!known) {
    if (event.pubkey !== r.founder) throw new Error("A new community roster must be signed by its founder");
    return r;
  }
  if (r.id !== known.id || r.founder !== known.founder) throw new Error("Roster does not belong to this community");
  if (r.version <= known.version) throw new Error("Stale roster version");
  const signerIsFounder = event.pubkey === known.founder;
  const signerIsAdmin = known.admins.includes(event.pubkey);
  if (!signerIsFounder && !signerIsAdmin) throw new Error("Roster update not signed by an admin");
  if (!signerIsFounder) {
    const sameAdmins = r.admins.length === known.admins.length && r.admins.every((a) => known.admins.includes(a));
    if (!sameAdmins) throw new Error("Only the founder can change admins");
    if (JSON.stringify(r.treasuryWallets) !== JSON.stringify(known.treasuryWallets)) throw new Error("Only the founder can change treasury wallets");
  }
  return r;
}

export class CommunityManager {
  private communities = new Map<string, Community>();
  constructor(private readonly rt: AppRuntime) {}

  private key() {
    return `relaymesh.communities.v1.${this.rt.identity!.pubkey}`;
  }

  async load() {
    // Communities are reconstructed from roster messages in the (encrypted) local history.
    const msgs = this.rt.store!.all().filter((m) => m.type === "community-invite" || m.type === "community-event");
    for (const m of msgs) await this.handle(m, true);
  }

  list(): Community[] {
    return [...this.communities.values()].sort((a, b) => a.roster.name.localeCompare(b.roster.name));
  }

  get(id: string) {
    return this.communities.get(id);
  }

  private sign(r: Roster): NostrEvent {
    return finalizeEvent({ kind: ROSTER_KIND, created_at: Math.floor(Date.now() / 1000), tags: [["d", dTag(r.id)]], content: JSON.stringify(r) }, this.rt.vault.secretKey());
  }

  async create(name: string, description: string, treasuryWallets: Address[]) {
    const me = this.rt.identity!.pubkey;
    const roster: Roster = {
      v: 1,
      id: bytesToHex(generateSecretKey()).slice(0, 32),
      name: name.trim().slice(0, 80),
      description: description.trim().slice(0, 280),
      founder: me,
      admins: [me],
      members: [me],
      treasuryWallets,
      version: 1,
      createdAt: Math.floor(Date.now() / 1000),
    };
    const ev = this.sign(roster);
    // Note-to-self carries the roster so it survives reinstall via relay history.
    await this.rt.messenger!.send([me], { type: "community-event", content: JSON.stringify({ kind: "roster", chain: [ev] }), extraTags: [["h", roster.id]] });
    this.communities.set(roster.id, { roster, rosterEvent: ev, history: [ev], hidden: [] });
    this.rt.bump();
    return roster.id;
  }

  private async publishRoster(c: Community, next: Roster, extraRecipients: string[] = []) {
    const ev = this.sign(next);
    validateRoster(ev, c.roster);
    const history = [...c.history, ev];
    const recipients = [...new Set([...next.members, ...extraRecipients])];
    // The full chain lets new members verify every role change back to the founder's genesis roster.
    await this.rt.messenger!.send(recipients, { type: "community-event", content: JSON.stringify({ kind: "roster", chain: history }), extraTags: [["h", next.id]] });
    this.communities.set(next.id, { ...c, roster: next, rosterEvent: ev, history });
    this.rt.bump();
  }

  /** Signed invitation: the new roster (containing the invitee) delivered privately to everyone. */
  async invite(id: string, pubkey: string) {
    const c = this.mustAdmin(id);
    if (c.roster.members.includes(pubkey)) throw new Error("Already a member");
    if (c.roster.members.length >= MAX_MEMBERS) throw new Error(`Member limit (${MAX_MEMBERS}) reached`);
    const next = { ...c.roster, members: [...c.roster.members, pubkey], version: c.roster.version + 1 };
    await this.publishRoster(c, next);
  }

  async remove(id: string, pubkey: string) {
    const c = this.mustAdmin(id);
    if (pubkey === c.roster.founder) throw new Error("The founder cannot be removed");
    const next = { ...c.roster, members: c.roster.members.filter((m) => m !== pubkey), admins: c.roster.admins.filter((a) => a !== pubkey), version: c.roster.version + 1 };
    await this.publishRoster(c, next, [pubkey]);
  }

  async setAdmin(id: string, pubkey: string, admin: boolean) {
    const c = this.communities.get(id);
    if (!c || c.roster.founder !== this.rt.identity!.pubkey) throw new Error("Only the founder can change admins");
    const admins = admin ? [...new Set([...c.roster.admins, pubkey])] : c.roster.admins.filter((a) => a !== pubkey || a === c.roster.founder);
    await this.publishRoster(c, { ...c.roster, admins, version: c.roster.version + 1 });
  }

  /** Admin moderation: signed hide request distributed to members; honoured by clients that verify the admin role. */
  async hideMessage(id: string, messageId: string) {
    const c = this.mustAdmin(id);
    const ev = finalizeEvent({ kind: ROSTER_KIND, created_at: Math.floor(Date.now() / 1000), tags: [["d", `relaymesh/community-mod/${id}/${messageId}`]], content: JSON.stringify({ action: "hide", community: id, message: messageId }) }, this.rt.vault.secretKey());
    await this.rt.messenger!.send(c.roster.members, { type: "community-event", content: JSON.stringify({ kind: "moderation", event: ev }), extraTags: [["h", id]] });
    c.hidden.push(messageId);
    this.rt.bump();
  }

  async sendMessage(id: string, text: string) {
    const c = this.communities.get(id);
    if (!c) throw new Error("Unknown community");
    if (!c.roster.members.includes(this.rt.identity!.pubkey)) throw new Error("You are no longer a member");
    await this.rt.messenger!.send(c.roster.members, { type: "text", content: text, extraTags: [["h", id]] });
  }

  messages(id: string): (StoredMessage & { verifiedMember: boolean })[] {
    const c = this.communities.get(id);
    if (!c) return [];
    return this.rt
      .store!.all()
      .filter((m) => m.type === "text" && m.tags.some((t) => t[0] === "h" && t[1] === id))
      .filter((m) => !c.hidden.includes(m.id))
      .map((m) => ({ ...m, verifiedMember: c.roster.members.includes(m.from) }));
  }

  /** Community payment requests are checked against the founder-signed treasury list. */
  policyFor(m: StoredMessage): PaymentPolicy | undefined {
    const id = m.tags.find((t) => t[0] === "h")?.[1];
    const c = id ? this.communities.get(id) : undefined;
    if (!c) return undefined;
    return new TreasuryPolicy({
      communityId: communityIdFromString(c.roster.id),
      authorizedSigners: c.roster.treasuryWallets.map((wallet) => ({ wallet })),
    });
  }

  private mustAdmin(id: string): Community {
    const c = this.communities.get(id);
    if (!c) throw new Error("Unknown community");
    if (!c.roster.admins.includes(this.rt.identity!.pubkey)) throw new Error("Admin role required");
    return c;
  }

  async handle(m: StoredMessage, silent = false) {
    let payload: { kind: string; chain?: NostrEvent[]; event: NostrEvent };
    try {
      payload = JSON.parse(m.content) as typeof payload;
    } catch {
      return;
    }
    if (payload.kind === "roster" && Array.isArray(payload.chain) && payload.chain.length > 0) {
      const chain = payload.chain;
      const latest = chain[chain.length - 1]!;
      try {
        const roster = validateRosterChain(chain);
        const known = this.communities.get(roster.id);
        if (known && known.roster.version >= roster.version) return;
        if (known && known.history[0]!.id !== chain[0]!.id) throw new Error("Roster chain has a different genesis than the community you know");
        this.communities.set(roster.id, { roster, rosterEvent: latest, history: chain, hidden: known?.hidden ?? [] });
        if (!silent) this.rt.store!.annotate(m.id, "community", { ok: true, detail: `Roster v${roster.version} for "${roster.name}" verified back to the founder's genesis` });
      } catch (e) {
        if (!silent) this.rt.store!.annotate(m.id, "community", { ok: false, detail: (e as Error).message });
      }
    } else if (payload.kind === "moderation") {
      const action = JSON.parse(payload.event.content) as { community: string; message: string };
      const c = this.communities.get(action.community);
      if (c && verifyStrict(payload.event) && c.roster.admins.includes(payload.event.pubkey) && !c.hidden.includes(action.message)) c.hidden.push(action.message);
    }
    if (!silent) this.rt.bump();
  }
}
