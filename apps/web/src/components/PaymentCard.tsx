import { useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, Clock, ReceiptText, ShieldAlert, ShieldCheck, XCircle } from "lucide-react";
import { formatUnitsExact } from "@relaymesh/chain";
import { fromWire, type SignedPaymentRequest } from "@relaymesh/payments";
import type { StoredMessage } from "@relaymesh/messaging";
import type { Address } from "viem";
import type { PaymentAnnotation, ReceiptPayload } from "../runtime/runtime.ts";
import { useRuntime } from "../ui/use-runtime.ts";
import { Badge, Button, Callout, CheckList, ErrorText, KV, Mono, cx, useAction } from "../ui/kit.tsx";

function safeParse(content: string): SignedPaymentRequest | null {
  try {
    return fromWire(content);
  } catch {
    return null;
  }
}

export function PaymentRequestCard({ m }: { m: StoredMessage }) {
  const rt = useRuntime();
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const ann = m.annotations?.payment as PaymentAnnotation | undefined;
  const signed = safeParse(m.content);
  const req = signed?.request;
  const token = req ? rt.tokens.find(req.chainId, req.token) : undefined;
  const entry = ann ? rt.ledgerEntries.find((e) => e.requestId.toLowerCase() === ann.requestId.toLowerCase()) : undefined;
  const amount = req ? (token ? `${formatUnitsExact(req.amount, token.decimals)} ${token.symbol}` : `${req.amount.toString()} base units (unknown token)`) : "–";
  const expired = req ? req.expiresAt * 1000 < Date.now() : false;

  const isCreator = m.direction === "out";
  let tone: "good" | "bad" | "info" | "warn" = "info";
  let label = "Pending verification";
  if (isCreator) {
    if (ann?.receipt?.status === "verified") [tone, label] = ["good", "Paid · receipt verified on-chain"];
    else if (ann?.receipt?.status === "failed") [tone, label] = ["bad", "Receipt failed on-chain verification"];
    else if (ann?.receipt) [tone, label] = ["warn", "Receipt awaiting confirmations"];
    else [tone, label] = [expired ? "warn" : "info", expired ? "Expired unpaid" : "Awaiting payment"];
  } else if (ann?.verdict === "rejected") [tone, label] = ["bad", `Rejected · ${ann.code}`];
  else if (entry) {
    const map: Record<string, ["good" | "bad" | "info" | "warn", string]> = {
      verified: [expired ? "warn" : "info", expired ? "Expired" : "Verified · awaiting your approval"],
      approved: ["info", "Approved · waiting for wallet"],
      submitted: ["warn", "Submitted · verifying receipt"],
      paid: ["good", "Paid · receipt verified on-chain"],
      failed: ["bad", "On-chain verification failed"],
      declined: ["bad", "Declined"],
    };
    [tone, label] = map[entry.state] ?? ["info", entry.state];
  }

  const Icon = tone === "good" ? ShieldCheck : tone === "bad" ? ShieldAlert : Clock;
  const canPay = !isCreator && ann?.verdict === "verified" && entry && ["verified", "approved", "submitted"].includes(entry.state) && !(expired && entry.state === "verified");

  return (
    <div className={cx("w-full max-w-md rounded-lg border bg-ink-900", tone === "bad" ? "border-rose/40" : tone === "good" ? "border-mint/30" : "border-ink-600")}>
      <div className="flex items-center gap-2 border-b border-ink-700 px-3.5 py-2.5">
        <ReceiptText className="h-4 w-4 text-violet-soft" />
        <span className="text-xs font-semibold text-ink-100">Payment request</span>
        <Badge tone={tone} className="ml-auto">
          <Icon className="h-3 w-3" /> {label}
        </Badge>
      </div>
      <div className="space-y-2 px-3.5 py-3">
        <div className="text-lg font-semibold tracking-tight text-ink-100">{amount}</div>
        {req?.description && <p className="text-xs text-ink-300">{req.description}</p>}
        {req && (
          <KV
            rows={[
              ["Pay to", <Mono value={req.recipient} />],
              ["Token contract", <Mono value={req.token} />],
              ["Chain", String(req.chainId)],
              ["Expires", new Date(req.expiresAt * 1000).toLocaleString()],
            ]}
          />
        )}
        {!req && <Callout tone="bad">This payload could not be parsed as a payment request.</Callout>}

        {ann?.verdict === "rejected" && (
          <Callout tone="bad" title="Aava refused this request">
            {ann.reason}
          </Callout>
        )}
        {ann?.verdict === "rejected" && ann.code === "unknown-wallet" && req && <PinWallet messageId={m.id} contact={m.from} wallet={req.creatorWallet} />}

        {ann?.steps && ann.steps.length > 0 && (
          <div>
            <button className="flex items-center gap-1 text-[11px] text-ink-300 hover:text-ink-100" onClick={() => setOpen((o) => !o)}>
              {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />} Verification evidence ({ann.steps.length} checks)
            </button>
            {open && (
              <div className="mt-2 rounded-md bg-ink-850 p-2.5">
                <CheckList steps={ann.steps} />
              </div>
            )}
          </div>
        )}

        {entry?.verification && (
          <div className="rounded-md bg-ink-850 p-2.5">
            <div className="mb-1.5 text-[11px] font-medium text-ink-300">On-chain receipt checks</div>
            <CheckList steps={entry.verification.checks.map((c) => ({ check: c.name, ok: c.ok, detail: c.detail }))} />
          </div>
        )}
        {isCreator && ann?.receipt && (
          <div className="rounded-md bg-ink-850 p-2.5">
            <div className="mb-1.5 text-[11px] font-medium text-ink-300">Independent check of the payer's receipt (tx {ann.receipt.txHash.slice(0, 12)}…)</div>
            <CheckList steps={ann.receipt.checks.map((c) => ({ check: c.name, ok: c.ok, detail: c.detail }))} />
          </div>
        )}

        {canPay && (
          <div className="space-y-2 pt-1">
            {entry!.state === "verified" && (
              <p className="text-[11px] leading-relaxed text-ink-400">A signed request is not permission to spend. Approving opens your wallet, which asks you to confirm the exact transfer.</p>
            )}
            {stage && busy && <p className="text-[11px] text-cyan">{stage}…</p>}
            <ErrorText error={error} />
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="primary"
                loading={busy}
                disabled={rt.wallet.state.kind === "none"}
                onClick={() => void run(() => rt.approveAndPay(m.id, setStage))}
              >
                {entry!.state === "verified" ? "Approve & pay" : "Resume verification"}
              </Button>
              {entry!.state === "verified" && (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => rt.declineRequest(m.id))}>
                  Decline
                </Button>
              )}
            </div>
            {rt.wallet.state.kind === "none" && <p className="text-[11px] text-amber">Connect a wallet on the Wallet page to pay.</p>}
          </div>
        )}
      </div>
    </div>
  );
}

function PinWallet({ messageId, contact, wallet }: { messageId: string; contact: string; wallet: Address }) {
  const rt = useRuntime();
  const { busy, error, run } = useAction();
  return (
    <div className="space-y-2 rounded-md border border-amber/25 bg-amber/5 p-2.5">
      <p className="text-[11px] leading-relaxed text-ink-200">
        This request is signed by <span className="font-mono">{wallet.slice(0, 10)}…{wallet.slice(-6)}</span>, which you have not accepted for {rt.contactName(contact)}. Confirm the
        full address with them through another channel before trusting it.
      </p>
      <ErrorText error={error} />
      <Button
        size="sm"
        loading={busy}
        onClick={() =>
          void run(async () => {
            await rt.pinWallet(contact, wallet);
            await rt.reverify(messageId);
          })
        }
      >
        I confirmed this wallet: trust it for this contact
      </Button>
    </div>
  );
}

export function ReceiptCard({ m }: { m: StoredMessage }) {
  let r: ReceiptPayload | null = null;
  try {
    r = JSON.parse(m.content) as ReceiptPayload;
  } catch {
    /* ignore */
  }
  return (
    <div className="w-full max-w-md rounded-lg border border-ink-600 bg-ink-900 px-3.5 py-2.5 text-xs">
      <div className="flex items-center gap-2 font-semibold text-ink-100">
        <CheckCircle2 className="h-4 w-4 text-mint" /> Payment receipt
      </div>
      {r && (
        <div className="mt-2">
          <KV rows={[["Transaction", <Mono value={r.txHash} />], ["Payer", <Mono value={r.payer} />]]} />
          <p className="mt-1 text-[11px] text-ink-400">
            {m.direction === "in" ? "Aava checked this transaction on-chain itself; see the original request for the result." : "Sent after your payment was verified on-chain."}
          </p>
        </div>
      )}
    </div>
  );
}

export function RotationCard({ m }: { m: StoredMessage }) {
  const rt = useRuntime();
  const r = m.annotations?.rotation as { ok: boolean; newPubkey?: string; detail: string } | undefined;
  const { busy, error, run } = useAction();
  return (
    <div className={cx("w-full max-w-md rounded-lg border px-3.5 py-2.5 text-xs", r?.ok ? "border-cyan/30" : "border-rose/40")}>
      <div className="flex items-center gap-2 font-semibold text-ink-100">
        {r?.ok ? <ShieldCheck className="h-4 w-4 text-cyan" /> : <XCircle className="h-4 w-4 text-rose" />} Key rotation notice
      </div>
      <p className="mt-1 text-ink-300">{r?.detail ?? "Not yet checked"}</p>
      {r?.ok && r.newPubkey && m.direction === "in" && (
        <div className="mt-2 space-y-1.5">
          <Mono value={r.newPubkey} />
          <ErrorText error={error} />
          <Button size="sm" loading={busy} onClick={() => void run(async () => rt.acceptRotation(m.id))}>
            Add new key as contact
          </Button>
        </div>
      )}
    </div>
  );
}
