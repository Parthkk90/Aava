import { useEffect, useState } from "react";
import { AlertTriangle, Download, Fingerprint, KeyRound, Lock, RefreshCw, Trash2 } from "lucide-react";
import { MIN_PASSWORD_LENGTH, type VaultIdentityRecord } from "@relaymesh/identity";
import { useRuntime } from "../ui/use-runtime.ts";
import { Badge, Button, Callout, Card, CardBody, CardHeader, ErrorText, Field, Input, KV, Mono, PageHeader, download, useAction } from "../ui/kit.tsx";

export function Identity() {
  const rt = useRuntime();
  const id = rt.identity!;
  const [all, setAll] = useState<Omit<VaultIdentityRecord, "ncryptsec">[]>([]);
  useEffect(() => {
    void rt.vault.listIdentities().then(setAll);
  }, [rt, id.pubkey]);

  return (
    <>
      <PageHeader title="Identity Vault" subtitle="Your identity is a secp256k1 key pair generated on this device. It is never sent to any server. Aava cannot recover it for you: keep an encrypted backup." />
      <div className="mb-4">
        <Callout tone="warn" title="An unlocked device can expose your key">
          While the vault is unlocked the key is in this tab's memory. Malware, a malicious browser extension, or someone with access to your unlocked device can copy it. Lock the vault when you
          step away. It also locks automatically after 15 minutes of inactivity.
        </Callout>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Active identity" icon={<Fingerprint className="h-4 w-4" />} actions={<Button size="sm" onClick={() => rt.lock()}><Lock className="h-3.5 w-3.5" /> Lock now</Button>} />
          <CardBody>
            <KV
              rows={[
                ["Label", id.label],
                ["npub (share this)", <Mono value={id.npub} />],
                ["Public key (hex)", <Mono value={id.pubkey} />],
                ["Created", new Date(id.createdAt * 1000).toLocaleString()],
                ["At rest", "NIP-49 ncryptsec (scrypt log_n=16, XChaCha20-Poly1305) in IndexedDB"],
                ["Message history at rest", "NIP-44 encrypted to your own key"],
              ]}
            />
            {all.length > 1 && (
              <div className="mt-4 border-t border-ink-700 pt-3">
                <div className="mb-2 text-xs font-medium text-ink-300">Key history</div>
                <ul className="space-y-1.5">
                  {all.map((i) => (
                    <li key={i.id} className="flex items-center justify-between gap-2 text-xs">
                      <Mono value={i.npub} />
                      <Badge tone={i.status === "active" ? "good" : "neutral"}>{i.status}</Badge>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardBody>
        </Card>
        <Backup />
        <Rotate />
        <Wipe />
      </div>
    </>
  );
}

function Backup() {
  const rt = useRuntime();
  const [pw, setPw] = useState({ a: "", b: "" });
  const [done, setDone] = useState(false);
  const { busy, error, run, setError } = useAction();
  return (
    <Card>
      <CardHeader title="Encrypted backup" description="Exports a NIP-49 encrypted file. Aava restores it in memory immediately to prove it works before you rely on it." icon={<Download className="h-4 w-4" />} />
      <CardBody>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (pw.a.length < MIN_PASSWORD_LENGTH || pw.a !== pw.b) return setError(`Use matching passwords of at least ${MIN_PASSWORD_LENGTH} characters.`);
            void run(async () => {
              const json = rt.exportBackup(pw.a);
              download(`relaymesh-identity-${rt.identity!.npub.slice(5, 13)}.json`, json);
              setDone(true);
              setPw({ a: "", b: "" });
            });
          }}
        >
          <Field label="Backup password" hint="Can differ from your device password. Without it the backup cannot be opened.">
            <Input type="password" autoComplete="new-password" value={pw.a} onChange={(e) => setPw({ ...pw, a: e.target.value })} />
          </Field>
          <Field label="Repeat backup password">
            <Input type="password" autoComplete="new-password" value={pw.b} onChange={(e) => setPw({ ...pw, b: e.target.value })} />
          </Field>
          <ErrorText error={error} />
          {done && <Callout tone="good">Backup created and verified: it decrypts to your current public key. Store it offline, separately from the password.</Callout>}
          <Button type="submit" variant="primary" loading={busy}>
            <KeyRound className="h-4 w-4" /> Create & verify backup
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

function Rotate() {
  const rt = useRuntime();
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState(false);
  const { busy, error, run } = useAction();
  const contacts = rt.store?.listContacts().length ?? 0;
  return (
    <Card>
      <CardHeader title="Key rotation" description="Generates a new identity key and sends your contacts a notice signed by both the old and the new key." icon={<RefreshCw className="h-4 w-4" />} />
      <CardBody className="space-y-3">
        <Callout tone="warn">
          Nostr has no network-wide key revocation. Rotation helps contacts who trust you move to the new key, but anyone holding a stolen old key can still sign as it. Make a new backup after
          rotating.
        </Callout>
        {!confirm ? (
          <Button onClick={() => setConfirm(true)}>Rotate key…</Button>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await rt.rotateIdentity(pw);
                setConfirm(false);
                setPw("");
              });
            }}
          >
            <Field label="Device password">
              <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" />
            </Field>
            <p className="text-[11px] text-ink-400">A rotation notice will be sent to {contacts} contact(s).</p>
            <ErrorText error={error} />
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={() => setConfirm(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" loading={busy}>
                Rotate now
              </Button>
            </div>
          </form>
        )}
      </CardBody>
    </Card>
  );
}

function Wipe() {
  const rt = useRuntime();
  const [text, setText] = useState("");
  return (
    <Card>
      <CardHeader title="Erase this device" description="Deletes the encrypted key, message history, payment ledger, and settings from this browser." icon={<Trash2 className="h-4 w-4" />} />
      <CardBody className="space-y-3">
        <Callout tone="bad">
          <span className="inline-flex items-center gap-1">
            <AlertTriangle className="h-3.5 w-3.5" /> Without a backup your identity cannot be recovered.
          </span>
        </Callout>
        <Field label='Type "erase" to confirm'>
          <Input value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
        <Button variant="danger" disabled={text !== "erase"} onClick={() => void rt.wipeDevice()}>
          Erase all local data
        </Button>
      </CardBody>
    </Card>
  );
}
