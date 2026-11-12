import { useCallback, useEffect, useState } from "react";
import { History, Plug, PlugZap, Plus, RefreshCw, Trash2, Wallet } from "lucide-react";
import type { Address } from "viem";
import { DEFAULT_CHAINS, formatUnitsExact, normalizeAddress, readTokenBalances, type TokenBalance } from "@relaymesh/chain";
import { useRuntime } from "../ui/use-runtime.ts";
import { Badge, Button, Callout, Card, CardBody, CardHeader, Empty, ErrorText, Field, Input, KV, Mono, PageHeader, Select, timeAgo, useAction } from "../ui/kit.tsx";

export function WalletPage() {
  const rt = useRuntime();
  const w = rt.wallet.state;
  const connect = useAction();
  const [devAccounts, setDevAccounts] = useState<Address[] | null>(null);
  const [balances, setBalances] = useState<TokenBalance[] | null>(null);
  const bal = useAction();
  const chainMismatch = w.kind !== "none" && w.chainId !== undefined && w.chainId !== rt.settings.chainId;

  const refresh = useCallback(() => {
    if (!w.account) return;
    void bal.run(async () => setBalances(await readTokenBalances(await rt.readClient(), w.account!, rt.tokens.forChain(rt.settings.chainId))));
  }, [w.account, rt.settings.chainId, rt.settings.tokens, rt.settings.rpc.mode]);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const txs = rt.ledgerEntries.filter((e) => e.txHash);

  return (
    <>
      <PageHeader title="Wallet" subtitle="Aava connects to your wallet through EIP-1193. It never asks for a seed phrase, never holds wallet keys, and never sends a transaction without your explicit approval." />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Connection" icon={<Wallet className="h-4 w-4" />} actions={w.kind !== "none" ? <Badge tone="good">Connected</Badge> : <Badge>Not connected</Badge>} />
          <CardBody className="space-y-4">
            {w.kind === "none" ? (
              <>
                <div className="space-y-2">
                  <Button variant="primary" className="w-full" loading={connect.busy} onClick={() => void connect.run(() => rt.wallet.connectInjected())} disabled={!rt.wallet.hasInjected}>
                    <Plug className="h-4 w-4" /> Connect browser wallet
                  </Button>
                  {!rt.wallet.hasInjected && <p className="text-[11px] text-ink-400">No EIP-1193 wallet extension detected in this browser.</p>}
                </div>
                <div className="space-y-2 border-t border-ink-700 pt-4">
                  <div className="text-xs font-medium text-ink-200">Local test wallet (devnet only)</div>
                  <p className="text-[11px] leading-relaxed text-ink-400">
                    Uses the unlocked development accounts of the demo's anvil node (the RPC must report chain 31337). The node holds the keys; Aava asks you to confirm every
                    signature and transfer. These are shared demo accounts with worthless tokens: never use it with real funds.
                  </p>
                  {devAccounts === null ? (
                    <Button size="sm" loading={connect.busy} onClick={() => void connect.run(async () => setDevAccounts(await rt.wallet.listDevAccounts()))}>
                      Find devnet accounts
                    </Button>
                  ) : (
                    <div className="flex gap-2">
                      <Select id="dev-acct" defaultValue={devAccounts[1] ?? devAccounts[0]}>
                        {devAccounts.map((a, i) => (
                          <option key={a} value={a}>
                            #{i} {a}
                          </option>
                        ))}
                      </Select>
                      <Button
                        size="sm"
                        onClick={() =>
                          void connect.run(async () => {
                            const sel = (document.getElementById("dev-acct") as HTMLSelectElement).value as Address;
                            await rt.wallet.connectDevNode(sel);
                          })
                        }
                      >
                        Use
                      </Button>
                    </div>
                  )}
                </div>
                <Callout>WalletConnect needs a project ID from a hosted relay service. It is not configured in this build, so it is not offered.</Callout>
                <ErrorText error={connect.error} />
              </>
            ) : (
              <>
                <KV
                  rows={[
                    ["Type", w.kind === "dev-node" ? "Local test wallet (anvil)" : "Browser wallet (EIP-1193)"],
                    ["Address", <Mono value={w.account ?? ""} short={false} />],
                    ["Wallet chain", w.chainId !== undefined ? `${DEFAULT_CHAINS.find((c) => c.id === w.chainId)?.name ?? "Unknown"} (${w.chainId})` : "–"],
                  ]}
                />
                {chainMismatch && (
                  <Callout tone="warn" title="Wallet is on a different chain">
                    Aava will refuse to sign or pay until the wallet is on chain {rt.settings.chainId}.{" "}
                    <button className="underline" onClick={() => void connect.run(() => rt.wallet.switchChain(rt.settings.chainId))}>
                      Switch wallet
                    </button>
                  </Callout>
                )}
                <ErrorText error={connect.error} />
                <Button variant="ghost" size="sm" onClick={() => rt.wallet.disconnect()}>
                  <PlugZap className="h-3.5 w-3.5" /> Disconnect
                </Button>
              </>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Network" description="The chain Aava verifies payments on, through the RPC you configure on the Privacy page (independent of your wallet's RPC)." />
          <CardBody className="space-y-3">
            <Field label="Selected chain">
              <Select
                value={rt.settings.chainId}
                onChange={(e) => {
                  const id = Number(e.target.value);
                  void rt.updateSettings((s) => (s.chainId = id));
                  if (rt.wallet.state.kind === "injected") void connect.run(() => rt.wallet.switchChain(id));
                }}
              >
                {DEFAULT_CHAINS.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.id}){c.testnet ? "" : " · real funds"}
                  </option>
                ))}
              </Select>
            </Field>
            <KV
              rows={[
                ["RPC", <span className="font-mono">{rt.rpcUrl(rt.settings.chainId)}</span>],
                ["Read routing", rt.routeSummary(rt.settings.chainId)],
                ["Finality policy", `${rt.chain().minConfirmations} confirmation(s)`],
              ]}
            />
            {!rt.chain().testnet && <Callout tone="warn">This is a mainnet. Automated tests and the demo never use it. Payments here move real funds.</Callout>}
          </CardBody>
        </Card>
      </div>

      <TokenList balances={balances} loading={bal.busy} error={bal.error} onRefresh={refresh} />

      <Card className="mt-4">
        <CardHeader title="Transaction history" description="Transfers made through Aava, with their on-chain verification result." icon={<History className="h-4 w-4" />} />
        {txs.length === 0 ? (
          <Empty title="No transactions yet" />
        ) : (
          <ul className="divide-y divide-ink-700">
            {txs.map((e) => (
              <li key={e.requestId} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-xs">
                <Mono value={e.txHash!} />
                <span className="text-ink-300">{e.wire.request.description || "Payment"}</span>
                <span className="text-ink-400">{timeAgo(e.updatedAt)}</span>
                <Badge tone={e.state === "paid" ? "good" : e.state === "failed" ? "bad" : "warn"}>{e.state === "paid" ? "verified" : e.state}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function TokenList({ balances, loading, error, onRefresh }: { balances: TokenBalance[] | null; loading: boolean; error: string | null; onRefresh: () => void }) {
  const rt = useRuntime();
  const tokens = rt.tokens.forChain(rt.settings.chainId);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ address: "", symbol: "", decimals: "18", name: "" });
  const add = useAction();
  return (
    <Card className="mt-4">
      <CardHeader
        title="Supported tokens"
        description="Tokens are identified by contract address on a specific chain, never by symbol. Aava checks that code exists at the address and that on-chain decimals match."
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={onRefresh} loading={loading} disabled={rt.wallet.state.kind === "none"}>
              <RefreshCw className="h-3.5 w-3.5" /> Balances
            </Button>
            <Button size="sm" onClick={() => setAdding((a) => !a)}>
              <Plus className="h-3.5 w-3.5" /> Add token
            </Button>
          </>
        }
      />
      {adding && (
        <CardBody className="space-y-3 border-b border-ink-700">
          <Callout tone="warn">Only add a token contract you verified independently (e.g. on the project's official site and a block explorer). Look-alike tokens with the same symbol are common.</Callout>
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Contract address">
              <Input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} className="font-mono text-xs" />
            </Field>
            <Field label="Symbol">
              <Input value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value })} />
            </Field>
            <Field label="Decimals">
              <Input value={form.decimals} onChange={(e) => setForm({ ...form, decimals: e.target.value })} />
            </Field>
            <Field label="Name">
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
          </div>
          <ErrorText error={add.error} />
          <Button
            size="sm"
            variant="primary"
            onClick={() =>
              void add.run(async () => {
                const address = normalizeAddress(form.address);
                const decimals = Number(form.decimals);
                if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error("Decimals must be 0–36");
                if (!form.symbol.trim()) throw new Error("Symbol required");
                await rt.updateSettings((s) => {
                  if (s.tokens.some((t) => t.chainId === s.chainId && t.address.toLowerCase() === address.toLowerCase())) throw new Error("Token already configured");
                  s.tokens.push({ chainId: s.chainId, address, symbol: form.symbol.trim(), decimals, name: form.name.trim() || form.symbol.trim(), source: "added manually by user" });
                });
                setAdding(false);
              })
            }
          >
            Add token
          </Button>
        </CardBody>
      )}
      {tokens.length === 0 ? (
        <Empty title={`No tokens configured for chain ${rt.settings.chainId}`} />
      ) : (
        <ul className="divide-y divide-ink-700">
          {tokens.map((t) => {
            const b = balances?.find((x) => x.token.address === t.address);
            return (
              <li key={t.address} className="flex flex-wrap items-center gap-3 px-5 py-3 text-xs">
                <div className="w-20 font-semibold text-ink-100">{t.symbol}</div>
                <div className="min-w-0 flex-1">
                  <Mono value={t.address} short={false} />
                  <div className="mt-0.5 text-[11px] text-ink-400">{t.source}</div>
                </div>
                <div className="text-right">
                  {b ? (
                    b.error ? (
                      <Badge tone="bad">{b.error}</Badge>
                    ) : (
                      <span className="font-mono text-ink-100">{formatUnitsExact(b.balance ?? 0n, t.decimals)}</span>
                    )
                  ) : (
                    <span className="text-ink-400">–</span>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="Remove token"
                  onClick={() => void rt.updateSettings((s) => (s.tokens = s.tokens.filter((x) => !(x.chainId === t.chainId && x.address === t.address))))}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {error && (
        <CardBody>
          <ErrorText error={error} />
        </CardBody>
      )}
    </Card>
  );
}
