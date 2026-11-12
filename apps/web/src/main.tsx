import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createHashRouter, RouterProvider, useRouteError } from "react-router-dom";
import "./index.css";
import { runtime } from "./runtime/runtime.ts";
import { AppShell } from "./ui/layout.tsx";
import { NotFound, RequireSession } from "./pages/Gate.tsx";
import { Landing } from "./pages/Landing.tsx";
import { Dashboard } from "./pages/Dashboard.tsx";
import { Messages } from "./pages/Messages.tsx";
import { Communities } from "./pages/Communities.tsx";
import { Payments } from "./pages/Payments.tsx";
import { WalletPage } from "./pages/Wallet.tsx";
import { Relays } from "./pages/Relays.tsx";
import { Privacy } from "./pages/Privacy.tsx";
import { Observatory } from "./pages/Observatory.tsx";
import { Identity } from "./pages/Identity.tsx";
import { Shielded } from "./pages/Shielded.tsx";

// Hash routing: the app works from any static host or a local file server
// without server-side rewrites (C-06: users can host the frontend themselves).
function RouteError() {
  const err = useRouteError();
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-md space-y-3 rounded-xl border border-rose/30 bg-ink-850 p-6 text-sm">
        <h1 className="font-semibold text-rose">Something went wrong</h1>
        <p className="text-ink-300">Your identity and messages are stored locally and are unaffected. Reload to continue.</p>
        <pre className="overflow-auto rounded bg-ink-950 p-2 text-[11px] text-ink-400">{err instanceof Error ? err.message : String(err)}</pre>
        <button className="rounded-md bg-violet px-4 py-2 text-white" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    </div>
  );
}

const router = createHashRouter([
  { path: "/", element: <Landing />, errorElement: <RouteError /> },
  {
    path: "/app",
    errorElement: <RouteError />,
    element: (
      <RequireSession>
        <AppShell />
      </RequireSession>
    ),
    children: [
      { index: true, element: <Dashboard /> },
      { path: "messages", element: <Messages /> },
      { path: "messages/:peer", element: <Messages /> },
      { path: "communities", element: <Communities /> },
      { path: "payments", element: <Payments /> },
      { path: "wallet", element: <WalletPage /> },
      { path: "private", element: <Shielded /> },
      { path: "relays", element: <Relays /> },
      { path: "privacy", element: <Privacy /> },
      { path: "observatory", element: <Observatory /> },
      { path: "identity", element: <Identity /> },
    ],
  },
  { path: "*", element: <NotFound /> },
]);

void runtime.init();

// Activity keeps the vault's inactivity timer fresh.
for (const ev of ["pointerdown", "keydown"]) window.addEventListener(ev, () => runtime.vault.isUnlocked && runtime.vault.touch(), { passive: true });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
