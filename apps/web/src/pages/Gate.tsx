import { useState, type ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { KeyRound, Loader2, Upload } from "lucide-react";
import { MIN_PASSWORD_LENGTH } from "@relaymesh/identity";
import { useRuntime } from "../ui/use-runtime.ts";
import { Button, Callout, Card, CardBody, ErrorText, Field, Input, Textarea, cx, useAction } from "../ui/kit.tsx";
import { CenteredPanel } from "../ui/layout.tsx";

/** Routes the user to onboarding / unlock until a session is ready. */
export function RequireSession({ children }: { children: ReactNode }) {
  const rt = useRuntime();
  if (rt.phase === "loading")
    return (
      <div className="flex h-full items-center justify-center text-ink-300">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  if (rt.phase === "onboarding") return <Onboarding />;
  if (rt.phase === "locked") return <Unlock />;
  return <>{children}</>;
}

function PasswordFields({ value, onChange, label = "Device password" }: { value: { a: string; b: string }; onChange: (v: { a: string; b: string }) => void; label?: string }) {
  const mismatch = value.b.length > 0 && value.a !== value.b;
  return (
    <>
      <Field label={label} hint={`At least ${MIN_PASSWORD_LENGTH} characters. Encrypts your key on this device (NIP-49: scrypt + XChaCha20-Poly1305).`}>
        <Input type="password" autoComplete="new-password" value={value.a} onChange={(e) => onChange({ ...value, a: e.target.value })} />
      </Field>
      <Field label="Repeat password" error={mismatch ? "Passwords do not match" : null}>
        <Input type="password" autoComplete="new-password" value={value.b} onChange={(e) => onChange({ ...value, b: e.target.value })} />
      </Field>
    </>
  );
}

function Onboarding() {
  const rt = useRuntime();
  const [mode, setMode] = useState<"create" | "restore" | "nsec">("create");
  const [label, setLabel] = useState("");
  const [pw, setPw] = useState({ a: "", b: "" });
  const [backup, setBackup] = useState("");
  const [backupPw, setBackupPw] = useState("");
  const [nsec, setNsec] = useState("");
  const { busy, error, run, setError } = useAction();
  const pwOk = pw.a.length >= MIN_PASSWORD_LENGTH && pw.a === pw.b;

  async function submit() {
    if (!pwOk) return setError(`Choose a matching password of at least ${MIN_PASSWORD_LENGTH} characters.`);
    await run(async () => {
      if (mode === "create") await rt.createIdentity(pw.a, label.trim() || "Primary");
      else if (mode === "restore") await rt.restoreFromBackup(backup, backupPw, pw.a);
      else await rt.importNsec(nsec, pw.a, label.trim() || "Imported");
    });
  }

  const tab = (m: typeof mode, text: string) => (
    <button
      type="button"
      onClick={() => {
        setMode(m);
        setError(null);
      }}
      className={cx("flex-1 rounded-md px-3 py-1.5 text-xs font-medium", mode === m ? "bg-ink-700 text-ink-100" : "text-ink-300 hover:text-ink-100")}
    >
      {text}
    </button>
  );

  return (
    <CenteredPanel>
      <Card>
        <CardBody className="space-y-4">
          <div>
            <h1 className="text-base font-semibold">Set up your identity</h1>
            <p className="mt-1 text-xs leading-relaxed text-ink-300">Your identity is a key pair created on this device. There is no account, server, or recovery service: keep an encrypted backup.</p>
          </div>
          <div className="flex gap-1 rounded-lg bg-ink-900 p-1">
            {tab("create", "Create new")}
            {tab("restore", "Restore backup")}
            {tab("nsec", "Import nsec")}
          </div>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            {mode !== "restore" && (
              <Field label="Label (local only)">
                <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Alice" maxLength={40} />
              </Field>
            )}
            {mode === "restore" && (
              <>
                <Field label="Backup file" hint="A relaymesh.identity-backup JSON file you exported earlier.">
                  <label className="flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-ink-600 px-3 py-2.5 text-xs text-ink-300 hover:border-ink-500">
                    <Upload className="h-4 w-4" />
                    {backup ? "Backup loaded" : "Choose file…"}
                    <input
                      type="file"
                      accept="application/json,.json"
                      className="sr-only"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void f.text().then(setBackup);
                      }}
                    />
                  </label>
                </Field>
                <Field label="Backup password">
                  <Input type="password" value={backupPw} onChange={(e) => setBackupPw(e.target.value)} autoComplete="off" />
                </Field>
              </>
            )}
            {mode === "nsec" && (
              <>
                <Callout tone="warn">Pasting an nsec exposes it to this page and your clipboard. Prefer restoring an encrypted backup.</Callout>
                <Field label="nsec">
                  <Textarea value={nsec} onChange={(e) => setNsec(e.target.value)} className="font-mono text-xs" autoComplete="off" spellCheck={false} />
                </Field>
              </>
            )}
            <PasswordFields value={pw} onChange={setPw} label={mode === "restore" ? "New device password" : "Device password"} />
            <ErrorText error={error} />
            <Button type="submit" variant="primary" className="w-full" loading={busy}>
              <KeyRound className="h-4 w-4" />
              {mode === "create" ? "Generate identity" : mode === "restore" ? "Restore identity" : "Import identity"}
            </Button>
          </form>
        </CardBody>
      </Card>
    </CenteredPanel>
  );
}

function Unlock() {
  const rt = useRuntime();
  const [pw, setPw] = useState("");
  const [confirmWipe, setConfirmWipe] = useState(false);
  const { busy, error, run } = useAction();
  return (
    <CenteredPanel>
      <Card>
        <CardBody className="space-y-4">
          <div>
            <h1 className="text-base font-semibold">Unlock {rt.identity?.label}</h1>
            <p className="mt-1 break-all font-mono text-[11px] text-ink-400">{rt.identity?.npub}</p>
          </div>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => rt.unlock(pw));
            }}
          >
            <Field label="Device password">
              <Input type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" />
            </Field>
            <ErrorText error={error} />
            <Button type="submit" variant="primary" className="w-full" loading={busy}>
              Unlock
            </Button>
          </form>
          <div className="border-t border-ink-700 pt-3">
            {!confirmWipe ? (
              <button className="text-[11px] text-ink-400 hover:text-rose" onClick={() => setConfirmWipe(true)}>
                Forgot password? Erase this device and restore from backup…
              </button>
            ) : (
              <div className="space-y-2">
                <Callout tone="bad" title="Erase all local data?">
                  This deletes the encrypted key, message history, and payment ledger on this device. Without a backup your identity is lost.
                </Callout>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => setConfirmWipe(false)}>
                    Cancel
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => void rt.wipeDevice()}>
                    Erase device
                  </Button>
                </div>
              </div>
            )}
          </div>
        </CardBody>
      </Card>
    </CenteredPanel>
  );
}

export function NotFound() {
  return <Navigate to="/" replace />;
}
