import {
  createWalletClient,
  http,
  parseAbi,
  type Hex,
  type Chain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import type { SellerPayout } from "./queue.js";
import type { PayoutExecutionResult, SellerPayoutExecutor } from "./executor.js";
import { StoreError } from "../errors/index.js";

const erc20TransferAbi = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
]);

export interface UsdcTransferPayoutOptions {
  readonly privateKey: `0x${string}`;
  readonly rpcUrl: string;
  readonly asset: `0x${string}`;
  /** Override chain; defaults from CAIP-2 network on each payout. */
  readonly chain?: Chain;
}

/**
 * Real on-chain USDC (ERC-20) transfer from store treasury to listing.payTo.
 * Not a stub — requires funded operator key + RPC.
 */
export class UsdcTransferPayout implements SellerPayoutExecutor {
  private readonly account;
  private readonly rpcUrl: string;
  private readonly asset: `0x${string}`;
  private readonly chainOverride: Chain | undefined;

  constructor(options: UsdcTransferPayoutOptions) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(options.privateKey)) {
      throw new Error("STORE_OPERATOR_PRIVATE_KEY must be 0x + 64 hex chars");
    }
    if (!options.rpcUrl.trim()) {
      throw new Error("STORE_RPC_URL is required for USDC payouts");
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(options.asset)) {
      throw new Error("PAYMCP_ASSET must be an EVM contract address");
    }
    this.account = privateKeyToAccount(options.privateKey);
    this.rpcUrl = options.rpcUrl.trim();
    this.asset = options.asset;
    this.chainOverride = options.chain;
  }

  async execute(payout: SellerPayout): Promise<PayoutExecutionResult> {
    if (payout.status === "paid" && payout.transaction) {
      return {
        transaction: payout.transaction,
        network: payout.network,
        payer: this.account.address,
      };
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(payout.payTo)) {
      throw new StoreError("VALIDATION", `invalid payTo: ${payout.payTo}`, 400);
    }
    const amount = BigInt(payout.amount);
    if (amount <= 0n) {
      throw new StoreError("VALIDATION", "payout amount must be > 0", 400);
    }
    const chain = this.chainOverride ?? chainFromNetwork(payout.network);
    const client = createWalletClient({
      account: this.account,
      chain,
      transport: http(this.rpcUrl),
    });
    const asset = (
      /^0x[a-fA-F0-9]{40}$/.test(payout.asset) ? payout.asset : this.asset
    ) as Hex;
    try {
      const hash = await client.writeContract({
        address: asset,
        abi: erc20TransferAbi,
        functionName: "transfer",
        args: [payout.payTo as Hex, amount],
        chain,
        account: this.account,
      });
      return {
        transaction: hash,
        network: payout.network,
        payer: this.account.address,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new StoreError(
        "INTERNAL",
        `USDC transfer payout failed: ${message}`,
        502,
        { payoutId: payout.id },
      );
    }
  }
}

function chainFromNetwork(network: string): Chain {
  if (network === "eip155:8453") {
    return base;
  }
  if (network === "eip155:84532") {
    return baseSepolia;
  }
  // Fallback: Base Sepolia for unknown test nets — callers should set chain.
  return baseSepolia;
}
