import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { AlertCircle, ArrowLeft, Check, CheckCheck, Clock, Lock, MessageSquarePlus, ReceiptText, Send, UserPlus } from "lucide-react";
import type { StoredMessage } from "@relaymesh/messaging";
import { useRuntime } from "../ui/use-runtime.ts";
import { Badge, Button, Callout, Empty, ErrorText, Field, Input, Modal, Mono, cx, timeAgo, useAction } from "../ui/kit.tsx";
import { PaymentRequestCard, ReceiptCard, RotationCard } from "../components/PaymentCard.tsx";
import { RequestPaymentForm } from "../components/RequestPaymentForm.tsx";

function DeliveryStatus({ m }: { m: StoredMessage }) {
  if (m.direction === "in") return null;
  const ok = m.relays.filter((r) => r.ok).length;
  const title = m.relays.map((r) => `${r.url}: ${r.ok ? "accepted" : r.message}`).join("\n") || m.status;
  const icon =
    m.status === "sent" ? <CheckCheck className="h-3 w-3 text-mint" /> : m.status === "sending" ? <Clock className="h-3 w-3" /> : m.status === "queued" ? <Clock className="h-3 w-3 text-amber" /> : m.status === "failed" ? <AlertCircle className="h-3 w-3 text-rose" /> : <Check className="h-3 w-3" />;
  return (
    <span className="inline-flex items-center gap-1" title={title}>
      {icon}
      {m.status === "sent" ? `${ok} relay${ok === 1 ? "" : "s"}` : m.status}
    </span>
  );
}

function Bubble({ m }: { m: StoredMessage }) {
  const out = m.direction === "out";
  const body =
    m.type === "payment-request" ? (
      <PaymentRequestCard m={m} />
    ) : m.type === "payment-receipt" ? (
      <ReceiptCard m={m} />
    ) : m.type === "key-rotation" ? (
      <RotationCard m={m} />
    ) : (
      <div className={cx("max-w-[min(32rem,85%)] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm", out ? "rounded-br-sm bg-violet/90 text-white" : "rounded-bl-sm bg-ink-700 text-ink-100")}>{m.content}</div>
    );
  return (
    <div className={cx("flex flex-col gap-1", out ? "items-end" : "items-start")}>
      {body}
      <div className="flex items-center gap-2 px-1 text-[10px] text-ink-400">
        <span>{new Date(m.createdAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
        <DeliveryStatus m={m} />
        {m.direction === "in" && m.seenOn.length > 0 && <span title={m.seenOn.join("\n")}>via {m.seenOn.length} relay{m.seenOn.length === 1 ? "" : "s"}</span>}
      </div>
    </div>
  );
}

function AddContact({ open, onClose }: { open: boolean; onClose: (pubkey?: string) => void }) {
  const rt = useRuntime();
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const { error, run } = useAction();
  return (
    <Modal open={open} title="Add contact" onClose={() => onClose()}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const pk = rt.addContact(key, name);
            setKey("");
            setName("");
            onClose(pk);
          });
        }}
      >
        <Field label="Public key" hint="npub1… or 64-character hex. Verify it with your contact through another channel.">
          <Input value={key} onChange={(e) => setKey(e.target.value)} className="font-mono text-xs" placeholder="npub1…" spellCheck={false} />
        </Field>
        <Field label="Name (stored encrypted on this device)">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
        </Field>
        <ErrorText error={error} />
        <div className="flex justify-end">
          <Button type="submit" variant="primary">
            Add contact
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function Messages() {
  const rt = useRuntime();
  const { peer } = useParams();
  const nav = useNavigate();
  const [adding, setAdding] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [text, setText] = useState("");
  const { busy, error, run } = useAction();
  const endRef = useRef<HTMLDivElement>(null);
  const me = rt.identity!.pubkey;

  const contacts = rt.store?.listContacts() ?? [];
  const convs = (rt.store?.conversations() ?? []).filter((c) => c.participants.length === 2 && !c.last.tags.some((t) => t[0] === "h"));
  const peers = useMemo(() => {
    const set = new Map<string, number>();
    for (const c of contacts) set.set(c.pubkey, 0);
    for (const c of convs) {
      const other = c.participants.find((p) => p !== me);
      if (other) set.set(other, c.last.createdAt);
    }
    return [...set.entries()].sort((a, b) => b[1] - a[1]).map(([pk]) => pk);
  }, [contacts, convs, me]);

  const thread = peer ? (rt.store?.conversation(rt.conversationWith(peer)) ?? []).filter((m) => !m.tags.some((t) => t[0] === "h") && m.subject !== "observatory-probe") : [];
  useEffect(() => {
    // Block body on purpose: newer Chromium returns a Promise from scrollIntoView,
    // which React would otherwise treat as an effect cleanup and crash on unmount.
    void endRef.current?.scrollIntoView({ block: "end" });
  }, [thread.length, peer]);
  const isContact = !!peer && !!rt.store?.contact(peer);

  return (
    <div className="-mx-4 -my-6 flex h-[calc(100vh-3.5rem)] sm:-mx-6 lg:-mx-8 lg:-my-8 lg:h-screen">
      <aside className={cx("w-full shrink-0 flex-col border-r border-ink-700 bg-ink-950 md:flex md:w-72", peer ? "hidden" : "flex")}>
        <div className="flex items-center justify-between border-b border-ink-700 px-4 py-3">
          <h1 className="text-sm font-semibold">Messages</h1>
          <Button size="sm" variant="ghost" onClick={() => setAdding(true)} aria-label="Add contact">
            <UserPlus className="h-4 w-4" />
          </Button>
        </div>
        <ul className="flex-1 overflow-y-auto scroll-thin">
          {peers.length === 0 && (
            <Empty icon={<MessageSquarePlus className="h-6 w-6" />} title="No contacts">
              Add someone by their npub to start an end-to-end encrypted conversation.
            </Empty>
          )}
          {peers.map((pk) => {
            const last = (rt.store?.conversation(rt.conversationWith(pk)) ?? []).filter((m) => !m.tags.some((t) => t[0] === "h")).at(-1);
            return (
              <li key={pk}>
                <Link to={`/app/messages/${pk}`} className={cx("flex items-center gap-3 border-b border-ink-800 px-4 py-3 hover:bg-ink-850", peer === pk && "bg-ink-800")}>
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink-700 font-mono text-xs text-violet-soft">{rt.contactName(pk).slice(0, 2).toUpperCase()}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm text-ink-100">{rt.contactName(pk)}</span>
                      {last && <span className="shrink-0 text-[10px] text-ink-400">{timeAgo(last.createdAt * 1000)}</span>}
                    </div>
                    <div className="truncate text-xs text-ink-400">{last ? (last.type === "text" ? last.content : last.type === "payment-request" ? "Payment request" : last.type) : "No messages yet"}</div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      </aside>

      <section className={cx("min-w-0 flex-1 flex-col", peer ? "flex" : "hidden md:flex")}>
        {!peer ? (
          <div className="flex flex-1 items-center justify-center">
            <Empty icon={<Lock className="h-6 w-6" />} title="Select a conversation">
              Messages are NIP-17 gift-wrapped: relays store only ciphertext signed by one-time keys.
            </Empty>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3 border-b border-ink-700 px-4 py-3">
              <button className="text-ink-300 md:hidden" onClick={() => nav("/app/messages")} aria-label="Back">
                <ArrowLeft className="h-4 w-4" />
              </button>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold">{rt.contactName(peer)}</div>
                <Mono value={peer} />
              </div>
              <Badge tone="good">
                <Lock className="h-3 w-3" /> NIP-17
              </Badge>
              <Button size="sm" onClick={() => setRequesting(true)}>
                <ReceiptText className="h-3.5 w-3.5" /> Request payment
              </Button>
            </div>
            {!isContact && (
              <div className="px-4 pt-3">
                <Callout tone="warn">
                  This key is not in your contacts. Messages from unknown keys can be spam or impersonation.{" "}
                  <button className="underline" onClick={() => rt.addContact(peer, "")}>
                    Add contact
                  </button>
                </Callout>
              </div>
            )}
            <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4 scroll-thin">
              {thread.length === 0 && <p className="py-8 text-center text-xs text-ink-400">No messages yet. Say hello: only {rt.contactName(peer)} can read it.</p>}
              {thread.map((m) => (
                <Bubble key={m.id} m={m} />
              ))}
              <div ref={endRef} />
            </div>
            <form
              className="flex items-end gap-2 border-t border-ink-700 px-4 py-3"
              onSubmit={(e) => {
                e.preventDefault();
                const t = text.trim();
                if (!t) return;
                void run(async () => {
                  await rt.sendText([peer], t);
                  setText("");
                });
              }}
            >
              <div className="flex-1">
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      e.currentTarget.form?.requestSubmit();
                    }
                  }}
                  rows={1}
                  placeholder="Encrypted message…"
                  aria-label="Message"
                  className="max-h-40 min-h-9 w-full resize-none rounded-md border border-ink-600 bg-ink-900 px-3 py-2 text-sm placeholder:text-ink-400 focus:border-violet focus:outline-none"
                />
                <ErrorText error={error} />
              </div>
              <Button type="submit" variant="primary" loading={busy} aria-label="Send">
                <Send className="h-4 w-4" />
              </Button>
            </form>
          </>
        )}
      </section>

      <AddContact
        open={adding}
        onClose={(pk) => {
          setAdding(false);
          if (pk) nav(`/app/messages/${pk}`);
        }}
      />
      {peer && (
        <Modal open={requesting} title={`Request payment from ${rt.contactName(peer)}`} onClose={() => setRequesting(false)}>
          <RequestPaymentForm to={peer} onDone={() => setRequesting(false)} />
        </Modal>
      )}
    </div>
  );
}
