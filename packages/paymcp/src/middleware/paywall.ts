import fp from "fastify-plugin";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
  onSendHookHandler,
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
import type {
  PaymentAccept,
  PaymentPayload,
  PaymentRequired,
  SettlementResponse,
} from "../types/x402.js";
import { SimpleRateLimiter } from "../http/rate-limit.js";
import { createLogger } from "../http/logger.js";
import { summarizePaymentSignatureHeader } from "../http/sanitize.js";
import type { AccessControls } from "../controls/types.js";
import {
  checkAllowlist,
  checkBudget,
  resolveAccessControls,
} from "../controls/resolve.js";
import { loadBudgetsFile } from "../controls/parse.js";
import {
  createSettlementWebhookSender,
  type SettlementWebhookSender,
} from "../webhook/settlement.js";

export interface PaywallOptions {
  readonly config: PaymcpEnvConfig;
  readonly prices: PriceTable;
  /** Map route → operationId. If omitted, uses request.routeOptions.config.paymcpOperationId. */
  readonly operationIdForRequest?: (req: FastifyRequest) => string | undefined;
  readonly settler?: FacilitatorSettler;
  readonly ledger?: Ledger;
  readonly publicBaseUrl?: string;
  /** Pre-built access controls; else resolved from config (+ optional prices/budgets files). */
  readonly accessControls?: AccessControls;
  /** Optional tenant id resolver (e.g. from x-paymcp-tenant header). */
  readonly tenantIdForRequest?: (req: FastifyRequest) => string | undefined;
  /** Optional settlement webhook notifier (defaults from config webhook URL). */
  readonly webhook?: SettlementWebhookSender;
}

/** Pending payment attached in preHandler; settle runs only after a 2xx reply. */
interface PendingPayment {
  readonly paymentPayload: PaymentPayload;
  readonly accept: PaymentAccept;
  readonly clientIdem: string;
  readonly operationId: string;
  readonly amount: string;
  readonly required: PaymentRequired;
  /** When ledger already has a settled row for this idempotency key. */
  readonly priorSettlement?: SettlementResponse;
}

declare module "fastify" {
  interface FastifyContextConfig {
    paymcpOperationId?: string;
  }

  interface FastifyRequest {
    paymcpPendingPayment?: PendingPayment;
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
  const webhook =
    options.webhook ?? createSettlementWebhookSender(options.config);

  const controls: AccessControls =
    options.accessControls ??
    resolveAccessControls({
      config: options.config,
      ...(options.config.budgetsPath !== undefined
        ? { budgetsFile: loadBudgetsFile(options.config.budgetsPath) }
        : {}),
    });

  const rateMax = options.config.rateLimitMax ?? 0;
  const rateLimiter =
    rateMax > 0
      ? new SimpleRateLimiter(
          rateMax,
          options.config.rateLimitWindowMs ?? 60_000,
        )
      : undefined;

  app.decorateRequest("paymcpPendingPayment", undefined);

  const hook: preHandlerHookHandler = async (request, reply) => {
    const operationId = resolveOperationId(request, options);
    if (operationId === undefined) {
      return;
    }

    const allow = checkAllowlist(controls, operationId);
    if (!allow.allowed) {
      await reply.code(403).send({
        error: "operation_not_allowlisted",
        detail: `Operation "${operationId}" is not on the PAYMCP allowlist`,
      });
      return;
    }

    const paidCheck = isOperationPaid(options.prices, operationId);
    if (!paidCheck.paid) {
      return;
    }

    const tenantId =
      options.tenantIdForRequest?.(request) ??
      headerValue(request, "x-paymcp-tenant");

    const budget = await checkBudget({
      controls,
      ledger,
      operationId,
      requestedAtomic: paidCheck.price.amount,
      ...(tenantId !== undefined ? { tenantId } : {}),
    });
    if (!budget.ok) {
      await reply.code(429).send({
        error: "budget_exceeded",
        detail: `Daily budget exceeded for "${operationId}": spent ${budget.spent.toString()} + requested ${budget.requested.toString()} > max ${budget.max.toString()} atomic units`,
        spent: budget.spent.toString(),
        max: budget.max.toString(),
        requested: budget.requested.toString(),
      });
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

    // Atomic claim: settled → replay; pending → fail closed; else this caller owns settle.
    const claim = await ledger.beginPending({
      idempotencyKey: clientIdem,
      operationId,
      amount: price.amount,
      network: accept.network,
      ...(tenantId !== undefined ? { tenantId } : {}),
    });

    if (claim.kind === "already_settled") {
      const priorSettlement: SettlementResponse = {
        success: true,
        transaction: claim.entry.transaction,
        network: claim.entry.network,
        payer: claim.entry.payer,
      };
      reply.header(
        HEADER_PAYMENT_RESPONSE,
        encodeHeaderPayload(priorSettlement),
      );
      request.paymcpPendingPayment = {
        paymentPayload,
        accept,
        clientIdem,
        operationId,
        amount: price.amount,
        required,
        priorSettlement,
      };
      return;
    }

    if (claim.kind === "in_flight") {
      // Prefer fail closed over waiting: do not start a second settle.
      await reply.code(409).send({
        error: "idempotency_in_flight",
        detail:
          "A request with this Idempotency-Key is already settling; retry after it completes (settled keys replay without re-charging).",
      });
      return;
    }

    // Early verify (signature validity) — settle only after a 2xx handler reply.
    let verification;
    try {
      verification = await settler.verify({
        paymentPayload,
        paymentRequirements: accept,
      });
    } catch (err) {
      await ledger.recordSettlement({
        idempotencyKey: clientIdem,
        operationId,
        amount: price.amount,
        network: accept.network,
        payer: "",
        transaction: "",
        status: "failed",
        errorReason: "facilitator_unavailable",
      });
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

    if (!verification.isValid) {
      const reason = verification.invalidReason ?? "payment_invalid";
      await ledger.recordSettlement({
        idempotencyKey: clientIdem,
        operationId,
        amount: price.amount,
        network: accept.network,
        payer: verification.payer ?? "",
        transaction: "",
        status: "failed",
        errorReason: reason,
      });
      await reply
        .code(402)
        .header(
          HEADER_PAYMENT_REQUIRED,
          encodeHeaderPayload({
            ...required,
            error: reason,
          }),
        )
        .send({
          error: "payment_failed",
          reason,
        });
      return;
    }

    request.paymcpPendingPayment = {
      paymentPayload,
      accept,
      clientIdem,
      operationId,
      amount: price.amount,
      required,
    };
  };

  const settleOnSuccess: onSendHookHandler = async (request, reply, payload) => {
    const pending = request.paymcpPendingPayment;
    if (pending === undefined) {
      return payload;
    }

    // Already settled for this idempotency key — never re-settle.
    if (pending.priorSettlement !== undefined) {
      if (!reply.hasHeader(HEADER_PAYMENT_RESPONSE)) {
        reply.header(
          HEADER_PAYMENT_RESPONSE,
          encodeHeaderPayload(pending.priorSettlement),
        );
      }
      return payload;
    }

    const statusCode = reply.statusCode;
    const is2xx = statusCode >= 200 && statusCode < 300;

    if (!is2xx) {
      await ledger.recordSettlement({
        idempotencyKey: pending.clientIdem,
        operationId: pending.operationId,
        amount: pending.amount,
        network: pending.accept.network,
        payer: "",
        transaction: "",
        status: "failed",
        errorReason: `upstream_http_${statusCode}`,
      });
      return payload;
    }

    let settlement: SettlementResponse;
    try {
      settlement = await settler.settle({
        paymentPayload: pending.paymentPayload,
        paymentRequirements: pending.accept,
      });
    } catch (err) {
      // Release pending claim so the same Idempotency-Key can be retried.
      await ledger.recordSettlement({
        idempotencyKey: pending.clientIdem,
        operationId: pending.operationId,
        amount: pending.amount,
        network: pending.accept.network,
        payer: "",
        transaction: "",
        status: "failed",
        errorReason: "facilitator_unavailable",
      });
      if (
        err instanceof FacilitatorHttpError ||
        err instanceof FacilitatorTransportError
      ) {
        log.warn("facilitator_unavailable", {
          operationId: pending.operationId,
          detail: err.message,
          status: err instanceof FacilitatorHttpError ? err.status : undefined,
        });
        reply.code(502);
        reply.removeHeader(HEADER_PAYMENT_RESPONSE);
        return JSON.stringify({
          error: "facilitator_unavailable",
          detail: err.message,
        });
      }
      throw err;
    }

    reply.header(HEADER_PAYMENT_RESPONSE, encodeHeaderPayload(settlement));

    if (!settlement.success) {
      await ledger.recordSettlement({
        idempotencyKey: pending.clientIdem,
        operationId: pending.operationId,
        amount: pending.amount,
        network: settlement.network,
        payer: settlement.payer,
        transaction: settlement.transaction,
        status: "failed",
        ...(settlement.errorReason !== undefined
          ? { errorReason: settlement.errorReason }
          : {}),
      });
      reply.code(402);
      reply.header(
        HEADER_PAYMENT_REQUIRED,
        encodeHeaderPayload({
          ...pending.required,
          error: settlement.errorReason ?? "payment_failed",
        }),
      );
      return JSON.stringify({
        error: "payment_failed",
        reason: settlement.errorReason ?? "settlement_failed",
      });
    }

    await ledger.recordSettlement({
      idempotencyKey: pending.clientIdem,
      operationId: pending.operationId,
      amount: pending.amount,
      network: settlement.network,
      payer: settlement.payer,
      transaction: settlement.transaction,
      status: "settled",
    });

    if (webhook !== undefined) {
      const requestId = (
        request as FastifyRequest & { requestId?: string }
      ).requestId;
      await webhook.notify({
        operationId: pending.operationId,
        amount: pending.amount,
        network: settlement.network,
        asset: pending.accept.asset,
        payer: settlement.payer,
        transaction: settlement.transaction,
        idempotencyKey: pending.clientIdem,
        ...(requestId !== undefined && requestId.length > 0
          ? { requestId }
          : {}),
      });
    }

    return payload;
  };

  app.addHook("preHandler", hook);
  app.addHook("onSend", settleOnSuccess);

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
