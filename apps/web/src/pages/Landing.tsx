import { Link } from "react-router-dom";
import { ArrowRight, Ban, Check, Code2, Eye, EyeOff, KeyRound, Lock, Network, Radar, ReceiptText, ServerCog, ShieldCheck, X } from "lucide-react";
import { Logo } from "../ui/layout.tsx";
import { Badge, cx } from "../ui/kit.tsx";

const REPO_URL = import.meta.env.VITE_REPO_URL as string | undefined;

const CROPS = [
  { letter: "C", title: "Censorship resistant", icon: Ban, body: "Messages are published to every relay you choose. Lose one relay, or all of ours, and the network keeps working on the rest. No registry is mandatory." },
  { letter: "O", title: "Open source", icon: Code2, body: "Every line of the client, relay, and test suite is MIT-licensed. Build it, host it, fork it. Releases ship with a hash manifest you can check." },
  { letter: "P", title: "Private", icon: EyeOff, body: "One-to-one messages use NIP-17 gift wraps: relays store ciphertext signed by throwaway keys. Your wallet and chat identity are never published together." },
  { letter: "S", title: "Secure", icon: ShieldCheck, body: "Payment requests are EIP-712 signed, bound to the sender's chat identity, and verified against the actual on-chain receipt before anything counts as paid." },
];

const STEPS = [
  { icon: KeyRound, title: "Own your identity", body: "A key pair generated on your device, encrypted at rest with NIP-49. No sign-up, no server account, no phone number." },
  { icon: Network, title: "Pick your infrastructure", body: "Connect to any Nostr relays, any EVM RPC, any TURN server. Import signed operator manifests or type URLs by hand." },
  { icon: ReceiptText, title: "Talk and get paid", body: "Send encrypted messages and signed payment requests. Payers approve every transfer in their own wallet; receipts are checked on-chain." },
  { icon: Radar, title: "Verify, don't trust", body: "The Privacy Observatory runs real tests in your browser and shows evidence and limitations: never a made-up score." },
];

const VISIBLE: [string, boolean][] = [
  ["Message content", false],
  ["Who sent a message", false],
  ["Who received a message (recipient key)", true],
  ["When and how large", true],
  ["Your IP address (unless you use Tor or a VPN)", true],
  ["Your wallet address", false],
];

const NOT_CLAIMED = [
  "Forward secrecy. NIP-44 uses static keys; a stolen key decrypts past messages. A ratcheting protocol (MLS) is future work.",
  "Anonymity. Aava does not route traffic through Tor by itself. Use Tor Browser or an onion-only relay policy.",
  "Private payments. ERC-20 transfers are public on-chain. The blind-token module is experimental and off by default.",
  "Production readiness. This has not had an independent security review.",
];

const OPERATORS = [
  "Relay operators publish signed manifests: URL, software, capabilities, key, and expiry. Aava verifies them before showing them as verified.",
  "Run the reference relay or any NIP-01 relay with one Docker command.",
  "Self-host the static frontend anywhere: every route works without server rewrites.",
];

function SectionHeading({ eyebrow, title, body }: { eyebrow: string; title: string; body?: string }) {
  return (
    <div className="max-w-2xl">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-soft">{eyebrow}</p>
      <h2 className="mt-3 text-2xl font-semibold tracking-tight text-ink-100 sm:text-3xl">{title}</h2>
      {body && <p className="mt-3 text-sm leading-relaxed text-ink-300">{body}</p>}
    </div>
  );
}

export function Landing() {
  return (
    <div className="min-h-full bg-ink-900">
      <header className="sticky top-0 z-30 border-b border-ink-700/60 bg-ink-900/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
          <Logo />
          <nav className="flex items-center gap-1 text-sm">
            <a href="#crops" className="hidden rounded-lg px-3 py-1.5 text-ink-300 transition-colors hover:bg-ink-800 hover:text-ink-100 sm:block">
              CROPS
            </a>
            <a href="#how" className="hidden rounded-lg px-3 py-1.5 text-ink-300 transition-colors hover:bg-ink-800 hover:text-ink-100 sm:block">
              How it works
            </a>
            <a href="#privacy" className="hidden rounded-lg px-3 py-1.5 text-ink-300 transition-colors hover:bg-ink-800 hover:text-ink-100 sm:block">
              Privacy
            </a>
            <Link
              to="/app"
              className="ml-2 inline-flex h-9 items-center gap-2 rounded-lg bg-violet px-4 text-sm font-medium text-white shadow-[0_6px_24px_-10px_rgba(139,92,246,0.9)] transition-all hover:bg-violet-soft hover:shadow-[0_8px_28px_-8px_rgba(139,92,246,0.95)]"
            >
              Launch app <ArrowRight className="h-4 w-4" />
            </Link>
          </nav>
        </div>
      </header>

      <section className="relative overflow-hidden">
        <div className="grid-bg pointer-events-none absolute inset-0" />
        <div
          aria-hidden
          className="pointer-events-none absolute -top-32 left-1/2 h-[420px] w-[720px] -translate-x-1/2 rounded-full bg-violet/15 blur-[110px]"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -right-24 top-40 h-[320px] w-[320px] rounded-full bg-cyan/10 blur-[100px]"
        />
        <div className="relative mx-auto max-w-6xl px-4 pb-24 pt-16 sm:px-6 sm:pt-24">
          <Badge tone="violet">Open source · MIT · testnet prototype</Badge>
          <h1 className="mt-6 max-w-3xl text-4xl font-semibold leading-[1.08] tracking-tight text-ink-100 sm:text-5xl lg:text-6xl">
            Private messages and verifiable payments, on infrastructure{" "}
            <span className="bg-gradient-to-r from-cyan via-violet-soft to-violet bg-clip-text text-transparent">you</span> choose.
          </h1>
          <p className="mt-6 max-w-2xl text-base leading-relaxed text-ink-300 sm:text-lg">
            Aava is a client for people, communities, and AI agents. It encrypts every private message, authenticates every payment request, and keeps working if
            the people who wrote it, and their servers, disappear.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Link
              to="/app"
              className="group inline-flex h-12 items-center gap-2 rounded-lg bg-violet px-6 text-sm font-medium text-white shadow-[0_10px_36px_-12px_rgba(139,92,246,0.95)] transition-all hover:bg-violet-soft hover:shadow-[0_12px_40px_-10px_rgba(139,92,246,1)]"
            >
              Launch Aava
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
            {REPO_URL && (
              <a
                href={REPO_URL}
                rel="noreferrer noopener"
                target="_blank"
                className="inline-flex h-12 items-center gap-2 rounded-lg border border-ink-600 bg-ink-850/60 px-6 text-sm text-ink-100 transition-colors hover:border-ink-500 hover:bg-ink-800"
              >
                <Code2 className="h-4 w-4" /> Read the source
              </a>
            )}
          </div>
          <dl className="mt-14 grid max-w-3xl grid-cols-2 gap-px overflow-hidden rounded-xl border border-ink-700 bg-ink-700 sm:grid-cols-4">
            {[
              ["NIP-17", "gift-wrapped DMs"],
              ["EIP-712", "signed requests"],
              ["N relays", "no single operator"],
              ["0", "analytics requests"],
            ].map(([k, v]) => (
              <div key={k} className="bg-ink-850 px-4 py-4">
                <dt className="font-mono text-lg text-ink-100">{k}</dt>
                <dd className="mt-1 text-xs text-ink-400">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section id="crops" className="border-t border-ink-700/60 bg-ink-950">
        <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <SectionHeading
            eyebrow="The standard"
            title="Built to the CROPS standard"
            body="Each property is backed by an automated acceptance test. A test fails if its condition is not met: nothing is marked as passing on trust."
          />
          <div className="mt-10 grid gap-4 sm:grid-cols-2">
            {CROPS.map(({ letter, title, icon: Icon, body }) => (
              <div
                key={title}
                className="group rounded-xl border border-ink-700 bg-ink-850 p-5 transition-all hover:border-violet/40 hover:bg-ink-800"
              >
                <div className="flex items-center gap-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-violet/30 bg-violet/10 font-mono text-sm font-semibold text-violet-soft transition-colors group-hover:bg-violet/20">
                    {letter}
                  </span>
                  <h3 className="font-medium text-ink-100">{title}</h3>
                  <Icon className="ml-auto h-4 w-4 text-ink-400 transition-colors group-hover:text-violet-soft" />
                </div>
                <p className="mt-3 text-sm leading-relaxed text-ink-300">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="how" className="border-t border-ink-700/60">
        <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <SectionHeading eyebrow="How it works" title="Four steps, no account required" />
          <div className="mt-10 grid gap-6 md:grid-cols-4">
            {STEPS.map(({ icon: Icon, title, body }, i) => (
              <div key={title} className="relative">
                <div className="flex items-center gap-3 text-xs text-ink-400">
                  <span className="font-mono text-violet-soft">0{i + 1}</span>
                  <span className="h-px flex-1 bg-gradient-to-r from-ink-600 to-transparent" />
                </div>
                <div className="mt-5 flex h-10 w-10 items-center justify-center rounded-lg border border-ink-700 bg-ink-850">
                  <Icon className="h-5 w-5 text-cyan" />
                </div>
                <h3 className="mt-4 font-medium text-ink-100">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-300">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="privacy" className="border-t border-ink-700/60 bg-ink-950">
        <div className="mx-auto grid max-w-6xl gap-12 px-4 py-20 sm:px-6 lg:grid-cols-2">
          <div>
            <SectionHeading
              eyebrow="Privacy"
              title="What a relay operator can see"
              body="Encryption protects content, not everything. We would rather tell you exactly what leaks than claim perfect privacy. These are the properties our tests check."
            />
            <ul className="mt-8 divide-y divide-ink-700 overflow-hidden rounded-xl border border-ink-700 bg-ink-850">
              {VISIBLE.map(([what, visible]) => (
                <li key={what} className="flex items-center justify-between gap-4 px-4 py-3.5 text-sm transition-colors hover:bg-ink-800">
                  <span className="text-ink-200">{what}</span>
                  <span className={cx("inline-flex shrink-0 items-center gap-1.5 text-xs", visible ? "text-amber" : "text-mint")}>
                    {visible ? <Eye className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
                    {visible ? "visible" : "hidden"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div className="space-y-8">
            <div>
              <h3 className="text-sm font-semibold text-ink-100">What we do not claim</h3>
              <div className="mt-4 space-y-3.5">
                {NOT_CLAIMED.map((t) => (
                  <div key={t} className="flex gap-3 rounded-lg border border-ink-700 bg-ink-850 px-4 py-3 text-sm leading-relaxed text-ink-300">
                    <X className="mt-1 h-3.5 w-3.5 shrink-0 text-rose" />
                    {t}
                  </div>
                ))}
              </div>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-ink-100">Independent operators</h3>
              <div className="mt-4 space-y-3.5">
                {OPERATORS.map((t) => (
                  <div key={t} className="flex gap-3 rounded-lg border border-ink-700 bg-ink-850 px-4 py-3 text-sm leading-relaxed text-ink-300">
                    <Check className="mt-1 h-3.5 w-3.5 shrink-0 text-mint" />
                    {t}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <footer className="border-t border-ink-700/70">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-8 text-xs text-ink-400 sm:px-6">
          <div className="flex items-center gap-2">
            <ServerCog className="h-4 w-4" /> No Aava backend is required to use this app.
          </div>
          <div>MIT licensed · Testnet prototype · Not independently audited</div>
        </div>
      </footer>
    </div>
  );
}
