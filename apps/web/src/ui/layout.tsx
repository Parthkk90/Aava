import { useState, type ReactNode } from "react";
import { NavLink, Link, Outlet } from "react-router-dom";
import { Activity, EyeOff, Fingerprint, LayoutDashboard, Lock, Menu, MessagesSquare, Network, Radar, ReceiptText, ShieldCheck, Users, Wallet, X } from "lucide-react";
import { useRuntime } from "./use-runtime.ts";
import { Button, Dot, KV, Modal, cx } from "./kit.tsx";

const NAV = [
  { to: "/app", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/app/messages", label: "Messages", icon: MessagesSquare },
  { to: "/app/communities", label: "Communities", icon: Users },
  { to: "/app/payments", label: "Payments", icon: ReceiptText },
  { to: "/app/wallet", label: "Wallet", icon: Wallet },
  { to: "/app/private", label: "Private payments", icon: EyeOff },
  { to: "/app/relays", label: "Relay Mesh", icon: Network },
  { to: "/app/privacy", label: "Privacy Routing", icon: Radar },
  { to: "/app/observatory", label: "Observatory", icon: Activity },
  { to: "/app/identity", label: "Identity Vault", icon: Fingerprint },
];

export function Logo({ className }: { className?: string }) {
  return (
    <Link to="/" className={cx("flex items-center", className)}>
      <span className="text-[17px] font-semibold tracking-tight text-ink-100">Aava</span>
    </Link>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const rt = useRuntime();
  const relays = rt.mesh?.states() ?? [];
  const open = relays.filter((r) => r.status === "open").length;
  return (
    <div className="flex h-full flex-col">
      <div className="px-4 py-4">
        <Logo />
      </div>
      <nav className="flex-1 space-y-0.5 px-2" aria-label="Main">
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            onClick={onNavigate}
            className={({ isActive }) =>
              cx("flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors", isActive ? "bg-ink-700 text-ink-100" : "text-ink-300 hover:bg-ink-800 hover:text-ink-100")
            }
          >
            <Icon className="h-4 w-4" aria-hidden />
            {label}
          </NavLink>
        ))}
      </nav>
      <div className="space-y-3 border-t border-ink-700 p-3">
        <div className="flex items-center gap-2 px-1 text-xs text-ink-300">
          <Dot tone={open === 0 ? "bad" : open < relays.length ? "warn" : "good"} pulse={open > 0} />
          {open}/{relays.length} relays connected
        </div>
        <div className="flex items-center justify-between gap-2 rounded-md bg-ink-800 px-2.5 py-2">
          <div className="min-w-0">
            <div className="truncate text-xs font-medium text-ink-100">{rt.identity?.label}</div>
            <div className="truncate font-mono text-[10px] text-ink-400">{rt.identity?.npub.slice(0, 20)}…</div>
          </div>
          <button className="text-ink-400 hover:text-ink-100" onClick={() => rt.lock()} title="Lock vault" aria-label="Lock vault">
            <Lock className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

function WalletPrompt() {
  const rt = useRuntime();
  const p = rt.wallet.prompt;
  return (
    <Modal
      open={!!p}
      title={p?.title ?? ""}
      onClose={() => p?.resolve(false)}
      footer={
        <>
          <Button onClick={() => p?.resolve(false)}>Reject</Button>
          <Button variant="primary" onClick={() => p?.resolve(true)}>
            Confirm
          </Button>
        </>
      }
    >
      <p className="mb-3 text-xs leading-relaxed text-ink-300">
        This is the <strong className="text-ink-100">local test wallet</strong>: the devnet node holds the key, and Aava never sees it. Nothing happens unless you confirm.
      </p>
      {p && <KV rows={p.lines.map(([k, v]) => [k, <span className="break-all font-mono">{v}</span>])} />}
    </Modal>
  );
}

export function AppShell() {
  const [mobileOpen, setMobileOpen] = useState(false);
  return (
    <div className="flex h-full">
      <aside className="hidden w-60 shrink-0 border-r border-ink-700 bg-ink-950 lg:block">
        <Sidebar />
      </aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 border-r border-ink-700 bg-ink-950">
            <button className="absolute right-3 top-4 text-ink-300" onClick={() => setMobileOpen(false)} aria-label="Close menu">
              <X className="h-5 w-5" />
            </button>
            <Sidebar onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-ink-700 px-4 py-3 lg:hidden">
          <Logo />
          <button className="text-ink-200" onClick={() => setMobileOpen(true)} aria-label="Open menu">
            <Menu className="h-5 w-5" />
          </button>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto scroll-thin">
          <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
            <Outlet />
          </div>
        </main>
      </div>
      <WalletPrompt />
    </div>
  );
}

export function CenteredPanel({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-full items-center justify-center px-4 py-12">
      <div className="grid-bg pointer-events-none absolute inset-0" />
      <div className="relative w-full max-w-md">
        <div className="mb-6 flex justify-center">
          <Logo />
        </div>
        {children}
        <p className="mt-6 flex items-center justify-center gap-1.5 text-center text-[11px] text-ink-400">
          <ShieldCheck className="h-3.5 w-3.5" /> Keys are generated and stored on this device only.
        </p>
      </div>
    </div>
  );
}
