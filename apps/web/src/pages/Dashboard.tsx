import { Link } from "react-router-dom";
import { Activity, ArrowRight, Fingerprint, MessagesSquare, Network, ReceiptText, Wallet } from "lucide-react";
import type { RelayState } from "@relaymesh/relay-mesh";
import { useRuntime } from "../ui/use-runtime.ts";
import { Badge, Card, CardBody, CardHeader, Dot, Empty, KV, Mono, timeAgo, type Tone } from "../ui/kit.tsx";

export function relayTone(s: RelayState["status"]): Tone {
  return s === "open" ? "good" : s === "connecting" ? "info" : s === "backoff" ? "bad" : "neutral";
}

const statusTone: Record<string, Tone> = { PASS: "good", FAIL: "bad", LIMITED: "warn", "NOT TESTED": "neutral" };

export function Dashboard() {
  const rt = useRuntime();
  const relays = rt.mesh?.states() ?? [];
  const open = relays.filter((r) => r.status === "open");
  const active = open.sort((a, b) => (a.connectLatencyMs ?? 1e9) - (b.connectLatencyMs ?? 1e9))[0];
  const msgs = (rt.store?.all() ?? []).filter((m) => m.subject !== "observatory-probe").slice(-6).reverse();
  const obs = rt.observatory;
  const counts = obs.reduce<Record<string, number>>((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {});
  const lastRun = obs.length ? obs[obs.length - 1]!.finishedAt : null;
  const pending = rt.mesh?.pendingOutbox().length ?? 0;
  const passing = counts["PASS"] ?? 0;

  const stats: [string, string][] = [
    [`${open.length}/${relays.length}`, "relays connected"],
    [`${rt.store?.all().length ?? 0}`, "messages on device"],
    [obs.length ? `${passing}/${obs.length}` : "–", "observatory tests passing"],
    [`${pending}`, "events queued"],
  ];

  return (
    <>
      <header className="relative overflow-hidden rounded-xl border border-ink-700 bg-ink-850">
        <div className="grid-bg pointer-events-none absolute inset-0 opacity-60" />
        <div
          aria-hidden
          className="pointer-events-none absolute -right-20 -top-24 h-56 w-72 rounded-full bg-violet/10 blur-[80px]"
        />
        <div className="relative px-5 py-6 sm:px-6">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-soft">Live overview</p>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-4">
            <h1 className="text-2xl font-semibold tracking-tight text-ink-100 sm:text-3xl">
              Everything here is read from the{" "}
              <span className="bg-gradient-to-r from-cyan via-violet-soft to-violet bg-clip-text text-transparent">running client</span>.
            </h1>
            <span className="inline-flex items-center gap-1.5 rounded-lg border border-ink-600 bg-ink-900/80 px-3 py-1.5 text-xs text-ink-300">
              {open.length > 0 ? <Dot tone="good" pulse /> : <Dot tone="bad" />}
              {open.length > 0 ? "Online" : "Offline"}
            </span>
          </div>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-ink-300">
            Live status of your identity, connections, and payments. Every value on this page comes from real state: never estimated, never faked.
          </p>
          <dl className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-ink-700 bg-ink-700 sm:grid-cols-4">
            {stats.map(([k, v]) => (
              <div key={v} className="bg-ink-900 px-4 py-4">
                <dt className="font-mono text-lg text-ink-100">{k}</dt>
                <dd className="mt-1 text-xs text-ink-400">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </header>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader title="Identity" icon={<Fingerprint className="h-4 w-4" />} actions={<Badge tone="good">Unlocked</Badge>} />
          <CardBody>
            <KV
              rows={[
                ["Label", rt.identity?.label],
                ["npub", <Mono value={rt.identity?.npub ?? ""} />],
                ["Created", rt.identity ? new Date(rt.identity.createdAt * 1000).toLocaleDateString() : "–"],
                ["Key storage", "NIP-49 ciphertext in IndexedDB"],
              ]}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Communication"
            icon={<Network className="h-4 w-4" />}
            actions={<Link to="/app/relays" className="text-xs text-ink-300 transition-colors hover:text-ink-100">Manage</Link>}
          />
          <CardBody>
            <KV
              rows={[
                ["Status", open.length > 0 ? <span className="inline-flex items-center gap-1.5"><Dot tone="good" pulse /> Online</span> : <span className="inline-flex items-center gap-1.5"><Dot tone="bad" /> Offline</span>],
                ["Relays connected", `${open.length} of ${relays.length}`],
                ["Fastest relay", active ? <span className="font-mono">{active.url.replace(/^wss?:\/\//, "")} · {active.connectLatencyMs} ms</span> : "–"],
                ["Queued for delivery", pending ? <Badge tone="warn">{pending} event(s)</Badge> : "0"],
              ]}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Wallet & network"
            icon={<Wallet className="h-4 w-4" />}
            actions={<Link to="/app/wallet" className="text-xs text-ink-300 transition-colors hover:text-ink-100">Open</Link>}
          />
          <CardBody>
            <KV
              rows={[
                ["Wallet", rt.wallet.state.kind === "none" ? <Badge>Not connected</Badge> : <Mono value={rt.wallet.state.account ?? ""} />],
                ["Wallet type", rt.wallet.state.kind === "dev-node" ? "Local test wallet" : rt.wallet.state.kind === "injected" ? "Browser wallet (EIP-1193)" : "–"],
                ["Selected chain", `${rt.chain().name} (${rt.settings.chainId})`],
                ["RPC", <span className="font-mono">{new URL(rt.rpcUrl(rt.settings.chainId)).host}</span>],
                ["Read routing", rt.routeSummary(rt.settings.chainId)],
              ]}
            />
          </CardBody>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Recent activity"
            icon={<MessagesSquare className="h-4 w-4" />}
            actions={<Link to="/app/messages" className="text-xs text-ink-300 transition-colors hover:text-ink-100">All messages</Link>}
          />
          {msgs.length === 0 ? (
            <Empty title="No messages yet">Add a contact by npub and send an encrypted message.</Empty>
          ) : (
            <ul className="divide-y divide-ink-700">
              {msgs.map((m) => {
                const peer = m.direction === "out" ? m.to.find((p) => p !== rt.identity?.pubkey) ?? m.from : m.from;
                return (
                  <li key={m.id} className="flex items-center gap-3 px-5 py-3">
                    {m.type === "payment-request" || m.type === "payment-receipt" ? <ReceiptText className="h-4 w-4 text-violet-soft" /> : <MessagesSquare className="h-4 w-4 text-ink-400" />}
                    <div className="min-w-0 flex-1">
                      <div className="text-xs text-ink-300">
                        {m.direction === "out" ? "To" : "From"} <span className="text-ink-100">{rt.contactName(peer)}</span>
                      </div>
                      <div className="truncate text-sm text-ink-200">{m.type === "text" ? m.content : m.subject ?? m.type}</div>
                    </div>
                    <span className="shrink-0 text-[11px] text-ink-400">{timeAgo(m.createdAt * 1000)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card className="transition-colors hover:border-violet/40">
          <CardHeader title="Privacy Observatory" icon={<Activity className="h-4 w-4" />} />
          <CardBody className="space-y-3">
            {obs.length === 0 ? (
              <p className="text-xs leading-relaxed text-ink-300">No tests have been run on this device yet. Results are only shown after real tests run.</p>
            ) : (
              <>
                <div className="flex flex-wrap gap-1.5">
                  {(["PASS", "FAIL", "LIMITED", "NOT TESTED"] as const).map((s) => (
                    <Badge key={s} tone={statusTone[s]}>
                      {counts[s] ?? 0} {s}
                    </Badge>
                  ))}
                </div>
                <p className="text-[11px] text-ink-400">Last run {lastRun ? timeAgo(Date.parse(lastRun)) : "–"}. Results are per test, never combined into a score.</p>
              </>
            )}
            <Link to="/app/observatory" className="inline-flex items-center gap-1 text-xs text-violet-soft transition-colors hover:text-ink-100">
              Open Observatory <ArrowRight className="h-3 w-3" />
            </Link>
          </CardBody>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader
          title="Payments"
          icon={<ReceiptText className="h-4 w-4" />}
          actions={<Link to="/app/payments" className="text-xs text-ink-300 transition-colors hover:text-ink-100">Open</Link>}
        />
        {rt.ledgerEntries.length === 0 ? (
          <Empty title="No payment requests received">Requests from contacts appear here after their signature and policy checks.</Empty>
        ) : (
          <ul className="divide-y divide-ink-700">
            {rt.ledgerEntries.slice(0, 5).map((e) => (
              <li key={e.requestId} className="flex items-center justify-between gap-3 px-5 py-3 text-xs">
                <span className="font-mono text-ink-300">{e.requestId.slice(0, 18)}…</span>
                <span className="text-ink-200">{e.wire.request.description || "Payment request"}</span>
                <Badge tone={e.state === "paid" ? "good" : e.state === "failed" || e.state === "declined" ? "bad" : "info"}>{e.state}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
