import { useState, type ReactNode } from "react";
import { Download, FileUp, Info, Network, Plus, RotateCcw, Search, ShieldCheck, ShieldQuestion, Trash2 } from "lucide-react";
import type { RelayProbe } from "@relaymesh/relay-mesh";
import { useRuntime } from "../ui/use-runtime.ts";
import { Badge, Button, Callout, Card, CardBody, CardHeader, Dot, Empty, ErrorText, Field, Input, KV, Modal, Mono, PageHeader, Textarea, download, timeAgo, useAction } from "../ui/kit.tsx";
import { relayTone } from "./Dashboard.tsx";

export function Relays() {
  const rt = useRuntime();
  const states = rt.mesh?.states() ?? [];
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [probes, setProbes] = useState<Record<string, RelayProbe>>({});
  const probe = useAction();
  const pending = rt.mesh?.pendingOutbox().length ?? 0;
  const excluded = rt.settings.privacy.connectionPolicy === "onion-only" ? rt.settings.relays.filter((r) => !states.some((s) => s.url.startsWith(r.url))) : [];

  return (
    <>
      <PageHeader
        title="Relay Mesh"
        subtitle="Every message is published to all relays below and read from all of them. Losing one relay does not lose messages, identities, or history: those live on this device. No central registry is involved: add any NIP-01 relay by URL."
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={() => download("relaymesh-relays.json", rt.exportRelayBundle())}>
              <Download className="h-3.5 w-3.5" /> Export
            </Button>
            <Button size="sm" onClick={() => setImporting(true)}>
              <FileUp className="h-3.5 w-3.5" /> Import
            </Button>
            <Button size="sm" variant="primary" onClick={() => setAdding(true)}>
              <Plus className="h-3.5 w-3.5" /> Add relay
            </Button>
          </>
        }
      />
      {pending > 0 && (
        <div className="mb-4">
          <Callout tone="warn" title={`${pending} event(s) waiting for a relay`}>
            No relay has accepted these yet. They are kept on this device and sent automatically when any relay reconnects.
          </Callout>
        </div>
      )}
      {excluded.length > 0 && (
        <div className="mb-4">
          <Callout tone="info">Onion-only policy is active: {excluded.length} clearnet relay(s) are configured but not used.</Callout>
        </div>
      )}
      <Card>
        <CardHeader title={`${states.filter((s) => s.status === "open").length} of ${states.length} relays connected`} icon={<Network className="h-4 w-4" />} />
        {states.length === 0 ? (
          <Empty title="No relays configured">Add at least two independently operated relays for failover.</Empty>
        ) : (
          <ul className="divide-y divide-ink-700">
            {states.map((s) => {
              const p = probes[s.url];
              const m = s.manifest?.manifest;
              return (
                <li key={s.url} className="space-y-3 px-5 py-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <Dot tone={relayTone(s.status)} pulse={s.status === "open"} />
                    <span className="font-mono text-sm text-ink-100">{s.url}</span>
                    <Badge tone={relayTone(s.status)}>{s.status}</Badge>
                    {m ? (
                      <Badge tone="violet">
                        <ShieldCheck className="h-3 w-3" /> signed manifest · {m.operator.name}
                      </Badge>
                    ) : (
                      <Badge>
                        <ShieldQuestion className="h-3 w-3" /> manual (no manifest)
                      </Badge>
                    )}
                    <div className="ml-auto flex items-center gap-1">
                      <Button size="sm" variant="ghost" onClick={() => void probe.run(async () => setProbes({ ...probes, [s.url]: await rt.probe(s.url) }))} aria-label="Probe relay">
                        <Search className="h-3.5 w-3.5" /> Verify
                      </Button>
                      {s.status === "backoff" && (
                        <Button size="sm" variant="ghost" onClick={() => rt.mesh?.retry(s.url)}>
                          <RotateCcw className="h-3.5 w-3.5" /> Retry now
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => void rt.setRelayEnabled(s.url, s.status === "disabled")}>
                        {s.status === "disabled" ? "Enable" : "Disable"}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void rt.removeRelay(rt.settings.relays.find((r) => s.url.startsWith(r.url))?.url ?? s.url)} aria-label="Remove relay">
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                  <div className="grid gap-x-8 gap-y-1 text-[11px] text-ink-400 sm:grid-cols-4">
                    <span>connect latency: {s.connectLatencyMs !== undefined ? `${s.connectLatencyMs} ms` : "–"}</span>
                    <span>last publish: {s.lastPublishLatencyMs !== undefined ? `${s.lastPublishLatencyMs} ms` : "–"}</span>
                    <span>
                      accepted / rejected: {s.publishesAccepted} / {s.publishesRejected}
                    </span>
                    <span>events received: {s.eventsReceived}</span>
                    {s.lastConnectedAt && <span>connected {timeAgo(s.lastConnectedAt)}</span>}
                    {s.lastError && <span className="text-rose sm:col-span-2">last error: {s.lastError}</span>}
                    {s.nextRetryAt && <span className="text-amber">retry in {Math.max(0, Math.round((s.nextRetryAt - Date.now()) / 1000))}s (attempt {s.attempts})</span>}
                  </div>
                  {m && (
                    <div className="rounded-md bg-ink-900 p-3">
                      <KV
                        rows={[
                          ["Operator", `${m.operator.name} (${m.operator.id})`],
                          ["Operator key", <Mono value={m.publicKey} />],
                          ["Software", `${m.software.name} ${m.software.version}`],
                          ["Capabilities", m.capabilities.join(", ") || "–"],
                          ["Manifest expires", new Date(m.expiresAt * 1000).toLocaleDateString()],
                        ]}
                      />
                    </div>
                  )}
                  {p && (
                    <div className="rounded-md bg-ink-900 p-3 text-xs">
                      <div className="mb-2 flex items-center gap-2 font-medium text-ink-200">
                        <Info className="h-3.5 w-3.5" /> Connectivity check
                        <Badge tone={p.reachable ? "good" : "bad"}>{p.reachable ? `reachable · ${p.latencyMs} ms` : "unreachable"}</Badge>
                      </div>
                      {p.error && <p className="text-rose">{p.error}</p>}
                      {p.info ? (
                        <KV
                          rows={[
                            ["Name", p.info.name ?? "–"],
                            ["Software", `${p.info.software ?? "–"} ${p.info.version ?? ""}`],
                            ["Supported NIPs", p.info.supported_nips?.join(", ") ?? "–"],
                            ["Supports NIP-17/59", p.info.supported_nips?.includes(17) || p.info.supported_nips?.includes(59) ? "declared" : "not declared (gift wraps may still work)"],
                            ["Operator key (NIP-11)", p.info.pubkey ? <Mono value={p.info.pubkey} /> : "not published"],
                            ...(m && p.info.pubkey ? ([["Matches manifest key", p.info.pubkey === m.publicKey ? <Badge tone="good">yes</Badge> : <Badge tone="bad">NO</Badge>]] as [string, ReactNode][]) : []),
                          ]}
                        />
                      ) : (
                        <p className="text-ink-400">NIP-11 document unavailable: {p.infoError}</p>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <ErrorText error={probe.error} />
      </Card>

      <Card className="mt-4">
        <CardHeader title="What relay operators can observe" />
        <CardBody>
          <ul className="list-disc space-y-1 pl-4 text-xs leading-relaxed text-ink-300">
            <li>Your IP address and connection times (use Tor Browser or an onion-only policy to hide it).</li>
            <li>The recipient public key of every gift wrap (the "p" tag), its size and approximate time (timestamps are randomised up to two days).</li>
            <li>Not the sender, not the content: gift wraps are signed by one-time keys and encrypted with NIP-44.</li>
            <li>When you send, a copy is also wrapped to yourself for history: a relay seeing both at the same moment can guess you were the sender.</li>
          </ul>
        </CardBody>
      </Card>

      <AddRelay open={adding} onClose={() => setAdding(false)} />
      <ImportRelays open={importing} onClose={() => setImporting(false)} />
    </>
  );
}

function AddRelay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const rt = useRuntime();
  const [url, setUrl] = useState("");
  const [manifest, setManifest] = useState("");
  const { busy, error, run } = useAction();
  return (
    <Modal open={open} title="Add relay" onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            let parsed: unknown;
            if (manifest.trim()) {
              try {
                parsed = JSON.parse(manifest);
              } catch {
                throw new Error("Manifest is not valid JSON");
              }
            }
            const u = url.trim() || ((parsed as { content?: string })?.content ? (JSON.parse((parsed as { content: string }).content) as { relayUrl: string }).relayUrl : "");
            if (!u) throw new Error("Enter a relay URL");
            const probe = await rt.probe(u);
            if (!probe.reachable) throw new Error(`Relay is not reachable: ${probe.error ?? "unknown error"}. Fix the URL or try again later.`);
            await rt.addRelay(u, parsed);
            setUrl("");
            setManifest("");
            onClose();
          });
        }}
      >
        <Field label="Relay URL" hint="wss:// for public relays. ws:// is accepted only for localhost, internal demo hosts, and .onion.">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="wss://relay.example.org" className="font-mono text-xs" />
        </Field>
        <Field label="Signed operator manifest (optional)" hint="A JSON Nostr event (kind 30078) published by the operator. It is verified (signature, key, expiry, schema) before being trusted.">
          <Textarea value={manifest} onChange={(e) => setManifest(e.target.value)} className="font-mono text-[11px]" rows={5} spellCheck={false} />
        </Field>
        <ErrorText error={error} />
        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={busy}>
            Verify & add
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ImportRelays({ open, onClose }: { open: boolean; onClose: () => void }) {
  const rt = useRuntime();
  const [json, setJson] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  return (
    <Modal open={open} title="Import relay configuration" onClose={onClose}>
      <div className="space-y-3">
        <p className="text-xs leading-relaxed text-ink-300">
          Paste a <span className="font-mono">relaymesh.relay-config</span> bundle from a friend, community, or operator. Relays without a valid manifest are added as manual entries; invalid
          manifests are reported and never trusted.
        </p>
        <Textarea value={json} onChange={(e) => setJson(e.target.value)} rows={8} className="font-mono text-[11px]" spellCheck={false} />
        <ErrorText error={error} />
        {result && <Callout tone="good">{result}</Callout>}
        <div className="flex justify-end">
          <Button
            variant="primary"
            loading={busy}
            onClick={() =>
              void run(async () => {
                const r = await rt.importRelayBundle(json);
                setResult(`Added ${r.added} relay(s).${r.rejected.length ? ` Rejected ${r.rejected.length} manifest(s): ${r.rejected.map((x) => x.error).join("; ")}` : ""}`);
              })
            }
          >
            Import
          </Button>
        </div>
      </div>
    </Modal>
  );
}
