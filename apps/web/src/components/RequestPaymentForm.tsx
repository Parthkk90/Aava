import { useState } from "react";
import { parseUnitsExact } from "@relaymesh/chain";
import { useRuntime } from "../ui/use-runtime.ts";
import { Button, Callout, ErrorText, Field, Input, Select, useAction } from "../ui/kit.tsx";

/** Creates an EIP-712 payment request signed by the user's wallet and sends it over NIP-17. */
export function RequestPaymentForm({ to, recipients, communityId, onDone }: { to: string; recipients?: string[]; communityId?: `0x${string}`; onDone: () => void }) {
  const rt = useRuntime();
  const tokens = rt.tokens.forChain(rt.settings.chainId);
  const [token, setToken] = useState(tokens[0]?.address ?? "");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [ttl, setTtl] = useState("86400");
  const { busy, error, run, setError } = useAction();
  const t = tokens.find((x) => x.address === token);

  if (rt.wallet.state.kind === "none") return <Callout tone="warn">Connect a wallet first. The request is signed by your wallet so the payer can verify the recipient and amount were not altered.</Callout>;
  if (tokens.length === 0) return <Callout tone="warn">No tokens are configured for chain {rt.settings.chainId}. Add one on the Wallet page.</Callout>;

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!t) return setError("Choose a token");
        let base: bigint;
        try {
          base = parseUnitsExact(amount, t.decimals);
          if (base <= 0n) throw new Error("Amount must be greater than zero");
        } catch (err) {
          return setError((err as Error).message);
        }
        void run(async () => {
          await rt.createPaymentRequest({ to, recipients, token: t.address, amount: base, description, ttlSec: Number(ttl), communityId });
          onDone();
        });
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Token" hint={t ? `Contract ${t.address.slice(0, 10)}…` : undefined}>
          <Select value={token} onChange={(e) => setToken(e.target.value as typeof token)}>
            {tokens.map((x) => (
              <option key={x.address} value={x.address}>
                {x.symbol} · {x.address.slice(0, 8)}…
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Amount">
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="25.00" />
        </Field>
      </div>
      <Field label="Description (visible to the payer)">
        <Input maxLength={280} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="March hosting" />
      </Field>
      <Field label="Valid for">
        <Select value={ttl} onChange={(e) => setTtl(e.target.value)}>
          <option value="900">15 minutes</option>
          <option value="3600">1 hour</option>
          <option value="86400">24 hours</option>
          <option value="604800">7 days</option>
        </Select>
      </Field>
      <p className="text-[11px] leading-relaxed text-ink-400">
        Payment goes to your connected wallet <span className="font-mono">{rt.wallet.state.account}</span> on chain {rt.settings.chainId}. Your wallet will ask you to sign the request (no
        funds move). Your wallet address is revealed only to the recipients of this encrypted message.
      </p>
      <ErrorText error={error} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={busy}>
          Sign & send request
        </Button>
      </div>
    </form>
  );
}
