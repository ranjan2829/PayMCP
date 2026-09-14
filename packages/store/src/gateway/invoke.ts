import { randomUUID } from "node:crypto";
import {
  SettlementWebhookSender,
  type SettlementWebhookSender as WebhookSender,
} from "openapi-to-paymcp";
import { StoreError } from "../errors/index.js";
import type { ListingRegistry } from "../listings/registry.js";
import type { Listing } from "../listings/schemas.js";
import type { BuyerBalanceLedger } from "../ledger/balance.js";
import type { SpendLogEntry } from "../ledger/schemas.js";
import type { SellerPayoutService } from "../payout/service.js";
import type { SellerPayout } from "../payout/queue.js";

export interface InvokeRequest {
  readonly listingId: string;
  readonly buyerId: string;
  readonly idempotencyKey: string;
  readonly requestId?: string;
  /** Override path (defaults to listing.defaultPath). */
  readonly path?: string;
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly query?: Readonly<Record<string, string>>;
}

export interface InvokeSuccess {
  readonly ok: true;
  readonly replayed: boolean;
  readonly spend: SpendLogEntry;
  readonly upstreamStatus: number;
  readonly upstreamHeaders: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly balanceAfter: string;
  readonly payout: SellerPayout | null;
}

export interface InvokeGatewayOptions {
  readonly listings: ListingRegistry;
  readonly ledger: BuyerBalanceLedger;
  readonly payouts?: SellerPayoutService;
  readonly webhook?: WebhookSender;
  readonly fetchImpl?: typeof fetch;
  /** Asset label for webhook payload (default USDC credits). */
  readonly asset?: string;
}

/**
 * Invoke a listing via store balance:
 * 1. beginSpend (hold + idempotency)
 * 2. proxy upstream
 * 3. on 2xx → completeSpend(settled) + seller payout to listing.payTo + optional webhook
 * 4. on non-2xx → completeSpend(failed) refund hold
 *
 * Mirrors paymcp settle-on-200 semantics for the credit-balance path.
 * Seller payout is required for a complete settle (not credit-only).
 */
export class InvokeGateway {
  private readonly listings: ListingRegistry;
  private readonly ledger: BuyerBalanceLedger;
  private readonly payouts: SellerPayoutService | undefined;
  private readonly webhook: WebhookSender | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly asset: string;

  constructor(options: InvokeGatewayOptions) {
    this.listings = options.listings;
    this.ledger = options.ledger;
    this.payouts = options.payouts;
    this.webhook = options.webhook;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.asset = options.asset ?? "USDC";
  }

  async invoke(req: InvokeRequest): Promise<InvokeSuccess> {
    const listing = this.listings.getOrThrow(req.listingId);
    if (listing.status !== "active") {
      throw new StoreError(
        "LISTING_INACTIVE",
        `listing is not active: ${listing.status}`,
        409,
        { listingId: listing.id, status: listing.status },
      );
    }

    const begin = this.ledger.beginSpend({
      buyerId: req.buyerId,
      listingId: listing.id,
      amount: listing.price,
      idempotencyKey: req.idempotencyKey,
      ...(req.requestId !== undefined ? { requestId: req.requestId } : {}),
    });

    if (begin.kind === "already_settled") {
      const balance = this.ledger.getBalance(req.buyerId);
      const existingPayout =
        this.payouts?.queueRef.findBySpendId(begin.entry.id) ?? null;
      return {
        ok: true,
        replayed: true,
        spend: begin.entry,
        upstreamStatus: begin.entry.upstreamStatus ?? 200,
        upstreamHeaders: {},
        body: {
          replayed: true,
          message: "idempotency key already settled; upstream not re-called",
        },
        balanceAfter: balance.balance,
        payout: existingPayout,
      };
    }

    if (begin.kind === "in_flight") {
      throw new StoreError(
        "IDEMPOTENCY_IN_FLIGHT",
        "idempotency key is already in flight",
        409,
        { idempotencyKey: req.idempotencyKey },
      );
    }

    const upstreamUrl = buildUpstreamUrl(listing, req);
    const method = req.method ?? listing.defaultMethod;
    let upstreamStatus = 0;
    let upstreamBody: unknown = null;
    const upstreamHeaders: Record<string, string> = {};

    try {
      const init: RequestInit = {
        method,
        headers: {
          accept: "application/json",
          ...(req.headers ?? {}),
        },
      };
      if (method !== "GET" && method !== "DELETE" && req.body !== undefined) {
        (init.headers as Record<string, string>)["content-type"] =
          "application/json";
        init.body = JSON.stringify(req.body);
      }

      const response = await this.fetchImpl(upstreamUrl, init);
      upstreamStatus = response.status;
      response.headers.forEach((value, key) => {
        upstreamHeaders[key] = value;
      });
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        upstreamBody = await response.json();
      } else {
        const text = await response.text();
        upstreamBody = text.length > 0 ? text : null;
      }

      if (upstreamStatus < 200 || upstreamStatus >= 300) {
        this.ledger.completeSpend({
          idempotencyKey: req.idempotencyKey,
          status: "failed",
          upstreamStatus,
          errorReason: `upstream returned ${upstreamStatus}`,
        });
        throw new StoreError(
          "UPSTREAM_FAILED",
          `upstream returned ${upstreamStatus}`,
          502,
          {
            listingId: listing.id,
            upstreamStatus,
            body: upstreamBody,
          },
        );
      }

      const spend = this.ledger.completeSpend({
        idempotencyKey: req.idempotencyKey,
        status: "settled",
        upstreamStatus,
      });

      let payout: SellerPayout | null = null;
      if (this.payouts !== undefined) {
        payout = await this.payouts.settleForSpend({ listing, spend });
      }

      void this.maybeNotifyWebhook(listing, spend, req);

      const balance = this.ledger.getBalance(req.buyerId);
      return {
        ok: true,
        replayed: false,
        spend,
        upstreamStatus,
        upstreamHeaders,
        body: upstreamBody,
        balanceAfter: balance.balance,
        payout,
      };
    } catch (err) {
      if (err instanceof StoreError) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.ledger.completeSpend({
        idempotencyKey: req.idempotencyKey,
        status: "failed",
        ...(upstreamStatus > 0 ? { upstreamStatus } : {}),
        errorReason: message,
      });
      throw new StoreError("UPSTREAM_FAILED", `upstream error: ${message}`, 502, {
        listingId: listing.id,
        detail: message,
      });
    }
  }

  private async maybeNotifyWebhook(
    listing: Listing,
    spend: SpendLogEntry,
    req: InvokeRequest,
  ): Promise<void> {
    if (this.webhook === undefined) {
      return;
    }
    try {
      await this.webhook.notify({
        operationId: `store:${listing.id}`,
        amount: spend.amount,
        network: listing.network,
        asset: this.asset,
        payer: req.buyerId,
        transaction: `balance:${spend.id}`,
        idempotencyKey: spend.idempotencyKey,
        settledAt: spend.updatedAt,
        ...(req.requestId !== undefined ? { requestId: req.requestId } : {}),
      });
    } catch {
      // SettlementWebhookSender.notify never throws; guard anyway.
    }
  }
}

export function buildUpstreamUrl(
  listing: Listing,
  req: Pick<InvokeRequest, "path" | "query">,
): string {
  const base = listing.upstreamBaseUrl;
  if (base === null || base.length === 0) {
    throw new StoreError(
      "LISTING_INVALID",
      `listing ${listing.id} has no upstreamBaseUrl`,
      400,
      { listingId: listing.id },
    );
  }
  const path = req.path ?? listing.defaultPath;
  const url = new URL(path.startsWith("http") ? path : joinUrl(base, path));
  if (req.query !== undefined) {
    for (const [k, v] of Object.entries(req.query)) {
      url.searchParams.set(k, v);
    }
  }
  return url.toString();
}

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
}

export function newIdempotencyKey(): string {
  return randomUUID();
}

export type { SettlementWebhookSender };
