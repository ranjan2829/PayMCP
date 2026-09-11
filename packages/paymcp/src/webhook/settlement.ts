import { createHmac } from "node:crypto";
import { createLogger, type Logger } from "../http/logger.js";
import type { PaymcpEnvConfig } from "../types/config.js";

/** HTTP header carrying HMAC-SHA256 of the raw JSON body. */
export const WEBHOOK_SIGNATURE_HEADER = "x-paymcp-signature";

/** Event type posted after a successful settle. */
export const SETTLEMENT_WEBHOOK_EVENT = "settlement.succeeded" as const;

export const SETTLEMENT_WEBHOOK_VERSION = 1 as const;

/**
 * Billing webhook payload. Never includes PAYMENT-SIGNATURE / PaymentPayload.
 */
export interface SettlementWebhookPayload {
  readonly event: typeof SETTLEMENT_WEBHOOK_EVENT;
  readonly version: typeof SETTLEMENT_WEBHOOK_VERSION;
  readonly operationId: string;
  /** Atomic units as decimal string. */
  readonly amount: string;
  readonly network: string;
  readonly asset: string;
  readonly payer: string;
  /** On-chain / facilitator transaction hash (or ref). */
  readonly transaction: string;
  readonly idempotencyKey: string;
  /** ISO-8601 when the settlement completed (server clock). */
  readonly settledAt: string;
  /** Echo of `x-request-id` when available. */
  readonly requestId?: string;
}

export interface SettlementWebhookSenderOptions {
  readonly url: string;
  readonly secret: string;
  /** Request timeout in ms (default 5_000). */
  readonly timeoutMs?: number;
  /** Max retries on 5xx / network only (default 2). */
  readonly maxRetries?: number;
  readonly fetchImpl?: typeof fetch;
  readonly logger?: Logger;
}

export interface NotifySettlementInput {
  readonly operationId: string;
  readonly amount: string;
  readonly network: string;
  readonly asset: string;
  readonly payer: string;
  readonly transaction: string;
  readonly idempotencyKey: string;
  readonly settledAt?: string;
  readonly requestId?: string;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RETRIES = 2;

/**
 * POSTs an HMAC-signed settlement.succeeded event to a billing URL.
 * Delivery failures are logged and never thrown to the settle path —
 * settlement already succeeded on-chain / at the facilitator.
 */
export class SettlementWebhookSender {
  private readonly url: string;
  private readonly secret: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly log: Logger;

  constructor(options: SettlementWebhookSenderOptions) {
    const trimmed = options.url.replace(/\/$/, "");
    if (trimmed.length === 0) {
      throw new Error("webhook url is required");
    }
    try {
      new URL(trimmed);
    } catch {
      throw new Error(`Invalid webhook url: ${options.url}`);
    }
    if (options.secret.trim().length < 16) {
      throw new Error("webhook secret must be at least 16 characters");
    }
    this.url = trimmed;
    this.secret = options.secret;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.log =
      options.logger ?? createLogger({ component: "settlement-webhook" });
  }

  /** Build the canonical payload (no payment secrets). */
  buildPayload(input: NotifySettlementInput): SettlementWebhookPayload {
    const payload: SettlementWebhookPayload = {
      event: SETTLEMENT_WEBHOOK_EVENT,
      version: SETTLEMENT_WEBHOOK_VERSION,
      operationId: input.operationId,
      amount: input.amount,
      network: input.network,
      asset: input.asset,
      payer: input.payer,
      transaction: input.transaction,
      idempotencyKey: input.idempotencyKey,
      settledAt: input.settledAt ?? new Date().toISOString(),
    };
    if (input.requestId !== undefined && input.requestId.length > 0) {
      return { ...payload, requestId: input.requestId };
    }
    return payload;
  }

  /** HMAC-SHA256 hex of the raw body, prefixed as `sha256=<hex>`. */
  signBody(rawBody: string): string {
    const hex = createHmac("sha256", this.secret)
      .update(rawBody, "utf8")
      .digest("hex");
    return `sha256=${hex}`;
  }

  /**
   * Deliver a settlement webhook. Retries 5xx/network with backoff.
   * Never throws — settle path must stay successful for the client.
   */
  async notify(input: NotifySettlementInput): Promise<void> {
    const payload = this.buildPayload(input);
    const rawBody = JSON.stringify(payload);
    const signature = this.signBody(rawBody);
    const deliveryId = payload.idempotencyKey;

    let attempt = 0;
    for (;;) {
      try {
        await this.postOnce(rawBody, signature);
        this.log.info("webhook_delivered", {
          operationId: payload.operationId,
          idempotencyKey: deliveryId,
          attempt: attempt + 1,
          transaction: payload.transaction,
          requestId: payload.requestId,
        });
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const retryable = isRetryableWebhookError(err);
        if (!retryable || attempt >= this.maxRetries) {
          this.log.warn("webhook_delivery_failed", {
            operationId: payload.operationId,
            idempotencyKey: deliveryId,
            attempt: attempt + 1,
            detail: message,
            requestId: payload.requestId,
          });
          return;
        }
        this.log.info("webhook_delivery_retry", {
          operationId: payload.operationId,
          idempotencyKey: deliveryId,
          attempt: attempt + 1,
          detail: message,
        });
        const delayMs = Math.min(500 * 2 ** attempt, 4_000);
        await sleep(delayMs);
        attempt += 1;
      }
    }
  }

  private async postOnce(rawBody: string, signature: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          [WEBHOOK_SIGNATURE_HEADER]: signature,
        },
        body: rawBody,
        signal: controller.signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (
        err instanceof Error &&
        (err.name === "AbortError" || message.includes("abort"))
      ) {
        throw new WebhookTimeoutError(
          `webhook timed out after ${this.timeoutMs}ms`,
        );
      }
      throw new WebhookTransportError(`webhook request failed: ${message}`);
    } finally {
      clearTimeout(timer);
    }

    if (response.ok) {
      return;
    }
    const detail = `HTTP ${response.status}`;
    throw new WebhookHttpError(response.status, detail);
  }
}

export class WebhookTransportError extends Error {
  readonly retryable = true;
  constructor(message: string) {
    super(message);
    this.name = "WebhookTransportError";
  }
}

export class WebhookTimeoutError extends WebhookTransportError {
  constructor(message: string) {
    super(message);
    this.name = "WebhookTimeoutError";
  }
}

export class WebhookHttpError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(status: number, detail: string) {
    super(`webhook ${detail}`);
    this.name = "WebhookHttpError";
    this.status = status;
    this.retryable = status >= 500 && status < 600;
  }
}

export function isRetryableWebhookError(err: unknown): boolean {
  if (err instanceof WebhookTransportError) {
    return true;
  }
  if (err instanceof WebhookHttpError) {
    return err.retryable;
  }
  return false;
}

/**
 * Build a sender from env config, or `undefined` when webhook URL is unset
 * (webhooks disabled).
 */
export function createSettlementWebhookSender(
  config: PaymcpEnvConfig,
  opts: { fetchImpl?: typeof fetch; logger?: Logger } = {},
): SettlementWebhookSender | undefined {
  if (config.webhookUrl === undefined) {
    return undefined;
  }
  if (config.webhookSecret === undefined) {
    throw new Error(
      "PAYMCP_WEBHOOK_SECRET is required when PAYMCP_WEBHOOK_URL is set",
    );
  }
  return new SettlementWebhookSender({
    url: config.webhookUrl,
    secret: config.webhookSecret,
    ...(config.webhookTimeoutMs !== undefined
      ? { timeoutMs: config.webhookTimeoutMs }
      : {}),
    ...(config.webhookMaxRetries !== undefined
      ? { maxRetries: config.webhookMaxRetries }
      : {}),
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
