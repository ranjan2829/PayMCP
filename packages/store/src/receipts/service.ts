import type { ListingRegistry } from "../listings/registry.js";
import type { BuyerBalanceLedger } from "../ledger/balance.js";
import type { SellerPayoutQueue } from "../payout/queue.js";
import { StoreError } from "../errors/index.js";
import { explorerTxUrl, networkLabel } from "./explorer.js";
import { redactBuyerId } from "./redact.js";
import {
  PublicReceiptSchema,
  type PublicReceipt,
  type PublicReceiptListQuery,
  PublicReceiptListQuerySchema,
} from "./types.js";

export interface ReceiptServiceOptions {
  readonly listings: ListingRegistry;
  readonly ledger: BuyerBalanceLedger;
  readonly payouts: SellerPayoutQueue;
  readonly publicBaseUrl?: string;
  /** Asset display label (default USDC). */
  readonly assetLabel?: string;
}

/**
 * Build public settlement receipts from spend log + listing + seller payout.
 * Buyer ids are redacted; unpaid / unsettled spends still surface for 402 demos.
 */
export class ReceiptService {
  private readonly listings: ListingRegistry;
  private readonly ledger: BuyerBalanceLedger;
  private readonly payouts: SellerPayoutQueue;
  private readonly publicBaseUrl: string | undefined;
  private readonly assetLabel: string;

  constructor(options: ReceiptServiceOptions) {
    this.listings = options.listings;
    this.ledger = options.ledger;
    this.payouts = options.payouts;
    this.publicBaseUrl = options.publicBaseUrl;
    this.assetLabel = options.assetLabel ?? "USDC";
  }

  /** Resolve by spend id or by payout tx hash (0x…). */
  getByIdOrTx(idOrTx: string): PublicReceipt {
    const bySpend = this.ledger.findSpendById(idOrTx);
    if (bySpend !== undefined) {
      return this.toReceipt(bySpend.id);
    }
    const byTx = this.payouts.findByTxHash(idOrTx);
    if (byTx !== undefined) {
      return this.toReceipt(byTx.spendId);
    }
    throw new StoreError(
      "VALIDATION",
      `receipt not found: ${idOrTx}`,
      404,
      { id: idOrTx },
    );
  }

  listRecent(query: PublicReceiptListQuery = {}): {
    receipts: PublicReceipt[];
    total: number;
    limit: number;
    offset: number;
  } {
    const q = PublicReceiptListQuerySchema.parse(query);
    const settledPage = this.ledger.listSettledSpends({
      limit: q.limit,
      offset: q.offset,
    });
    return {
      receipts: settledPage.entries.map((e) => this.toReceipt(e.id)),
      total: settledPage.total,
      limit: q.limit ?? 20,
      offset: q.offset ?? 0,
    };
  }

  toReceipt(spendId: string): PublicReceipt {
    const spend = this.ledger.findSpendById(spendId);
    if (spend === undefined) {
      throw new StoreError("VALIDATION", `spend not found: ${spendId}`, 404, {
        spendId,
      });
    }
    const listing = this.listings.findById(spend.listingId);
    const payout = this.payouts.findBySpendId(spend.id);
    const network = listing?.network ?? payout?.network ?? "eip155:84532";
    const payoutTx = payout?.transaction ?? null;
    const explorerUrl = explorerTxUrl(network, payoutTx);
    const receiptPath = `/v1/receipts/${spend.id}`;
    const receiptUrl =
      this.publicBaseUrl !== undefined
        ? `${this.publicBaseUrl.replace(/\/$/, "")}${receiptPath}`
        : undefined;

    return PublicReceiptSchema.parse({
      spendId: spend.id,
      amount: spend.amount,
      asset: this.assetLabel,
      network,
      networkLabel: networkLabel(network),
      listing: {
        id: spend.listingId,
        name: listing?.name ?? spend.listingId,
        ...(listing?.description !== undefined && listing.description.length > 0
          ? { description: listing.description }
          : {}),
      },
      buyer: redactBuyerId(spend.buyerId),
      settleStatus: spend.status,
      rail: spend.rail === "visa" ? "visa" : (listing?.rail === "visa" ? "visa" : "x402"),
      payoutStatus: payout?.status ?? "none",
      payoutTx,
      explorerUrl,
      createdAt: spend.createdAt,
      settledAt: spend.status === "settled" ? spend.updatedAt : null,
      ...(receiptUrl !== undefined ? { receiptUrl } : {}),
    });
  }
}
