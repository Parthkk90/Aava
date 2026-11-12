import { useEffect, useState } from "react";
import { Ban, Inbox, Send, ShieldCheck, Trash2 } from "lucide-react";
import type { RejectionRecord } from "@relaymesh/payments";
import { useRuntime } from "../ui/use-runtime.ts";
import { Badge, Button, Callout, Card, CardBody, CardHeader, Empty, Mono, PageHeader, cx, timeAgo } from "../ui/kit.tsx";
import { PaymentRequestCard } from "../components/PaymentCard.tsx";

type Tab = "incoming" | "outgoing" | "rejected" | "policy";

export function Payments() {
  const rt = useRuntime();
  const [tab, setTab] = useState<Tab>("incoming");
  const [rejections, setRejections] = useState<RejectionRecord[]>([]);
  const all = rt.store?.all() ?? [];
  const incoming = all.filter((m) => m.type === "payment-request" && m.direction === "in").reverse();
  const outgoing = all.filter((m) => m.type === "payment-request" && m.direction === "out").reverse();

  useEffect(() => {
    void rt.ledger?.listRejections().then(setRejections);
  }, [rt, rt.ledgerEntries, incoming.length]);

  const tabs: [Tab, string, number][] = [
    ["incoming", "Requests to pay", incoming.length],
    ["outgoing", "Requests I sent", outgoing.length],
    ["rejected", "Rejected", rejections.length],
    ["policy", "Trusted wallets", Object.keys(rt.settings.pinnedWallets).length],
  ];

  return (
    <>
      <PageHeader
        title="Secure payments"
        subtitle="Payment requests are EIP-712 signed by the requester's wallet and bound to their chat identity. Aava verifies the signature, chain, token contract, expiry, policy and replay state, but only you can approve a transfer, and nothing counts as paid until the receipt is verified on-chain."
      />
      <div className="mb-4 flex flex-wrap gap-1 rounded-lg border border-ink-700 bg-ink-950 p-1">
        {tabs.map(([id, label, n]) => (
          <button key={id} onClick={() => setTab(id)} className={cx("flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium", tab === id ? "bg-ink-700 text-ink-100" : "text-ink-300 hover:text-ink-100")}>
            {label}
            <span className="rounded bg-ink-800 px-1.5 text-[10px] text-ink-300">{n}</span>
          </button>
        ))}
      </div>

      {tab === "incoming" &&
        (incoming.length === 0 ? (
          <Card>
            <Empty icon={<Inbox className="h-6 w-6" />} title="No payment requests">
              When a contact sends you a request it is verified automatically and appears here.
            </Empty>
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {incoming.map((m) => (
              <div key={m.id} className="space-y-1.5">
                <div className="text-[11px] text-ink-400">
                  From <span className="text-ink-200">{rt.contactName(m.from)}</span> · {timeAgo(m.createdAt * 1000)}
                </div>
                <PaymentRequestCard m={m} />
              </div>
            ))}
          </div>
        ))}

      {tab === "outgoing" &&
        (outgoing.length === 0 ? (
          <Card>
            <Empty icon={<Send className="h-6 w-6" />} title="No requests sent">
              Open a conversation and choose "Request payment".
            </Empty>
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {outgoing.map((m) => (
              <div key={m.id} className="space-y-1.5">
                <div className="text-[11px] text-ink-400">
                  To <span className="text-ink-200">{m.to.map((p) => rt.contactName(p)).join(", ")}</span> · {timeAgo(m.createdAt * 1000)}
                </div>
                <PaymentRequestCard m={m} />
              </div>
            ))}
          </div>
        ))}

      {tab === "rejected" && (
        <Card>
          <CardHeader title="Rejected requests" description="Every request that failed verification, with the reason. These were never shown as payable." icon={<Ban className="h-4 w-4" />} />
          {rejections.length === 0 ? (
            <Empty title="Nothing rejected yet" />
          ) : (
            <ul className="divide-y divide-ink-700">
              {rejections.map((r, i) => (
                <li key={i} className="flex flex-wrap items-start gap-3 px-5 py-3 text-xs">
                  <Badge tone="bad">{r.code}</Badge>
                  <div className="min-w-0 flex-1 text-ink-200">{r.reason}</div>
                  <div className="text-ink-400">
                    {r.from ? rt.contactName(r.from) : "unknown"} · {timeAgo(r.at)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {tab === "policy" && (
        <Card>
          <CardHeader
            title="Wallets you trust per contact"
            description="A contact's payment request is accepted only if it is signed by a wallet you have confirmed for that contact. Community requests are checked against the founder-signed treasury list instead."
            icon={<ShieldCheck className="h-4 w-4" />}
          />
          <CardBody className="space-y-3">
            {Object.keys(rt.settings.pinnedWallets).length === 0 && <Callout>No wallets pinned yet. You will be asked to confirm a wallet the first time a contact sends a request.</Callout>}
            {Object.entries(rt.settings.pinnedWallets).map(([pk, wallets]) => (
              <div key={pk} className="rounded-md border border-ink-700 p-3">
                <div className="mb-2 text-xs font-medium text-ink-100">{rt.contactName(pk)}</div>
                {wallets.map((w) => (
                  <div key={w} className="flex items-center justify-between gap-2 py-1">
                    <Mono value={w} short={false} />
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label="Remove"
                      onClick={() =>
                        void rt.updateSettings((s) => {
                          s.pinnedWallets[pk] = (s.pinnedWallets[pk] ?? []).filter((x) => x !== w);
                          if (s.pinnedWallets[pk]!.length === 0) delete s.pinnedWallets[pk];
                        })
                      }
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            ))}
          </CardBody>
        </Card>
      )}
    </>
  );
}
