import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ZodError } from "zod";
import { isStoreError, StoreError } from "../errors/index.js";
import {
  CreateListingInputSchema,
  CatalogQuerySchema,
  UpdateListingInputSchema,
} from "../listings/schemas.js";
import {
  BuyerIdSchema,
  SpendLogQuerySchema,
} from "../ledger/schemas.js";
import type { ListingRegistry } from "../listings/registry.js";
import type { BuyerBalanceLedger } from "../ledger/balance.js";
import type { StripeFundingClient } from "../funding/stripe.js";
import { creditsForUsdCents } from "../funding/stripe.js";
import type { SellerPayoutService } from "../payout/service.js";
import type { ReceiptService } from "../receipts/service.js";
import { renderReceiptHtml } from "../receipts/html.js";
import { PublicReceiptListQuerySchema } from "../receipts/types.js";
import { InvokeGateway } from "./invoke.js";
import { AtomicAmountSchema } from "../listings/schemas.js";

export interface StoreAppDeps {
  readonly listings: ListingRegistry;
  readonly ledger: BuyerBalanceLedger;
  readonly invoke: InvokeGateway;
  readonly stripe?: StripeFundingClient;
  readonly payouts?: SellerPayoutService;
  readonly receipts?: ReceiptService;
  readonly publicBaseUrl?: string;
  readonly stripeSuccessUrl?: string;
  readonly stripeCancelUrl?: string;
}

const InvokeBodySchema = z.object({
  buyerId: BuyerIdSchema,
  path: z.string().min(1).optional(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
  headers: z.record(z.string()).optional(),
  body: z.unknown().optional(),
  query: z.record(z.string()).optional(),
});

const CheckoutBodySchema = z.object({
  buyerId: BuyerIdSchema,
  /** Fiat amount in cents (USD). Credits derived at USDC 6-decimal parity unless creditAmount set. */
  fiatAmountCents: z.number().int().min(50).max(10_000_000),
  creditAmount: AtomicAmountSchema.optional(),
  currency: z.string().min(3).max(8).optional(),
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
  customerEmail: z.string().email().optional(),
});

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof ZodError) {
    return reply.status(400).send({
      error: {
        code: "VALIDATION",
        message: "request validation failed",
        details: err.flatten(),
      },
    });
  }
  if (isStoreError(err)) {
    return reply.status(err.statusCode).send({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  return reply.status(500).send({
    error: { code: "INTERNAL", message },
  });
}

/**
 * Register PayMCP Store HTTP routes on a Fastify instance.
 */
export async function registerStoreRoutes(
  app: FastifyInstance,
  deps: StoreAppDeps,
): Promise<void> {
  app.get("/healthz", async () => ({ ok: true, service: "@paymcp/store" }));

  app.get("/readyz", async (_req, reply) => {
    try {
      deps.listings.list({ limit: 1, offset: 0 });
      return { ok: true };
    } catch (err) {
      return reply.status(503).send({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ── Catalog ──────────────────────────────────────────────────────────────
  app.get("/v1/catalog", async (req, reply) => {
    try {
      const query = CatalogQuerySchema.parse(req.query);
      const effective =
        query.status === undefined ? { ...query, status: "active" as const } : query;
      const result = deps.listings.list(effective);
      return {
        listings: result.listings,
        total: result.total,
        limit: effective.limit,
        offset: effective.offset,
      };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>(
    "/v1/catalog/:id",
    async (req, reply) => {
      try {
        const listing = deps.listings.getOrThrow(req.params.id);
        return { listing };
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // ── Seller listings ──────────────────────────────────────────────────────
  app.post("/v1/listings", async (req, reply) => {
    try {
      const body = CreateListingInputSchema.parse(req.body);
      const listing = deps.listings.create(body);
      return reply.status(201).send({ listing });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.patch<{ Params: { id: string } }>(
    "/v1/listings/:id",
    async (req, reply) => {
      try {
        const body = UpdateListingInputSchema.parse(req.body);
        const listing = deps.listings.update(req.params.id, body);
        return { listing };
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/v1/listings/:id",
    async (req, reply) => {
      try {
        deps.listings.delete(req.params.id);
        return reply.status(204).send();
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );


  // ── Public receipts (settle / payout surface for demos) ─────────────────
  app.get("/v1/receipts", async (req, reply) => {
    try {
      if (deps.receipts === undefined) {
        throw new StoreError(
          "INTERNAL",
          "receipt service is not configured",
          503,
        );
      }
      const query = PublicReceiptListQuerySchema.parse(req.query);
      return deps.receipts.listRecent(query);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>(
    "/v1/receipts/:id",
    async (req, reply) => {
      try {
        if (deps.receipts === undefined) {
          throw new StoreError(
            "INTERNAL",
            "receipt service is not configured",
            503,
          );
        }
        const receipt = deps.receipts.getByIdOrTx(req.params.id);
        const wantsHtml =
          String((req.query as { format?: string }).format ?? "") === "html" ||
          (typeof req.headers.accept === "string" &&
            req.headers.accept.includes("text/html") &&
            !req.headers.accept.includes("application/json"));
        if (wantsHtml) {
          return reply
            .type("text/html; charset=utf-8")
            .send(renderReceiptHtml(receipt));
        }
        return { receipt };
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // ── Buyer funding (Stripe Checkout — no faucet) ──────────────────────────
  app.post("/v1/funding/checkout", async (req, reply) => {
    try {
      if (deps.stripe === undefined) {
        throw new StoreError(
          "FUNDING_DISABLED",
          "Stripe funding is not configured (set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET)",
          503,
        );
      }
      const body = CheckoutBodySchema.parse(req.body);
      const creditAmount =
        body.creditAmount ?? creditsForUsdCents(body.fiatAmountCents);
      const successUrl =
        body.successUrl ??
        deps.stripeSuccessUrl ??
        (deps.publicBaseUrl !== undefined
          ? `${deps.publicBaseUrl}/v1/funding/success`
          : undefined);
      const cancelUrl =
        body.cancelUrl ??
        deps.stripeCancelUrl ??
        (deps.publicBaseUrl !== undefined
          ? `${deps.publicBaseUrl}/v1/funding/cancel`
          : undefined);
      if (successUrl === undefined || cancelUrl === undefined) {
        throw new StoreError(
          "VALIDATION",
          "successUrl and cancelUrl are required (or set STRIPE_SUCCESS_URL / STRIPE_CANCEL_URL / STORE_PUBLIC_BASE_URL)",
          400,
        );
      }
      const session = await deps.stripe.createCheckoutSession({
        buyerId: body.buyerId,
        creditAmount,
        fiatAmountCents: body.fiatAmountCents,
        ...(body.currency !== undefined ? { currency: body.currency } : {}),
        successUrl,
        cancelUrl,
        ...(body.customerEmail !== undefined
          ? { customerEmail: body.customerEmail }
          : {}),
      });
      return reply.status(201).send({
        sessionId: session.id,
        url: session.url,
        buyerId: body.buyerId,
        creditAmount,
        fiatAmountCents: body.fiatAmountCents,
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/v1/webhooks/stripe", async (req, reply) => {
    try {
      if (deps.stripe === undefined) {
        throw new StoreError(
          "FUNDING_DISABLED",
          "Stripe funding is not configured",
          503,
        );
      }
      const raw =
        (req as FastifyRequest & { rawBody?: string }).rawBody ??
        JSON.stringify(req.body ?? {});
      const sig = headerString(req, "stripe-signature");
      const credited = deps.stripe.parseVerifiedWebhook(raw, sig);
      if (credited === null) {
        return { received: true, credited: false };
      }
      const balance = deps.ledger.creditFromFunding({
        buyerId: credited.buyerId,
        amount: credited.creditAmount,
        fundingId: credited.fundingId,
        source: "stripe",
        note: "stripe checkout.session.completed",
      });
      return { received: true, credited: true, balance };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Explicit rejection of legacy faucet route
  app.post("/v1/top-up", async (_req, reply) => {
    return reply.status(410).send({
      error: {
        code: "FUNDING_DISABLED",
        message:
          "Faucet top-up removed. Use POST /v1/funding/checkout + Stripe webhook, or a verified USDC deposit.",
      },
    });
  });

  app.get<{ Params: { buyerId: string } }>(
    "/v1/balances/:buyerId",
    async (req, reply) => {
      try {
        const buyerId = BuyerIdSchema.parse(req.params.buyerId);
        const balance = deps.ledger.getBalance(buyerId);
        return { balance };
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.get("/v1/spend-log", async (req, reply) => {
    try {
      const query = SpendLogQuerySchema.parse(req.query);
      const result = deps.ledger.listSpendLog(query);
      return {
        entries: result.entries,
        total: result.total,
        limit: query.limit ?? 50,
        offset: query.offset ?? 0,
      };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/v1/payouts/flush", async (_req, reply) => {
    try {
      if (deps.payouts === undefined) {
        throw new StoreError(
          "PAYOUT_FAILED",
          "Seller payout executor is not configured",
          503,
        );
      }
      const result = await deps.payouts.flushPending();
      return {
        paid: result.paid.length,
        failed: result.failed.length,
        payouts: { paid: result.paid, failed: result.failed },
      };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ── Invoke (balance debit after 2xx + seller payout) ─────────────────────
  app.post<{ Params: { id: string } }>(
    "/v1/listings/:id/invoke",
    async (req, reply) => {
      try {
        const idem =
          headerString(req, "idempotency-key") ??
          headerString(req, "x-idempotency-key");
        if (idem === undefined || idem.length === 0) {
          throw new StoreError(
            "VALIDATION",
            "Idempotency-Key header is required",
            400,
          );
        }
        const body = InvokeBodySchema.parse(req.body);
        const requestId =
          headerString(req, "x-request-id") ?? undefined;

        const result = await deps.invoke.invoke({
          listingId: req.params.id,
          buyerId: body.buyerId,
          idempotencyKey: idem,
          ...(requestId !== undefined ? { requestId } : {}),
          ...(body.path !== undefined ? { path: body.path } : {}),
          ...(body.method !== undefined ? { method: body.method } : {}),
          ...(body.headers !== undefined ? { headers: body.headers } : {}),
          ...(body.body !== undefined ? { body: body.body } : {}),
          ...(body.query !== undefined ? { query: body.query } : {}),
        });

        const receiptUrl =
          deps.publicBaseUrl !== undefined
            ? `${deps.publicBaseUrl.replace(/\/$/, "")}/v1/receipts/${result.spend.id}`
            : deps.receipts !== undefined
              ? `/v1/receipts/${result.spend.id}`
              : undefined;
        return reply.status(200).send({
          ok: true,
          replayed: result.replayed,
          spend: result.spend,
          upstreamStatus: result.upstreamStatus,
          balanceAfter: result.balanceAfter,
          payout: result.payout,
          ...(receiptUrl !== undefined ? { receiptUrl } : {}),
          body: result.body,
        });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}

function headerString(
  req: FastifyRequest,
  name: string,
): string | undefined {
  const raw = req.headers[name];
  if (typeof raw === "string") {
    return raw;
  }
  if (Array.isArray(raw) && typeof raw[0] === "string") {
    return raw[0];
  }
  return undefined;
}
