import { erc20Abi, type Address, type PublicClient } from "viem";
import type { TokenConfig } from "./config.ts";

export interface TokenBalance {
  token: TokenConfig;
  balance: bigint | null;
  error?: string;
  /** On-chain decimals; a mismatch with configuration is a red flag shown to the user. */
  onChainDecimals?: number;
}

export type BalanceClient = Pick<PublicClient, "readContract" | "getCode">;

/** Reads balances for configured tokens and cross-checks contract code and decimals. */
export async function readTokenBalances(client: BalanceClient, owner: Address, tokens: TokenConfig[]): Promise<TokenBalance[]> {
  return Promise.all(
    tokens.map(async (token): Promise<TokenBalance> => {
      try {
        const code = await client.getCode({ address: token.address });
        if (!code || code === "0x") return { token, balance: null, error: "No contract deployed at this address on the selected chain" };
        const [balance, decimals] = await Promise.all([
          client.readContract({ address: token.address, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
          client.readContract({ address: token.address, abi: erc20Abi, functionName: "decimals" }),
        ]);
        const result: TokenBalance = { token, balance, onChainDecimals: decimals };
        if (decimals !== token.decimals) result.error = `Configured decimals ${token.decimals} differ from on-chain ${decimals}`;
        return result;
      } catch (e) {
        return { token, balance: null, error: (e as Error).message.split("\n")[0] };
      }
    }),
  );
}
