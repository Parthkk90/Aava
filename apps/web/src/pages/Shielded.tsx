import { useEffect, useState } from "react";
import { EyeOff, KeyRound, RefreshCw, Send, ShieldCheck } from "lucide-react";
import { isAddress, type Address } from "viem";
import { formatUnitsExact } from "@relaymesh/chain";
import { useRuntime } from "../ui/use-runtime.ts";
import { Badge, Button, Callout, Card, CardBody, CardHeader, ErrorText, Field, Input, KV, Mono, PageHeader, Select, useAction } from "../ui/kit.tsx";
import { SEPOLIA_ETH_POOLS, SHIELDED_CHAIN_ID, type PrivateSendResult } from "../runtime/shielded.ts";

const ETH = (wei: bigint) => `${formatUnitsExact(wei, 18)} ETH`;
const AMOUNTS = SEPOLIA_ETH_POOLS;
const EXPLORER = "https://sepolia.etherscan.io";

export function Shielded() {
  const rt = useRuntime();
  const action = useAction();
  const [password, setPassword] = useState("");
  const [phrase, setPhrase] = useState<string | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [shieldAmount, setShieldAmount] = useState(String(AMOUNTS[0]));
  const [sendAmount, setSendAmount] = useState(String(AMOUNTS[0]));
  const [recipient, setRecipient] = useState("");
  const [deposits, setDeposits] = useState<string[]>([]);
  const [sent, setSent] = useState<PrivateSendResult | null>(null);
  const pinned = Object.entries(rt.settings.pinnedWallets).flatMap(([pk, ws]) => ws.map((w) => ({ label: `${rt.contactName(pk)} · ${w.slice(0, 10)}…`, wallet: w })));

  const refresh = () =>
    action.run(async () => {
      setStage("Syncing Tornado pools (the first sync reads the pools' whole history)");
      try {
        await rt.shielded().sync();
        setBalance(await rt.shielded().balance());
      } finally {
        setStage(null);
      }
    });

  useEffect(() => {
    if (rt.shieldedUnlocked) void refresh();
  }, [rt.shieldedUnlocked]);

  return (
    <>
      <PageHeader
        title="Private payments"
        badge={<Badge tone="warn">experimental · Sepolia only</Badge>}
        subtitle="Shield Sepolia ETH into Tornado Cash pools with Kohaku, then pay anyone from the shielded balance. On-chain, the payment cannot be linked to your deposit or your wallet."
      />

      {!rt.shieldedConfigured && (
        <Card>
          <CardHeader title="Set up private payments" icon={<KeyRound className="h-4 w-4" />} />
          <CardBody className="space-y-3">
            <p className="text-sm text-ink-300">
              Aava creates a separate 24-word recovery phrase for your private notes. It is stored encrypted with your device password and included in your encrypted backup. Unlike the rest of Aava, this means Aava holds spending keys
              for the shielded balance.
            </p>
            <Field label="Device password">
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Button
              variant="primary"
              loading={action.busy}
              disabled={!password}
              onClick={() =>
                void action.run(async () => {
                  setPhrase(await rt.enableShielded(password));
                  setPassword("");
                })
              }
            >
              Create recovery phrase
            </Button>
            <ErrorText error={action.error} />
          </CardBody>
        </Card>
      )}

      {phrase && (
        <Card className="mt-4">
          <CardHeader title="Write down your private-payments recovery phrase" />
          <CardBody className="space-y-3">
            <Callout tone="warn">Anyone with these words can spend your shielded balance. Aava will not show them again unless you enter your password.</Callout>
            <ol className="grid grid-cols-2 gap-1 font-mono text-sm sm:grid-cols-4">
              {phrase.split(" ").map((w, i) => (
                <li key={i} className="rounded bg-ink-900 px-2 py-1">
                  {i + 1}. {w}
                </li>
              ))}
            </ol>
            <Button onClick={() => setPhrase(null)}>I have written it down</Button>
          </CardBody>
        </Card>
      )}

      {rt.shieldedConfigured && !rt.shieldedUnlocked && (
        <Card>
          <CardHeader title="Unlock private payments" icon={<KeyRound className="h-4 w-4" />} />
          <CardBody className="space-y-3">
            <Field label="Device password">
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Button variant="primary" loading={action.busy} onClick={() => void action.run(() => rt.unlockShielded(password).then(() => setPassword("")))}>
              Unlock
            </Button>
            <ErrorText error={action.error} />
          </CardBody>
        </Card>
      )}

      {rt.shieldedUnlocked && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader
              title="Shielded balance"
              icon={<EyeOff className="h-4 w-4" />}
              actions={
                <Button size="sm" variant="ghost" loading={action.busy} onClick={() => void refresh()} aria-label="Sync shielded balance">
                  <RefreshCw className="h-3.5 w-3.5" />
                </Button>
              }
            />
            <CardBody className="space-y-3">
              <div className="text-2xl font-semibold text-ink-100">{balance === null ? "…" : ETH(balance)}</div>
              <KV
                rows={[
                  ["Network", "Sepolia testnet (Tornado Cash pools: 0.01 to 30 ETH)"],
                  ["Chain reads", rt.routeSummary(SHIELDED_CHAIN_ID)],
                  ["Last sync", rt.shielded().lastSyncMs ? `${Math.round(rt.shielded().lastSyncMs! / 1000)} s` : "–"],
                ]}
              />
              {stage && <Callout tone="info">{stage}</Callout>}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Shield (deposit)" description="Your connected wallet sends the deposit. The deposit itself is public; what you do with it afterwards is not." icon={<ShieldCheck className="h-4 w-4" />} />
            <CardBody className="space-y-3">
              <Field label="Amount">
                <Select value={shieldAmount} onChange={(e) => setShieldAmount(e.target.value)}>
                  {AMOUNTS.map((a) => (
                    <option key={String(a)} value={String(a)}>
                      {ETH(a)}
                    </option>
                  ))}
                </Select>
              </Field>
              {rt.wallet.state.kind === "none" && <Callout tone="warn">Connect a wallet on Sepolia (Wallet page) to deposit.</Callout>}
              <Button
                variant="primary"
                loading={action.busy}
                disabled={rt.wallet.state.kind === "none"}
                onClick={() =>
                  void action.run(async () => {
                    try {
                      setDeposits(await rt.shielded().shield(BigInt(shieldAmount), setStage));
                      setStage("Syncing the new deposit");
                      setBalance(await rt.shielded().balance());
                    } finally {
                      setStage(null);
                    }
                  })
                }
              >
                Shield {ETH(BigInt(shieldAmount))}
              </Button>
              {deposits.map((h) => (
                <a key={h} className="block font-mono text-xs text-violet-soft hover:underline" href={`${EXPLORER}/tx/${h}`} target="_blank" rel="noreferrer">
                  deposit {h.slice(0, 18)}…
                </a>
              ))}
            </CardBody>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader
              title="Send privately"
              description="A zero-knowledge withdrawal to the recipient, submitted as a paymaster-sponsored ERC-4337 operation. The paymaster's fee comes out of the note; the recipient gets the rest. In anonymous RPC mode the submission also travels through the mixnet."
              icon={<Send className="h-4 w-4" />}
            />
            <CardBody className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Amount">
                  <Select value={sendAmount} onChange={(e) => setSendAmount(e.target.value)}>
                    {AMOUNTS.map((a) => (
                      <option key={String(a)} value={String(a)}>
                        {ETH(a)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <div className="sm:col-span-2">
                  <Field label="Recipient address" hint="Use an address that has never been linked to you. A contact's pinned wallet can be picked below.">
                    <Input value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="0x…" className="font-mono text-xs" />
                  </Field>
                </div>
              </div>
              {pinned.length > 0 && (
                <Select aria-label="Pick a contact's wallet" value="" onChange={(e) => setRecipient(e.target.value)}>
                  <option value="">Pick a contact's pinned wallet…</option>
                  {pinned.map((p) => (
                    <option key={p.wallet} value={p.wallet}>
                      {p.label}
                    </option>
                  ))}
                </Select>
              )}
              <Button
                variant="primary"
                loading={action.busy}
                disabled={!isAddress(recipient)}
                onClick={() =>
                  void action.run(async () => {
                    try {
                      setSent(await rt.shielded().sendPrivately(BigInt(sendAmount), recipient as Address, setStage));
                      setBalance(await rt.shielded().balance());
                    } finally {
                      setStage(null);
                    }
                  })
                }
              >
                Send {ETH(BigInt(sendAmount))} privately
              </Button>
              {sent && (
                <KV
                  rows={[
                    ["User operation", <Mono value={sent.userOperationHash} />],
                    [
                      "Transaction",
                      sent.transactionHash ? (
                        <a className="font-mono text-xs text-violet-soft hover:underline" href={`${EXPLORER}/tx/${sent.transactionHash}`} target="_blank" rel="noreferrer">
                          {sent.transactionHash.slice(0, 18)}…
                        </a>
                      ) : (
                        "not included yet"
                      ),
                    ],
                    ["Result", sent.success === undefined ? "pending" : sent.success ? <Badge tone="good">withdrawn</Badge> : <Badge tone="bad">failed</Badge>],
                  ]}
                />
              )}
              <ErrorText error={action.error} />
            </CardBody>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader title="Recovery phrase" description="Your shielded notes can be recovered on any device from these 24 words. They are also inside your encrypted backup file." icon={<KeyRound className="h-4 w-4" />} />
            <CardBody className="flex flex-wrap items-end gap-2">
              <div className="min-w-60 flex-1">
                <Field label="Device password to show the phrase">
                  <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
                </Field>
              </div>
              <Button
                onClick={() =>
                  void action.run(async () => {
                    setPhrase(await rt.revealShieldedPhrase(password));
                    setPassword("");
                  })
                }
              >
                Show recovery phrase
              </Button>
            </CardBody>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader title="What this does and does not hide" />
            <CardBody>
              <ul className="list-disc space-y-1 pl-5 text-xs leading-relaxed text-ink-300">
                <li>Hidden on-chain: which deposit paid which recipient, and that your wallet paid at all.</li>
                <li>Visible on-chain: your deposit (from your wallet), and the recipient receiving a withdrawal from a Tornado pool.</li>
                <li>Timing still leaks: on Sepolia few people use these pools, so a withdrawal right after your deposit is easy to link. Wait, and use the common amounts.</li>
                <li>Aava holds the spending keys for shielded notes (your separate recovery phrase). Kohaku's Tornado package is alpha and still undergoing audits; this is testnet only.</li>
                <li>The proving files (~34 MB) are downloaded directly from GitHub once; that download reveals your IP and that you use Tornado Cash.</li>
                <li>Tornado Cash has been subject to sanctions in some jurisdictions in the past. Check the rules that apply to you before using it with real funds.</li>
              </ul>
            </CardBody>
          </Card>
        </div>
      )}
    </>
  );
}
