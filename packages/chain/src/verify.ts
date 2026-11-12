import { erc20Abi, parseEventLogs, type Address, type Hash, type PublicClient } from "viem";
import { sameAddress } from "./config.ts";

export interface ExpectedTransfer {
  chainId: number;
  token: Address;
  /** The address whose tokens must move (the payer). */
  from: Address;
  to: Address;
  amount: bigint;
}

export interface VerificationCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export type VerificationStatus = "verified" | "pending" | "failed";

export interface VerificationReport {
  status: VerificationStatus;
  txHash: Hash;
  chainId: number;
  checks: VerificationCheck[];
  blockNumber?: bigint;
  confirmations?: number;
  requiredConfirmations: number;
  verifiedAt: number;
}

/** The subset of viem's PublicClient used for verification (easy to mock in tests). */
export type VerifierClient = Pick<PublicClient, "getChainId" | "getTransactionReceipt" | "getTransaction" | "getBlockNumber" | "getCode">;

/**
 * Verifies that a transaction really performed the expected ERC-20 transfer.
 * A wallet returning a hash proves nothing; only the receipt, logs, and
 * confirmation depth from the configured chain do. A malicious RPC endpoint
 * can still lie — use your own node or cross-check providers for high value.
 */
export async function verifyTokenTransfer(
  client: VerifierClient,
  txHash: Hash,
  expected: ExpectedTransfer,
  requiredConfirmations: number,
): Promise<VerificationReport> {
  const checks: VerificationCheck[] = [];
  const report = (status: VerificationStatus, extra: Partial<VerificationReport> = {}): VerificationReport => ({
    status,
    txHash,
    chainId: expected.chainId,
    checks,
    requiredConfirmations,
    verifiedAt: Date.now(),
    ...extra,
  });
  const check = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail });
    return ok;
  };

  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    check("Transaction hash format", false, "Not a 32-byte hex hash");
    return report("failed");
  }

  const chainId = await client.getChainId();
  if (!check("RPC chain", chainId === expected.chainId, `RPC reports chain ${chainId}, expected ${expected.chainId}`)) return report("failed");

  let receipt: Awaited<ReturnType<VerifierClient["getTransactionReceipt"]>>;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash });
  } catch {
    check("Receipt available", false, "No receipt yet: transaction is unknown or not mined");
    return report("pending");
  }
  check("Receipt available", true, `Mined in block ${receipt.blockNumber}`);

  if (!check("Execution status", receipt.status === "success", `Receipt status: ${receipt.status}`)) return report("failed", { blockNumber: receipt.blockNumber });

  // Informational only (the Transfer log decides). Light clients such as Helios
  // cannot prove eth_getTransaction, so its absence must not fail verification.
  const tx = await client.getTransaction({ hash: txHash }).catch(() => null);
  const code = await client.getCode({ address: expected.token });
  if (!check("Token contract exists", !!code && code !== "0x", code && code !== "0x" ? `Contract code present at ${expected.token}` : `No contract code at ${expected.token}`)) {
    return report("failed", { blockNumber: receipt.blockNumber });
  }

  const transfers = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs });
  const fromToken = transfers.filter((l) => sameAddress(l.address, expected.token));
  check(
    "Transfer emitted by expected token",
    fromToken.length > 0,
    fromToken.length > 0 ? `${fromToken.length} Transfer event(s) from ${expected.token}` : `No Transfer event from ${expected.token} (${transfers.length} from other contracts)`,
  );
  const matching = fromToken.filter(
    (l) => sameAddress(l.args.from, expected.from) && sameAddress(l.args.to, expected.to) && l.args.value === expected.amount,
  );
  const first = fromToken[0];
  check("Sender", fromToken.some((l) => sameAddress(l.args.from, expected.from)), first ? `Transfer.from = ${first.args.from}; expected ${expected.from}` : "no transfer");
  check("Recipient", fromToken.some((l) => sameAddress(l.args.to, expected.to)), first ? `Transfer.to = ${first.args.to}; expected ${expected.to}` : "no transfer");
  check("Amount", fromToken.some((l) => l.args.value === expected.amount), first ? `Transfer.value = ${first.args.value}; expected ${expected.amount}` : "no transfer");
  if (!check("Exact matching transfer", matching.length >= 1, matching.length ? "Found a Transfer matching sender, recipient and amount" : "No single Transfer matches all fields")) {
    return report("failed", { blockNumber: receipt.blockNumber });
  }
  check(
    "Transaction sender",
    true,
    !tx
      ? "tx.from not available from this provider (light client); token movement verified via Transfer log"
      : sameAddress(tx.from, expected.from)
        ? `tx.from matches payer ${tx.from}`
        : `tx.from ${tx.from} differs from payer (contract wallet or relayer); token movement verified via Transfer log`,
  );

  // viem caches getBlockNumber by default; a stale head would under-count confirmations.
  const head = await client.getBlockNumber({ cacheTime: 0 });
  const confirmations = Math.max(0, Number(head - receipt.blockNumber + 1n));
  const final = confirmations >= requiredConfirmations;
  check("Confirmations", final, `${confirmations} of ${requiredConfirmations} required`);
  return report(final ? "verified" : "pending", { blockNumber: receipt.blockNumber, confirmations });
}
