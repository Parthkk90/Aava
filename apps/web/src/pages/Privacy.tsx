import { useState } from "react";
import { Globe, Plus, Radar, Server, Stethoscope, Trash2 } from "lucide-react";
import { DEFAULT_CHAINS } from "@relaymesh/chain";
import { useRuntime } from "../ui/use-runtime.ts";
import { Badge, Button, Callout, Card, CardBody, CardHeader, ErrorText, Field, Input, PageHeader, Select, cx, useAction } from "../ui/kit.tsx";
import { gatherIceCandidates } from "../runtime/ice.ts";
import { RpcRoutingCard } from "../components/RpcRoutingCard.tsx";
import type { ConnectionPolicy } from "../runtime/settings.ts";

interface Diag {
  name: string;
  ok: boolean | null;
  detail: string;
}

export function Privacy() {
  const rt = useRuntime();
  const p = rt.settings.privacy;
  const [turn, setTurn] = useState({ urls: "", username: "", credential: "" });
  const [diags, setDiags] = useState<Diag[]>([]);
  const diag = useAction();
  const rpc = useAction();
  const [rpcDraft, setRpcDraft] = useState<Record<string, string>>({});

  async function runDiagnostics() {
    const out: Diag[] = [];
    for (const r of rt.settings.relays.filter((x) => x.enabled)) {
      const pr = await rt.probe(r.url);
      out.push({ name: `Relay ${r.url}`, ok: pr.reachable, detail: pr.reachable ? `WebSocket open in ${pr.latencyMs} ms; NIP-11 ${pr.info ? "ok" : "unavailable"}` : pr.error ?? "unreachable" });
      setDiags([...out]);
    }
    const chainId = rt.settings.chainId;
    const t0 = performance.now();
    try {
      const id = await (await rt.readClient(chainId)).getChainId();
      const via = `${rt.settings.rpc.mode} mode`;
      out.push({ name: `RPC ${rt.rpcUrl(chainId)}`, ok: id === chainId, detail: id === chainId ? `chain ${id} in ${Math.round(performance.now() - t0)} ms (${via})` : `reports chain ${id}, expected ${chainId}` });
    } catch (e) {
      out.push({ name: `RPC ${rt.rpcUrl(chainId)}`, ok: false, detail: (e as Error).message.split("\n")[0]! });
    }
    setDiags([...out]);
    try {
      const cands = await gatherIceCandidates({ iceServers: p.turnServers, iceTransportPolicy: p.relayOnlyWebRTC ? "relay" : "all" }, 4000);
      const types = cands.map((c) => / typ ([a-z]+)/.exec(c)?.[1]);
      const leaks = types.filter((t) => t !== "relay").length;
      out.push({
        name: "WebRTC ICE",
        ok: p.relayOnlyWebRTC ? leaks === 0 && cands.length > 0 : null,
        detail: `${cands.length} candidate(s): ${[...new Set(types)].join(", ") || "none"}${p.relayOnlyWebRTC && cands.length === 0 ? ": no TURN server reachable, calls would not connect" : ""}`,
      });
    } catch (e) {
      out.push({ name: "WebRTC ICE", ok: null, detail: `WebRTC unavailable: ${(e as Error).message}` });
    }
    setDiags([...out]);
  }

  const policies: [ConnectionPolicy, string, string][] = [
    ["standard", "Standard", "Connect to every relay you configure. Relays see your IP address; RPC providers do too unless RPC routing below is anonymous."],
    ["onion-only", "Onion-only relays", "Only connect to .onion relays. Works in Tor Browser (or with an OS-level Tor proxy). Clearnet relays are ignored, and nothing connects if you have none."],
  ];

  return (
    <>
      <PageHeader
        title="Privacy routing"
        subtitle="Choose which infrastructure sees what. Aava only claims what it can enforce or test: a web page cannot force all of its traffic through Tor, so that is stated explicitly below."
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <RpcRoutingCard />
        <Card>
          <CardHeader title="Connection policy" icon={<Globe className="h-4 w-4" />} />
          <CardBody className="space-y-3">
            {policies.map(([id, label, desc]) => (
              <label key={id} className={cx("flex cursor-pointer gap-3 rounded-md border p-3", p.connectionPolicy === id ? "border-violet/60 bg-violet/5" : "border-ink-700 hover:border-ink-600")}>
                <input
                  type="radio"
                  name="policy"
                  className="mt-0.5 accent-violet"
                  checked={p.connectionPolicy === id}
                  onChange={() => void rt.updateSettings((s) => (s.privacy.connectionPolicy = id)).then(() => rt.endAndRestart())}
                />
                <div>
                  <div className="text-sm font-medium text-ink-100">{label}</div>
                  <div className="mt-0.5 text-xs leading-relaxed text-ink-300">{desc}</div>
                </div>
              </label>
            ))}
            <Field label="How is this browser connected?" hint="Your statement only. Aava cannot verify OS-level proxying from inside a web page, so the Observatory never counts this as a passed test.">
              <Select value={p.declaredProxy} onChange={(e) => void rt.updateSettings((s) => (s.privacy.declaredProxy = e.target.value as typeof p.declaredProxy))}>
                <option value="none">Direct connection</option>
                <option value="tor-browser">Tor Browser</option>
                <option value="system-socks">System-wide SOCKS / VPN</option>
              </Select>
            </Field>
            <Callout tone="warn">Tor hides your IP from relays and RPC providers, but not from your wallet extension, which makes its own connections. Anonymous RPC mode needs WebRTC, which Tor Browser disables: use direct RPC routing there.</Callout>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="RPC providers" description="Used to read balances and verify receipts. A malicious RPC can lie about receipts: run your own node or use one you trust for anything valuable." icon={<Server className="h-4 w-4" />} />
          <CardBody className="space-y-3">
            {DEFAULT_CHAINS.map((c) => {
              const key = String(c.id);
              const value = rpcDraft[key] ?? rt.settings.rpcUrls[key] ?? "";
              return (
                <Field key={c.id} label={`${c.name} (${c.id})`}>
                  <div className="flex gap-2">
                    <Input value={value} onChange={(e) => setRpcDraft({ ...rpcDraft, [key]: e.target.value })} className="font-mono text-xs" />
                    <Button
                      size="sm"
                      loading={rpc.busy}
                      onClick={() =>
                        void rpc.run(async () => {
                          const url = new URL(value).toString();
                          // Probed over the current routing mode, so testing an endpoint never bypasses anonymous mode.
                          const id = await rt.rpc.probe(url);
                          if (id !== c.id) throw new Error(`${url} reports chain ${id}, not ${c.id}. Not saved.`);
                          await rt.updateSettings((s) => (s.rpcUrls[key] = url));
                        })
                      }
                    >
                      Test & save
                    </Button>
                  </div>
                </Field>
              );
            })}
            <ErrorText error={rpc.error} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="WebRTC & TURN" description="Applies to every peer connection Aava creates." icon={<Radar className="h-4 w-4" />} />
          <CardBody className="space-y-3">
            <label className="flex items-start gap-3">
              <input type="checkbox" className="mt-0.5 accent-violet" checked={p.relayOnlyWebRTC} onChange={(e) => void rt.updateSettings((s) => (s.privacy.relayOnlyWebRTC = e.target.checked))} />
              <div>
                <div className="text-sm text-ink-100">Relay-only mode (iceTransportPolicy: "relay")</div>
                <div className="text-xs leading-relaxed text-ink-300">Peers see the TURN server's address instead of yours. Requires a reachable TURN server; the TURN operator still sees both IP addresses.</div>
              </div>
            </label>
            {p.relayOnlyWebRTC && p.turnServers.length === 0 && <Callout tone="warn">Relay-only mode is on but no TURN server is configured: peer connections cannot connect.</Callout>}
            <div className="space-y-2">
              {p.turnServers.map((t, i) => (
                <div key={i} className="flex items-center justify-between rounded-md bg-ink-900 px-3 py-2 text-xs">
                  <span className="font-mono">{t.urls}</span>
                  <Button size="sm" variant="ghost" onClick={() => void rt.updateSettings((s) => s.privacy.turnServers.splice(i, 1))} aria-label="Remove TURN server">
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <Input placeholder="turn:host:3478" value={turn.urls} onChange={(e) => setTurn({ ...turn, urls: e.target.value })} className="font-mono text-xs" />
              <Input placeholder="username" value={turn.username} onChange={(e) => setTurn({ ...turn, username: e.target.value })} />
              <Input placeholder="credential" type="password" value={turn.credential} onChange={(e) => setTurn({ ...turn, credential: e.target.value })} />
            </div>
            <Button
              size="sm"
              disabled={!/^turns?:/.test(turn.urls)}
              onClick={() =>
                void rt
                  .updateSettings((s) => s.privacy.turnServers.push({ urls: turn.urls.trim(), ...(turn.username ? { username: turn.username } : {}), ...(turn.credential ? { credential: turn.credential } : {}) }))
                  .then(() => setTurn({ urls: "", username: "", credential: "" }))
              }
            >
              <Plus className="h-3.5 w-3.5" /> Add TURN server
            </Button>
            <p className="text-[11px] text-ink-400">Aava does not include a calling feature yet; this policy is enforced by the single peer-connection factory that any P2P feature must use, and tested by the Observatory.</p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Network diagnostics" icon={<Stethoscope className="h-4 w-4" />} actions={<Button size="sm" loading={diag.busy} onClick={() => void diag.run(runDiagnostics)}>Run</Button>} />
          <CardBody>
            {diags.length === 0 ? (
              <p className="text-xs text-ink-400">Checks each enabled relay, the selected chain's RPC, and WebRTC candidate gathering with your current settings.</p>
            ) : (
              <ul className="space-y-2">
                {diags.map((d, i) => (
                  <li key={i} className="flex items-start gap-3 text-xs">
                    <Badge tone={d.ok === null ? "warn" : d.ok ? "good" : "bad"}>{d.ok === null ? "info" : d.ok ? "ok" : "fail"}</Badge>
                    <div className="min-w-0">
                      <div className="truncate font-mono text-ink-200">{d.name}</div>
                      <div className="text-ink-400">{d.detail}</div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <ErrorText error={diag.error} />
          </CardBody>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader title="Who can see what" />
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-ink-400">
              <tr className="border-b border-ink-700">
                <th className="px-5 py-2 font-medium">Party</th>
                <th className="px-5 py-2 font-medium">Sees</th>
                <th className="px-5 py-2 font-medium">Does not see</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-700 text-ink-300">
              {[
                ["Relay operator", "IP address, recipient key, timing, size, your self-copy", "Message content, sender identity, wallet address"],
                ["RPC provider", "Which addresses and transactions you look up; your IP address unless RPC routing is anonymous", "Your messages and chat identity"],
                ["Mixnet entry node (anonymous RPC)", "Your IP address and when you use it", "Which RPC you query or what you ask (end-to-end TLS through the mixnet)"],
                ["TURN operator", "Both peers' IP addresses, timing, traffic volume", "Media/data content (DTLS-encrypted)"],
                ["Network observer", "That you connect to relays/RPC (unless using Tor)", "Message content (TLS + NIP-44)"],
                ["Blockchain (anyone)", "Payer, recipient, amount, token, time", "Your chat identity (unless you link them yourself)"],
                ["Message recipient", "Content, your chat identity, wallet address in payment requests", "Your other conversations"],
              ].map(([who, sees, not]) => (
                <tr key={who}>
                  <td className="px-5 py-2.5 font-medium text-ink-100">{who}</td>
                  <td className="px-5 py-2.5">{sees}</td>
                  <td className="px-5 py-2.5">{not}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
