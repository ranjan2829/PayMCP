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
  TopUpInputSchema,
} from "../ledger/schemas.js";
import type { ListingRegistry } from "../listings/registry.js";
import type { BuyerBalanceLedger } from "../ledger/balance.js";
import { InvokeGateway } from "./invoke.js";
import { AtomicAmountSchema } from "../listings/schemas.js";

export interface StoreAppDeps {
  readonly listings: ListingRegistry;
  readonly ledger: BuyerBalanceLedger;
  readonly invoke: InvokeGateway;
}

const InvokeBodySchema = z.object({
  buyerId: BuyerIdSchema,
  path: z.string().min(1).optional(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
  headers: z.record(z.string()).optional(),
  body: z.unknown().optional(),
  query: z.record(z.string()).optional(),
});

const TopUpBodySchema = TopUpInputSchema;

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
      // Default catalog to active listings when status omitted.
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

  // ── Buyer balance ────────────────────────────────────────────────────────
  app.post("/v1/top-up", async (req, reply) => {
    try {
      const body = TopUpBodySchema.parse(req.body);
      const balance = deps.ledger.topUp(body);
      return reply.status(201).send({ balance, note: body.note ?? "dev faucet" });
    } catch (err) {
      return sendError(reply, err);
    }
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

  // ── Invoke (balance debit after 2xx) ─────────────────────────────────────
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

        return reply.status(result.replayed ? 200 : 200).send({
          ok: true,
          replayed: result.replayed,
          spend: result.spend,
          upstreamStatus: result.upstreamStatus,
          balanceAfter: result.balanceAfter,
          body: result.body,
        });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Quiet unused import guard for AtomicAmountSchema in future route tweaks
  void AtomicAmountSchema;
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
