import fp from "fastify-plugin";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from "fastify";
import type { PaymcpEnvConfig } from "../types/config.js";
import type { PriceTable } from "../pricing/resolve.js";
import { isOperationPaid } from "../pricing/resolve.js";
import {
  HEADER_IDEMPOTENCY_KEY,
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  encodeHeaderPayload,
  decodeHeaderPayload,
} from "../headers/codec.js";
import { parsePaymentPayload } from "../headers/validate.js";
import {
  FacilitatorSettler,
  FacilitatorHttpError,
  FacilitatorTransportError,
} from "../settler/facilitator.js";
import { buildPaymentRequired, buildResource } from "../settler/challenge.js";
import { createLedger } from "../ledger/create.js";
import { deriveIdempotencyKey } from "../ledger/sqlite.js";
import type { Ledger } from "../ledger/types.js";
import type { PaymentAccept, PaymentPayload } from "../types/x402.js";
import { SimpleRateLimiter } from "../http/rate-limit.js";
import { createLogger } from "../http/logger.js";
import { summarizePaymentSignatureHeader } from "../http/sanitize.js";

export interface PaywallOptions {
  readonly config: PaymcpEnvConfig;
  readonly prices: PriceTable;
  /** Map route → operationId. If omitted, uses request.routeOptions.config.paymcpOperationId. */
  readonly operationIdForRequest?: (req: FastifyRequest) => string | undefined;
  readonly settler?: FacilitatorSettler;
  readonly ledger?: Ledger;
  readonly publicBaseUrl?: string;
}

declare module "fastify" {
  interface FastifyContextConfig {
    paymcpOperationId?: string;
  }
}

async function paymcpPaywallImpl(
  app: FastifyInstance,
  options: PaywallOptions,
): Promise<void> {
  const log = createLogger({ component: "paywall" });
  const settler =
    options.settler ??
    new FacilitatorSettler({
      baseUrl: options.config.facilitatorUrl,
      ...(options.config.facilitatorAuthToken !== undefined
        ? { authToken: options.config.facilitatorAuthToken }
        : {}),
      ...(options.config.facilitatorTimeoutMs !== undefined
        ? { timeoutMs: options.config.facilitatorTimeoutMs }
        : {}),
      ...(options.config.facilitatorMaxRetries !== undefined
        ? { maxRetries: options.config.facilitatorMaxRetries }
        : {}),
    });
  const ledger = options.ledger ?? (await createLedger(options.config));

  const rateMax = options.config.rateLimitMax ?? 0;
  const rateLimiter =
    rateMax > 0
      ? new SimpleRateLimiter(
          rateMax,
          options.config.rateLimitWindowMs ?? 60_000,
        )
      : undefined;

  const hook: preHandlerHookHandler = async (request, reply) => {
    const operationId = resolveOperationId(request, options);
    if (operationId === undefined) {
      return;
    }
    const paidCheck = isOperationPaid(options.prices, operationId);
    if (!paidCheck.paid) {
      return;
    }

    if (rateLimiter !== undefined) {
      const ip = request.ip || "unknown";
      if (!rateLimiter.allow(`${ip}:${operationId}`)) {
        await reply.code(429).send({ error: "rate_limited" });
        return;
      }
    }

    const price = paidCheck.price;
    const resourceUrl = buildRequestUrl(request, options.publicBaseUrl);
    const resource = buildResource({
      url: resourceUrl,
      description: price.description ?? operationId,
    });
    const required = buildPaymentRequired({
      config: options.config,
      price,
      resource,
    });
    const accept = required.accepts[0];
    if (accept === undefined) {
      await reply.code(500).send({ error: "misconfigured_accepts" });
      return;
    }

    const signatureHeader = headerValue(request, HEADER_PAYMENT_SIGNATURE);
    if (signatureHeader === undefined) {
      await reply
        .code(402)
        .header(HEADER_PAYMENT_REQUIRED, encodeHeaderPayload(required))
        .send({ error: "payment_required" });
      return;
    }

    const sigMeta = summarizePaymentSignatureHeader(signatureHeader);
    log.debug("payment_signature_received", {
      operationId,
      requestId: (request as FastifyRequest & { requestId?: string }).requestId,
      signaturePresent: sigMeta.present,
      signatureLength: sigMeta.length,
    });

    let paymentPayload: PaymentPayload;
    try {
      paymentPayload = decodeHeaderPayload(signatureHeader, parsePaymentPayload);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "invalid_payment_signature";
      await reply
        .code(400)
        .send({ error: "invalid_payment_signature", detail: message });
      return;
    }

    if (!acceptMatches(paymentPayload.accepted, accept)) {
      await reply
        .code(402)
        .header(
          HEADER_PAYMENT_REQUIRED,
          encodeHeaderPayload({
            ...required,
            error: "accepted terms do not match server requirements",
          }),
        )
        .send({ error: "payment_terms_mismatch" });
      return;
    }

    const clientIdem =
      headerValue(request, HEADER_IDEMPOTENCY_KEY) ??
      deriveIdempotencyKey({
        operationId,
        paymentSignatureHeader: signatureHeader,
      });

    const existing = await ledger.findByIdempotencyKey(clientIdem);
    if (existing !== undefined && existing.status === "settled") {
      reply.header(
        HEADER_PAYMENT_RESPONSE,
        encodeHeaderPayload({
          success: true,
          transaction: existing.transaction,
          network: existing.network,
          payer: existing.payer,
        }),
      );
      return;
    }

    let settlement;
    try {
      settlement = await settler.verifyAndSettle({
        paymentPayload,
        paymentRequirements: accept,
      });
    } catch (err) {
      if (
        err instanceof FacilitatorHttpError ||
        err instanceof FacilitatorTransportError
      ) {
        log.warn("facilitator_unavailable", {
          operationId,
          detail: err.message,
          status: err instanceof FacilitatorHttpError ? err.status : undefined,
        });
        await reply.code(502).send({
          error: "facilitator_unavailable",
          detail: err.message,
        });
        return;
      }
      throw err;
    }

    reply.header(HEADER_PAYMENT_RESPONSE, encodeHeaderPayload(settlement));

    if (!settlement.success) {
      await ledger.recordSettlement({
        idempotencyKey: clientIdem,
        operationId,
        amount: price.amount,
        network: settlement.network,
        payer: settlement.payer,
        transaction: settlement.transaction,
        status: "failed",
        ...(settlement.errorReason !== undefined
          ? { errorReason: settlement.errorReason }
          : {}),
      });
      await reply
        .code(402)
        .header(
          HEADER_PAYMENT_REQUIRED,
          encodeHeaderPayload({
            ...required,
            error: settlement.errorReason ?? "payment_failed",
          }),
        )
        .send({
          error: "payment_failed",
          reason: settlement.errorReason ?? "settlement_failed",
        });
      return;
    }

    await ledger.recordSettlement({
      idempotencyKey: clientIdem,
      operationId,
      amount: price.amount,
      network: settlement.network,
      payer: settlement.payer,
      transaction: settlement.transaction,
      status: "settled",
    });
  };

  app.addHook("preHandler", hook);

  app.addHook("onClose", async () => {
    await ledger.close();
  });
}

/** Drop-in Fastify plugin (non-encapsulated) protecting allowlisted paid routes. */
export const paymcpPaywall = fp(paymcpPaywallImpl, {
  name: "paymcp-paywall",
  fastify: "5.x",
});

function resolveOperationId(
  request: FastifyRequest,
  options: PaywallOptions,
): string | undefined {
  if (options.operationIdForRequest !== undefined) {
    return options.operationIdForRequest(request);
  }
  const fromConfig = request.routeOptions.config?.paymcpOperationId;
  if (typeof fromConfig === "string") {
    return fromConfig;
  }
  return undefined;
}

function headerValue(
  request: FastifyRequest,
  name: string,
): string | undefined {
  const raw = request.headers[name.toLowerCase()];
  if (typeof raw === "string" && raw.length > 0) {
    return raw;
  }
  if (Array.isArray(raw) && typeof raw[0] === "string") {
    return raw[0];
  }
  return undefined;
}

function buildRequestUrl(
  request: FastifyRequest,
  publicBaseUrl: string | undefined,
): string {
  if (publicBaseUrl !== undefined) {
    return `${publicBaseUrl.replace(/\/$/, "")}${request.url}`;
  }
  const host = request.headers.host ?? "localhost";
  const proto = request.protocol ?? "http";
  return `${proto}://${host}${request.url}`;
}

function acceptMatches(got: PaymentAccept, expected: PaymentAccept): boolean {
  return (
    got.scheme === expected.scheme &&
    got.network === expected.network &&
    got.amount === expected.amount &&
    got.asset === expected.asset &&
    got.payTo === expected.payTo
  );
}

export type { FastifyReply, preHandlerHookHandler };
