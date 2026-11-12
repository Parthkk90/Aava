import { useState } from "react";
import { EyeOff, ShieldCheck } from "lucide-react";
import { getAddress, isAddress } from "viem";
import { useRuntime } from "../ui/use-runtime.ts";
import { Badge, Button, Callout, Card, CardBody, CardHeader, ErrorText, Field, Input, KV, Modal, cx, useAction, type Tone } from "../ui/kit.tsx";
import { SEPOLIA_ID, type BootState, type RpcMode, type SpecifierPin } from "../runtime/rpc.ts";

const MODES: [RpcMode, string, string][] = [
  ["direct", "Direct", "Reads go straight to the RPC you configured. Fast. The provider sees your IP address and every address and transaction you look up."],
  [
    "anon",
    "Anonymous (Anon-RPC, experimental)",
    "Reads travel through a hash-pinned Anon-RPC worker in a sandboxed iframe. The default network is the Nox mixnet (specifier on Sepolia). The RPC provider sees the request but not your IP; the mixnet entry node sees your IP but not the request. Slower: expect seconds per read and a boot delay.",
  ],
  [
    "light-client",
    "Verified (Helios light client, experimental)",
    "Reads go through a Helios light client (Kohaku provider adapter) that checks balances, code and receipts against the beacon chain, so a lying RPC is detected. Sepolia is configured by default. The endpoints still see your IP.",
  ],
];

function stateBadge(b: BootState | undefined): [Tone, string] {
  if (!b || b.state === "idle") return ["neutral", "not started"];
  if (b.state === "booting") return ["warn", "starting…"];
  if (b.state === "ready") return ["good", `ready (${Math.round(b.ms / 1000)} s boot)`];
  return ["bad", "failed"];
}

export function RpcRoutingCard() {
  const rt = useRuntime();
  const r = rt.settings.rpc;
  const action = useAction();
  const [pending, setPending] = useState<SpecifierPin | null>(null);
  const [anonDraft, setAnonDraft] = useState<{ specifier: string; bootstrap: string }>({ specifier: r.anon.specifier, bootstrap: r.anon.bootstrapRpcUrl });
  const lc = r.lightClients[String(SEPOLIA_ID)];
  const [lcDraft, setLcDraft] = useState({ consensus: lc?.consensusRpc ?? "", execution: lc?.executionRpc ?? "" });
  const chainId = rt.settings.chainId;

  const connect = () =>
    action.run(async () => {
      await rt.rpc.warmUp(chainId);
      const id = await (await rt.readClient(chainId)).getChainId();
      if (id !== chainId) throw new Error(`Endpoint reports chain ${id}, expected ${chainId}`);
    });

  const checkUpdate = () =>
    action.run(async () => {
      const res = await rt.rpc.checkForWorkerUpdate();
      if (res.changed) setPending(res.pin);
    });

  const [anonTone, anonLabel] = stateBadge(rt.rpc.anonState);
  const [lcTone, lcLabel] = stateBadge(rt.rpc.lightState.get(chainId));

  return (
    <Card className="lg:col-span-2">
      <CardHeader
        title="RPC routing"
        description="How Aava reads the chain (balances, receipt verification). It never falls back to a weaker mode: if the selected mode cannot answer, the read fails. Local devnet (loopback) RPCs are always direct. Your wallet extension keeps using its own RPC to send transactions."
        icon={<EyeOff className="h-4 w-4" />}
      />
      <CardBody className="space-y-4">
        <div className="grid gap-2 md:grid-cols-3">
          {MODES.map(([id, label, desc]) => (
            <label key={id} className={cx("flex cursor-pointer gap-3 rounded-md border p-3", r.mode === id ? "border-violet/60 bg-violet/5" : "border-ink-700 hover:border-ink-600")}>
              <input type="radio" name="rpc-mode" aria-label={label} className="mt-0.5 accent-violet" checked={r.mode === id} onChange={() => void rt.updateRpcRouting((x) => (x.mode = id))} />
              <div>
                <div className="text-sm font-medium text-ink-100">{label}</div>
                <div className="mt-0.5 text-xs leading-relaxed text-ink-300">{desc}</div>
              </div>
            </label>
          ))}
        </div>

        <KV rows={[["Selected chain", `${rt.chain().name} (${chainId})`], ["Routing", rt.routeSummary(chainId)]]} />

        {r.mode === "anon" && (
          <div className="space-y-3 rounded-md border border-ink-700 p-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium text-ink-100">Anon-RPC worker</div>
              <Badge tone={anonTone}>{anonLabel}</Badge>
            </div>
            {rt.rpc.anonState.state === "failed" && <Callout tone="bad">{rt.rpc.anonState.error}</Callout>}
            <KV
              rows={[
                ["Specifier", <span className="font-mono text-xs">{r.anon.specifier} (chain {r.anon.specifierChainId})</span>],
                ["Pinned worker hash", r.anon.pin ? <span className="break-all font-mono text-xs">{r.anon.pin.hash}</span> : "not pinned yet (pinned on first use)"],
                ["Bundle sources", r.anon.pin ? <span className="break-all font-mono text-[11px]">{r.anon.pin.resolvers.join(" · ")}</span> : "–"],
              ]}
            />
            <div className="grid gap-2 sm:grid-cols-2">
              <Field label="Specifier contract" hint="IWorkerSpecifier address. Changing it clears the pinned hash.">
                <Input value={anonDraft.specifier} onChange={(e) => setAnonDraft({ ...anonDraft, specifier: e.target.value })} className="font-mono text-xs" />
              </Field>
              <Field label="Bootstrap RPC (direct, first use only)" hint="Reads the specifier once. Use a different provider from the one you query anonymously.">
                <Input value={anonDraft.bootstrap} onChange={(e) => setAnonDraft({ ...anonDraft, bootstrap: e.target.value })} className="font-mono text-xs" />
              </Field>
            </div>
            {safeOrigin(r.anon.bootstrapRpcUrl) !== null && safeOrigin(r.anon.bootstrapRpcUrl) === safeOrigin(rt.rpcUrl(r.anon.specifierChainId)) && (
              <Callout tone="warn">The bootstrap RPC is the same provider you query anonymously on this chain. It could link the direct first-use read to your anonymized reads.</Callout>
            )}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="primary" loading={action.busy} onClick={() => void connect()}>
                Connect now
              </Button>
              <Button size="sm" loading={action.busy} onClick={() => void checkUpdate()}>
                Check for worker update
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void action.run(async () => {
                    if (!isAddress(anonDraft.specifier)) throw new Error("Specifier is not a valid address");
                    const bootstrap = new URL(anonDraft.bootstrap).toString();
                    const specifier = getAddress(anonDraft.specifier);
                    await rt.updateRpcRouting((x) => {
                      if (x.anon.specifier !== specifier) delete x.anon.pin;
                      x.anon.specifier = specifier;
                      x.anon.bootstrapRpcUrl = bootstrap;
                    });
                  })
                }
              >
                Save worker settings
              </Button>
            </div>
            <p className="text-[11px] leading-relaxed text-ink-400">
              The worker code is fetched from the sources above and runs only if its keccak256 matches the pinned hash. The hash's owner can publish new code; Aava refuses it until you accept it here. The worker sees every
              request it carries and could censor or alter responses.
            </p>
          </div>
        )}

        {r.mode === "light-client" && (
          <div className="space-y-3 rounded-md border border-ink-700 p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-medium text-ink-100">
                <ShieldCheck className="h-4 w-4" /> Helios light client (Sepolia)
              </div>
              <Badge tone={lcTone}>{lcLabel}</Badge>
            </div>
            {rt.rpc.lightState.get(chainId)?.state === "failed" && <Callout tone="bad">{(rt.rpc.lightState.get(chainId) as { error: string }).error}</Callout>}
            {!r.lightClients[String(chainId)] && <Callout tone="warn">The selected chain has no light-client configuration, so reads fail in this mode. Select Sepolia on the Wallet page or choose another mode.</Callout>}
            <div className="grid gap-2 sm:grid-cols-2">
              <Field label="Consensus (beacon light-client API)">
                <Input value={lcDraft.consensus} onChange={(e) => setLcDraft({ ...lcDraft, consensus: e.target.value })} className="font-mono text-xs" />
              </Field>
              <Field label="Execution RPC (must serve eth_getProof)" hint="Its answers are checked against the beacon chain, not trusted.">
                <Input value={lcDraft.execution} onChange={(e) => setLcDraft({ ...lcDraft, execution: e.target.value })} className="font-mono text-xs" />
              </Field>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="primary" loading={action.busy} onClick={() => void connect()}>
                Connect now
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void action.run(async () => {
                    const consensusRpc = new URL(lcDraft.consensus).toString().replace(/\/$/, "");
                    const executionRpc = new URL(lcDraft.execution).toString();
                    await rt.updateRpcRouting((x) => (x.lightClients[String(SEPOLIA_ID)] = { network: "sepolia", consensusRpc, executionRpc }));
                  })
                }
              >
                Save endpoints
              </Button>
            </div>
            <p className="text-[11px] leading-relaxed text-ink-400">
              First sync takes about 30–60 seconds and downloads about 4 MB. Receipts can be verified for roughly the last 27 hours (8,191 blocks); older receipts stay pending in this mode.
            </p>
          </div>
        )}
        <ErrorText error={action.error} />
      </CardBody>

      <Modal
        open={!!pending}
        title="Accept new anonymizing worker?"
        onClose={() => setPending(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPending(null)}>
              Keep the old pin
            </Button>
            <Button
              variant="primary"
              onClick={() =>
                void action.run(async () => {
                  await rt.rpc.acceptPin(pending!);
                  setPending(null);
                })
              }
            >
              Accept new hash
            </Button>
          </>
        }
      >
        <div className="space-y-2 text-xs text-ink-300">
          <p>The specifier contract now publishes different worker code. Only accept it if you have checked the change (for example the network's release notes or a reproducible build).</p>
          <KV
            rows={[
              ["Pinned", <span className="break-all font-mono">{r.anon.pin?.hash}</span>],
              ["On-chain now", <span className="break-all font-mono">{pending?.hash}</span>],
            ]}
          />
        </div>
      </Modal>
    </Card>
  );
}

function safeOrigin(url: string) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
