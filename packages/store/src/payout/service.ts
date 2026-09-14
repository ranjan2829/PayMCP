import type { Listing } from "../listings/schemas.js";
import type { SpendLogEntry } from "../ledger/schemas.js";
import { SellerPayoutQueue, type SellerPayout } from "./queue.js";
import type { SellerPayoutExecutor } from "./executor.js";
import { StoreError } from "../errors/index.js";

export interface PayoutServiceOptions {
  readonly queue: SellerPayoutQueue;
  readonly executor: SellerPayoutExecutor;
  readonly defaultAsset: string;
}

/**
 * On invoke settle (2xx): enqueue seller payout to listing.payTo and execute.
 * Credit-only debit without this step is incomplete.
 */
export class SellerPayoutService {
  private readonly queue: SellerPayoutQueue;
  private readonly executor: SellerPayoutExecutor;
  private readonly defaultAsset: string;

  constructor(options: PayoutServiceOptions) {
    this.queue = options.queue;
    this.executor = options.executor;
    this.defaultAsset = options.defaultAsset;
  }

  async settleForSpend(args: {
    readonly listing: Listing;
    readonly spend: SpendLogEntry;
  }): Promise<SellerPayout> {
    const asset =
      this.defaultAsset.length > 0 ? this.defaultAsset : args.listing.network;
    const payout = this.queue.enqueue({
      spendId: args.spend.id,
      listingId: args.listing.id,
      sellerId: args.listing.sellerId,
      payTo: args.listing.payTo,
      network: args.listing.network,
      asset,
      amount: args.spend.amount,
    });
    if (payout.status === "paid") {
      return payout;
    }
    try {
      const result = await this.executor.execute(payout);
      return this.queue.markPaid(payout.id, result.transaction);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.queue.markFailed(payout.id, message);
      throw err instanceof StoreError
        ? err
        : new StoreError("INTERNAL", `seller payout failed: ${message}`, 502, {
            payoutId: payout.id,
            spendId: args.spend.id,
          });
    }
  }

  async flushPending(limit = 50): Promise<{
    paid: SellerPayout[];
    failed: SellerPayout[];
  }> {
    const pending = this.queue.listPending(limit);
    const paid: SellerPayout[] = [];
    const failed: SellerPayout[] = [];
    for (const row of pending) {
      const target =
        row.status === "failed" ? this.queue.requeue(row.id) : row;
      try {
        const result = await this.executor.execute(target);
        paid.push(this.queue.markPaid(target.id, result.transaction));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failed.push(this.queue.markFailed(target.id, message));
      }
    }
    return { paid, failed };
  }

  get queueRef(): SellerPayoutQueue {
    return this.queue;
  }
}
