import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { AlertTriangle, Check, CheckCircle2, Copy, Info, Loader2, ShieldAlert, X, XCircle } from "lucide-react";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "ghost" | "danger";
const variants: Record<Variant, string> = {
  primary: "bg-violet text-white hover:bg-violet-soft disabled:bg-ink-600 disabled:text-ink-300",
  secondary: "bg-ink-800 text-ink-100 border border-ink-600 hover:border-ink-500 hover:bg-ink-700 disabled:text-ink-400",
  ghost: "text-ink-200 hover:bg-ink-800 hover:text-ink-100 disabled:text-ink-500",
  danger: "bg-rose/10 text-rose border border-rose/30 hover:bg-rose/20 disabled:opacity-50",
};

export function Button({ variant = "secondary", size = "md", loading, className, children, disabled, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md"; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors disabled:cursor-not-allowed",
        size === "sm" ? "h-8 px-3 text-xs" : "h-9 px-4 text-sm",
        variants[variant],
        className,
      )}
    >
      {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <section className={cx("rounded-xl border border-ink-700 bg-ink-850", className)}>{children}</section>;
}

export function CardHeader({ title, description, actions, icon }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-700 px-5 py-4">
      <div className="flex min-w-0 items-start gap-3">
        {icon && <div className="mt-0.5 text-ink-300">{icon}</div>}
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink-100">{title}</h2>
          {description && <p className="mt-0.5 text-xs leading-relaxed text-ink-300">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("px-5 py-4", className)}>{children}</div>;
}

export type Tone = "neutral" | "good" | "warn" | "bad" | "info" | "violet";
const tones: Record<Tone, string> = {
  neutral: "bg-ink-700 text-ink-200 border-ink-600",
  good: "bg-mint/10 text-mint border-mint/25",
  warn: "bg-amber/10 text-amber border-amber/25",
  bad: "bg-rose/10 text-rose border-rose/25",
  info: "bg-cyan/10 text-cyan border-cyan/25",
  violet: "bg-violet/10 text-violet-soft border-violet/25",
};

export function Badge({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cx("inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-0.5 text-[11px] font-medium leading-none", tones[tone], className)}>{children}</span>;
}

const dotTones: Record<Tone, string> = { neutral: "bg-ink-400", good: "bg-mint", warn: "bg-amber", bad: "bg-rose", info: "bg-cyan", violet: "bg-violet" };
export function Dot({ tone, pulse }: { tone: Tone; pulse?: boolean }) {
  return (
    <span className="relative inline-flex h-2 w-2">
      {pulse && <span className={cx("absolute inline-flex h-full w-full animate-ping rounded-full opacity-50", dotTones[tone])} />}
      <span className={cx("relative inline-flex h-2 w-2 rounded-full", dotTones[tone])} />
    </span>
  );
}

const inputCls = "w-full rounded-md border border-ink-600 bg-ink-900 px-3 py-2 text-sm text-ink-100 placeholder:text-ink-400 focus:border-violet focus:outline-none disabled:opacity-60";

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(inputCls, "h-9", props.className)} />;
}
export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx(inputCls, "min-h-20 resize-y", props.className)} />;
}
export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cx(inputCls, "h-9", props.className)} />;
}

/**
 * Label + control. Hints and errors sit outside the <label> so the control's
 * accessible name is exactly the label text.
 */
export function Field({ label, hint, children, error }: { label: string; hint?: ReactNode; children: ReactNode; error?: string | null }) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <label className="block space-y-1.5">
        <span className="text-xs font-medium text-ink-200">{label}</span>
        {children}
      </label>
      {hint && !error && (
        <p id={`${id}-hint`} className="text-[11px] leading-relaxed text-ink-400">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-err`} role="alert" className="text-[11px] text-rose">
          {error}
        </p>
      )}
    </div>
  );
}

export function Callout({ tone = "info", title, children }: { tone?: "info" | "warn" | "bad" | "good"; title?: ReactNode; children?: ReactNode }) {
  const Icon = tone === "warn" ? AlertTriangle : tone === "bad" ? ShieldAlert : tone === "good" ? CheckCircle2 : Info;
  const border = { info: "border-cyan/25 bg-cyan/5", warn: "border-amber/25 bg-amber/5", bad: "border-rose/30 bg-rose/5", good: "border-mint/25 bg-mint/5" }[tone];
  const color = { info: "text-cyan", warn: "text-amber", bad: "text-rose", good: "text-mint" }[tone];
  return (
    <div className={cx("flex gap-3 rounded-lg border px-4 py-3 text-xs leading-relaxed", border)}>
      <Icon className={cx("mt-0.5 h-4 w-4 shrink-0", color)} aria-hidden />
      <div className="space-y-1 text-ink-200">
        {title && <div className={cx("font-semibold", color)}>{title}</div>}
        {children}
      </div>
    </div>
  );
}

export function Mono({ value, short = true, className }: { value: string; short?: boolean; className?: string }) {
  const [copied, setCopied] = useState(false);
  const display = short && value.length > 22 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value;
  return (
    <span className={cx("inline-flex max-w-full items-center gap-1.5 font-mono text-xs text-ink-200", className)}>
      <span className="truncate" title={value}>
        {display}
      </span>
      <button
        type="button"
        className="shrink-0 text-ink-400 hover:text-ink-100"
        aria-label="Copy"
        onClick={() => {
          void navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          });
        }}
      >
        {copied ? <Check className="h-3 w-3 text-mint" /> : <Copy className="h-3 w-3" />}
      </button>
    </span>
  );
}

export function PageHeader({ title, subtitle, actions, badge }: { title: string; subtitle?: ReactNode; actions?: ReactNode; badge?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight text-ink-100">{title}</h1>
          {badge}
        </div>
        {subtitle && <p className="mt-1 max-w-3xl text-sm leading-relaxed text-ink-300">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
      {icon && <div className="mb-3 text-ink-400">{icon}</div>}
      <div className="text-sm font-medium text-ink-200">{title}</div>
      {children && <div className="mt-1 max-w-sm text-xs leading-relaxed text-ink-400">{children}</div>}
    </div>
  );
}

export function Modal({ open, title, onClose, children, footer }: { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} aria-label={title} className="m-auto w-[min(560px,calc(100vw-2rem))] rounded-xl border border-ink-600 bg-ink-850 p-0 text-ink-100 backdrop:bg-black/70">
      <div className="flex items-center justify-between border-b border-ink-700 px-5 py-3.5">
        <h2 className="text-sm font-semibold">{title}</h2>
        <button className="text-ink-400 hover:text-ink-100" onClick={onClose} aria-label="Close">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="max-h-[70vh] overflow-y-auto px-5 py-4 scroll-thin">{children}</div>
      {footer && <div className="flex justify-end gap-2 border-t border-ink-700 px-5 py-3">{footer}</div>}
    </dialog>
  );
}

export function KV({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="divide-y divide-ink-700/70 text-xs">
      {rows.map(([k, v], i) => (
        <div key={i} className="flex items-start justify-between gap-4 py-2">
          <dt className="shrink-0 text-ink-400">{k}</dt>
          <dd className="min-w-0 text-right text-ink-200">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function CheckList({ steps }: { steps: { check: string; ok: boolean; detail: string }[] }) {
  return (
    <ul className="space-y-1.5">
      {steps.map((s, i) => (
        <li key={i} className="flex gap-2 text-xs">
          {s.ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-mint" /> : <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose" />}
          <span className="text-ink-200">
            <span className="font-medium text-ink-100">{s.check}</span> — {s.detail}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Small async-action helper: tracks busy state and surfaces errors to the user. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError((e as Error).message.split("\n")[0] ?? "Something went wrong");
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, run };
}

export function ErrorText({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="text-xs text-rose">
      {error}
    </p>
  );
}

export function timeAgo(ms: number) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${Math.max(s, 0)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ms).toLocaleDateString();
}

export function download(filename: string, content: string) {
  const blob = new Blob([content], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
