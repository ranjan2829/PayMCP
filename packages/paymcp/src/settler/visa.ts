import { createHash } from "node:crypto";
import { isRecord } from "../headers/codec.js";
import { redactPaymentSignature } from "../http/sanitize.js";
import type { SettlementResponse } from "../types/x402.js";
import { buildXPayToken, canonicalizeQuery } from "./xpay.js";
import type { SettlementRail } from "./rail.js";
import { ConfigValidationError } from "../types/config.js";

/** Env var NAMES for Visa Intelligent Commerce / X-Pay — no placeholder values. */
export const VISA_ENV_KEYS = {
  enabled: "PAYMCP_VISA_ENABLED",
  apiBaseUrl: "VISA_API_BASE_URL",
  apiKey: "VISA_API_KEY",
  sharedSecret: "VISA_SHARED_SECRET",
  /** Optional key id / project id for operator dashboards. */
  keyId: "VISA_KEY_ID",
  merchantId: "VISA_MERCHANT_ID",
  timeoutMs: "PAYMCP_VISA_TIMEOUT_MS",
  maxRetries: "PAYMCP_VISA_MAX_RETRIES",
  /** Settle path under api base (default /vic/v1/payments/settle). */
  settlePath: "VISA_SETTLE_PATH",
  verifyPath: "VISA_VERIFY_PATH",
} as const;

export interface VisaVicEnvConfig {
  readonly enabled: boolean;
  readonly apiBaseUrl: string;
  readonly apiKey: string;
  readonly sharedSecret: string;
  readonly keyId?: string;
  readonly merchantId?: string;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly settlePath: string;
  readonly verifyPath: string;
}

/**
 * Load Visa VIC settler config. When PAYMCP_VISA_ENABLED is truthy, all of
 * VISA_API_BASE_URL, VISA_API_KEY, VISA_SHARED_SECRET must be set — refuse boot otherwise.
 * When disabled, returns enabled:false without requiring secrets.
 */
export function loadVisaVicConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): VisaVicEnvConfig | { readonly enabled: false } {
  const enabled = isTruthy(env[VISA_ENV_KEYS.enabled]);
  if (!enabled) {
    return { enabled: false };
  }

  const missing: string[] = [];
  const apiBaseUrl = optional(env, VISA_ENV_KEYS.apiBaseUrl);
  const apiKey = optional(env, VISA_ENV_KEYS.apiKey);
  const sharedSecret = optional(env, VISA_ENV_KEYS.sharedSecret);
  if (apiBaseUrl === undefined) missing.push(`${VISA_ENV_KEYS.apiBaseUrl} is required when Visa rail is enabled`);
  if (apiKey === undefined) missing.push(`${VISA_ENV_KEYS.apiKey} is required when Visa rail is enabled`);
  if (sharedSecret === undefined) {
    missing.push(`${VISA_ENV_KEYS.sharedSecret} is required when Visa rail is enabled`);
  }
  if (missing.length > 0) {
    throw new ConfigValidationError(missing);
  }

  let parsedBase: URL;
  try {
    parsedBase = new URL(apiBaseUrl!);
  } catch {
    throw new ConfigValidationError([
      `${VISA_ENV_KEYS.apiBaseUrl} must be a valid URL`,
    ]);
  }
  if (parsedBase.protocol !== "https:" && parsedBase.protocol !== "http:") {
    throw new ConfigValidationError([
      `${VISA_ENV_KEYS.apiBaseUrl} must be http(s)`,
    ]);
  }

  const timeoutMs = parsePositiveInt(optional(env, VISA_ENV_KEYS.timeoutMs), VISA_ENV_KEYS.timeoutMs);
  const maxRetries = parseNonNegInt(optional(env, VISA_ENV_KEYS.maxRetries), VISA_ENV_KEYS.maxRetries);

  const keyId = optional(env, VISA_ENV_KEYS.keyId);
  const merchantId = optional(env, VISA_ENV_KEYS.merchantId);
  const result: VisaVicEnvConfig = {
    enabled: true,
    apiBaseUrl: apiBaseUrl!.replace(/\/$/, ""),
    apiKey: apiKey!,
    sharedSecret: sharedSecret!,
    settlePath: optional(env, VISA_ENV_KEYS.settlePath) ?? "/vic/v1/payments/settle",
    verifyPath: optional(env, VISA_ENV_KEYS.verifyPath) ?? "/vic/v1/payments/verify",
  };
  if (keyId !== undefined) {
    (result as { keyId?: string }).keyId = keyId;
  }
  if (merchantId !== undefined) {
    (result as { merchantId?: string }).merchantId = merchantId;
  }
  if (timeoutMs !== undefined) {
    (result as { timeoutMs?: number }).timeoutMs = timeoutMs;
  }
  if (maxRetries !== undefined) {
    (result as { maxRetries?: number }).maxRetries = maxRetries;
  }
  return result;
}

/** Agent → merchant Visa payment credential reference (Intelligent Commerce style). */
export interface VisaPaymentPayload {
  readonly version: 1;
  readonly amount: string;
  readonly currency: string;
  readonly merchantReference: string;
  /** Opaque VIC instruction / tokenized credential reference from the agent. */
  readonly credentialRef: string;
  /** Receipt network label (default visa:vic). */
  readonly network?: string;
  readonly payer?: string;
}

export interface VisaSettleInput {
  readonly payment: VisaPaymentPayload;
  readonly idempotencyKey: string;
  /** Optional TAP keyid / nonce for audit linkage (not a secret). */
  readonly tapKeyId?: string;
  readonly tapNonce?: string;
}

export interface VisaVerifyResponse {
  readonly isValid: boolean;
  readonly invalidReason?: string;
  readonly payer?: string;
}

export interface VisaClientOptions {
  readonly apiBaseUrl: string;
  readonly apiKey: string;
  readonly sharedSecret: string;
  readonly keyId?: string;
  readonly merchantId?: string;
  readonly settlePath?: string;
  readonly verifyPath?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  /** Inject clock for X-Pay timestamp (tests). */
  readonly nowSeconds?: () => number;
}

export type VisaSettlementResponse = SettlementResponse & {
  readonly rail: "visa";
};

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 2;

/**
 * Visa Intelligent Commerce–style settler (X-Pay authenticated HTTP).
 * Parallel interface to FacilitatorSettler: verify then settle; settle-on-2xx
 * semantics are enforced by the paywall / invoke gateway callers.
 *
 * Production requires real Visa env (API base, API key, shared secret).
 * Tests inject a recording/fixture fetchImpl — not a FakeSettler product mode.
 */
export class VisaVicSettler {
  readonly rail: SettlementRail = "visa";
  private readonly apiBaseUrl: string;
  private readonly apiKey: string;
  private readonly sharedSecret: string;
  private readonly keyId: string | undefined;
  private readonly merchantId: string | undefined;
  private readonly settlePath: string;
  private readonly verifyPath: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly nowSeconds: () => number;

  constructor(options: VisaClientOptions) {
    const trimmed = options.apiBaseUrl.replace(/\/$/, "");
    if (trimmed.length === 0) {
      throw new Error("Visa apiBaseUrl is required");
    }
    try {
      new URL(trimmed);
    } catch {
      throw new Error(`Invalid Visa apiBaseUrl: ${options.apiBaseUrl}`);
    }
    if (options.apiKey.trim().length === 0) {
      throw new Error("Visa apiKey is required");
    }
    if (options.sharedSecret.trim().length === 0) {
      throw new Error("Visa sharedSecret is required");
    }
    this.apiBaseUrl = trimmed;
    this.apiKey = options.apiKey;
    this.sharedSecret = options.sharedSecret;
    this.keyId = options.keyId;
    this.merchantId = options.merchantId;
    this.settlePath = options.settlePath ?? "/vic/v1/payments/settle";
    this.verifyPath = options.verifyPath ?? "/vic/v1/payments/verify";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.nowSeconds =
      options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Fail-closed factory from env; returns undefined when Visa rail disabled. */
  static fromEnv(
    env: NodeJS.ProcessEnv = process.env,
    overrides: Partial<VisaClientOptions> = {},
  ): VisaVicSettler | undefined {
    const cfg = loadVisaVicConfigFromEnv(env);
    if (!cfg.enabled) {
      return undefined;
    }
    return new VisaVicSettler({
      apiBaseUrl: cfg.apiBaseUrl,
      apiKey: cfg.apiKey,
      sharedSecret: cfg.sharedSecret,
      ...(cfg.keyId !== undefined ? { keyId: cfg.keyId } : {}),
      ...(cfg.merchantId !== undefined ? { merchantId: cfg.merchantId } : {}),
      settlePath: cfg.settlePath,
      verifyPath: cfg.verifyPath,
      ...(cfg.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {}),
      ...(cfg.maxRetries !== undefined ? { maxRetries: cfg.maxRetries } : {}),
      ...overrides,
    });
  }

  async verify(input: VisaSettleInput): Promise<VisaVerifyResponse> {
    const body = this.buildBody(input, "verify");
    const raw = await this.postSigned(this.verifyPath, body);
    return parseVisaVerify(raw);
  }

  async settle(input: VisaSettleInput): Promise<VisaSettlementResponse> {
    const body = this.buildBody(input, "settle");
    const raw = await this.postSigned(this.settlePath, body);
    return parseVisaSettle(raw, input.payment);
  }

  async verifyAndSettle(input: VisaSettleInput): Promise<VisaSettlementResponse> {
    const verification = await this.verify(input);
    if (!verification.isValid) {
      return {
        success: false,
        transaction: "",
        network: input.payment.network ?? "visa:vic",
        payer: verification.payer ?? input.payment.payer ?? "",
        errorReason: verification.invalidReason ?? "payment_invalid",
        rail: "visa",
      };
    }
    return this.settle(input);
  }

  private buildBody(
    input: VisaSettleInput,
    intent: "verify" | "settle",
  ): Record<string, unknown> {
    return {
      intent,
      amount: input.payment.amount,
      currency: input.payment.currency,
      merchantReference: input.payment.merchantReference,
      credentialRef: input.payment.credentialRef,
      idempotencyKey: input.idempotencyKey,
      ...(this.merchantId !== undefined ? { merchantId: this.merchantId } : {}),
      ...(input.tapKeyId !== undefined ? { tapKeyId: input.tapKeyId } : {}),
      ...(input.tapNonce !== undefined
        ? { tapNonceHash: sha256Hex(input.tapNonce) }
        : {}),
    };
  }

  private async postSigned(
    resourcePath: string,
    bodyObj: Record<string, unknown>,
  ): Promise<unknown> {
    const body = JSON.stringify(bodyObj);
    const query = canonicalizeQuery({ apikey: this.apiKey });
    let attempt = 0;
    for (;;) {
      try {
        return await this.postSignedOnce(resourcePath, query, body);
      } catch (err) {
        const retryable = isRetryableVisaError(err);
        if (!retryable || attempt >= this.maxRetries) {
          throw err;
        }
        await sleep(Math.min(1000 * 2 ** attempt, 8000));
        attempt += 1;
      }
    }
  }

  private async postSignedOnce(
    resourcePath: string,
    query: string,
    body: string,
  ): Promise<unknown> {
    const ts = this.nowSeconds();
    const token = buildXPayToken({
      sharedSecret: this.sharedSecret,
      timestampSeconds: ts,
      resourcePath,
      queryString: query,
      body,
    });
    const url = `${this.apiBaseUrl}${resourcePath}?${query}`;
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/json",
      "x-pay-token": token,
    };
    if (this.keyId !== undefined) {
      headers["x-visa-key-id"] = this.keyId;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const safe = redactPaymentSignature(message);
      if (
        err instanceof Error &&
        (err.name === "AbortError" || message.includes("abort"))
      ) {
        throw new VisaTimeoutError(
          `Visa request timed out after ${this.timeoutMs}ms`,
        );
      }
      throw new VisaTransportError(`Visa request failed: ${safe}`);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let parsed: unknown = {};
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        throw new VisaTransportError(
          `Visa returned non-JSON (HTTP ${response.status})`,
        );
      }
    }
    if (!response.ok) {
      throw new VisaHttpError(
        response.status,
        summarizeVisaError(parsed, response.status),
      );
    }
    return parsed;
  }
}

export class VisaTransportError extends Error {
  readonly retryable = true;
  constructor(message: string) {
    super(message);
    this.name = "VisaTransportError";
  }
}

export class VisaTimeoutError extends VisaTransportError {
  constructor(message: string) {
    super(message);
    this.name = "VisaTimeoutError";
  }
}

export class VisaHttpError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(status: number, detail: string) {
    super(`Visa HTTP ${status}: ${detail}`);
    this.name = "VisaHttpError";
    this.status = status;
    this.retryable = status >= 500 && status < 600;
  }
}

export function isRetryableVisaError(err: unknown): boolean {
  if (err instanceof VisaTransportError) return true;
  if (err instanceof VisaHttpError) return err.retryable;
  return false;
}

function parseVisaVerify(raw: unknown): VisaVerifyResponse {
  if (!isRecord(raw)) {
    throw new VisaTransportError("verify response must be an object");
  }
  const isValid = raw["isValid"];
  if (typeof isValid !== "boolean") {
    throw new VisaTransportError("verify.isValid must be boolean");
  }
  const invalidReason = raw["invalidReason"];
  const payer = raw["payer"];
  const result: VisaVerifyResponse = { isValid };
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

function parseVisaSettle(
  raw: unknown,
  payment: VisaPaymentPayload,
): VisaSettlementResponse {
  if (!isRecord(raw)) {
    throw new VisaTransportError("settle response must be an object");
  }
  const success = raw["success"];
  if (typeof success !== "boolean") {
    throw new VisaTransportError("settle.success must be boolean");
  }
  const transaction =
    typeof raw["transaction"] === "string" ? raw["transaction"] : "";
  const network =
    typeof raw["network"] === "string"
      ? raw["network"]
      : (payment.network ?? "visa:vic");
  const payer =
    typeof raw["payer"] === "string"
      ? raw["payer"]
      : (payment.payer ?? "");
  const errorReason = raw["errorReason"];
  const base: VisaSettlementResponse = {
    success,
    transaction,
    network,
    payer,
    rail: "visa",
  };
  if (typeof errorReason === "string") {
    return { ...base, errorReason };
  }
  return base;
}

function summarizeVisaError(parsed: unknown, status: number): string {
  if (isRecord(parsed)) {
    const err = parsed["error"] ?? parsed["message"] ?? parsed["errorReason"];
    if (typeof err === "string") {
      return redactPaymentSignature(err);
    }
  }
  return `status ${status}`;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function optional(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = env[key];
  if (v === undefined || v.trim() === "") return undefined;
  return v.trim();
}

function isTruthy(v: string | undefined): boolean {
  if (v === undefined) return false;
  const t = v.trim().toLowerCase();
  return t === "1" || t === "true" || t === "yes" || t === "on";
}

function parsePositiveInt(
  raw: string | undefined,
  key: string,
): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ConfigValidationError([`${key} must be a positive integer`]);
  }
  return n;
}

function parseNonNegInt(
  raw: string | undefined,
  key: string,
): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new ConfigValidationError([`${key} must be a non-negative integer`]);
  }
  return n;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Validate VisaPaymentPayload shape (fail closed). */
export function parseVisaPaymentPayload(raw: unknown): VisaPaymentPayload {
  if (!isRecord(raw)) {
    throw new Error("VisaPaymentPayload must be an object");
  }
  if (raw["version"] !== 1) {
    throw new Error("VisaPaymentPayload.version must be 1");
  }
  const amount = requireNonEmpty(raw, "amount");
  if (!/^\d+$/.test(amount)) {
    throw new Error("VisaPaymentPayload.amount must be decimal integer string");
  }
  const currency = requireNonEmpty(raw, "currency");
  const merchantReference = requireNonEmpty(raw, "merchantReference");
  const credentialRef = requireNonEmpty(raw, "credentialRef");
  const network = raw["network"];
  const payer = raw["payer"];
  return {
    version: 1,
    amount,
    currency,
    merchantReference,
    credentialRef,
    ...(typeof network === "string" && network.length > 0
      ? { network }
      : {}),
    ...(typeof payer === "string" ? { payer } : {}),
  };
}

function requireNonEmpty(
  obj: Record<string, unknown>,
  key: string,
): string {
  const v = obj[key];
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new Error(`VisaPaymentPayload.${key} must be a non-empty string`);
  }
  return v.trim();
}

export const HEADER_VISA_PAYMENT = "VISA-PAYMENT";
