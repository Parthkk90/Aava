import { useState } from "react";
import { Crown, EyeOff, FlaskConical, Plus, ReceiptText, Send, Shield, ShieldCheck, UserMinus, UserPlus, Users } from "lucide-react";
import { communityIdFromString } from "@relaymesh/payments";
import { parsePubkey } from "@relaymesh/identity";
import { useRuntime } from "../ui/use-runtime.ts";
import { Badge, Button, Callout, Card, CardBody, CardHeader, Empty, ErrorText, Field, Input, Modal, Mono, PageHeader, Textarea, cx, useAction } from "../ui/kit.tsx";
import { MAX_MEMBERS } from "../runtime/communities.ts";
import { PaymentRequestCard } from "../components/PaymentCard.tsx";
import { RequestPaymentForm } from "../components/RequestPaymentForm.tsx";

export function Communities() {
  const rt = useRuntime();
  const list = rt.communities?.list() ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const current = selected ? rt.communities?.get(selected) : list[0];

  return (
    <>
      <PageHeader
        title="Communities"
        badge={
          <Badge tone="warn">
            <FlaskConical className="h-3 w-3" /> experimental
          </Badge>
        }
        subtitle="Small private groups built on NIP-17. A founder-signed roster defines members and roles; rosters, invitations, and messages travel only inside gift wraps, so relays never see a membership list."
        actions={
          <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5" /> New community
          </Button>
        }
      />
      <div className="mb-4">
        <Callout tone="warn" title="Know the limits before relying on this">
          No forward secrecy; removed members keep what they already received. Each message is wrapped once per member (max {MAX_MEMBERS}). Moderation is enforced by honest clients, not by
          cryptography. Discovery happens only through signed invitations: there is no public directory by design. A reviewed group protocol (MLS) is the planned upgrade.
        </Callout>
      </div>
      <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
        <Card className="h-fit">
          <CardHeader title="Your communities" icon={<Users className="h-4 w-4" />} />
          {list.length === 0 ? (
            <Empty title="None yet">Create one, or ask a member to invite your npub.</Empty>
          ) : (
            <ul className="p-1.5">
              {list.map((c) => (
                <li key={c.roster.id}>
                  <button
                    onClick={() => setSelected(c.roster.id)}
                    className={cx("w-full rounded-md px-3 py-2 text-left", current?.roster.id === c.roster.id ? "bg-ink-700" : "hover:bg-ink-800")}
                  >
                    <div className="text-sm text-ink-100">{c.roster.name}</div>
                    <div className="text-[11px] text-ink-400">
                      {c.roster.members.length} members · roster v{c.roster.version}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        {current ? <CommunityView id={current.roster.id} /> : <Card><Empty title="Select or create a community" /></Card>}
      </div>
      <CreateCommunity open={creating} onClose={(id) => { setCreating(false); if (id) setSelected(id); }} />
    </>
  );
}

function CommunityView({ id }: { id: string }) {
  const rt = useRuntime();
  const c = rt.communities!.get(id)!;
  const me = rt.identity!.pubkey;
  const isAdmin = c.roster.admins.includes(me);
  const isFounder = c.roster.founder === me;
  const msgs = rt.communities!.messages(id);
  const requests = (rt.store?.all() ?? []).filter((m) => m.type === "payment-request" && m.tags.some((t) => t[0] === "h" && t[1] === id));
  const [text, setText] = useState("");
  const [invite, setInvite] = useState("");
  const [requesting, setRequesting] = useState(false);
  const send = useAction();
  const admin = useAction();

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title={c.roster.name}
          description={c.roster.description || "No description"}
          actions={
            <Badge tone="violet">
              <ShieldCheck className="h-3 w-3" /> roster v{c.roster.version} verified to founder
            </Badge>
          }
        />
        <CardBody className="grid gap-4 md:grid-cols-2">
          <div>
            <div className="mb-2 text-xs font-medium text-ink-300">Members ({c.roster.members.length})</div>
            <ul className="space-y-1.5">
              {c.roster.members.map((m) => (
                <li key={m} className="flex items-center gap-2 text-xs">
                  {m === c.roster.founder ? <Crown className="h-3.5 w-3.5 text-amber" /> : c.roster.admins.includes(m) ? <Shield className="h-3.5 w-3.5 text-cyan" /> : <span className="w-3.5" />}
                  <span className="text-ink-100">{rt.contactName(m)}</span>
                  <span className="font-mono text-[10px] text-ink-400">{m.slice(0, 8)}</span>
                  {isAdmin && m !== c.roster.founder && m !== me && (
                    <span className="ml-auto flex gap-1">
                      {isFounder && (
                        <button className="text-[10px] text-ink-400 hover:text-ink-100" onClick={() => void admin.run(() => rt.communities!.setAdmin(id, m, !c.roster.admins.includes(m)))}>
                          {c.roster.admins.includes(m) ? "revoke admin" : "make admin"}
                        </button>
                      )}
                      <button className="text-ink-400 hover:text-rose" aria-label="Remove member" onClick={() => void admin.run(() => rt.communities!.remove(id, m))}>
                        <UserMinus className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
          <div className="space-y-3">
            {isAdmin && (
              <form
                className="space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void admin.run(async () => {
                    await rt.communities!.invite(id, parsePubkey(invite));
                    setInvite("");
                  });
                }}
              >
                <Field label="Invite by npub" hint="Sends a signed roster to every member, including the invitee, over NIP-17.">
                  <div className="flex gap-2">
                    <Input value={invite} onChange={(e) => setInvite(e.target.value)} className="font-mono text-xs" placeholder="npub1…" />
                    <Button size="sm" type="submit" loading={admin.busy}>
                      <UserPlus className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </Field>
              </form>
            )}
            <div className="text-xs">
              <div className="mb-1 font-medium text-ink-300">Treasury wallets (founder-signed)</div>
              {c.roster.treasuryWallets.length ? c.roster.treasuryWallets.map((w) => <Mono key={w} value={w} />) : <span className="text-ink-400">None: community payment requests will be rejected.</span>}
            </div>
            {c.roster.treasuryWallets.some((w) => w.toLowerCase() === rt.wallet.state.account?.toLowerCase()) && (
              <Button size="sm" onClick={() => setRequesting(true)}>
                <ReceiptText className="h-3.5 w-3.5" /> Treasury payment request
              </Button>
            )}
            <ErrorText error={admin.error} />
          </div>
        </CardBody>
      </Card>

      {requests.length > 0 && (
        <div className="grid gap-3 md:grid-cols-2">
          {requests.map((m) => (
            <PaymentRequestCard key={m.id} m={m} />
          ))}
        </div>
      )}

      <Card>
        <CardHeader title="Conversation" description="Messages from keys that are not on the current roster are hidden." />
        <div className="max-h-[420px] space-y-3 overflow-y-auto px-5 py-4 scroll-thin">
          {msgs.length === 0 && <p className="text-center text-xs text-ink-400">No messages yet.</p>}
          {msgs.map((m) =>
            m.verifiedMember ? (
              <div key={m.id} className="group">
                <div className="flex items-center gap-2 text-[11px] text-ink-400">
                  <span className="text-ink-200">{rt.contactName(m.from)}</span>
                  <span>{new Date(m.createdAt * 1000).toLocaleString()}</span>
                  {isAdmin && (
                    <button className="hidden text-ink-400 hover:text-rose group-hover:inline" onClick={() => void admin.run(() => rt.communities!.hideMessage(id, m.id))} aria-label="Hide message for all members">
                      <EyeOff className="h-3 w-3" />
                    </button>
                  )}
                </div>
                <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-ink-100">{m.content}</p>
              </div>
            ) : null,
          )}
        </div>
        <form
          className="flex gap-2 border-t border-ink-700 px-5 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!text.trim()) return;
            void send.run(async () => {
              await rt.communities!.sendMessage(id, text.trim());
              setText("");
            });
          }}
        >
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={`Message ${c.roster.members.length} members…`} />
          <Button type="submit" variant="primary" loading={send.busy} aria-label="Send">
            <Send className="h-4 w-4" />
          </Button>
        </form>
        <div className="px-5 pb-3">
          <ErrorText error={send.error} />
        </div>
      </Card>
      <Modal open={requesting} title="Treasury payment request" onClose={() => setRequesting(false)}>
        <RequestPaymentForm
          to={c.roster.members.find((m) => m !== me) ?? me}
          recipients={c.roster.members.filter((m) => m !== me)}
          communityId={communityIdFromString(c.roster.id)}
          onDone={() => setRequesting(false)}
        />
      </Modal>
    </div>
  );
}

function CreateCommunity({ open, onClose }: { open: boolean; onClose: (id?: string) => void }) {
  const rt = useRuntime();
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [useWallet, setUseWallet] = useState(true);
  const { busy, error, run } = useAction();
  const account = rt.wallet.state.account;
  return (
    <Modal open={open} title="New community" onClose={() => onClose()}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            if (!name.trim()) throw new Error("Name is required");
            const id = await rt.communities!.create(name, desc, useWallet && account ? [account] : []);
            setName("");
            setDesc("");
            onClose(id);
          });
        }}
      >
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        </Field>
        <Field label="Description">
          <Textarea value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={280} />
        </Field>
        <label className="flex items-start gap-2 text-xs text-ink-200">
          <input type="checkbox" className="mt-0.5 accent-violet" checked={useWallet && !!account} disabled={!account} onChange={(e) => setUseWallet(e.target.checked)} />
          <span>
            Use my connected wallet as the treasury signer{account ? <span className="font-mono"> ({account.slice(0, 10)}…)</span> : " (connect a wallet first)"}. Only treasury wallets can issue
            community payment requests.
          </span>
        </label>
        <ErrorText error={error} />
        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={busy}>
            Create
          </Button>
        </div>
      </form>
    </Modal>
  );
}
