import { erc20Abi, getAddress, type Address, type Hash } from "viem";
import { verifyTokenTransfer, type VerificationReport, type VerifierClient } from "@relaymesh/chain";
import { fromWire } from "./request.ts";
import { LedgerTransitionError, type RequestLedger } from "./ledger.ts";

/**
 * The minimal wallet surface RelayMesh needs. Implemented in the app on top of
 * an EIP-1193 provider; the wallet keeps its keys and shows its own prompt.
 */
export interface PaymentWallet {
  account(): Promise<Address>;
  chainId(): Promise<number>;
  /** Must trigger the wallet's own confirmation prompt. */
  transferToken(token: Address, to: Address, amount: bigint): Promise<Hash>;
}

export class UnauthorizedExecutionError extends Error {}

/**
 * Executes a payment that the user (or a constrained policy) has explicitly
 * approved. Refuses anything else. Returns the transaction hash — which is
 * NOT proof of payment; call settlePayment() for that.
 */
export async function executeApprovedPayment(ledger: RequestLedger, requestId: string, wallet: PaymentWallet, now = () => Math.floor(Date.now() / 1000)): Promise<Hash> {
  const entry = await ledger.get(requestId);
  if (!entry) throw new UnauthorizedExecutionError("Unknown payment request");
  if (entry.state !== "approved" || !entry.approval) throw new UnauthorizedExecutionError(`Payment is not approved (state: ${entry.state})`);
  const { request } = fromWire(entry.wire);
  if (request.expiresAt <= now()) throw new UnauthorizedExecutionError("Payment request has expired");
  const walletChain = await wallet.chainId();
  if (walletChain !== request.chainId) throw new UnauthorizedExecutionError(`Wallet is on chain ${walletChain}; request requires chain ${request.chainId}`);
  const payer = getAddress(await wallet.account());
  const hash = await wallet.transferToken(request.token, request.recipient, request.amount);
  await ledger.markSubmitted(requestId, hash, payer);
  return hash;
}

/** Verifies the on-chain receipt and moves the ledger entry to paid/failed. */
export async function settlePayment(ledger: RequestLedger, requestId: string, client: VerifierClient, requiredConfirmations: number): Promise<VerificationReport> {
  const entry = await ledger.get(requestId);
  if (!entry?.txHash || !entry.payer) throw new LedgerTransitionError("No submitted transaction for this request");
  const { request } = fromWire(entry.wire);
  const report = await verifyTokenTransfer(
    client,
    entry.txHash,
    { chainId: request.chainId, token: request.token, from: entry.payer, to: request.recipient, amount: request.amount },
    requiredConfirmations,
  );
  await ledger.applyVerification(requestId, report);
  return report;
}

/** Helper to build the ERC-20 transfer call for EIP-1193 wallets. */
export const erc20TransferCall = (token: Address, to: Address, amount: bigint) => ({
  address: token,
  abi: erc20Abi,
  functionName: "transfer" as const,
  args: [to, amount] as const,
});
