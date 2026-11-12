import { createWalletClient, http, type Address, type Hex, type TypedDataDefinition } from "viem";

/**
 * The only wallet capability an agent receives: produce a typed-data
 * signature for an already policy-approved payment. The agent process never
 * holds the wallet's private key.
 */
export interface AgentSigner {
  address(): Promise<Address>;
  signTypedData(data: TypedDataDefinition): Promise<Hex>;
}

/**
 * Devnet signer backed by an RPC node's unlocked account (anvil). The key
 * stays in the node. For production use a remote signer or hardware wallet
 * that enforces its own limits; it is not implemented in this repository.
 */
export class NodeUnlockedSigner implements AgentSigner {
  constructor(
    private readonly rpcUrl: string,
    private readonly account: Address,
  ) {}
  async address() {
    return this.account;
  }
  async signTypedData(data: TypedDataDefinition): Promise<Hex> {
    const client = createWalletClient({ transport: http(this.rpcUrl) });
    return client.signTypedData({ ...(data as object), account: this.account } as Parameters<typeof client.signTypedData>[0]);
  }
}
