import {
  X402_VERSION,
  type PaymentAccept,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentResource,
  type SettlementResponse,
} from "../types/x402.js";
import { HeaderDecodeError, isRecord } from "./codec.js";

export function parsePaymentRequired(raw: unknown): PaymentRequired {
  if (!isRecord(raw)) {
    throw new HeaderDecodeError("PaymentRequired must be an object");
  }
  if (raw["x402Version"] !== X402_VERSION) {
    throw new HeaderDecodeError(`x402Version must be ${X402_VERSION}`);
  }
  const error = requireString(raw, "error");
  const resource = parseResource(raw["resource"]);
  const acceptsRaw = raw["accepts"];
  if (!Array.isArray(acceptsRaw) || acceptsRaw.length === 0) {
    throw new HeaderDecodeError("accepts must be a non-empty array");
  }
  const accepts = acceptsRaw.map((item, i) => parseAccept(item, `accepts[${i}]`));
  return { x402Version: X402_VERSION, error, resource, accepts };
}

export function parsePaymentPayload(raw: unknown): PaymentPayload {
  if (!isRecord(raw)) {
    throw new HeaderDecodeError("PaymentPayload must be an object");
  }
  if (raw["x402Version"] !== X402_VERSION) {
    throw new HeaderDecodeError(`x402Version must be ${X402_VERSION}`);
  }
  const resource = parseResource(raw["resource"]);
  const accepted = parseAccept(raw["accepted"], "accepted");
  const payload = raw["payload"];
  if (!isRecord(payload)) {
    throw new HeaderDecodeError("payload must be an object");
  }
  return {
    x402Version: X402_VERSION,
    resource,
    accepted,
    payload,
  };
}

export function parseSettlementResponse(raw: unknown): SettlementResponse {
  if (!isRecord(raw)) {
    throw new HeaderDecodeError("SettlementResponse must be an object");
  }
  const success = raw["success"];
  if (typeof success !== "boolean") {
    throw new HeaderDecodeError("success must be boolean");
  }
  // x402 failure examples use transaction: "" — allow empty string.
  const transactionRaw = raw["transaction"];
  if (typeof transactionRaw !== "string") {
    throw new HeaderDecodeError("transaction must be a string");
  }
  const transaction = transactionRaw;
  const network = requireString(raw, "network");
  const payerVal = raw["payer"];
  if (typeof payerVal !== "string") {
    throw new HeaderDecodeError("payer must be a string");
  }
  const payer = payerVal;
  const errorReason = raw["errorReason"];
  if (errorReason === undefined) {
    return { success, transaction, network, payer };
  }
  if (typeof errorReason !== "string") {
    throw new HeaderDecodeError("errorReason must be a string when present");
  }
  return { success, transaction, network, payer, errorReason };
}

function parseResource(raw: unknown): PaymentResource {
  if (!isRecord(raw)) {
    throw new HeaderDecodeError("resource must be an object");
  }
  return {
    url: requireString(raw, "url"),
    description: requireString(raw, "description"),
    mimeType: requireString(raw, "mimeType"),
  };
}

function parseAccept(raw: unknown, label: string): PaymentAccept {
  if (!isRecord(raw)) {
    throw new HeaderDecodeError(`${label} must be an object`);
  }
  const scheme = requireString(raw, "scheme");
  if (scheme !== "exact" && scheme !== "upto") {
    throw new HeaderDecodeError(`${label}.scheme must be exact or upto`);
  }
  const accept: PaymentAccept = {
    scheme,
    network: requireString(raw, "network"),
    amount: requireString(raw, "amount"),
    asset: requireString(raw, "asset"),
    payTo: requireString(raw, "payTo"),
    maxTimeoutSeconds: requirePositiveInt(raw, "maxTimeoutSeconds"),
  };
  const extra = raw["extra"];
  if (extra === undefined) {
    return accept;
  }
  if (!isRecord(extra)) {
    throw new HeaderDecodeError(`${label}.extra must be an object`);
  }
  const normalized: Record<string, string> = {};
  for (const [k, v] of Object.entries(extra)) {
    if (typeof v !== "string") {
      throw new HeaderDecodeError(`${label}.extra.${k} must be a string`);
    }
    normalized[k] = v;
  }
  return { ...accept, extra: normalized };
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new HeaderDecodeError(`${key} must be a non-empty string`);
  }
  return value;
}

function requirePositiveInt(obj: Record<string, unknown>, key: string): number {
  const value = obj[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new HeaderDecodeError(`${key} must be a positive integer`);
  }
  return value;
}
