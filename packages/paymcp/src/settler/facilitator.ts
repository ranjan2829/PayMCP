import {
  X402_VERSION,
  type FacilitatorSettleRequest,
  type FacilitatorSettleResponse,
  type FacilitatorVerifyRequest,
  type FacilitatorVerifyResponse,
  type PaymentAccept,
  type PaymentPayload,
  type SettlementResponse,
} from "../types/x402.js";
import { isRecord } from "../headers/codec.js";
import { parseSettlementResponse } from "../headers/validate.js";
import { redactPaymentSignature } from "../http/sanitize.js";

export interface FacilitatorClientOptions {
  readonly baseUrl: string;
  /** Optional Authorization header value (e.g. "Bearer <jwt>"). */
  readonly authToken?: string;
  readonly fetchImpl?: typeof fetch;
  /** Request timeout in ms (default 15_000). */
  readonly timeoutMs?: number;
  /** Max retries on 5xx / network only (default 2). Never retries invalid payments. */
  readonly maxRetries?: number;
}

export interface SettleInput {
  readonly paymentPayload: PaymentPayload;
  readonly paymentRequirements: PaymentAccept;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 2;

/**
 * Real HTTP facilitator settler (x402 verify + settle).
 * Talks to POST {base}/verify and POST {base}/settle.
 * No simulated success path — network errors and invalid payments fail closed.
 *
 * Retries only on transport failures and HTTP 5xx (exponential backoff).
 * 4xx and verify/settle business failures are never retried.
 * Never logs full PAYMENT-SIGNATURE / payload bodies.
 */
export class FacilitatorSettler {
  private readonly baseUrl: string;
  private readonly authToken: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(options: FacilitatorClientOptions) {
    const trimmed = options.baseUrl.replace(/\/$/, "");
    if (trimmed.length === 0) {
      throw new Error("facilitator baseUrl is required");
    }
    try {
      new URL(trimmed);
    } catch {
      throw new Error(`Invalid facilitator baseUrl: ${options.baseUrl}`);
    }
    this.baseUrl = trimmed;
    this.authToken = options.authToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  async verify(input: SettleInput): Promise<FacilitatorVerifyResponse> {
    const body: FacilitatorVerifyRequest = {
      x402Version: X402_VERSION,
      paymentPayload: input.paymentPayload,
      paymentRequirements: input.paymentRequirements,
    };
    const raw = await this.postJson(`${this.baseUrl}/verify`, body);
    return parseVerifyResponse(raw);
  }

  async settle(input: SettleInput): Promise<SettlementResponse> {
    const body: FacilitatorSettleRequest = {
      x402Version: X402_VERSION,
      paymentPayload: input.paymentPayload,
      paymentRequirements: input.paymentRequirements,
    };
    const raw = await this.postJson(`${this.baseUrl}/settle`, body);
    const response: FacilitatorSettleResponse = parseSettlementResponse(raw);
    return response;
  }

  /**
   * Verify then settle. Fails closed if verify rejects or settle reports failure.
   */
  async verifyAndSettle(input: SettleInput): Promise<SettlementResponse> {
    const verification = await this.verify(input);
    if (!verification.isValid) {
      const reason = verification.invalidReason ?? "payment_invalid";
      return {
        success: false,
        transaction: "",
        network: input.paymentRequirements.network,
        payer: verification.payer ?? "",
        errorReason: reason,
      };
    }
    return this.settle(input);
  }

  private async postJson(url: string, body: unknown): Promise<unknown> {
    let attempt = 0;
    // attempts = 1 + maxRetries
    for (;;) {
      try {
        return await this.postJsonOnce(url, body);
      } catch (err) {
        const retryable = isRetryableFacilitatorError(err);
        if (!retryable || attempt >= this.maxRetries) {
          throw err;
        }
        const delayMs = Math.min(1000 * 2 ** attempt, 8000);
        await sleep(delayMs);
        attempt += 1;
      }
    }
  }

  private async postJsonOnce(url: string, body: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };
    if (this.authToken !== undefined) {
      headers["authorization"] = this.authToken.startsWith("Bearer ")
        ? this.authToken
        : `Bearer ${this.authToken}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const safe = redactPaymentSignature(message);
      if (
        err instanceof Error &&
        (err.name === "AbortError" || message.includes("abort"))
      ) {
        throw new FacilitatorTimeoutError(
          `facilitator request timed out after ${this.timeoutMs}ms`,
        );
      }
      throw new FacilitatorTransportError(
        `facilitator request failed: ${safe}`,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let parsed: unknown = {};
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        throw new FacilitatorTransportError(
          `facilitator returned non-JSON (HTTP ${response.status})`,
        );
      }
    }
    if (!response.ok) {
      const detail = summarizeError(parsed, response.status);
      throw new FacilitatorHttpError(response.status, detail);
    }
    return parsed;
  }
}

export class FacilitatorTransportError extends Error {
  readonly retryable = true;
  constructor(message: string) {
    super(message);
    this.name = "FacilitatorTransportError";
  }
}

export class FacilitatorTimeoutError extends FacilitatorTransportError {
  constructor(message: string) {
    super(message);
    this.name = "FacilitatorTimeoutError";
  }
}

export class FacilitatorHttpError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(status: number, detail: string) {
    super(`facilitator HTTP ${status}: ${detail}`);
    this.name = "FacilitatorHttpError";
    this.status = status;
    this.retryable = status >= 500 && status < 600;
  }
}

export function isRetryableFacilitatorError(err: unknown): boolean {
  if (err instanceof FacilitatorTransportError) {
    return true;
  }
  if (err instanceof FacilitatorHttpError) {
    return err.retryable;
  }
  return false;
}

function parseVerifyResponse(raw: unknown): FacilitatorVerifyResponse {
  if (!isRecord(raw)) {
    throw new FacilitatorTransportError("verify response must be an object");
  }
  const isValid = raw["isValid"];
  if (typeof isValid !== "boolean") {
    throw new FacilitatorTransportError("verify.isValid must be boolean");
  }
  const invalidReason = raw["invalidReason"];
  const payer = raw["payer"];
  const result: FacilitatorVerifyResponse = { isValid };
  if (typeof invalidReason === "string") {
    return {
      ...result,
      invalidReason,
      ...(typeof payer === "string" ? { payer } : {}),
    };
  }
  if (typeof payer === "string") {
    return { ...result, payer };
  }
  return result;
}

function summarizeError(parsed: unknown, status: number): string {
  if (isRecord(parsed)) {
    const err = parsed["error"] ?? parsed["message"] ?? parsed["errorReason"];
    if (typeof err === "string") {
      return redactPaymentSignature(err);
    }
  }
  return `status ${status}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
